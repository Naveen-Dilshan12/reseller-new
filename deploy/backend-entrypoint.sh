#!/bin/sh
# Builds DATABASE_URL from the database password SECRET FILE, so the password is not stored in an environment file
# or in the Compose definition. The non-secret parts come from DB_HOST / DB_NAME / DB_USER.
# Used by the backend and by the one-shot tools (migrate, admin-init); then hands over to the real command.
set -eu

SECRET_FILE="${DB_PASSWORD_FILE:-/run/secrets/db_password}"

if [ -r "$SECRET_FILE" ]; then
  : "${DB_USER:?DB_USER is required}" "${DB_NAME:?DB_NAME is required}"
  # The password is generated hex/alphanumeric only (see docs/DEPLOYMENT.md), so it needs no URL-encoding.
  DATABASE_URL="postgresql://${DB_USER}:$(tr -d '\r\n' < "$SECRET_FILE")@${DB_HOST:-db}:5432/${DB_NAME}?schema=public"
  export DATABASE_URL
elif [ -z "${DATABASE_URL:-}" ]; then
  echo "No database password secret at $SECRET_FILE and DATABASE_URL is not set." >&2
  exit 1
fi

exec "$@"
