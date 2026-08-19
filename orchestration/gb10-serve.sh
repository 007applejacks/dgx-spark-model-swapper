#!/usr/bin/env bash
# gb10-serve.sh — bring up the box's vLLM serve container (NVFP4) for a model,
# on demand. First run creates the container (docker run -d); later runs just
# docker start it. Waits for /health, prints the OpenAI endpoint, then leaves it
# up. Stop it with gb10-stop.sh when idle.
#
# Runs ON token.
#   gb10-serve.sh -m <merged-or-base-dir-on-the-box> -n <served-model-name> \
#                 [-q nvfp4|fp8] [--max-model-len N]
#
# Model-specific paths/flags live in local/gb10/*.env (gitignored); pass with
# SERVE_ENV_FILE=local/gb10/qwen36.env to add extra `vllm serve` args.
set -euo pipefail
. "$(dirname "$0")/gb10-lib.sh"

# Optional per-model registry env file (the gb10-model-configs repo's models/*.env). Sourced HERE —
# before the defaults below — so its values win, while still leaving everything overridable by CLI
# flags after. This is the mechanism the swap-ui / gb10-swap.sh use to serve any registered model on
# :8002 with its own recipe (reasoning parser, max-len, spec-decode, extra args). Standalone use is
# unchanged.
if [ -n "${SERVE_ENV_FILE:-}" ]; then
  [ -r "${SERVE_ENV_FILE}" ] || { echo "ERROR: SERVE_ENV_FILE not readable: ${SERVE_ENV_FILE}" >&2; exit 1; }
  # stderr, not stdout: --print-hash's caller captures this script's stdout via command
  # substitution expecting ONLY the hash back — any incidental stdout line would corrupt that
  # capture. swap-ui's own job-log capture merges stderr into stdout anyway, so nothing is lost
  # there; this only changes what plain `$(...)` callers see.
  echo "sourcing model env: ${SERVE_ENV_FILE}" >&2
  # shellcheck disable=SC1090
  . "${SERVE_ENV_FILE}"
fi

# MAX_LEN default = 262144 (256K = Qwen3.6's full native window). [measured] this fits the locked
# Qwen3.6-27B-NVFP4 with huge room — the hybrid Gated-DeltaNet linear-attention layers keep KV
# ~flat (only the periodic full-attention layers grow), so 256K costs far less KV than a
# non-hybrid dense model of similar size would. A fully-dense fallback (e.g. Qwen3-32B, no GDN
# layers) has much larger KV per token — pass a smaller --max-model-len for it.
# MODEL_DIR/SERVED_NAME/QUANT default from the sourced env file (SERVE_MODEL/SERVED_NAME/QUANT)
# when present, so a registry entry needs no -m/-n/-q; CLI flags below still override.
MODEL_DIR="${MODEL_DIR:-${SERVE_MODEL:-}}" ; SERVED_NAME="${SERVED_NAME:-}" ; QUANT="${QUANT:-auto}" ; MAX_LEN="${MAX_LEN:-262144}"
# Reasoning parser is per-model: qwen3 for Qwen, nemotron_v3 for Nemotron-3. Overridable via env.
# Use ${VAR-default} (not :-): an env file that sets REASONING_PARSER="" must be able to DISABLE
# the parser entirely (e.g. gemma-4, a non-reasoning model) — with :- an explicit empty value was
# treated as unset and silently re-defaulted to qwen3, attaching the wrong parser. Matches the
# unset-only semantics of SPEC_ARG/COMPILE_ARG/KV_ARG/GENCFG_ARG below.
REASONING_PARSER="${REASONING_PARSER-qwen3}"
# Extra per-model vLLM flags (e.g. Nemotron Super's `--max-num-seqs 4`), threaded verbatim.
EXTRA_ARGS="${EXTRA_ARGS:-}"
# GPU_UTIL default 0.85: NVIDIA's own vLLM-on-DGX-Spark guidance caps unified-memory utilization at
# 0.85 max for long-running sessions — going higher risks the same UVM/page-cache pressure pattern
# that causes OOM lockups on this hardware. Override with GPU_UTIL=<n> if you've validated higher.
GPU_UTIL="${GPU_UTIL:-0.85}" ; TOOLS="${TOOLS:-0}"
# Tool-call parser is per-model, like REASONING_PARSER: qwen3_xml for Qwen, gemma4 for Gemma-4
# (vLLM 0.24's dedicated parser for its <|tool_call>call:name{...}<tool_call|> template format —
# NOT pythonic, which is Gemma-3's format). Override via the model env file.
TOOL_PARSER="${TOOL_PARSER:-qwen3_xml}"
while [ $# -gt 0 ]; do case "$1" in
  -m) MODEL_DIR="$2"; shift 2;; -n) SERVED_NAME="$2"; shift 2;;
  -q) QUANT="$2"; shift 2;; --max-model-len) MAX_LEN="$2"; shift 2;;
  --tools) TOOLS=1; shift;;       # opt-in tool-calling (qwen3_xml parser, validated 2026-07-03)
  --print-hash) PRINT_HASH=1; shift;;  # resolve the recipe and echo its hash; no docker/GPU touched
  *) echo "unknown arg: $1" >&2; exit 1;;
esac; done
[ -z "$MODEL_DIR" ] || [ -z "$SERVED_NAME" ] && { echo "usage: gb10-serve.sh -m <repo-or-dir> -n <name> [-q auto|modelopt_fp4|fp8] [--tools]"; exit 1; }

# vLLM auto-detects the quant from a ModelOpt/NVFP4 checkpoint, so default QUANT=auto
# omits --quantization. Pass -q only to force a method. Tool-calling is opt-in.
# Parser = qwen3_xml: the alternative qwen3_coder parser systematically mis-extracts calls
# (schema placeholders as values, reasoning bleeding into tool names); qwen3_xml parses the
# <function=...><parameter=...> template format cleanly. Qwen3.6 is a thinking model — always
# parse the <think>...</think> stream out with --reasoning-parser qwen3, which returns reasoning
# in the response's `reasoning` field, keeping `content` + tool_calls clean. Harmless when
# thinking is disabled (no think block → nothing to strip).
QUANT_ARG=""; [ "$QUANT" != auto ] && QUANT_ARG="--quantization ${QUANT}"
# Reasoning parser is optional — an imported model may have none; omit the flag when empty.
REASONING_ARG=""; [ -n "$REASONING_PARSER" ] && REASONING_ARG="--reasoning-parser ${REASONING_PARSER}"
TOOL_ARG="";  [ "$TOOLS" = 1 ] && TOOL_ARG="--enable-auto-tool-choice --tool-call-parser ${TOOL_PARSER}"

# Speculative decoding: native MTP, k=3, on by default. `cudagraph_mode` MUST stay PIECEWISE
# whenever SPEC_ARG is set — vLLM's default (FULL_AND_PIECEWISE) corrupts tool-call output under
# spec decode on this hardware/model combo (dropped/malformed tool calls). k=4 was promoted to
# production once (2026-07-08) and crashed under real load (EngineDeadError, device-side assert in
# the GDN causal_conv1d_update kernel) -- but that run was ALSO silently serving fp8_e4m3 KV cache
# with uncalibrated scales (the auto-KV bug fixed below), never isolated as a separate variable, so
# k=4-the-cause was never actually confirmed vs. the KV bug. Nobody has re-run k=4 since the KV fix
# landed. Stick with k=3 as the validated default, but treat k=4 as "unconfirmed", not "proven
# unsafe" -- a fresh isolated test (synthetic gate + real load) is fair game if revisited. Safe to
# clear COMPILE_ARG only if SPEC_ARG is also cleared.
SPEC_ARG="${SPEC_ARG-"--speculative-config '{\"method\":\"mtp\",\"num_speculative_tokens\":3}'"}"
COMPILE_ARG="${COMPILE_ARG-"--compilation-config '{\"cudagraph_mode\":\"PIECEWISE\"}'"}"

# KV cache dtype: explicit bfloat16 is required. Leaving this unset ("auto") resolves NVFP4/
# ModelOpt checkpoints to fp8_e4m3 with uncalibrated scales — an accuracy bug, not a speed
# tradeoff. bf16 costs ~2x the KV memory of fp8 but throughput is unaffected (weights dominate
# memory traffic, not KV).
KV_ARG="${KV_ARG-"--kv-cache-dtype bfloat16"}"
# Qwen3.6 recommended server-side sampling defaults (per-request client values override these).
# JSON single-quoted to survive the gb10_ssh hop — verify it reaches vllm intact on FIRST re-serve.
GENCFG_ARG="${GENCFG_ARG-"--override-generation-config '{\"temperature\": 0.6, \"presence_penalty\": 0.0}'"}"

# RUN_ARGS is the single source of truth for "what does this recipe actually launch" — built once
# here, used BOTH to compute RECIPE_HASH below AND as the literal docker run tail further down, so
# the hash can never drift from the command it's supposed to describe. Hashing the fully-resolved
# string (rather than diffing individual recipe vars) means ANY change that affects the running
# container — a new GPU_UTIL, a VLLM_IMAGE bump in containers.env, a hand-edited EXTRA_ARGS — is
# caught the same way, with no per-field allowlist to keep in sync as new knobs get added.
RUN_ARGS="--gpus all --ipc=host \
    --ulimit memlock=-1 --ulimit stack=67108864 \
    -p ${SERVE_PORT}:${SERVE_PORT} \
    -v ${HF_CACHE_VOL}:/root/.cache/huggingface \
    -v ${OUT_DIR_HOST}:/out:ro \
    '${VLLM_IMAGE}' \
    --model '${MODEL_DIR}' \
      --served-model-name '${SERVED_NAME}' \
      --port ${SERVE_PORT} \
      --max-model-len ${MAX_LEN} \
      --gpu-memory-utilization ${GPU_UTIL} \
      --trust-remote-code --enable-prefix-caching \
      ${REASONING_ARG} ${KV_ARG} ${QUANT_ARG} ${TOOL_ARG} ${GENCFG_ARG} ${SPEC_ARG} ${COMPILE_ARG} ${EXTRA_ARGS}"
RECIPE_HASH="$(printf '%s' "$RUN_ARGS" | sha256sum | cut -d' ' -f1)"
[ "${PRINT_HASH:-0}" = 1 ] && { echo "$RECIPE_HASH"; exit 0; }

# CANONICAL qwen36-27b-dense serve (reproduces the validated default stack; name = $SERVE_CONTAINER
# in containers.env):
#   gb10-serve.sh -m nvidia/Qwen3.6-27B-NVFP4 -n qwen36-27b-dense -q modelopt --tools
# (-q modelopt matches the checkpoint's explicit quant; QUANT=auto also resolves to modelopt for an
# NVFP4 checkpoint, so it's equivalent. --tools enables the tool-call parser.)
# Brings up: vLLM v0.24.0 (see containers.env) + MTP(k=3) spec decode + forced PIECEWISE cudagraph
# + explicit bf16 KV cache (see KV_ARG above) + 0.85 GPU utilization (see GPU_UTIL above).

if gb10_container_running "$SERVE_CONTAINER"; then
  echo "NOTE: ${SERVE_CONTAINER} already running; stop it first to change models." >&2
  exit 1
fi

NEED_CREATE=1
if gb10_container_exists "$SERVE_CONTAINER"; then
  EXISTING_HASH="$(gb10_container_label "$SERVE_CONTAINER" gb10.recipe-hash)"
  if [ "$EXISTING_HASH" = "$RECIPE_HASH" ]; then
    echo "starting existing ${SERVE_CONTAINER} (recipe unchanged) ..."
    gb10_ssh "docker start '${SERVE_CONTAINER}'"
    NEED_CREATE=0
  else
    # Docker bakes CMD/labels in at `docker create` time and never lets you change them on an
    # existing container — a plain `docker start` would keep serving whatever recipe (GPU_UTIL,
    # quant, spec-decode, ...) was in effect the LAST time this container was created, silently
    # ignoring any edits to the .env since. Recreate it instead so the new recipe actually takes.
    echo "recipe changed since ${SERVE_CONTAINER} was created (or its recipe is unknown) — recreating ..."
    gb10_ssh "docker rm '${SERVE_CONTAINER}'"
  fi
fi
if [ "$NEED_CREATE" = 1 ]; then
  echo "creating ${SERVE_CONTAINER} (vLLM ${VLLM_IMAGE}, quant=${QUANT}, tools=${TOOLS}) ..."
  # vLLM OpenAI API on :SERVE_PORT. NVIDIA-recommended docker flags (--ipc=host + memlock/stack
  # ulimits) are required for vLLM on the GB10. NOTE: vllm/vllm-openai's entrypoint IS the API
  # server already — CMD args are `--model <repo> ...`, NOT `vllm serve <repo> ...` (that
  # subcommand form was only correct for the old nvcr.io/nvidia/vllm image).
  gb10_ssh "docker run -d --name '${SERVE_CONTAINER}' --label 'gb10.recipe-hash=${RECIPE_HASH}' ${RUN_ARGS}"
fi

wait_health "$GB10_HEALTH" "${SERVE_TIMEOUT:-900}" "$SERVE_CONTAINER"
DIGEST=$(gb10_image_digest "$VLLM_IMAGE")
echo "served:   ${SERVED_NAME}"
echo "endpoint: http://${GB10_SSH}:${SERVE_PORT}/v1"   # LAN/mDNS from token (no Tailscale)
echo "image:    ${DIGEST:-$VLLM_IMAGE}"
