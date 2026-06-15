#!/usr/bin/env bash
# Tear down the hand-test harness: stop the facilitator process, remove containers.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/harness.env"
PIDFILE="$HERE/facilitator.pid"

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "== stopping facilitator PID $PID =="
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi
# Belt-and-suspenders: kill any tsx still bound to the port.
pkill -f "tsx src/index.ts" 2>/dev/null || true

echo "== removing docker containers =="
docker rm -f "$PG_CONTAINER" "$PUBSUB_CONTAINER" >/dev/null 2>&1 || true
echo "DONE."
