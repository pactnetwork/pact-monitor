#!/usr/bin/env bash
# 04b-stop-stack.sh — kill background processes started by 04-run-stack.sh.
set -euo pipefail
SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SMOKE_DIR/.smoke-state"

for svc in pubsub indexer settler; do
  PIDFILE="$STATE_DIR/$svc.pid"
  if [[ -f "$PIDFILE" ]]; then
    PID=$(cat "$PIDFILE")
    if [[ "$PID" == docker:* ]]; then
      docker rm -f "${PID#docker:}" 2>/dev/null || true
    elif kill -0 "$PID" 2>/dev/null; then
      echo "Stopping $svc (pid $PID)"
      kill -TERM "$PID" 2>/dev/null || true
      sleep 2
      kill -KILL "$PID" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
done

# Belt-and-braces: nuke any leftover containers / processes.
docker rm -f pact-smoke-pubsub 2>/dev/null || true
pkill -f "node.*packages/indexer/dist" 2>/dev/null || true
pkill -f "node.*packages/settler/dist" 2>/dev/null || true

echo "Stack stopped."
