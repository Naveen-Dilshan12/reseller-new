#!/usr/bin/env bash
# Backup of the Hexalyte Reseller database (+ uploaded files). Validated on scratch resources only (see docs/PRODUCTION_READINESS.md); NOT installed or run on the VPS.
#
# Usage (on the VPS, only once approved):  BACKUP_DIR=/path/outside/the/repo deploy/backup.sh
#
# What it does: a custom-format pg_dump taken INSIDE the db container (local socket, so no password is handled here),
# checks that the archive can be read back (pg_restore --list), records a SHA-256, and archives the uploads volume.
# What it does NOT do: it never deletes anything unless RETENTION_DAYS is set explicitly (then only files it created, by exact
# name pattern, in BACKUP_DIR). It does not copy anything off the server unless OFFSITE_COMMAND is provided.
# A backup that lives only on this VPS is NOT a disaster-recovery backup.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -p hexalyte-reseller -f "$HERE/docker-compose.prod.yml" --env-file "$HERE/compose.env")
BACKUP_DIR="${BACKUP_DIR:?Set BACKUP_DIR to an existing directory outside the repository}"
[ -d "$BACKUP_DIR" ] || { echo "BACKUP_DIR does not exist: $BACKUP_DIR" >&2; exit 1; }

set -a; . "$HERE/compose.env"; set +a
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$BACKUP_DIR/hexalyte-db-$STAMP.dump"
trap 'rm -f "$DUMP.tmp"' EXIT   # never leave a partial dump behind after a failure
UPLOADS="$BACKUP_DIR/hexalyte-uploads-$STAMP.tar.gz"

echo "[1/4] Dumping database ${DB_NAME} ..."
"${COMPOSE[@]}" exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc --no-owner > "$DUMP.tmp"

echo "[2/4] Verifying the archive can be read back ..."
"${COMPOSE[@]}" exec -T db pg_restore --list < "$DUMP.tmp" > /dev/null
mv "$DUMP.tmp" "$DUMP"
# Relative file name inside the .sha256 file, so it still verifies after the pair is copied off the server.
(cd "$BACKUP_DIR" && sha256sum "$(basename "$DUMP")" > "$(basename "$DUMP").sha256")

echo "[3/4] Archiving the uploads volume (encrypted files; useless without ENCRYPTION_KEY, which is backed up separately) ..."
docker run --rm -v hexalyte_reseller_uploads:/data:ro -v "$BACKUP_DIR":/out alpine \
  tar czf "/out/$(basename "$UPLOADS")" -C /data .

echo "[4/4] Off-server copy ..."
if [ -n "${OFFSITE_COMMAND:-}" ]; then
  # e.g. OFFSITE_COMMAND='rclone copy' ; invoked as: $OFFSITE_COMMAND <file>   (you choose and configure the target)
  for f in "$DUMP" "$DUMP.sha256" "$UPLOADS"; do $OFFSITE_COMMAND "$f"; done
else
  echo "WARNING: OFFSITE_COMMAND is not set. These backups exist ONLY on this server." >&2
fi

if [ -n "${RETENTION_DAYS:-}" ]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'hexalyte-db-*.dump' -o -name 'hexalyte-db-*.dump.sha256' -o -name 'hexalyte-uploads-*.tar.gz' \) \
    -mtime "+$RETENTION_DAYS" -print -delete
fi

echo "Backup complete: $DUMP"
