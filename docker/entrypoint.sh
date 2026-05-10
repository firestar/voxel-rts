#!/bin/sh
# Boot all three processes and forward signals so `docker stop` shuts
# the container down cleanly. Each backend is a small Node script;
# nginx fronts them and serves the SPA bundle.
set -eu

PIDS=""

shutdown() {
  for pid in $PIDS; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  wait
  exit 0
}
trap shutdown TERM INT

echo "[entrypoint] starting ai-server on :3030"
node /srv/voxel-rts/ai-server.cjs &
PIDS="$PIDS $!"

echo "[entrypoint] starting session-server on :3040"
node /srv/voxel-rts/session-server.cjs &
PIDS="$PIDS $!"

echo "[entrypoint] starting game-server on :3050"
node /srv/voxel-rts/game-server.cjs &
PIDS="$PIDS $!"

echo "[entrypoint] starting nginx on :8080"
nginx -g 'daemon off;' &
PIDS="$PIDS $!"

# Exit if any of them dies — better to crash the container than to
# leave the user with a half-functional system.
wait -n
echo "[entrypoint] one process exited, shutting down" >&2
shutdown
