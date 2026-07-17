#!/usr/bin/env bash
# bootstrap.sh — create the gb10-agent venv, run AS the sandboxed `gx10` user under /home/gx10.
# (`gx10` is a real, already-provisioned OS username — see agent/README.md; not renamed to gb10.)
# The daemon is jailed to /home/gx10 (no sudo/docker), so its venv lives there too — NOT in the
# nathan-owned repo clone. Deploy copies this dir into /home/gx10/agent, then runs this:
#   sudo -u gx10 -H bash /home/gx10/agent/bootstrap.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
if [ "$(id -un)" != "gx10" ]; then
  echo "refusing to run as $(id -un) — run as the gx10 user: sudo -u gx10 -H bash $0" >&2
  exit 1
fi
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt
echo
echo "venv ready at $HERE/.venv"
echo "run:  ./.venv/bin/python agent.py --host 0.0.0.0 --port 8090"
echo "(or install the systemd unit: systemd/gb10-agent.service)"
