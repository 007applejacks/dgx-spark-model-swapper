# dgx-spark-model-swapper

A small web control plane for an NVIDIA **DGX Spark (GB10)** doing one-model-at-a-time vLLM
serving. The GB10 is an integrated GPU with unified memory — it can hold exactly one model at a
time, and (unlike a discrete card) it **cannot be reset** if a swap goes wrong; only a reboot
recovers it. This tool exists to make swapping between models a safe, one-click, drain-aware
operation instead of a footgun.

Click a model in the dashboard and it checks what's currently loaded, and if the target differs:
stops the running container, **drains the GPU**, starts the target with its validated per-model
recipe, and waits for health. Every model serves on the same port, so clients never change their
endpoint.

## Layout

```
├── swap-ui/          FastAPI backend + React/Vite dashboard — the web control plane
├── agent/            Unprivileged companion daemon that owns the chat/agent tool-execution path
├── orchestration/     Bash drivers (stop → drain → serve) — single source of truth for vLLM flags
├── manifests/         Pinned container images + shared stack config
└── systemd/           Unit files for both services
```

Model **recipes** (which checkpoint, quant, context length, sampling profile, per-model vLLM
flags) live in a separate, dedicated repo —
[`007applejacks/gb10-model-configs`](https://github.com/007applejacks/gb10-model-configs) — so the
tool and the model registry can version independently. See that repo's README for the recipe
format.

## Quick start

```bash
cd swap-ui/frontend && npm ci && npm run build      # → frontend/dist/, served by app.py
cd ../.. && swap-ui/bootstrap.sh                     # create the backend venv
CONFIGS_REPO=/path/to/gb10-model-configs \
  swap-ui/.venv/bin/python swap-ui/app.py --host 0.0.0.0 --port 8080
```

`CONFIGS_REPO` points at a local clone of `gb10-model-configs`; falls back to an in-tree
`models/` directory (gitignored) if unset — handy for developing the UI without a full deploy.
See `swap-ui/README.md` and `agent/README.md` for the full deploy/operate notes, HTTP API, and
systemd install steps.

## A note on naming

This repo uses **"gb10"** — the actual NVIDIA chip in a DGX Spark. A handful of identifiers in the
scripts and unit files still reflect one specific already-deployed box's real setup (its SSH
alias, hostname, and a sandboxed OS user the chat daemon runs as) and were deliberately left
unrenamed rather than silently edited into something that would stop matching reality. If you're
deploying fresh, use your own host/alias/username and update the handful of places that reference
them — `manifests/containers.env`, and `agent/`'s systemd unit and bootstrap script are the ones
that matter.

## License

MIT — see `LICENSE`.
