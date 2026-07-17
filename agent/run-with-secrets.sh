#!/usr/bin/env bash
# ExecStart wrapper for gb10-agent.service. Resolves secrets from Bitwarden Secrets Manager at
# launch (no literal token ever on disk, per the repo secrets rule), then execs the daemon.
#
# BWS_ACCESS_TOKEN comes from the gx10 user's machine access-token file (mode 600, never committed).
# `bws run` injects every secret the machine account can read as env vars (none required today —
# the HA integration was removed 2026-07-12; the wrapper stays for future tools that need secrets).
set -euo pipefail
export BWS_ACCESS_TOKEN="$(cat /home/gx10/.config/bws/access-token)"
exec /home/gx10/.local/bin/bws run -- \
  /home/gx10/agent/.venv/bin/python /home/gx10/agent/agent.py --host 127.0.0.1 --port 8090
