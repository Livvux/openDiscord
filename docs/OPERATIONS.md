# Operational checks and recovery

## Health probes

`GET /api/health` returns HTTP 200 with `{"status":"ok"}` when the web process can serve a request. It never connects to PostgreSQL. Use it for process liveness; restarting a healthy web process during a database outage does not repair the database.

`GET /api/ready` returns HTTP 200 with `{"status":"ready"}` only after PostgreSQL resolves every table and column in the current application schema. An unavailable, locked or incompletely migrated database returns HTTP 503 with `{"status":"unavailable"}`. No records, connection details, versions or error messages are returned. Both routes execute at request time and send `Cache-Control: no-store`.

Readiness uses a dedicated connection with a one-second connection timeout, one-second PostgreSQL statement timeout and 1.5-second client query timeout. It closes the connection after each attempt and does not retry. Overlapping requests share one in-flight check per process; completed results are not cached. A probe is normally bounded by about 2.5 seconds plus socket cleanup. Give an external monitor five seconds. Probe every 30–60 seconds and alert after repeated failures rather than restarting the process on readiness failures.

Readiness verifies schema accessibility, not every index, constraint, external service or end-user workflow. It does not prove SMTP delivery, object storage, LiveKit/TURN, off-host backup delivery or voice acceptance on physical devices. Monitor those separately and keep their release evidence explicit.

## Backups and restore

The existing `scripts/backup.sh` produces an unencrypted custom-format PostgreSQL dump through the selected Compose project's `db` service. Dumps contain personal data. Restrict file permissions, encrypt before transfer, keep the decryption identity separately, send encrypted archives off host and apply the retention policy in [PRIVACY.md](PRIVACY.md). A database dump does not include object-storage attachments or Compose configuration; back those up separately with their required keys and configuration.

`scripts/restore.sh` is destructive: it drops the selected Compose database after interactive confirmation. Before an actual recovery, identify the intended host and Compose project, stop writers, preserve the current database, decrypt a chosen archive in a restricted temporary location, and rehearse it against an isolated PostgreSQL instance. Check the archive and attachments belong to the same recovery point. Restore only after the isolated checks pass, apply newer migrations, then verify readiness and authenticated application flows before admitting users. Delete temporary plaintext dumps afterwards.

The required CI check runs `apps/web/scripts/verify-restore.mjs` against the disposable PostgreSQL service. It creates randomly named source and target databases, restores the migrated CI database into the source, adds a data sentinel, produces an age-encrypted dump, decrypts and restores it into the target, compares every application and migration table's row count and ordered row digest, and proves a corrupted encrypted archive is rejected. Temporary databases, encryption identity and archive are removed in cleanup. It never invokes the destructive production restore script and refuses non-CI/non-localhost input.

Run this rehearsal through CI. It requires `age`, Docker access to the disposable PostgreSQL service and a database role that can create temporary databases. It validates the encryption and PostgreSQL recovery mechanism with CI data; production backup freshness, off-host delivery, key availability, retention and full attachment recovery still require evidence from the actual operator setup.

## Release evidence

Required automated gates include lint, typecheck, migrations, integration tests, encrypted restore rehearsal, production build and Playwright checks of both public probes on desktop and mobile. Integration tests cover a migrated database, an empty database, a stalled connection and a locked schema, followed by recovery. Keep CI success separate from deployment and external monitoring acceptance.

For an operational handover, record deployment revision, external health/readiness checks, maintenance scheduling and last successful execution, last encrypted off-host backup, alert delivery and an isolated restore date. Do not call scheduling or off-host backup delivery complete solely because the scripts or this document exist.

## Encrypted production recovery bundles

`scripts/production-backup.sh` is a Linux operator job for the Dokploy installation. It captures a
PostgreSQL custom dump, private object-storage media and recovery configuration (including secrets).
Plaintext is held only in a restrictive `/dev/shm` temporary directory, removed on exit, and streamed
through `age` before upload to a dedicated private bucket. The uploader holds only the public age
recipient; the separate recovery identity is in the operator's 1Password vault. Backup credentials
are bucket-scoped and live outside Git in `/etc/opendiscord-backup/rclone.conf` (mode 600).

Set `OPENDISCORD_DB_CONTAINER`, `OPENDISCORD_WEB_CONTAINER`, `OPENDISCORD_COMPOSE_DIR` and
`OPENDISCORD_VOICE_COMPOSE_DIR` to the verified deployed resources. Run only with an outer deadline:
`timeout --kill-after=30s 1800 scripts/production-backup.sh`, or systemd `TimeoutStartSec=1800` and
`KillMode=control-group`. The dump has a 30-second lock-wait timeout. The script checks RAM/storage
budgets, verifies every archived attachment reference exists in the copied media, and compares a full
readback SHA-256 of the encrypted off-host object before updating `/var/backups/opendiscord/last-success`.
A concurrent attachment deletion makes the run fail rather than accepting an incomplete bundle.

The dedicated bucket retains daily recovery bundles for 30 days. The 1 GiB aggregate budget fails
closed and needs an operator capacity review if reached; there is no automatic unlimited growth.
Monitor both failed jobs and backup freshness. A verified ciphertext upload is not yet an isolated
production-data restore; record the recovery rehearsal separately. Never restore a recovery bundle
into the live database as a test. Local-volume attachments require extending this S3-oriented job
before changing the production storage backend.


## Operator alerts

`scripts/operator-monitor.py` runs as a short systemd oneshot, independently of the application.
A monitor on a separate host checks the public HTTPS health/readiness endpoints every minute;
three consecutive failures trigger an operator email. On the production host, a five-minute check
alerts on failed backup jobs or a success marker older than 30 hours. A successful backup marker
is written only after a complete encrypted off-host readback. It does not continuously prove that
the object remains available later. Monitor state suppresses repeat emails for one hour and sends
a recovery email after a notified failure resolves.

The owner-only JSON configuration contains `mode` (`health` or `backup`), `smtp_url`, `from`, and
`to`; the file must belong to the executing user and have no group/other permissions. SMTP uses
verified TLS (implicit TLS for `smtps`, mandatory STARTTLS for `smtp`). Credentials are never
included in check output or exception logs. State is stored in `/var/lib/opendiscord-monitor`.
Run `python3 scripts/operator-monitor.py --config /etc/opendiscord-monitor/config.json --test-mail`
to test SMTP submission. SMTP acceptance proves submission, not inbox delivery. Timer status and
mail delivery should be checked independently; a failure of the monitoring host or SMTP provider
can itself prevent delivery. Use a systemd timeout of 90 seconds and serialize runs with the
script's lock. No alerts contain user/message contents.

### Hosted-instance restore evidence, 2026-10-15

The actual encrypted off-host production backup was decrypted and restored with PostgreSQL 18.6
on a separate host. The temporary service had no network access, a dedicated temporary user,
read-only host filesystems and a Unix socket only. The initial recovery completed with 31 public tables and
23 migrations. After the release deployed, a fresh encrypted backup restored successfully with
34 public tables and 25 migrations. This archive contained zero attachment references; production-media recovery with
existing attachments remains a separate acceptance case. The temporary database, recovery-key
credential, encrypted input copy and temporary user were removed and their absence checked.
This is operational recovery evidence, not a security audit.


### Hosted maintenance lifecycle

`scripts/production-maintenance.sh` serializes hourly maintenance, requires a verified backup younger
than 30 hours and refuses to build or pull a missing release image. Each statement has a 15-second
budget and a 2-second lock budget. The overall CLI deadline is five minutes; the EXIT trap explicitly
removes only the uniquely labelled maintenance container created by that run. Killing a Docker Compose client
alone does not stop its container. The systemd service should allow a 330-second stop budget and a
20-second graceful stop period so cleanup can finish. A pre-existing labelled project job is preserved and
reported as a failure rather than silently removed.

Dokploy recreates this installation's `.env` with broad read permissions during deployment. The
hosted installation uses a path-triggered oneshot running `scripts/secure-dokploy-env.sh` to restore
owner-only access after replacement. It reads only the file mode, never its contents, and does no
work when the mode is already 0600. Keep its path unit scoped to the app's exact `.env`; do not
change the permissions or runtime settings of unrelated deployments.
