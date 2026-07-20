#!/usr/bin/env bash
# gb10-lib.sh — shared helpers for the token-side gb10 (DGX Spark) drivers.
#
# Runs ON token. Reaches the box via SSH over the LAN — the GB10_SSH alias (see
# manifests/containers.env; set it to your own ~/.ssh/config Host entry for the box) resolves to
# its mDNS/LAN hostname (Tailscale SSH was dropped: its check-mode re-auth hangs the alias).
# Job parameters are ALWAYS passed to `docker` via --env-file /
# files, never string-interpolated into the remote shell (injection defense).
#
# Source this, then call gb10_ssh / gb10_image_digest / wait_health / etc.

set -euo pipefail

# Load the pinned manifest relative to this file.
GB10_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
. "${GB10_DIR}/manifests/containers.env"
# Untracked, installer-generated overrides (e.g. OUT_DIR_HOST localized to wherever install.sh put
# it) — sourced AFTER containers.env so it wins for just the variables it sets. Never committed;
# absent on a fresh checkout that hasn't been installed yet, so this is optional.
if [ -r "${GB10_DIR}/manifests/containers.local.env" ]; then
  # shellcheck disable=SC1091
  . "${GB10_DIR}/manifests/containers.local.env"
fi

# Run a command on the box. Non-interactive, fail-fast. The command is passed as a
# SINGLE argument so the remote shell runs it verbatim — do NOT add `bash -lc`
# here: ssh already invokes the login shell with the joined args, and an extra
# `bash -lc "$1"` makes the remote shell re-split the string (so e.g.
# `docker --format '{{.X}}'` would run as bare `docker`).
#
# GB10_LOCAL=1 — run the command on THIS box instead of over SSH. Set this when a
# driver runs ON the box itself (e.g. the swap-ui backend), so every helper below
# (wait_health, gb10_wait_gpu_idle, container checks) operates against local
# docker/nvidia-smi with no SSH hop. `bash -c "$1"` is correct here (unlike the
# ssh path) because we intentionally run the single string through one shell.
gb10_ssh() {
  if [ "${GB10_LOCAL:-0}" = 1 ]; then
    bash -c "$1"
  else
    ssh -o BatchMode=yes "${GB10_SSH}" "$1"
  fi
}

# Copy a local file to the box (e.g. an --env-file or args file for a job).
gb10_put() { scp -q "$1" "${GB10_SSH}:$2"; }

# Pull a directory from the box to token (artifacts after a train job).
gb10_pull() { rsync -a "${GB10_SSH}:$1/" "$2/"; }

# Resolve the digest of an image as docker sees it on the box (for DB provenance).
gb10_image_digest() {
  gb10_ssh "docker inspect --format '{{index .RepoDigests 0}}' '$1' 2>/dev/null || echo ''"
}

# True if a named container exists on the box (any state).
gb10_container_exists() {
  [ -n "$(gb10_ssh "docker ps -aq -f name=^$1\$")" ]
}
# True if a named container is currently running.
gb10_container_running() {
  [ -n "$(gb10_ssh "docker ps -q -f name=^$1\$")" ]
}

# Read a docker label off a container. Empty string if the container or label doesn't exist —
# `|| true` on the remote side keeps a missing container from aborting the caller under set -e; a
# container that predates a given label (e.g. any container created before gb10.recipe-hash was
# introduced) resolves the Go-template map index to Go's zero value, also empty, so "no label yet"
# and "no container yet" are indistinguishable — both correctly read as "unknown, don't trust it".
gb10_container_label() {  # <container> <label-key>
  gb10_ssh "docker inspect --format '{{index .Config.Labels \"$2\"}}' '$1' 2>/dev/null || true"
}

# Poll an HTTP health endpoint (from the box's own network) until 200 or timeout. If a container
# name is given, ALSO fail fast (return 2) the moment that container is no longer running — a model
# that crashes on startup (bad recipe, unsupported arch) exits its container in seconds, so there's
# no point waiting out the full timeout. Lets the swapper surface a broken load immediately.
#
# Also surfaces first-boot download/load progress: a first-time model needs its weights pulled
# (huggingface_hub tqdm bars to stderr) and then loaded onto the GPU (vLLM's own "Loading
# safetensors checkpoint shards" tqdm bar) before /health goes green — both minutes-long with zero
# externally visible signal otherwise. Every poll, tail the container's own docker logs for the
# latest tqdm-style line ('...%|...' is tqdm's universal signature, matches both) and echo it as
# `PROGRESS <text>` — the swap-ui backend (_run_swap in app.py) parses that prefix into JOB just
# like PHASE/RESULT, so the frontend can show live progress instead of a blank spinner. Deduped
# against the last-seen line so unchanged output between polls doesn't spam the job log.
wait_health() {  # <url> <timeout_s> [container]
  local url="$1" timeout="${2:-600}" container="${3:-}" waited=0 last_progress="" cur
  echo "waiting for ${url} (timeout ${timeout}s) ..."
  while [ "$waited" -lt "$timeout" ]; do
    if gb10_ssh "curl -fsS -o /dev/null '${url}'" 2>/dev/null; then
      echo "healthy after ${waited}s"; return 0
    fi
    if [ -n "$container" ] && ! gb10_container_running "$container"; then
      echo "ERROR: container ${container} exited before becoming healthy (startup crash)" >&2; return 2
    fi
    if [ -n "$container" ]; then
      cur="$(gb10_ssh "docker logs --tail 20 '${container}' 2>&1 | grep -o '.*%|.*' | tail -1" 2>/dev/null || true)"
      if [ -n "$cur" ] && [ "$cur" != "$last_progress" ]; then
        echo "PROGRESS ${cur}"
        last_progress="$cur"
      fi
    fi
    sleep 5; waited=$((waited+5))
  done
  echo "ERROR: ${url} not healthy after ${timeout}s" >&2; return 1
}

# Stop (do NOT remove) a container so it persists for next session.
gb10_stop() { gb10_ssh "docker stop '$1' >/dev/null 2>&1 || true"; }

# Wait until the GB10 GPU is responsive with no lingering compute processes.
# CRITICAL on this box: it has ONE GPU, and that GPU is necessarily the system's primary GPU (no
# secondary GPU to hand console/display duty to), so `nvidia-smi -r` refuses to reset it — this is a
# general nvidia-smi restriction on primary GPUs, not something specific to the GB10 or to
# integrated GPUs. An abrupt CUDA teardown can wedge it into ERR! state, and reloading kernel
# modules doesn't recover it; only a reboot clears it. So after stopping a GPU container, always
# drain before the next container grabs the device: confirm the GPU still enumerates (name, not
# ERR!) and no compute apps remain. If this times out, the GPU is likely wedged — STOP and reboot
# rather than starting another GPU job (which would fail container init with `gpu requires reset`).
gb10_wait_gpu_idle() {  # <timeout_s>
  local timeout="${1:-120}" waited=0 name apps
  echo "draining GPU (timeout ${timeout}s) ..."
  while [ "$waited" -lt "$timeout" ]; do
    name=$(gb10_ssh "nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null" || echo ERR)
    apps=$(gb10_ssh "nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null | grep -c . || true")
    case "$name" in
      *ERR*|"") : ;;                                  # not responsive yet
      *) [ "${apps:-0}" -eq 0 ] && { echo "GPU idle after ${waited}s (${name})"; return 0; } ;;
    esac
    sleep 3; waited=$((waited+3))
  done
  echo "ERROR: GPU not idle/healthy after ${timeout}s — it may be wedged (sole/primary GPU; needs reboot)." >&2
  return 1
}
