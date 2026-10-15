#!/usr/bin/env bash
# A path unit runs this after Dokploy replaces the application's private environment file.
set -euo pipefail
: "${OPENDISCORD_COMPOSE_DIR:?Set the deployed app checkout}"
path="$OPENDISCORD_COMPOSE_DIR/.env"
if test -f "$path" && test "$(stat -c '%a' "$path")" != 600; then
  chmod 600 -- "$path"
fi
