#!/bin/sh
# Writes a complete, portable backup of an openDiscord instance (all communities, channels,
# messages, roles, invites, bans, audit log and accounts) as a compressed PostgreSQL dump.
#
#   scripts/backup.sh [output-file]      default: backups/opendiscord-<UTC timestamp>.dump
#
# Uses the `db` service of the compose project in the current directory. Set COMPOSE_FILE to
# target another compose file (e.g. compose.dev.yaml). The dump contains personal data:
# store it encrypted and delete it according to your retention policy (docs/PRIVACY.md).
set -eu

out="${1:-backups/opendiscord-$(date -u +%Y%m%dT%H%M%SZ).dump}"
mkdir -p "$(dirname "$out")"
umask 077
docker compose exec -T db pg_dump -U opendiscord -d opendiscord --format=custom --no-owner >"$out"
echo "Backup written to $out ($(wc -c <"$out" | tr -d ' ') bytes)"
