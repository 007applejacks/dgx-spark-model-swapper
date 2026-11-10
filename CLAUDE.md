# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A web control plane for an NVIDIA DGX Spark (GB10) that serves **one vLLM model at a time** on
`:8002`. Swapping is stop → **drain the GPU** → start the target recipe → wait for `/health`. The
GB10 is the box's sole GPU, so `nvidia-smi -r` refuses to reset it, and an un-drained or abrupt
CUDA teardown can wedge the GPU until a reboot. Any change to the swap path must keep the drain
step and the one-model-at-a-time rule.

## Commands

```bash
# Frontend (React + Vite + Tailwind, TypeScript). `build` runs tsc, which is the only type/lint check.
cd swap-ui/frontend && npm ci && npm run build    # -> dist/ (gitignored, served by app.py)
cd swap-ui/frontend && npm run dev                # Vite dev server

# Backend (FastAPI)
swap-ui/bootstrap.sh                              # create swap-ui/.venv
CONFIGS_REPO=/path/to/gb10-model-configs \
  swap-ui/.venv/bin/python swap-ui/app.py --host 0.0.0.0 --port 8080

# Orchestration: syntax check, and resolve a recipe without touching docker/GPU
bash -n orchestration/*.sh
SERVE_ENV_FILE=../gb10-model-configs/models/<id>.env orchestration/gb10-serve.sh --print-hash
```

There is no unit test suite, linter config or CI. The checks are `npm run build` (tsc), `bash -n`
and `--print-hash`. Real validation is the **GB10 stability battery**, run from the dashboard
("Test stability", backed by `swap-ui/benchmarks.py` / `stability.py`) against a model loaded on the
box. It can't run on a Mac.

## Architecture

Three layers, plus a separate recipe repo:

- **`orchestration/` (bash)** is the single source of truth for how vLLM is launched.
  - `gb10-swap.sh --env <recipe.env>` does the idempotent stop → drain → serve and prints
    machine-readable lines (`PHASE <...>`, `RESULT SWAPPED|NOOP|WEDGED|ERROR ...`) that the backend
    parses.
  - `gb10-serve.sh` sources the recipe via `SERVE_ENV_FILE`, then applies its own defaults. It
    builds `RUN_ARGS` once and uses it both as the `docker run` tail and as a sha256 **recipe
    hash** stored as container label `gb10.recipe-hash`. If the hash changes (recipe edit, image
    bump), the container is recreated instead of `docker start`ed. `gb10-swap.sh` also uses the
    hash to decide NOOP.
  - `gb10-lib.sh` sources `manifests/containers.env`. Every script runs over SSH (`GB10_SSH`) by
    default, or against local docker/nvidia-smi when `GB10_LOCAL=1`. The backend always sets
    `GB10_LOCAL=1`.
  - `gb10-swap.sh` records the last-loaded model in `~/.config/gb10-swap/last-model`.
    `gb10-serve-boot.service` restarts `swap-vllm-<id>` from that file after boot. So the model
    served after a reboot is the **last loaded** one, not the containers.env default.
- **`swap-ui/app.py` (FastAPI, single file)** runs on the box as the privileged `deploy` user
  (docker, sudo for apt/reboot/poweroff), and also serves the built SPA.
  - It never builds vLLM flags itself. It shells out to the orchestration scripts.
  - It parses recipe `.env` files with a plain `KEY="value"` regex, with **no shell
    evaluation**, so recipes must stay in that form.
  - `/proxy/v1` is an OpenAI-compatible passthrough to whatever model is loaded.
  - Import/edit/promote write `.env` files into `CONFIGS_REPO` and git commit + push from the box.
- **`agent/agent.py`** is a separate daemon running as the unprivileged `gb10-agent` user
  (no sudo, not in docker, systemd-jailed) on `127.0.0.1:8090`. It owns the chat path, so
  untrusted model output and web content never go through the privileged backend. Keep it that
  way: chat and tool execution go in `agent/`, never in `app.py`.
- **`gb10-model-configs`** is a separate repo; it is usually cloned beside this one.
  - It holds one `models/<id>.env` per model: serve recipe plus `UI_*` metadata.
  - **The box's clone is the system of record.** Uncommitted `.env` = draft; committed = official.
  - `EXPERIMENTAL="1"` clears only after the stability battery passes.
  - If `CONFIGS_REPO` is unset, the backend falls back to the in-tree `models/` (gitignored).

## Recipe / env-var conventions

- `manifests/containers.env` holds only shared stack config: the pinned `VLLM_IMAGE` plus its
  digest, volume, port, and the bare-fallback `SERVE_MODEL`/`SERVED_NAME`/`SERVE_CONTAINER`.
  Per-model flags belong in the recipe repo.
- `SPEC_ARG`, `COMPILE_ARG`, `KV_ARG`, `GENCFG_ARG` and `REASONING_PARSER` use `${VAR-default}`
  (unset-only). A recipe that sets one to `""` **disables** it rather than falling back to the
  default. Keep that semantics when adding knobs.
- Container names are `swap-vllm-<served-name>`. `SERVE_TIMEOUT` (default 900s) is per recipe; slow
  inits (e.g. NVFP4 at ~930s) need it raised.
- Comments in `containers.env` and `gb10-serve.sh` record why each version and flag was chosen, with
  dates and measurements. Update them when behaviour changes, and don't delete history. Example:
  `manifests/vllm-logprob-clamp.Dockerfile` is unused but kept on purpose in case its bug comes back.

## Operating the box

- Never swap or stop the serving model on the box without the user's explicit OK, each time.
- Edits happen in this repo on the dev machine. Deploy by `git pull` on the box plus rsync of
  `frontend/dist/` (the box has no Node at runtime). See `swap-ui/README.md` and `agent/README.md`
  for the systemd install and the sudoers rules needed for reboot/poweroff.
