#!/usr/bin/env bash
set -euo pipefail

TS=$(date +%Y%m%d_%H%M%S)
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
else
  COMPOSE_CMD="docker-compose"
fi

$COMPOSE_CMD exec -T postgres pg_dump -U redcliff redcliff > "$OUT_DIR/redcliff_${TS}.sql"
echo "backup saved: $OUT_DIR/redcliff_${TS}.sql"
