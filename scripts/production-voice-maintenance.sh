#!/usr/bin/env bash
# Bounded leased-Voice repair, independent of destructive retention's backup gate.
set -euo pipefail
umask 077
: "${OPENDISCORD_COMPOSE_DIR:?Set the deployed app checkout}"
: "${OPENDISCORD_COMPOSE_PROJECT:?Set the deployed Compose project}"
state=${STATE_DIRECTORY:-/var/lib/opendiscord-voice-maintenance}
mkdir -p "$state"
exec 9>"$state/job.lock"
flock -n 9 || exit 0
output=$(mktemp /dev/shm/opendiscord-voice-maintenance.XXXXXXXX)
run_id=$(cat /proc/sys/kernel/random/uuid)
job_name="${OPENDISCORD_COMPOSE_PROJECT}-voice-maintenance-$run_id"
result=1
finish() {
  local metadata container_id owner_run
  # Resolve the unique name, verify this run, then remove by immutable ID only.
  metadata=$(timeout 5s docker container inspect --format '{{.Id}} {{index .Config.Labels "opendiscord.voice-maintenance.run"}}' "$job_name" 2>/dev/null) || metadata=''
  if test -n "$metadata"; then
    read -r container_id owner_run <<< "$metadata"
    if test "$owner_run" = "$run_id"; then
      timeout --kill-after=2s 10s docker rm -f "$container_id" >/dev/null 2>&1 || result=1
    else
      result=1
    fi
  fi
  python3 - "$state/status.json" "$output" "$result" <<'PY' || result=1
import json,os,pathlib,sys,time
path,output=map(pathlib.Path,sys.argv[1:3]);code=int(sys.argv[3])
try: previous=json.loads(path.read_text())
except (OSError,ValueError): previous={}
try:
 data=json.loads(output.read_text());rooms=data['rooms']
 names=('claimed','requests','retired','deleted','failed','unavailable')
 if data['apply'] is not True or not all(type(data[k]) is int and data[k]>=0 for k in ('scanned','closed','removed')):raise ValueError()
 if not all(type(rooms[k]) is int and rooms[k]>=0 for k in names):raise ValueError()
 if type(data['limited']) is not bool or type(rooms['limited']) is not bool:raise ValueError()
 limited=data['limited'] or rooms['limited'];sdk_failed=bool(rooms['failed'] or rooms['unavailable'])
 code=1 if sdk_failed else code
except (OSError,ValueError,KeyError,TypeError):
 limited=False;sdk_failed=False;code=1
status={'finished_at':time.time(),'ok':code==0,
 'limited_streak':previous.get('limited_streak',0)+1 if limited else 0,
 'sdk_failure_streak':previous.get('sdk_failure_streak',0)+1 if sdk_failed else 0}
temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(status));temporary.replace(path)
sys.exit(0 if code==0 else 1)
PY
  rm -f "$output"
  if test "$result" != 0; then echo 'Voice maintenance failed; inspect private status and service state' >&2; fi
  trap - EXIT
  exit "$result"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
cd "$OPENDISCORD_COMPOSE_DIR"
timeout 5s docker image inspect "${OPENDISCORD_COMPOSE_PROJECT}-migrate" >/dev/null 2>&1
# Preserve orphaned jobs for investigation; never delete another invocation.
previous=$(timeout 5s docker ps -aq --filter "label=opendiscord.voice-maintenance.project=$OPENDISCORD_COMPOSE_PROJECT")
if test -n "$previous"; then
  echo 'Voice maintenance blocked: a previous project Voice job still exists' >&2
  exit 1
fi
set +e
timeout --kill-after=5s 60s docker compose -p "$OPENDISCORD_COMPOSE_PROJECT" \
  -f docker-compose.dokploy.yml -f ops/voice-maintenance/compose.yml \
  run --name "$job_name" --rm --no-deps --pull never \
  --label "opendiscord.voice-maintenance.project=$OPENDISCORD_COMPOSE_PROJECT" \
  --label "opendiscord.voice-maintenance.run=$run_id" \
  -e 'PGOPTIONS=-c statement_timeout=15000 -c lock_timeout=2000' \
  migrate pnpm --filter web exec tsx scripts/voice-maintenance.ts --apply >"$output" 2>/dev/null
result=$?
set -e
exit "$result"
