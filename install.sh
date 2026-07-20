#!/usr/bin/env bash
# install.sh — installs/updates the gb10 Model Swapper (swap-ui + orchestration) and, optionally,
# the gb10-agent chat daemon, on this box. Safe to re-run: reads .install-config for previous
# answers and skips steps that are already correctly in place. See
# docs/superpowers/specs/2026-07-20-installer-design.md for the design this implements.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

CONFIG_FILE="${HERE}/.install-config"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

# Read the value of the variable NAMED by $1, or "" if unset — used so `prompt`'s shown default
# prefers an already-loaded .install-config answer over its hardcoded fallback. Deliberately NOT
# `local -n` (nameref): that needs bash >= 4.3, and macOS ships bash 3.2 as /bin/bash — this repo's
# own scripts are dev-tested on a Mac (see gb10-lib.sh etc., all plain bash 3.2-compatible already).
# eval + classic ${var:-} default expansion works unchanged back to bash 3.x.
_indirect() { eval "printf '%s' \"\${$1:-}\""; }

prompt() {  # <var-name> <question> <default>
  local __var="$1" __question="$2" __default="$3" __current __answer
  __current="$(_indirect "$__var")"
  [ -n "$__current" ] || __current="$__default"
  read -r -p "${__question} [${__current}]: " __answer
  printf -v "$__var" '%s' "${__answer:-$__current}"
}

prompt_yn() {  # <var-name> <question> <default: yes|no>
  local __var="$1" __question="$2" __default="$3" __current __answer
  __current="$(_indirect "$__var")"
  [ -n "$__current" ] || __current="$__default"
  read -r -p "${__question} [${__current}]: " __answer
  __answer="${__answer:-$__current}"
  case "$__answer" in
    [Yy]*) printf -v "$__var" '%s' "yes" ;;
    *)     printf -v "$__var" '%s' "no" ;;
  esac
}

_sed_escape() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }

render_template() {  # <template-file> <output-file> <TOKEN1=value1> [TOKEN2=value2 ...]
  local template="$1" output="$2"; shift 2
  local sed_args=() pair token value
  for pair in "$@"; do
    token="${pair%%=*}"
    value="$(_sed_escape "${pair#*=}")"
    sed_args+=(-e "s|@@${token}@@|${value}|g")
  done
  sed "${sed_args[@]}" "$template" > "$output"
  if grep -q '@@[A-Z_]*@@' "$output"; then
    die "template ${template} still has unfilled @@..@@ placeholders in ${output} — a render_template call site is missing a token: $(grep -o '@@[A-Z_]*@@' "$output" | sort -u | tr '\n' ' ')"
  fi
}

NEED_FRONTEND_BUILD=0

check_prereqs() {
  log "Checking prerequisites"
  command -v docker >/dev/null 2>&1 \
    || die "docker not found — install it: https://docs.docker.com/engine/install/"
  docker info >/dev/null 2>&1 \
    || die "docker is installed but not usable by $(whoami) — add yourself to the docker group (sudo usermod -aG docker $(whoami), then log out/in) or start the docker service (sudo systemctl start docker)"
  command -v nvidia-smi >/dev/null 2>&1 \
    || die "nvidia-smi not found — this installer targets an NVIDIA DGX Spark (GB10); the NVIDIA driver should already be present on that hardware"
  nvidia-smi -L >/dev/null 2>&1 \
    || die "nvidia-smi found but reports no GPU — check the driver with 'nvidia-smi'"
  local gpu_smoke_image="nvidia/cuda:12.6.1-base-ubuntu24.04"
  log "Verifying docker can see the GPU (pulling ${gpu_smoke_image} if needed — one-time, ~200MB)..."
  docker run --rm --gpus all "$gpu_smoke_image" nvidia-smi -L >/dev/null 2>&1 \
    || die "docker can't see the GPU via --gpus all. Install nvidia-container-toolkit and restart docker: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
  command -v python3 >/dev/null 2>&1 \
    || die "python3 not found — install it (e.g. sudo apt install python3)"
  python3 -c "import venv" 2>/dev/null \
    || die "python3's venv module is missing — install it (e.g. sudo apt install python3-venv)"

  if [ ! -d "${HERE}/swap-ui/frontend/dist" ]; then
    NEED_FRONTEND_BUILD=1
  elif [ -n "$(find "${HERE}/swap-ui/frontend/src" -newer "${HERE}/swap-ui/frontend/dist" -type f 2>/dev/null | head -1)" ]; then
    NEED_FRONTEND_BUILD=1
  fi
  if [ "$NEED_FRONTEND_BUILD" = 1 ]; then
    command -v node >/dev/null 2>&1 || die "node not found, but the frontend needs building (swap-ui/frontend/dist is missing or stale) — install Node.js: https://nodejs.org/en/download"
    command -v npm >/dev/null 2>&1 || die "npm not found, but the frontend needs building — install Node.js (includes npm): https://nodejs.org/en/download"
  fi

  log "Prerequisites OK"
}
