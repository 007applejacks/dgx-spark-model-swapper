#!/usr/bin/env bash
# bootstrap.sh — create the backend venv on the box. Run once after cloning/pulling.
#   cd swap-ui && ./bootstrap.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt
echo
echo "venv ready. Run:  ./.venv/bin/python app.py --host 0.0.0.0 --port 8080"
echo "(or install the systemd unit: systemd/gb10-swap.service)"
