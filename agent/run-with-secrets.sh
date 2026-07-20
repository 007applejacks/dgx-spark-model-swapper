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
