#!/usr/bin/env bash
# Operator job: database + attachments + recovery configuration, encrypted before leaving RAM.
set -euo pipefail
umask 077
config=/etc/opendiscord-backup/rclone.conf
recipient=/etc/opendiscord-backup/age-recipient
state=/var/backups/opendiscord
remote=opendiscord-backup:opendiscord-backups-private
: "${OPENDISCORD_DB_CONTAINER:?Set the deployed database container}"
: "${OPENDISCORD_WEB_CONTAINER:?Set the deployed web container}"
: "${OPENDISCORD_COMPOSE_DIR:?Set the deployed app checkout}"
: "${OPENDISCORD_VOICE_COMPOSE_DIR:?Set the deployed voice checkout}"
exec 9>"$state/backup.lock"
flock -n 9 || exit 1
test -s "$config" && test -s "$recipient"
work=$(mktemp -d /dev/shm/opendiscord-backup.XXXXXXXX)
trap 'rm -rf "$work"' EXIT
key="daily/$(date -u +%Y-%m-%dT%H-%M-%SZ).tar.gz.age"
mkdir "$work/media" "$work/config"
# Prevent oversized dumps from filling the production host's tmpfs.
db_bytes=$(docker exec "$OPENDISCORD_DB_CONTAINER" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select pg_database_size(current_database())"')
python3 - "$db_bytes" <<'PY'
import shutil,sys
size=int(sys.argv[1]); free=shutil.disk_usage('/dev/shm').free
if size*4 > free or size > 536870912: raise SystemExit('Database exceeds safe in-memory backup budget')
PY
docker exec "$OPENDISCORD_DB_CONTAINER" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --lock-wait-timeout=30s' > "$work/database.dump"
test -s "$work/database.dump"
docker exec -i "$OPENDISCORD_DB_CONTAINER" pg_restore --list < "$work/database.dump" > /dev/null
# Capture object references from this exact dump, not a later mutable database read.
docker exec -i "$OPENDISCORD_DB_CONTAINER" pg_restore --data-only --table=attachment --file=- < "$work/database.dump" > "$work/attachments.sql"
docker inspect "$OPENDISCORD_WEB_CONTAINER" --format '{{json .Config.Env}}' > "$work/web-env.json"
# Capture before the storage helper deletes this private environment snapshot.
python3 "$(dirname "$0")/capture-scanner-recovery.py" "$work"
python3 - "$work" <<'PY'
import json,pathlib,re,sys
p=pathlib.Path(sys.argv[1]);env=dict(s.split('=',1) for s in json.loads((p/'web-env.json').read_text()) if '=' in s)
keys=['R2_ENDPOINT','R2_BUCKET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY']
if not all(env.get(k) for k in keys): raise SystemExit('Attachment storage configuration is incomplete')
if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,62}',env['R2_BUCKET']): raise SystemExit('Invalid storage bucket')
if any('\n' in env[k] or '\r' in env[k] for k in keys): raise SystemExit('Invalid storage configuration')
(p/'media-rclone.conf').write_text('[media]\ntype = s3\nprovider = Other\naccess_key_id = '+env['R2_ACCESS_KEY_ID']+'\nsecret_access_key = '+env['R2_SECRET_ACCESS_KEY']+'\nendpoint = '+env['R2_ENDPOINT']+'\nno_check_bucket = true\n')
(p/'media-source').write_text('media:'+env['R2_BUCKET'])
(p/'web-env.json').unlink()
PY
source=$(cat "$work/media-source")
rclone --config "$work/media-rclone.conf" size "$source" --json > "$work/media-size.json"
python3 - "$work/media-size.json" <<'PY'
import json,shutil,sys
size=json.load(open(sys.argv[1]))['bytes']; free=shutil.disk_usage('/dev/shm').free
if size*3 > free or size > 536870912: raise SystemExit('Media exceeds safe in-memory backup budget')
PY
rclone --config "$work/media-rclone.conf" copy "$source" "$work/media" --quiet
python3 - "$work" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]);data=False;index=None;checked=0
for line in (p/'attachments.sql').read_text().splitlines():
 if line.startswith('COPY ') and 'attachment ' in line:
  columns=line.split('(',1)[1].split(')',1)[0].split(', ');index=columns.index('key');data=True;continue
 if data and line=='\\.': data=False;continue
 if not data:continue
 key=line.split('\t')[index]
 # App-generated storage keys use only this alphabet; do not interpret arbitrary COPY escapes.
 if not re.fullmatch(r'[A-Za-z0-9_./-]+',key):raise SystemExit('Invalid attachment key in archive')
 target=(p/'media'/key).resolve()
 if not target.is_relative_to((p/'media').resolve()) or not target.is_file():raise SystemExit('Referenced attachment missing from backup')
 checked+=1
(p/'manifest.txt').write_text('format=opendiscord-recovery-v1\nattachment_references='+str(checked)+'\n')
PY
# These files contain secrets; they are included only inside the encrypted recovery archive.
cp "$OPENDISCORD_COMPOSE_DIR/.env" "$work/config/app.env"
cp "$OPENDISCORD_COMPOSE_DIR/docker-compose.dokploy.yml" "$work/config/app-compose.yml"
if test -f "$OPENDISCORD_VOICE_COMPOSE_DIR/.env"; then
  cp "$OPENDISCORD_VOICE_COMPOSE_DIR/.env" "$work/config/voice.env"
fi
cp "$OPENDISCORD_VOICE_COMPOSE_DIR/docker-compose.yml" "$work/config/voice-compose.yml"
cp /etc/dokploy/traefik/dynamic/opendiscord.yml "$work/config/traefik.yml"
if test -f /etc/dokploy/traefik/dynamic/opendiscord-turn.yml; then
  cp /etc/dokploy/traefik/dynamic/opendiscord-turn.yml "$work/config/traefik-turn.yml"
fi
cp /etc/nftables.d/dokploy-public-ingress.nft "$work/config/firewall.nft"
# Optional installed scheduling/configuration belongs in the same encrypted recovery bundle.
mkdir "$work/config/voice-maintenance"
for path in /etc/systemd/system/opendiscord-voice-maintenance.service \
  /etc/systemd/system/opendiscord-voice-maintenance.timer \
  /etc/systemd/system/opendiscord-voice-monitor.service \
  /etc/systemd/system/opendiscord-voice-monitor.timer \
  /usr/local/sbin/opendiscord-voice-maintenance \
  /usr/local/sbin/opendiscord-operator-monitor \
  /etc/opendiscord-voice-maintenance/environment \
  /etc/opendiscord-monitor/voice.json \
  /var/lib/opendiscord-voice-maintenance/status.json; do
  if test -f "$path"; then
    cp --parents "$path" "$work/config/voice-maintenance/"
  fi
done
if test -f "$OPENDISCORD_COMPOSE_DIR/ops/voice-maintenance/compose.yml"; then
  cp "$OPENDISCORD_COMPOSE_DIR/ops/voice-maintenance/compose.yml" "$work/config/voice-maintenance/compose.yml"
fi
# Stream tar directly to age: there is no unencrypted archive on persistent disk.
tar -C "$work" -czf - database.dump media config manifest.txt | age -R "$recipient" -o "$work/recovery.tar.gz.age"
bytes=$(stat -c %s "$work/recovery.tar.gz.age")
rclone --config "$config" size "$remote" --json > "$work/backup-size.json"
python3 - "$work/backup-size.json" "$bytes" <<'PY'
import json,sys
if json.load(open(sys.argv[1]))['bytes']+int(sys.argv[2])>1073741824:raise SystemExit('1 GiB encrypted backup budget reached')
PY
rclone --config "$config" copyto --immutable "$work/recovery.tar.gz.age" "$remote/$key" --quiet
# Read back the complete encrypted bytes and compare, not just an object listing or ETag.
rclone --config "$config" cat "$remote/$key" | sha256sum > "$work/remote-sha256"
local_hash=$(sha256sum "$work/recovery.tar.gz.age" | cut -d' ' -f1)
remote_hash=$(cut -d' ' -f1 "$work/remote-sha256")
test "$local_hash" = "$remote_hash"
printf '%s\n' "$(date -u +%FT%TZ) $key $bytes $local_hash" > "$state/last-success"
printf 'Encrypted off-host backup verified: %s (%s bytes)\n' "$key" "$bytes"
