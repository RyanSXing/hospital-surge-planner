#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
chmod 700 backups
backup_path="backups/hospital-$(date -u +%Y%m%dT%H%M%SZ).dump"
compose=(docker compose --env-file .env -f infra/compose.yaml)
umask 077
"${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_path"
"${compose[@]}" run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD/backups:/backup:ro" api python scripts/upload_backup.py "/backup/$(basename "$backup_path")"
# Remove only this application's successful local backup files older than seven days.
# A bucket lifecycle rule handles the same retention for private cloud backups.
find backups -maxdepth 1 -type f -name 'hospital-*.dump' -mtime +6 -delete
