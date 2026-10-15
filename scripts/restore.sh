#!/bin/sh
# Restores a backup made by scripts/backup.sh into the compose project's database,
# replacing its current contents. Stop the web service first so nobody writes meanwhile:
#
#   docker compose stop web
#   scripts/restore.sh backups/opendiscord-20260101T000000Z.dump
#   docker compose up -d
#
# The migrate service runs on start and applies any migrations newer than the backup.
set -eu

file="${1:?usage: scripts/restore.sh <backup-file>}"
[ -f "$file" ] || { echo "No such file: $file" >&2; exit 1; }
printf 'This replaces ALL data in the current database with %s. Type "restore" to continue: ' "$file"
read -r answer
[ "$answer" = "restore" ] || { echo "Aborted."; exit 1; }

docker compose exec -T db psql -U opendiscord -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS opendiscord WITH (FORCE)" -c "CREATE DATABASE opendiscord OWNER opendiscord"
docker compose exec -T db pg_restore -U opendiscord -d opendiscord --no-owner --exit-on-error <"$file"
echo "Restored $file"
