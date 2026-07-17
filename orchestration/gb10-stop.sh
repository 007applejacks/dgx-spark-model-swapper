#!/usr/bin/env bash
# gb10-stop.sh — power off idle tokenai-* containers on the box WITHOUT removing
# them. They persist (image + pip state + HF cache) and restart fast next session.
# This is the "we don't tear down, we power off" operating model.
#
# Runs ON token.  gb10-stop.sh            # stop all tokenai-* containers
#                 gb10-stop.sh -n <name>  # stop a single container
set -euo pipefail
. "$(dirname "$0")/gb10-lib.sh"

ONE=""
[ "${1:-}" = "-n" ] && ONE="${2:-}"

if [ -n "$ONE" ]; then
  gb10_stop "$ONE"; echo "stopped ${ONE}."
else
  names=$(gb10_ssh "docker ps -q -f name=^tokenai- | xargs -r docker inspect --format '{{.Name}}' | sed 's#^/##'")
  if [ -z "$names" ]; then echo "no running tokenai-* containers."; exit 0; fi
  while IFS= read -r n; do [ -n "$n" ] && { gb10_stop "$n"; echo "stopped ${n}."; }; done <<< "$names"
fi

echo "--- running containers now ---"
gb10_ssh "docker ps --format '  {{.Names}}\t{{.Status}}' | grep tokenai- || echo '  (none running)'"
