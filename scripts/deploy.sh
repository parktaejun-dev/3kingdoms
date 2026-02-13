#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
else
  COMPOSE_CMD="docker-compose"
fi

COMPOSE_FILES=(-f docker-compose.yml)
# Optional portrait generation integration (server-only, mounts sd-cli/models from host).
if [ -f docker-compose.portraits.yml ]; then
  # Enable only when the host mount exists (or explicitly forced).
  if [ "${ENABLE_PORTRAITS:-}" = "1" ] || [ -d "/home/ubuntu/sdcpp" ]; then
    COMPOSE_FILES+=(-f docker-compose.portraits.yml)
  else
    echo "[deploy] skipping docker-compose.portraits.yml (missing /home/ubuntu/sdcpp; set ENABLE_PORTRAITS=1 to force)" >&2
  fi
fi

$COMPOSE_CMD "${COMPOSE_FILES[@]}" pull || true
$COMPOSE_CMD "${COMPOSE_FILES[@]}" up -d --build

$COMPOSE_CMD "${COMPOSE_FILES[@]}" ps
