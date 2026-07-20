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

load_config() {
  if [ -f "$CONFIG_FILE" ]; then
    log "Loading previous answers from ${CONFIG_FILE}"
    # shellcheck disable=SC1090
    . "$CONFIG_FILE"
  fi
}

save_config() {
  cat > "$CONFIG_FILE" <<EOF
# Written by install.sh — re-run ./install.sh to update, using these as the shown defaults.
SWAP_USER="${SWAP_USER}"
INSTALL_DIR="${INSTALL_DIR}"
SWAP_PORT="${SWAP_PORT}"
VLLM_SERVE_PORT="${VLLM_SERVE_PORT}"
INSTALL_AGENT="${INSTALL_AGENT}"
AGENT_USER="${AGENT_USER:-}"
AGENT_PORT="${AGENT_PORT:-}"
CONFIGS_REPO_URL="${CONFIGS_REPO_URL:-}"
EOF
}

collect_config() {
  log "Configuration (press Enter to accept each default)"
  prompt SWAP_USER       "swap-ui service user"                 "$(whoami)"
  prompt INSTALL_DIR     "install directory (this repo's path)" "$HERE"
  prompt SWAP_PORT       "swap-ui dashboard port"                "8080"
  prompt VLLM_SERVE_PORT "vLLM serve port"                       "8002"

  prompt_yn INSTALL_AGENT "Install the gb10-agent chat daemon too?" "${INSTALL_AGENT:-yes}"
  if [ "$INSTALL_AGENT" = "yes" ]; then
    prompt AGENT_USER "agent sandbox user" "gb10-agent"
    prompt AGENT_PORT "agent daemon port"  "8090"
  fi

  # Default is empty, not a real URL — pressing Enter with nothing typed must mean "skip", so the
  # suggested URL lives in the question text, not as the pre-filled default value.
  prompt CONFIGS_REPO_URL \
    "model-configs git repo to clone (blank to skip; e.g. https://github.com/007applejacks/gb10-model-configs)" \
    "${CONFIGS_REPO_URL:-}"

  if [ ! -f /etc/gb10-swap.env ]; then
    prompt HF_TOKEN "HuggingFace token (optional, blank to skip)" ""
  else
    HF_TOKEN=""
  fi

  save_config
}

write_containers_local_env() {
  mkdir -p "$OUT_DIR_HOST_DEST"
  cat > "${HERE}/manifests/containers.local.env" <<EOF
# Generated by install.sh — local overrides layered onto manifests/containers.env.
# Do not commit (see .gitignore). Re-run ./install.sh to regenerate.
OUT_DIR_HOST=${OUT_DIR_HOST_DEST}
EOF
  log "Wrote manifests/containers.local.env (OUT_DIR_HOST=${OUT_DIR_HOST_DEST})"
}

render_boot_unit() {
  local swap_user_home
  swap_user_home="$(getent passwd "$SWAP_USER" | cut -d: -f6)"
  [ -n "$swap_user_home" ] || die "no such user: $SWAP_USER"
  local rendered="/tmp/gb10-serve-boot.service.rendered.$$"
  render_template "${HERE}/orchestration/gb10-serve-boot.service" "$rendered" \
    "SWAP_USER_HOME=${swap_user_home}"
  if ! sudo test -f /etc/systemd/system/gb10-serve-boot.service \
     || ! cmp -s "$rendered" <(sudo cat /etc/systemd/system/gb10-serve-boot.service 2>/dev/null); then
    log "Installing/updating gb10-serve-boot.service"
    sudo cp "$rendered" /etc/systemd/system/gb10-serve-boot.service
    sudo systemctl daemon-reload
    sudo systemctl enable gb10-serve-boot
  else
    log "gb10-serve-boot.service unchanged"
  fi
  rm -f "$rendered"
}

install_swapui() {
  log "Installing swap-ui"

  if [ ! -d "${HERE}/swap-ui/.venv" ]; then
    log "Creating swap-ui venv"
    (cd "${HERE}/swap-ui" && ./bootstrap.sh)
  else
    log "swap-ui venv already exists — refreshing dependencies"
    "${HERE}/swap-ui/.venv/bin/pip" install --upgrade -r "${HERE}/swap-ui/requirements.txt"
  fi

  if [ "$NEED_FRONTEND_BUILD" = 1 ]; then
    log "Building frontend"
    (cd "${HERE}/swap-ui/frontend" && npm ci && npm run build)
  else
    log "Frontend dist is up to date — skipping build"
  fi

  local swap_user_home
  swap_user_home="$(getent passwd "$SWAP_USER" | cut -d: -f6)"
  [ -n "$swap_user_home" ] || die "no such user: $SWAP_USER (create it first, or re-answer the 'swap-ui service user' prompt)"

  local rendered_unit="/tmp/gb10-swap.service.rendered.$$"
  render_template "${HERE}/systemd/gb10-swap.service" "$rendered_unit" \
    "SWAP_USER=${SWAP_USER}" \
    "INSTALL_DIR=${INSTALL_DIR}" \
    "SWAP_PORT=${SWAP_PORT}" \
    "VLLM_SERVE_PORT=${VLLM_SERVE_PORT}" \
    "CONFIGS_REPO=${CONFIGS_REPO_DEST}"

  if ! sudo test -f /etc/systemd/system/gb10-swap.service \
     || ! cmp -s "$rendered_unit" <(sudo cat /etc/systemd/system/gb10-swap.service 2>/dev/null); then
    log "Installing/updating gb10-swap.service"
    sudo cp "$rendered_unit" /etc/systemd/system/gb10-swap.service
    sudo systemctl daemon-reload
    sudo systemctl enable --now gb10-swap
  else
    log "gb10-swap.service unchanged — leaving the running service alone"
  fi
  rm -f "$rendered_unit"

  if [ ! -f /etc/gb10-swap.env ]; then
    log "Writing /etc/gb10-swap.env"
    if [ -n "${HF_TOKEN:-}" ]; then
      printf 'HF_TOKEN=%s\n' "$HF_TOKEN" | sudo tee /etc/gb10-swap.env >/dev/null
    else
      sudo tee /etc/gb10-swap.env >/dev/null <<'EOF'
# HF_TOKEN=hf_xxxxxxxx
EOF
    fi
    sudo chown root:root /etc/gb10-swap.env
    sudo chmod 640 /etc/gb10-swap.env
  fi

  render_boot_unit
}

install_agent() {
  if [ "$INSTALL_AGENT" != "yes" ]; then
    log "Skipping gb10-agent (not requested)"
    return 0
  fi
  log "Installing gb10-agent"

  if ! id "$AGENT_USER" >/dev/null 2>&1; then
    log "Creating sandboxed user ${AGENT_USER}"
    sudo useradd --create-home --home-dir "/home/${AGENT_USER}" --shell /bin/bash --user-group \
      --comment "agent tool-execution sandbox (no sudo/docker)" "$AGENT_USER"
    sudo passwd -l "$AGENT_USER"
    sudo chmod 750 "/home/${AGENT_USER}"
  else
    log "User ${AGENT_USER} already exists"
  fi

  local agent_home
  agent_home="$(getent passwd "$AGENT_USER" | cut -d: -f6)"

  log "Syncing agent/ into ${agent_home}/agent"
  sudo -u "$AGENT_USER" mkdir -p "${agent_home}/agent"
  sudo rsync -a --delete --chown="${AGENT_USER}:${AGENT_USER}" "${HERE}/agent/" "${agent_home}/agent/"

  if [ ! -d "${agent_home}/agent/.venv" ]; then
    log "Creating gb10-agent venv"
    sudo -u "$AGENT_USER" -H bash "${agent_home}/agent/bootstrap.sh"
  else
    log "gb10-agent venv already exists — refreshing dependencies"
    sudo -u "$AGENT_USER" "${agent_home}/agent/.venv/bin/pip" install --upgrade -r "${agent_home}/agent/requirements.txt"
  fi

  local rendered_unit="/tmp/gb10-agent.service.rendered.$$"
  render_template "${HERE}/systemd/gb10-agent.service" "$rendered_unit" \
    "AGENT_USER=${AGENT_USER}" \
    "AGENT_HOME=${agent_home}" \
    "AGENT_PORT=${AGENT_PORT}" \
    "VLLM_SERVE_PORT=${VLLM_SERVE_PORT}"

  if ! sudo test -f /etc/systemd/system/gb10-agent.service \
     || ! cmp -s "$rendered_unit" <(sudo cat /etc/systemd/system/gb10-agent.service 2>/dev/null); then
    log "Installing/updating gb10-agent.service"
    sudo cp "$rendered_unit" /etc/systemd/system/gb10-agent.service
    sudo systemctl daemon-reload
    sudo systemctl enable --now gb10-agent
  else
    log "gb10-agent.service unchanged — leaving the running service alone"
  fi
  rm -f "$rendered_unit"

  if [ ! -f /etc/gb10-agent.env ]; then
    sudo tee /etc/gb10-agent.env >/dev/null <<'EOF'
# No secrets required by default. Add environment overrides here if a future tool needs them.
EOF
    sudo chown root:root /etc/gb10-agent.env
    sudo chmod 640 /etc/gb10-agent.env
  fi
}
