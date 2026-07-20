#!/usr/bin/env bash
# gb10-swap.sh — swap the single served model on the box's one GPU, safely and idempotently.
#
# The GB10 is this box's sole/primary GPU, so `nvidia-smi -r` refuses to reset it (a general
# "won't reset the primary GPU" restriction, not GB10-specific — any single-GPU box hits it, since
# there's no secondary GPU to take over the console while it resets). An abrupt CUDA teardown can
# wedge it into ERR! state, recoverable only by a reboot. So a model swap is:
#   check target → (already loaded & healthy? NOOP) → stop current → DRAIN GPU → start target → wait health.
#
# Designed to run BOTH ways:
#   • ON the box (the swap-ui backend):   GB10_LOCAL=1 gb10-swap.sh --id qwen36-27b-dense
#   • FROM token (over SSH, legacy):      gb10-swap.sh --id qwen36-27b-dense
#
# Emits machine-readable progress the backend parses, one per line:
#   PHASE <stopping|draining|starting|waiting-health>
#   RESULT <SWAPPED <name> | NOOP <name> | WEDGED | ERROR <msg>>
# Exit 0 on SWAPPED/NOOP, non-zero otherwise.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "${HERE}/gb10-lib.sh"                       # sources manifests/containers.env
STATE_DIR="${GB10_SWAP_STATE_DIR:-$HOME/.config/gb10-swap}"

MODEL_ID="" ; ENV_FILE=""
while [ $# -gt 0 ]; do case "$1" in
  --id) MODEL_ID="$2"; shift 2;;
  --env) ENV_FILE="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; echo "RESULT ERROR bad-args"; exit 2;;
esac; done

# MODELS_DIR is only resolved lazily, here, when --id was passed instead of --env — the normal
# path (the swap-ui backend always passes --env with a fully-resolved recipe path) never touches
# it. Fixed 2026-07-17: this used to be an unconditional `cd "${HERE}/../models"` at the top of the
# script, which hard-failed under `set -e` on a fresh checkout where ../models doesn't exist (model
# recipes live in the separate gb10-model-configs repo, not in-tree here).
if [ -z "$ENV_FILE" ] && [ -n "$MODEL_ID" ]; then
  MODELS_DIR="$(cd "${HERE}/../models" && pwd)"
  ENV_FILE="${MODELS_DIR}/${MODEL_ID}.env"
fi
if [ -z "$ENV_FILE" ] || [ ! -r "$ENV_FILE" ]; then
  echo "usage: gb10-swap.sh --id <model-id> | --env <path>" >&2
  echo "RESULT ERROR no-such-model"; exit 2
fi
# Derive the id (used for the last-model state file) from the env filename when --env was passed.
[ -z "$MODEL_ID" ] && MODEL_ID="$(basename "$ENV_FILE" .env)"

# Load the target recipe (SERVED_NAME / SERVE_CONTAINER / SERVE_PORT).
# shellcheck disable=SC1090
. "$ENV_FILE"
SERVE_PORT="${SERVE_PORT:-8002}"
[ -z "${SERVED_NAME:-}" ] || [ -z "${SERVE_CONTAINER:-}" ] && { echo "RESULT ERROR bad-model-env"; exit 2; }

# When running locally on the box, the bare ssh-alias name is not a resolvable hostname —
# point the health check at localhost. (containers.env now honors a pre-set GB10_HEALTH.)
if [ "${GB10_LOCAL:-0}" = 1 ]; then
  export GB10_HEALTH="http://localhost:${SERVE_PORT}/health"
fi

# --- 1. Idempotency: is the target already loaded, healthy, AND on the current recipe? ------
# "Already loaded and healthy" alone isn't enough to NOOP on — a recipe edit (GPU_UTIL, quant,
# extra args, ...) doesn't touch the running container, so a health-only check would silently
# skip applying it. Resolve what THIS recipe would hash to (--print-hash: same computation
# gb10-serve.sh uses when it actually creates a container, so this can't drift from that decision)
# and compare against the running container's own label before trusting "nothing to do".
TARGET_HASH="$(SERVE_ENV_FILE="$ENV_FILE" GB10_LOCAL="${GB10_LOCAL:-0}" "${HERE}/gb10-serve.sh" --print-hash)"
if gb10_container_running "$SERVE_CONTAINER"; then
  RUNNING_HASH="$(gb10_container_label "$SERVE_CONTAINER" gb10.recipe-hash)"
  if [ "$RUNNING_HASH" = "$TARGET_HASH" ] \
     && gb10_ssh "curl -fsS -o /dev/null 'http://localhost:${SERVE_PORT}/health'" 2>/dev/null; then
    echo "target ${SERVED_NAME} already running, healthy, and on the current recipe — nothing to do."
    echo "RESULT NOOP ${SERVED_NAME}"
    exit 0
  fi
  echo "target container is up but its recipe changed (or it's unhealthy) — restarting it clean."
fi

# --- 2. Stop every vLLM SERVE container before the target starts ------------------------------
# Only one model fits in the GB10's unified memory, so all serving vLLM containers must be down
# first — not just swapper-managed ones. Matches: swap-vllm-* by name, anything publishing the
# serve port, OR any vLLM-image container that publishes a port (catches legacy/manual serves on
# other ports, e.g. a nemotron container left on :8006). The trailing `$2 != ""` on the image match
# is critical: a model-download runs the SAME vLLM image but publishes NO ports — without this it
# would be collateral-killed mid-download (SIGKILL -> exit 137). dcgm-exporter etc. are left alone.
echo "PHASE stopping"
to_stop="$(gb10_ssh "docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Image}}' \
  | awk -F '\t' -v p=':${SERVE_PORT}->' '\$1 ~ /^swap-vllm-/ || index(\$2,p) || (\$3 ~ /vllm/ && \$2 != \"\") {print \$1}'" || true)"
if [ -n "$to_stop" ]; then
  while IFS= read -r n; do
    [ -n "$n" ] && { echo "  stopping ${n} ..."; gb10_stop "$n"; }
  done <<< "$to_stop"
else
  echo "  no vLLM serve containers running."
fi

# --- 3. Drain the GPU before the next container grabs it (WEDGE guard) -----------------------
echo "PHASE draining"
if ! gb10_wait_gpu_idle "${DRAIN_TIMEOUT:-180}"; then
  echo "GPU did not drain — likely wedged (sole/primary GPU; only a reboot recovers)." >&2
  echo "RESULT WEDGED"
  exit 1
fi

# --- 4. Start the target with its registry recipe (gb10-serve.sh does create-or-start + wait) -
echo "PHASE starting"
echo "PHASE waiting-health"    # gb10-serve.sh blocks on /health after (re)start
if SERVE_ENV_FILE="$ENV_FILE" GB10_LOCAL="${GB10_LOCAL:-0}" "${HERE}/gb10-serve.sh"; then
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$MODEL_ID" > "${STATE_DIR}/last-model"     # for gb10-serve-boot.service restore
  echo "RESULT SWAPPED ${SERVED_NAME}"
  exit 0
else
  echo "serve failed for ${SERVED_NAME}" >&2
  echo "RESULT ERROR serve-failed"
  exit 1
fi
