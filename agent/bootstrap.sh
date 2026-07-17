#!/usr/bin/env bash
# bootstrap.sh — create the gb10-agent venv, run AS the sandboxed agent user under its own home.
# The daemon is jailed to that home dir (no sudo/docker), so its venv lives there too — NOT in the
# main repo clone. Deploy copies this dir into ~/agent for that user, then runs this:
#   sudo -u gb10-agent -H bash ~gb10-agent/agent/bootstrap.sh
#
# AGENT_USER must match systemd's User= for gb10-agent.service (default: gb10-agent).
AGENT_USER="${AGENT_USER:-gb10-agent}"
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
if [ "$(id -un)" != "$AGENT_USER" ]; then
  echo "refusing to run as $(id -un) — run as the ${AGENT_USER} user: sudo -u ${AGENT_USER} -H bash $0" >&2
  exit 1
fi
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt
echo
echo "venv ready at $HERE/.venv"
echo "run:  ./.venv/bin/python agent.py --host 0.0.0.0 --port 8090"
echo "(or install the systemd unit: systemd/gb10-agent.service)"
