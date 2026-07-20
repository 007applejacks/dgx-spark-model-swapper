# Public installer (install.sh) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single `install.sh` at the repo root that installs/updates the gb10 Model Swapper (swap-ui + orchestration) and the optional `gb10-agent` chat daemon on a fresh DGX Spark box, replacing the two manual README runbooks.

**Architecture:** One bash script (`install.sh`), organized as named phase functions (`check_prereqs`, `collect_config`, `install_swapui`, `install_agent`, `install_model_configs`, `verify_and_summarize`) wired together by a `main()` at the bottom, guarded so the file can also be `source`d for testing individual functions. Runs as the invoking non-root user; shells out to `sudo` only for the specific privileged steps. Config answers persist to a gitignored `.install-config` so re-runs are idempotent updates, not "ask everything again." Three checked-in files it depends on get converted from literal example values to `@@TOKEN@@` placeholders it renders via `sed`.

**Tech Stack:** bash (`set -euo pipefail`), sed, systemd, docker, rsync — no new runtime dependency.

## Global Constraints

- `set -euo pipefail` in every script touched or created — matches `gb10-swap.sh`/`gb10-serve.sh`/`gb10-lib.sh` convention.
- Fail-fast, no rollback: a failed step prints the specific problem + remediation and exits; re-running the script picks up from wherever it left off (idempotency is what makes this safe).
- Never auto-install missing system prerequisites (docker, node, nvidia-container-toolkit) — check and print remediation only.
- Never touch the model-configs clone if it already exists at the expected path (no pull/fetch) — it's the box's system of record and may hold local draft commits.
- Never overwrite `/etc/gb10-swap.env` or `/etc/gb10-agent.env` if they already exist.
- The three systemd-related templates use `@@TOKEN@@` syntax; `install.sh`'s `render_template` must fail loudly if any `@@..@@` survives rendering (never silently ship a half-filled unit file).
- Public audience: every prereq-check failure names the specific missing thing and how to get it, never a bare "error".

---

### Task 1: Convert systemd/boot templates to placeholders

**Files:**
- Modify: `systemd/gb10-swap.service`
- Modify: `systemd/gb10-agent.service`
- Modify: `orchestration/gb10-serve-boot.service`

**Interfaces:**
- Produces: the exact `@@TOKEN@@` names every later task's `render_template` calls must supply:
  - `gb10-swap.service`: `@@SWAP_USER@@`, `@@INSTALL_DIR@@`, `@@SWAP_PORT@@`, `@@VLLM_SERVE_PORT@@`, `@@CONFIGS_REPO@@`
  - `gb10-agent.service`: `@@AGENT_USER@@`, `@@AGENT_HOME@@`, `@@AGENT_PORT@@`, `@@VLLM_SERVE_PORT@@`
  - `gb10-serve-boot.service`: `@@SWAP_USER_HOME@@`

- [ ] **Step 1: Rewrite `systemd/gb10-swap.service`**

Replace the entire file with:

```ini
[Unit]
Description=gb10 Model Swapper — web control plane for one-model-at-a-time vLLM serving
# Runs ON the box, from the deploy clone (adjust WorkingDirectory/ExecStart below to match wherever
# you clone this repo, and User= to whatever account you run it as). Drives local docker/nvidia-smi
# (GB10_LOCAL=1), so it needs docker up. It does NOT require a model to be loaded to start.
#
# The @@-wrapped placeholders below are filled in by ./install.sh — see docs/superpowers/specs/
# 2026-07-20-installer-design.md. Hand-editing this file directly also works; each one is just a
# plain value substitution, nothing installer-specific about the syntax itself.
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=@@SWAP_USER@@
WorkingDirectory=@@INSTALL_DIR@@/swap-ui
Environment=GB10_LOCAL=1
Environment=HOST=0.0.0.0
Environment=PORT=@@SWAP_PORT@@
Environment=SERVE_PORT=@@VLLM_SERVE_PORT@@
Environment=CONFIGS_REPO=@@CONFIGS_REPO@@
# Optional host-local secrets (HF_TOKEN for authenticated / gated / full-speed HF downloads).
# Root-owned, 640, never committed. The leading '-' makes it optional (service starts without it).
EnvironmentFile=-/etc/gb10-swap.env
# Serves the built React dashboard + /api on all interfaces (LAN + tailnet). No auth (trusted network).
ExecStart=@@INSTALL_DIR@@/swap-ui/.venv/bin/python @@INSTALL_DIR@@/swap-ui/app.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

(Previously `ExecStart` hardcoded `--host 0.0.0.0 --port 8080` as CLI args; `swap-ui/app.py` already reads `HOST`/`PORT` env vars as argparse defaults — line `ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))` — so moving them to `Environment=` lines is a pure refactor, not a behavior change when `PORT=8080`.)

- [ ] **Step 2: Rewrite `systemd/gb10-agent.service`**

Replace the entire file with:

```ini
[Unit]
Description=gb10-agent — unprivileged chat/agent tool-execution daemon (jailed to its own home)
Documentation=https://github.com/007applejacks/dgx-spark-model-swapper/tree/main/agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Dedicated sandbox identity: own uid, NO sudo, NOT in the docker group. This is the whole point —
# the chat/agent path (untrusted model output + web-search content) runs here, never as the
# privileged swap-ui account. install.sh creates this user; see agent/README.md for the manual steps.
User=@@AGENT_USER@@
Group=@@AGENT_USER@@
WorkingDirectory=@@AGENT_HOME@@/agent
Environment=HOME=@@AGENT_HOME@@
Environment=HOST=127.0.0.1
Environment=PORT=@@AGENT_PORT@@
Environment=SERVE_PORT=@@VLLM_SERVE_PORT@@
# Fronted by `tailscale serve --set-path /agent`? If tailscale forwards the prefix, uncomment:
# Environment=STRIP_PREFIX=/agent
EnvironmentFile=-/etc/gb10-agent.env
# Loopback only — the daemon is NEVER exposed on the LAN; the tailnet HTTPS path mount (/agent) is
# the sole ingress. The launcher wraps the daemon in `bws run` to resolve secrets at start, when
# a Bitwarden Secrets Manager token is present; otherwise it execs the daemon directly.
ExecStart=@@AGENT_HOME@@/agent/run-with-secrets.sh
Restart=on-failure
RestartSec=5

# --- sandbox / jail (defense in depth on top of the unprivileged user) ---
NoNewPrivileges=yes
# Whole filesystem read-only except the explicit write path below (and private /tmp).
ProtectSystem=strict
ReadWritePaths=@@AGENT_HOME@@
PrivateTmp=yes
ProtectControlGroups=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
# Runs unprivileged and never needs to escalate — drop every capability.
CapabilityBoundingSet=
AmbientCapabilities=
# Only needs IPv4/IPv6 sockets (talk to :SERVE_PORT + outbound internet); deny the exotic families.
RestrictAddressFamilies=AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Rewrite `orchestration/gb10-serve-boot.service`**

Replace the entire file with:

```ini
[Unit]
Description=Restore the box's last-loaded vLLM model after boot (swapper-aware; waits for GPU)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
# Wait up to ~60s for the GPU to be queryable before touching the container, so it doesn't race the driver.
ExecStartPre=/bin/bash -c 'for i in $(seq 1 30); do nvidia-smi -L >/dev/null 2>&1 && break; sleep 2; done'
# Restart whichever model the swap-ui last loaded (state file written by gb10-swap.sh, owned by the
# swap-ui's service user — install.sh fills in @@SWAP_USER_HOME@@ to match User= in gb10-swap.service).
# The container name is swap-vllm-<model-id>. If nothing was recorded yet, do nothing (bay stays empty).
ExecStart=/bin/bash -c 'f=@@SWAP_USER_HOME@@/.config/gb10-swap/last-model; \
  if [ -r "$f" ] && id=$(cat "$f") && [ -n "$id" ]; then \
    echo "restoring last model: $id"; docker restart "swap-vllm-$id"; \
  else echo "no last-model recorded; leaving GPU bay empty"; fi'

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: Verify no template lost a placeholder by accident**

Run:
```bash
grep -c '@@[A-Z_]*@@' systemd/gb10-swap.service systemd/gb10-agent.service orchestration/gb10-serve-boot.service
```
Expected: `gb10-swap.service:5`, `gb10-agent.service:4`, `gb10-serve-boot.service:1` (one line per file, count of `@@..@@` occurrences — `gb10-swap.service` has 5 distinct tokens each appearing once except none repeat; `gb10-agent.service` has `@@AGENT_HOME@@` appearing 3 times + `@@AGENT_USER@@` twice + `@@AGENT_PORT@@` once + `@@VLLM_SERVE_PORT@@` once = 7 — recount carefully with `grep -o '@@[A-Z_]*@@' <file> | sort | uniq -c` instead and confirm every name from the Interfaces list above appears at least once, which is the actual thing that matters):
```bash
for f in systemd/gb10-swap.service systemd/gb10-agent.service orchestration/gb10-serve-boot.service; do
  echo "=== $f ==="; grep -o '@@[A-Z_]*@@' "$f" | sort -u
done
```
Expected output: the exact token sets listed in this task's Interfaces section, one block per file.

- [ ] **Step 5: Commit**

```bash
git add systemd/gb10-swap.service systemd/gb10-agent.service orchestration/gb10-serve-boot.service
git commit -m "installer: convert systemd/boot unit templates to @@TOKEN@@ placeholders"
```

---

### Task 2: `gb10-lib.sh` sources an optional local override file

**Files:**
- Modify: `orchestration/gb10-lib.sh:14-15`

**Interfaces:**
- Produces: `manifests/containers.local.env`, an untracked, optional file that — when present — is sourced immediately after `manifests/containers.env`, so any variable it sets wins for that variable only.

- [ ] **Step 1: Write a test that proves the override does NOT apply yet**

```bash
cd /Users/nathanevans/github/dgx-spark-model-swapper
cat > manifests/containers.local.env <<'EOF'
HF_CACHE_VOL=test-override-value
EOF
bash -c '
  . orchestration/gb10-lib.sh
  echo "HF_CACHE_VOL=$HF_CACHE_VOL"
'
rm manifests/containers.local.env
```

Expected (current code): `HF_CACHE_VOL=tokenai-hf-cache` — the override file is ignored because nothing sources it yet.

- [ ] **Step 2: Add the sourcing block**

In `orchestration/gb10-lib.sh`, replace:

```bash
GB10_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
. "${GB10_DIR}/manifests/containers.env"
```

with:

```bash
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
```

- [ ] **Step 3: Re-run the test from Step 1 and confirm the override now applies**

```bash
cd /Users/nathanevans/github/dgx-spark-model-swapper
cat > manifests/containers.local.env <<'EOF'
HF_CACHE_VOL=test-override-value
EOF
bash -c '
  . orchestration/gb10-lib.sh
  echo "HF_CACHE_VOL=$HF_CACHE_VOL"
'
rm manifests/containers.local.env
```

Expected: `HF_CACHE_VOL=test-override-value`

- [ ] **Step 4: Confirm absence still falls through cleanly**

```bash
bash -c '
  . orchestration/gb10-lib.sh
  echo "HF_CACHE_VOL=$HF_CACHE_VOL"
'
```

Expected: `HF_CACHE_VOL=tokenai-hf-cache` (the file doesn't exist right now — `manifests/containers.local.env` was removed in Step 3 — so this proves the `[ -r ... ]` guard doesn't error when the file is absent).

- [ ] **Step 5: Commit**

```bash
git add orchestration/gb10-lib.sh
git commit -m "orchestration: source an optional containers.local.env override after containers.env"
```

---

### Task 3: `run-with-secrets.sh` — make BWS optional, drop hardcoded host/port

**Files:**
- Modify: `agent/run-with-secrets.sh`

**Interfaces:**
- Consumes: `HOME` (to locate `~/.config/bws/access-token`), `HOST`/`PORT`/`SERVE_PORT` (set by `gb10-agent.service`'s `Environment=` lines per Task 1 — `agent.py` already reads these via `os.environ.get(...)` argparse defaults).
- Produces: no change to the daemon's external behavior when a BWS token is present; when absent, execs the daemon directly with no secrets wrapper.

- [ ] **Step 1: Write a test harness proving today's behavior requires BWS unconditionally**

```bash
cd /Users/nathanevans/github/dgx-spark-model-swapper
mkdir -p /tmp/rws-test/home/.local/bin /tmp/rws-test/agentdir
cat > /tmp/rws-test/agentdir/.venv_bin_python <<'EOF'
#!/usr/bin/env bash
echo "AGENT_STUB_RAN args=[$*]"
EOF
mkdir -p /tmp/rws-test/agentdir/.venv/bin
mv /tmp/rws-test/agentdir/.venv_bin_python /tmp/rws-test/agentdir/.venv/bin/python
chmod +x /tmp/rws-test/agentdir/.venv/bin/python
cat > /tmp/rws-test/agentdir/agent.py <<'EOF'
# unused placeholder — run-with-secrets.sh execs .venv/bin/python "$HERE/agent.py", and our stub
# python just echoes its argv, so this file's content never actually runs.
EOF
cp agent/run-with-secrets.sh /tmp/rws-test/agentdir/run-with-secrets.sh
chmod +x /tmp/rws-test/agentdir/run-with-secrets.sh
HOME=/tmp/rws-test/home /tmp/rws-test/agentdir/run-with-secrets.sh; echo "exit=$?"
```

Expected (current code): fails with something like `cat: /tmp/rws-test/home/.config/bws/access-token: No such file or directory` and a non-zero exit — proving there's no fallback today.

- [ ] **Step 2: Rewrite `agent/run-with-secrets.sh`**

Replace the entire file with:

```bash
#!/usr/bin/env bash
# ExecStart wrapper for gb10-agent.service. If a Bitwarden Secrets Manager access token is present
# (this project's own setup), resolve secrets via `bws run` before execing the daemon — no literal
# token ever on disk. Otherwise (anyone else installing this repo), exec the daemon directly: HOST/
# PORT/SERVE_PORT come from the systemd unit's Environment= lines, not CLI flags, so no secrets
# wrapper is required just to configure it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BWS_TOKEN_FILE="${HOME}/.config/bws/access-token"
if [ -r "$BWS_TOKEN_FILE" ]; then
  export BWS_ACCESS_TOKEN="$(cat "$BWS_TOKEN_FILE")"
  exec "${HOME}/.local/bin/bws" run -- "${HERE}/.venv/bin/python" "${HERE}/agent.py"
else
  exec "${HERE}/.venv/bin/python" "${HERE}/agent.py"
fi
```

- [ ] **Step 3: Re-run the harness from Step 1 — no BWS token present**

```bash
HOME=/tmp/rws-test/home /tmp/rws-test/agentdir/run-with-secrets.sh; echo "exit=$?"
```

Expected: `AGENT_STUB_RAN args=[/tmp/rws-test/agentdir/agent.py]` then `exit=0`.

- [ ] **Step 4: Add a fake BWS token + stub bws binary, prove the bws path still works**

```bash
mkdir -p /tmp/rws-test/home/.config/bws
echo "fake-token" > /tmp/rws-test/home/.config/bws/access-token
cat > /tmp/rws-test/home/.local/bin/bws <<'EOF'
#!/usr/bin/env bash
echo "BWS_STUB_RAN token=$BWS_ACCESS_TOKEN"
shift  # drop "run"
[ "$1" = "--" ] && shift
exec "$@"
EOF
chmod +x /tmp/rws-test/home/.local/bin/bws
HOME=/tmp/rws-test/home /tmp/rws-test/agentdir/run-with-secrets.sh; echo "exit=$?"
```

Expected: `BWS_STUB_RAN token=fake-token` then `AGENT_STUB_RAN args=[/tmp/rws-test/agentdir/agent.py]` then `exit=0` — proving the existing-token path is unchanged.

- [ ] **Step 5: Clean up the test harness**

```bash
rm -rf /tmp/rws-test
```

- [ ] **Step 6: Commit**

```bash
git add agent/run-with-secrets.sh
git commit -m "agent: make run-with-secrets.sh fall back to a direct exec when no BWS token is present"
```

---

### Task 4: `install.sh` — helpers + prereq check

**Files:**
- Create: `install.sh` (repo root)

**Interfaces:**
- Produces (for later tasks to call): `log(msg)`, `warn(msg)`, `die(msg)`, `prompt(var_name, question, default)`, `prompt_yn(var_name, question, default_yes_or_no)`, `render_template(template_file, output_file, TOKEN=value...)`, `check_prereqs()` (sets global `NEED_FRONTEND_BUILD` to `0` or `1`).

- [ ] **Step 1: Create `install.sh` with helpers, `render_template`, and `check_prereqs`**

```bash
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
```

- [ ] **Step 2: Make it executable and syntax-check**

```bash
chmod +x install.sh
bash -n install.sh && echo "syntax OK"
```

Expected: `syntax OK`

- [ ] **Step 3: Test `prompt` and `prompt_yn` with scripted stdin**

```bash
cd /Users/nathanevans/github/dgx-spark-model-swapper
bash -c '
  source install.sh
  printf "\n" | { prompt MYVAR "question" "the-default"; echo "MYVAR=$MYVAR"; }
  printf "typed-answer\n" | { prompt MYVAR2 "question" "the-default"; echo "MYVAR2=$MYVAR2"; }
  printf "\n" | { prompt_yn FLAG "install?" "yes"; echo "FLAG=$FLAG"; }
  printf "n\n" | { prompt_yn FLAG2 "install?" "yes"; echo "FLAG2=$FLAG2"; }
'
```

Expected:
```
MYVAR=the-default
MYVAR2=typed-answer
FLAG=yes
FLAG2=no
```

(Sourcing `install.sh` here only defines functions — there is no `main "$@"` call yet in the file at this point in the plan, so sourcing is safe and runs nothing.)

- [ ] **Step 4: Test `render_template`'s success path and its missing-token failure**

```bash
cd /Users/nathanevans/github/dgx-spark-model-swapper
bash -c '
  source install.sh
  printf "User=@@FOO@@\nPath=@@BAR@@\n" > /tmp/tmpl.txt
  render_template /tmp/tmpl.txt /tmp/out.txt "FOO=alice" "BAR=/home/alice"
  cat /tmp/out.txt
'
```

Expected:
```
User=alice
Path=/home/alice
```

Then the failure path (missing `BAR`):

```bash
bash -c '
  source install.sh
  printf "User=@@FOO@@\nPath=@@BAR@@\n" > /tmp/tmpl.txt
  render_template /tmp/tmpl.txt /tmp/out.txt "FOO=alice"
'; echo "exit=$?"
```

Expected: prints `ERROR: template /tmp/tmpl.txt still has unfilled @@..@@ placeholders...` mentioning `@@BAR@@`, then `exit=1`.

- [ ] **Step 5: Clean up temp files and commit**

```bash
rm -f /tmp/tmpl.txt /tmp/out.txt
git add install.sh
git commit -m "installer: add install.sh with prompt/render_template helpers and check_prereqs"
```

---

### Task 5: `install.sh` — config collection + local containers override

**Files:**
- Modify: `install.sh` (append)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `HERE`, `log`, `prompt`, `prompt_yn` from Task 4.
- Produces: `load_config()`, `save_config()`, `collect_config()` (sets globals `SWAP_USER`, `INSTALL_DIR`, `SWAP_PORT`, `VLLM_SERVE_PORT`, `INSTALL_AGENT`, `AGENT_USER`, `AGENT_PORT`, `CONFIGS_REPO_URL`, `HF_TOKEN`), `write_containers_local_env()` (consumes global `OUT_DIR_HOST_DEST`).

- [ ] **Step 1: Add `.install-config` and `manifests/containers.local.env` to `.gitignore`**

Append to `.gitignore`:
```
.install-config
/manifests/containers.local.env
```

- [ ] **Step 2: Append `load_config`, `save_config`, `collect_config`, `write_containers_local_env` to `install.sh`**

```bash

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
```

- [ ] **Step 3: Syntax-check**

```bash
bash -n install.sh && echo "syntax OK"
```

Expected: `syntax OK`

- [ ] **Step 4: Test `collect_config` writes and reloads correctly**

```bash
cd /Users/nathanevans/github/dgx-spark-model-swapper
bash -c '
  source install.sh
  CONFIG_FILE=/tmp/test-install-config
  printf "testuser\n/tmp/testdir\n9080\n9002\nno\n\n\n" | collect_config
  cat "$CONFIG_FILE"
'
```

Expected `.install-config` content:
```
SWAP_USER="testuser"
INSTALL_DIR="/tmp/testdir"
SWAP_PORT="9080"
VLLM_SERVE_PORT="9002"
INSTALL_AGENT="no"
AGENT_USER=""
AGENT_PORT=""
CONFIGS_REPO_URL=""
```

(Seven lines of input map to exactly seven `read` calls in this path: `SWAP_USER`, `INSTALL_DIR`,
`SWAP_PORT`, `VLLM_SERVE_PORT`, the `INSTALL_AGENT` yes/no prompt — answering "no" here skips the
`AGENT_USER`/`AGENT_PORT` sub-prompts entirely, consuming no input for them — then
`CONFIGS_REPO_URL`, then `HF_TOKEN`. The `HF_TOKEN` prompt fires because `/etc/gb10-swap.env` does
not exist on the machine running this test.)

- [ ] **Step 5: Test that a second run reads the file back as defaults**

```bash
bash -c '
  source install.sh
  CONFIG_FILE=/tmp/test-install-config
  load_config
  echo "loaded SWAP_USER=$SWAP_USER INSTALL_DIR=$INSTALL_DIR"
  printf "\n\n\n\n\n\n\n" | collect_config
  diff /tmp/test-install-config <(cat <<EOF
SWAP_USER="testuser"
INSTALL_DIR="/tmp/testdir"
SWAP_PORT="9080"
VLLM_SERVE_PORT="9002"
INSTALL_AGENT="no"
AGENT_USER=""
AGENT_PORT=""
CONFIGS_REPO_URL=""
EOF
  ) && echo "IDEMPOTENT: re-run with all-blank input reproduced the same file"
'
rm -f /tmp/test-install-config
```

Expected: `loaded SWAP_USER=testuser INSTALL_DIR=/tmp/testdir` then `IDEMPOTENT: re-run with all-blank input reproduced the same file`.

- [ ] **Step 6: Commit**

```bash
git add install.sh .gitignore
git commit -m "installer: add config collection + containers.local.env writer"
```

---

### Task 6: `install.sh` — `install_swapui`

**Files:**
- Modify: `install.sh` (append)

**Interfaces:**
- Consumes: `SWAP_USER`, `INSTALL_DIR`, `SWAP_PORT`, `VLLM_SERVE_PORT`, `CONFIGS_REPO_DEST`, `HF_TOKEN`, `NEED_FRONTEND_BUILD` (globals from earlier tasks/phases), `render_template`.
- Produces: `install_swapui()`, `render_boot_unit()`.

- [ ] **Step 1: Append `install_swapui` and `render_boot_unit` to `install.sh`**

```bash

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
```

- [ ] **Step 2: Syntax-check**

```bash
bash -n install.sh && echo "syntax OK"
```

Expected: `syntax OK`

- [ ] **Step 3: Test the rendering logic in isolation with a stubbed `sudo`, without touching the real `/etc`**

```bash
cd /Users/nathanevans/github/dgx-spark-model-swapper
mkdir -p /tmp/install-stub-bin
cat > /tmp/install-stub-bin/sudo <<'EOF'
#!/usr/bin/env bash
# records every invocation instead of actually running privileged commands
echo "SUDO_CALL: $*" >> /tmp/sudo-calls.log
case "$1" in
  test) exit 1 ;;      # pretend the unit file doesn't exist yet -> forces the "installing" branch
  cat)  exit 1 ;;       # nothing to cat if it doesn't exist
  *) exit 0 ;;
esac
EOF
chmod +x /tmp/install-stub-bin/sudo
rm -f /tmp/sudo-calls.log
bash -c '
  source install.sh
  SWAP_USER="'"$(whoami)"'"
  INSTALL_DIR="/opt/gb10"
  SWAP_PORT="8080"
  VLLM_SERVE_PORT="8002"
  CONFIGS_REPO_DEST="/opt/gb10-model-configs"
  HF_TOKEN=""
  rendered="/tmp/gb10-swap.service.rendered.test"
  render_template "systemd/gb10-swap.service" "$rendered" \
    "SWAP_USER=${SWAP_USER}" "INSTALL_DIR=${INSTALL_DIR}" "SWAP_PORT=${SWAP_PORT}" \
    "VLLM_SERVE_PORT=${VLLM_SERVE_PORT}" "CONFIGS_REPO=${CONFIGS_REPO_DEST}"
  grep -E "User=|WorkingDirectory=|Environment=PORT|Environment=SERVE_PORT|Environment=CONFIGS_REPO|ExecStart=" "$rendered"
'
```

Expected output shows the real values substituted, e.g.:
```
User=<your-username>
WorkingDirectory=/opt/gb10/swap-ui
Environment=PORT=8080
Environment=SERVE_PORT=8002
Environment=CONFIGS_REPO=/opt/gb10-model-configs
ExecStart=/opt/gb10/swap-ui/.venv/bin/python /opt/gb10/swap-ui/app.py
```

This proves `render_template`'s output is correct for this unit; the `sudo cp`/`systemctl`/`useradd` calls themselves (Steps that genuinely need root + a real systemd + a real GPU) can only be exercised by actually running `install.sh` on the target box — call that out explicitly rather than faking a passing test for something this script can't safely simulate.

- [ ] **Step 4: Clean up and commit**

```bash
rm -f /tmp/gb10-swap.service.rendered.test /tmp/sudo-calls.log
rm -rf /tmp/install-stub-bin
git add install.sh
git commit -m "installer: add install_swapui (venv, frontend build, unit render, env file, boot unit)"
```

---

### Task 7: `install.sh` — `install_agent`

**Files:**
- Modify: `install.sh` (append)

**Interfaces:**
- Consumes: `INSTALL_AGENT`, `AGENT_USER`, `AGENT_PORT`, `VLLM_SERVE_PORT`, `render_template`.
- Produces: `install_agent()`.

- [ ] **Step 1: Append `install_agent` to `install.sh`**

```bash

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
```

- [ ] **Step 2: Syntax-check**

```bash
bash -n install.sh && echo "syntax OK"
```

Expected: `syntax OK`

- [ ] **Step 3: Test the skip path (no root/docker needed)**

```bash
cd /Users/nathanevans/github/dgx-spark-model-swapper
bash -c '
  source install.sh
  INSTALL_AGENT="no"
  install_agent
'
```

Expected: prints `==> Skipping gb10-agent (not requested)` and returns 0, touching nothing else.

- [ ] **Step 4: Test `render_template` for the agent unit produces correct substitutions**

```bash
bash -c '
  source install.sh
  rendered="/tmp/gb10-agent.service.rendered.test"
  render_template "systemd/gb10-agent.service" "$rendered" \
    "AGENT_USER=gb10-agent" "AGENT_HOME=/home/gb10-agent" "AGENT_PORT=8090" "VLLM_SERVE_PORT=8002"
  grep -E "^User=|^Group=|^WorkingDirectory=|Environment=HOME|Environment=PORT|Environment=SERVE_PORT|^ExecStart=|^ReadWritePaths=" "$rendered"
  rm "$rendered"
'
```

Expected:
```
User=gb10-agent
Group=gb10-agent
WorkingDirectory=/home/gb10-agent/agent
Environment=HOME=/home/gb10-agent
Environment=PORT=8090
Environment=SERVE_PORT=8002
ExecStart=/home/gb10-agent/agent/run-with-secrets.sh
ReadWritePaths=/home/gb10-agent
```

As with Task 6, the `useradd`/`rsync`/`systemctl` steps genuinely need root and a real systemd — they're verified by actually running `install.sh` on the target box (called out in the final acceptance step of this plan), not simulated here.

- [ ] **Step 5: Commit**

```bash
git add install.sh
git commit -m "installer: add install_agent (sandboxed user, copy-out deploy, unit render)"
```

---

### Task 8: `install.sh` — model-configs, verify+summary, `main()`, final wiring

**Files:**
- Modify: `install.sh` (append)

**Interfaces:**
- Consumes: everything from Tasks 4-7.
- Produces: `install_model_configs()`, `wait_for_health()`, `verify_and_summarize()`, `main()`, and the executable entrypoint guard.

- [ ] **Step 1: Append the remaining functions and `main()` to `install.sh`**

```bash

install_model_configs() {
  if [ -z "${CONFIGS_REPO_URL:-}" ]; then
    log "No model-configs repo URL given — skipping (the dashboard will show an empty registry until you add one)"
    return 0
  fi
  if [ -d "$CONFIGS_REPO_DEST" ]; then
    log "model-configs already present at ${CONFIGS_REPO_DEST} — leaving it untouched"
    return 0
  fi
  log "Cloning model-configs into ${CONFIGS_REPO_DEST}"
  git clone "$CONFIGS_REPO_URL" "$CONFIGS_REPO_DEST"
}

wait_for_health() {  # <url> <label> [timeout_s]
  local url="$1" label="$2" timeout="${3:-60}" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    curl -fsS -o /dev/null "$url" 2>/dev/null && { log "${label} is healthy (${url})"; return 0; }
    sleep 2; waited=$((waited+2))
  done
  die "${label} did not become healthy at ${url} within ${timeout}s — check: sudo journalctl -u ${label} -n 50"
}

verify_and_summarize() {
  wait_for_health "http://localhost:${SWAP_PORT}/health" "gb10-swap"
  [ "$INSTALL_AGENT" = "yes" ] && wait_for_health "http://localhost:${AGENT_PORT}/health" "gb10-agent"

  echo
  echo "============================================================"
  echo " gb10 Model Swapper is running."
  echo "============================================================"
  echo " Dashboard:  http://localhost:${SWAP_PORT}   (also reachable on your LAN)"
  [ "$INSTALL_AGENT" = "yes" ] && echo " Agent:      http://localhost:${AGENT_PORT}/health"
  echo
  echo " Manual follow-ups (not automated by this installer):"
  echo
  echo " 1. Tailnet HTTPS (optional, needs tailscale already logged into a tailnet):"
  echo "      sudo tailscale serve --bg ${SWAP_PORT}"
  if [ "$INSTALL_AGENT" = "yes" ]; then
    echo "      sudo tailscale serve --bg --set-path /agent http://127.0.0.1:${AGENT_PORT}"
  fi
  echo
  echo " 2. Passwordless reboot button (needed for the dashboard's Reboot action):"
  echo "      echo '${SWAP_USER} ALL=(root) NOPASSWD: /sbin/reboot' | sudo tee /etc/sudoers.d/gb10-swap-reboot"
  echo "      sudo chmod 440 /etc/sudoers.d/gb10-swap-reboot"
  echo
  echo " 3. HuggingFace token (add later for authenticated/full-speed model downloads):"
  echo "      sudo tee /etc/gb10-swap.env <<< 'HF_TOKEN=hf_xxxxxxxx'"
  echo "      sudo systemctl restart gb10-swap"
  echo "============================================================"
}

main() {
  load_config
  check_prereqs
  collect_config
  CONFIGS_REPO_DEST="$(dirname "$INSTALL_DIR")/gb10-model-configs"
  OUT_DIR_HOST_DEST="$(dirname "$INSTALL_DIR")/gb10-out"
  write_containers_local_env
  install_swapui
  install_agent
  install_model_configs
  verify_and_summarize
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
```

- [ ] **Step 2: Syntax-check**

```bash
bash -n install.sh && echo "syntax OK"
```

Expected: `syntax OK`

- [ ] **Step 3: Confirm the sourcing guard works — sourcing the finished file must NOT run `main`**

```bash
cd /Users/nathanevans/github/dgx-spark-model-swapper
bash -c '
  source install.sh
  echo "sourced without running main — no prompts appeared above this line"
  type main >/dev/null 2>&1 && echo "main is defined and callable"
'
```

Expected: both lines print, with no interactive prompts having appeared (proving `main "$@"` did not fire on source).

- [ ] **Step 4: Confirm `CONFIGS_REPO_DEST` / `OUT_DIR_HOST_DEST` derivation is correct**

```bash
bash -c '
  source install.sh
  INSTALL_DIR="/home/alice/github/dgx-spark-model-swapper"
  CONFIGS_REPO_DEST="$(dirname "$INSTALL_DIR")/gb10-model-configs"
  OUT_DIR_HOST_DEST="$(dirname "$INSTALL_DIR")/gb10-out"
  echo "CONFIGS_REPO_DEST=$CONFIGS_REPO_DEST"
  echo "OUT_DIR_HOST_DEST=$OUT_DIR_HOST_DEST"
'
```

Expected:
```
CONFIGS_REPO_DEST=/home/alice/github/gb10-model-configs
OUT_DIR_HOST_DEST=/home/alice/github/gb10-out
```

- [ ] **Step 5: Full end-to-end syntax + shellcheck pass (if shellcheck is available)**

```bash
bash -n install.sh && echo "syntax OK"
command -v shellcheck >/dev/null 2>&1 && shellcheck install.sh || echo "shellcheck not installed — skipping (non-blocking)"
```

Expected: `syntax OK`; shellcheck warnings (if run) should be reviewed but are advisory, not blocking, consistent with the rest of this repo's scripts (none of which are shellcheck-clean by strict default rules — e.g. `gb10-lib.sh` already carries `# shellcheck disable=SC1091` comments rather than being fully clean).

- [ ] **Step 6: Commit**

```bash
git add install.sh
git commit -m "installer: add model-configs clone, health verification, summary, and main() wiring"
```

- [ ] **Step 7: Real acceptance test — run it on an actual DGX Spark box**

This cannot be simulated on a dev machine (needs real root, a real GPU, a real systemd, and should NOT be run against this project's own already-customized gx10 box per the design doc's explicit non-goal). Acceptance is: on a **fresh** DGX Spark (or a disposable VM with docker + GPU passthrough for a partial check), `git clone` the repo, run `./install.sh`, answer the prompts, and confirm the dashboard loads at the printed URL. Track this as a manual follow-up outside this plan — do not mark this task's code complete as equivalent to a real-box run.

---

### Task 9: Remove the now-obsolete recipe-change note; final docs pass

**Files:**
- Modify: `swap-ui/README.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Remove the stale "Notes / follow-ups" limitation**

In `swap-ui/README.md`, delete the section:

```markdown
## Notes / follow-ups

- **Recipe changes**: a model's container is created once then start/stop-ed. If you change a model's
  `*.env` recipe, remove its stale container on the box (`docker rm swap-vllm-<id>`) so the next swap
  recreates it with the new flags.
```

This limitation no longer exists — `gb10-serve.sh`/`gb10-swap.sh` now detect a changed recipe via a
content-hash container label and recreate automatically (fixed earlier in this project's session,
prior to this plan).

- [ ] **Step 2: Verify the section is gone and the file still renders sensibly**

```bash
grep -c "Recipe changes" swap-ui/README.md
```

Expected: `0`

- [ ] **Step 3: Commit**

```bash
git add swap-ui/README.md
git commit -m "docs: remove stale recipe-change workaround note (fixed via recipe-hash container labels)"
```

---

## Self-review notes (from writing this plan)

- **Spec coverage:** every spec section has a task — Task 1 (templating), Task 2 (containers.local.env), Task 3 (bws fix, called out explicitly in spec), Tasks 4-8 (the six phases + main wiring), Task 9 (incidental README fix). The spec's "Config collection" prompts all appear in Task 5's `collect_config`. The spec's "Verification" and "Final summary" sections are both in Task 8's `verify_and_summarize`.
- **Gap found and closed during planning:** the spec didn't specify where the model-configs repo actually clones to, and didn't account for `swap-ui/app.py`'s `CONFIGS_REPO`/`SERVE_PORT`/`PORT`/`HOST` environment variables needing to be wired from the systemd unit for the phase-2 prompts to have any real effect. Both are resolved concretely in Task 1 (added `Environment=` lines + `@@CONFIGS_REPO@@`/`@@SWAP_PORT@@`/`@@VLLM_SERVE_PORT@@` tokens) and Task 8 (`CONFIGS_REPO_DEST`/`OUT_DIR_HOST_DEST` derived deterministically as siblings of `INSTALL_DIR`).
- **Type/name consistency check:** `CONFIGS_REPO_DEST` and `OUT_DIR_HOST_DEST` are computed once in `main()` (Task 8) and consumed by `install_swapui` (Task 6) and `install_model_configs`/`write_containers_local_env` (Tasks 5 and 8) — same names throughout, no drift. `render_template`'s signature (`template, output, TOKEN=value...`) is identical at every call site across Tasks 6-8.
- **No placeholders:** every step above shows complete, runnable code — no "add validation here" gaps.
