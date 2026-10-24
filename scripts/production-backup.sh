#!/usr/bin/env bash
# Operator job: database + attachments + recovery configuration into an encrypted, incremental
# restic repository off host. Unchanged media is neither re-downloaded nor re-uploaded.
set -euo pipefail
umask 077
config=/etc/opendiscord-backup/rclone.conf
password=/etc/opendiscord-backup/restic-password
state=/var/backups/opendiscord
# Plaintext media mirror on the root disk (root-only, like the database volume beside it).
mirror=/var/lib/opendiscord-backup/media
export RESTIC_REPOSITORY=rclone:opendiscord-backup:opendiscord-backups-private/restic
export RESTIC_PASSWORD_FILE=$password RCLONE_CONFIG=$config RESTIC_CACHE_DIR=/var/cache/opendiscord-restic
: "${OPENDISCORD_DB_CONTAINER:?Set the deployed database container}"
: "${OPENDISCORD_WEB_CONTAINER:?Set the deployed web container}"
: "${OPENDISCORD_COMPOSE_DIR:?Set the deployed app checkout}"
: "${OPENDISCORD_VOICE_COMPOSE_DIR:?Set the deployed voice checkout}"
exec 9>"$state/backup.lock"
flock -n 9 || exit 1
test -s "$config" && test -s "$password"
restic cat config > /dev/null
# A fixed staging path keeps snapshot paths stable, so restic finds its parent snapshot.
work=/dev/shm/opendiscord-backup
rm -rf "$work"
mkdir -m 700 "$work" "$work/config"
mkdir -p -m 700 "$mirror"
trap 'rm -rf "$work"' EXIT
# Every budget measurement is recorded for the operator monitor (80% warning) before it fails closed.
capacity() { python3 "$(dirname "$0")/backup-capacity.py" "$state/capacity.json" "$@"; }
capacity reset
# Prevent oversized dumps from filling the production host's tmpfs.
db_bytes=$(docker exec "$OPENDISCORD_DB_CONTAINER" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select pg_database_size(current_database())"')
capacity database "$db_bytes"
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
capacity media "$(python3 -c 'import json,sys;print(int(json.load(open(sys.argv[1]))["bytes"]))' "$work/media-size.json")"
# App object keys are immutable. Delete obsolete mirror files before transfers so the
# capacity calculation can credit their space; older restic snapshots retain their bytes.
rclone --config "$work/media-rclone.conf" sync "$source" "$mirror" --delete-before --quiet
rm "$work/media-rclone.conf"
python3 - "$work" "$mirror" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]);mirror=pathlib.Path(sys.argv[2]);data=False;index=None;checked=0;dm_bytes=0
for line in (p/'attachments.sql').read_text().splitlines():
 if line.startswith('COPY ') and 'attachment ' in line:
  columns=line.split('(',1)[1].split(')',1)[0].split(', ');index=columns.index('key');size_index=columns.index('size');dm_index=columns.index('dm_message_id');data=True;continue
 if data and line=='\\.': data=False;continue
 if not data:continue
 fields=line.split('\t');key=fields[index]
 # App-generated storage keys use only this alphabet; do not interpret arbitrary COPY escapes.
 if not re.fullmatch(r'[A-Za-z0-9_./-]+',key):raise SystemExit('Invalid attachment key in archive')
 target=(mirror/key).resolve()
 if not target.is_relative_to(mirror.resolve()) or not target.is_file():raise SystemExit('Referenced attachment missing from backup')
 checked+=1
 if fields[dm_index]!='\\N':
  if not fields[size_index].isdigit():raise SystemExit('Invalid attachment size in archive')
  dm_bytes+=int(fields[size_index])
(p/'manifest.txt').write_text('format=opendiscord-recovery-v2\nattachment_references='+str(checked)+'\ndm_ciphertext_bytes='+str(dm_bytes)+'\n')
(p/'dm-bytes').write_text(str(dm_bytes))
PY
capacity dm_ciphertext "$(cat "$work/dm-bytes")"
rm "$work/dm-bytes"
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
# Stage the same media path into every snapshot; restic deduplicates and encrypts client-side.
restic backup --host opendiscord --tag daily --compression max --json \
  "$work/database.dump" "$work/manifest.txt" "$work/config" "$mirror" > "$work/backup.json"
snapshot=$(python3 -c 'import json,sys;print([m for m in map(json.loads,open(sys.argv[1])) if m.get("message_type")=="summary"][0]["snapshot_id"][:8])' "$work/backup.json")
# Read back the database dump and the manifest from the new snapshot, not just a listing.
dump_hash=$(sha256sum "$work/database.dump" | cut -d' ' -f1)
test "$(restic dump "$snapshot" "$work/database.dump" | sha256sum | cut -d' ' -f1)" = "$dump_hash"
cmp <(restic dump "$snapshot" "$work/manifest.txt") "$work/manifest.txt"
restic forget --host opendiscord --tag daily --keep-daily 30 --prune --quiet
# Rotating 1/30 of pack data each day reads the whole repository about once a month.
restic check --read-data-subset="$(( $(date -u +%-j) % 30 + 1 ))/30" --quiet
bytes=$(restic stats --mode raw-data --json | python3 -c 'import json,sys;print(int(json.load(sys.stdin)["total_size"]))')
capacity repository "$bytes"
printf '%s\n' "$(date -u +%FT%TZ) restic:$snapshot $bytes $dump_hash" > "$state/last-success"
printf 'Encrypted off-host restic snapshot verified: %s (repository %s bytes)\n' "$snapshot" "$bytes"
