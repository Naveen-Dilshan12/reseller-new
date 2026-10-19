#!/usr/bin/env bash
# Restore test. Validated on a scratch database only; NOT yet run against a production backup. A backup is only proven by restoring it.
#
# Usage:  deploy/restore-test.sh /path/to/hexalyte-db-<stamp>.dump
#
# Restores the dump into a NEW scratch database (named restore_test_<stamp>) inside the same PostgreSQL container, prints
# a few sanity counts, then drops ONLY that scratch database. It never touches the live database. Because it creates and
# drops a database on the production server it needs explicit approval; prefer running it against a staging copy.
set -euo pipefail

DUMP="${1:?Usage: restore-test.sh <dump file>}"
[ -r "$DUMP" ] || { echo "Cannot read $DUMP" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -p hexalyte-reseller -f "$HERE/docker-compose.prod.yml" --env-file "$HERE/compose.env")
set -a; . "$HERE/compose.env"; set +a

if [ -r "$DUMP.sha256" ]; then (cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256"); else echo "WARNING: no .sha256 next to the dump" >&2; fi

SCRATCH="restore_test_$(date -u +%Y%m%d%H%M%S)"
case "$SCRATCH" in restore_test_*) ;; *) echo "refusing: unexpected scratch name" >&2; exit 1 ;; esac
[ "$SCRATCH" != "$DB_NAME" ] || { echo "refusing: scratch name equals the live database" >&2; exit 1; }

psql_db() { "${COMPOSE[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" "$@"; }
cleanup() { psql_db -d postgres -c "DROP DATABASE IF EXISTS \"$SCRATCH\"" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Creating scratch database $SCRATCH ..."
psql_db -d postgres -c "CREATE DATABASE \"$SCRATCH\""

echo "Restoring ..."
"${COMPOSE[@]}" exec -T db pg_restore -U "$DB_USER" -d "$SCRATCH" --no-owner --exit-on-error < "$DUMP"

echo "Sanity checks (counts only, no personal data):"
psql_db -d "$SCRATCH" -At -c "SELECT 'tables', count(*) FROM information_schema.tables WHERE table_schema='public'"
psql_db -d "$SCRATCH" -At -c "SELECT 'users', count(*) FROM users"
psql_db -d "$SCRATCH" -At -c "SELECT 'migrations_applied', count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"
psql_db -d "$SCRATCH" -At -c "SELECT 'migrations_failed', count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL"

echo "Restore test finished; dropping scratch database $SCRATCH."
