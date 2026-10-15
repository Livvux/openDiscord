#!/usr/bin/env bash
# Linux operator job. Always use the already-built release image and a recent verified backup.
set -euo pipefail
: "${OPENDISCORD_COMPOSE_DIR:?Set the deployed app checkout}"
: "${OPENDISCORD_COMPOSE_PROJECT:?Set the deployed Compose project}"
exec 9>/var/backups/opendiscord/maintenance.lock
flock -n 9 || exit 0
python3 - <<'PY'
import datetime,pathlib,time
stamp=pathlib.Path('/var/backups/opendiscord/last-success').read_text().split()[0]
age=time.time()-datetime.datetime.fromisoformat(stamp.replace('Z','+00:00')).timestamp()
if age < -300 or age > 30*3600:raise SystemExit('Maintenance blocked: recent verified backup required')
PY
cd "$OPENDISCORD_COMPOSE_DIR"
docker image inspect "${OPENDISCORD_COMPOSE_PROJECT}-migrate" >/dev/null
# Refuse overlapping/orphaned jobs from this project without deleting them.
if test -n "$(docker ps -aq --filter "label=opendiscord.maintenance.project=$OPENDISCORD_COMPOSE_PROJECT")"; then
  echo 'Maintenance blocked: a previous project maintenance container still exists' >&2
  exit 1
fi
run_id=$(cat /proc/sys/kernel/random/uuid)
job_name="${OPENDISCORD_COMPOSE_PROJECT}-maintenance-$run_id"
cleanup() {
  local metadata container_id owner_run
  metadata=$(docker container inspect --format '{{.Id}} {{index .Config.Labels "opendiscord.maintenance.run"}}' "$job_name" 2>/dev/null) || return 0
  read -r container_id owner_run <<< "$metadata"
  if test "$owner_run" = "$run_id"; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
}
# A unique run label and immutable container ID prevent cleanup from touching another job.
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
timeout --kill-after=10s 300s docker compose -p "$OPENDISCORD_COMPOSE_PROJECT" \
  -f docker-compose.dokploy.yml run --name "$job_name" --rm --no-deps --pull never \
  --label "opendiscord.maintenance.project=$OPENDISCORD_COMPOSE_PROJECT" \
  --label "opendiscord.maintenance.run=$run_id" \
  -e 'PGOPTIONS=-c statement_timeout=15000 -c lock_timeout=2000' \
  migrate pnpm --filter web exec tsx scripts/maintenance.ts --apply
