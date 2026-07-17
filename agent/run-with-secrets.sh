#!/usr/bin/env bash
# ExecStart wrapper for gb10-agent.service. Resolves secrets from Bitwarden Secrets Manager at
# launch (no literal token ever on disk), then execs the daemon.
#
# BWS_ACCESS_TOKEN comes from the agent user's machine access-token file (mode 600, never
# committed). `bws run` injects every secret the machine account can read as env vars (none
# required by default — the wrapper exists so a future tool can add secrets without touching
# the unit file).
set -euo pipefail
export BWS_ACCESS_TOKEN="$(cat ~/.config/bws/access-token)"
exec ~/.local/bin/bws run -- \
  "$(dirname "$0")/.venv/bin/python" "$(dirname "$0")/agent.py" --host 127.0.0.1 --port 8090
