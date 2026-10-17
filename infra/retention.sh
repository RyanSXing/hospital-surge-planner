#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose --env-file .env -f infra/compose.yaml run --rm --no-deps api python -m surge_api.manage retention --apply --limit 100
