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
  COMPOSE_FILES+=(-f docker-compose.portraits.yml)
fi

$COMPOSE_CMD "${COMPOSE_FILES[@]}" pull || true
$COMPOSE_CMD "${COMPOSE_FILES[@]}" up -d --build

$COMPOSE_CMD "${COMPOSE_FILES[@]}" ps
