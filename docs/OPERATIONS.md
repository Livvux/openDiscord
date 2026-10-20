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

#### Backup capacity budgets and early warning

The budgets live in `scripts/backup-capacity.py`, a sibling of the backup script like
`capture-scanner-recovery.py`. Each run records every measurement (byte counts and limits, never
content) in `/var/backups/opendiscord/capacity.json` before checking it, so a run that fails at a
budget still leaves the numbers behind:

| Metric | Limit | Enforced |
| --- | --- | --- |
| `database` (`pg_database_size`) | 512 MiB, and at most 1/4 of free `/dev/shm` | yes |
| `media` (whole media bucket) | 512 MiB, and at most 1/3 of free `/dev/shm` | yes |
| `dm_ciphertext` (E2EE DM attachments in this dump, part of `media`) | same as `media` | no, shown separately |
| `encrypted_total` (bucket contents + this bundle) | 1 GiB | yes |
| `retention_projection` (this bundle × 31 retained dailies) | 1 GiB | no, early warning |

Media must sit in RAM because community attachments are plaintext and are copied, checked against
the dump's attachment references and tarred into the age stream without touching disk. E2EE DM
attachments are already ciphertext (up to 4 × 25 MB per message, counted against the existing 500 MB
per-user daily upload quota). They are still copied into each bundle, so the bundle is complete
without depending on another copy. The server never decrypts them. Ciphertext does not compress.
Because every daily bundle holds all media, the aggregate budget reaches a steady state of about
31 × bundle size. One maximum-size DM message (~100 MB) is enough to exhaust 1 GiB within about ten
days. `retention_projection` reports that on the first day.

The `backup` monitor mode reads the record after the job checks. It raises
`backup-capacity-warning` once any metric reaches 80% of its limit (the backups keep succeeding),
`backup-capacity-exceeded` when a failed run had reached an enforced budget, and
`backup-capacity-unavailable` if the record is missing, invalid or older than 30 hours. When warned,
review capacity before the job starts to fail: raise the budgets together with the backup bucket
quota and host RAM, shorten retention, or move media to incremental off-host copies. Never exclude
media from the bundle without a verified replacement copy.

Operator install (manual; update the backup script, helper and monitor together, or the monitor
reports `backup-capacity-unavailable`). The backup monitor is `opendiscord-monitor.service` (timer
`opendiscord-monitor.timer`, every five minutes) running `/etc/opendiscord-monitor/monitor.py` with
`/etc/opendiscord-monitor/config.json`. The scanner and voice monitor units run the same script from
`/usr/local/sbin/opendiscord-operator-monitor`, so install it to both paths to keep them identical:

```sh
install -o root -g root -m 700 scripts/production-backup.sh scripts/backup-capacity.py /etc/opendiscord-backup/
install -o root -g root -m 700 scripts/operator-monitor.py /etc/opendiscord-monitor/monitor.py
install -o root -g root -m 755 scripts/operator-monitor.py /usr/local/sbin/opendiscord-operator-monitor
systemctl start opendiscord-backup.service   # writes the first capacity.json
cat /var/backups/opendiscord/capacity.json
systemctl start opendiscord-monitor.service && journalctl -u opendiscord-monitor.service -n 3   # expect "status": "healthy"
```
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

The owner-only JSON configuration contains `mode` (`health`, `backup`, activation-only `voice` or `scanner`), `smtp_url`, `from`, and
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

### Hosted-instance restore evidence, 2026-10-19

The newest scheduled bundle `daily/2026-10-19T03-11-46Z.tar.gz.age` (70,020 bytes) was downloaded with
the read-only recovery credential, decrypted with the 1Password recovery identity on the operator's
workstation and restored into a throwaway PostgreSQL 18 container started with `--network none`
(`pg_restore --no-owner --no-privileges --exit-on-error`). Result: 36 migrations (matching the journal
and production), and users 3, communities 1, messages 22, attachments 1, each equal to the live
database for rows created before the snapshot. The single attachment row's object key was present
in the bundle's media copy (manifest `attachment_references=1`). Avatars and community assets are
rows in the same `attachment` table, so this check covers all stored media. The bucket lifecycle rule
`daily-30-days` expires `daily/` after 30 days; `scanner-config/` has no expiry rule (two 12 KB objects).
The container, decrypted files, recovery identity copy and credential file were removed afterwards.
Not covered: booting the application against the restored database and re-uploading media to a
fresh bucket.


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
## 0032 compatible writer rollout

Migration `0032` and compatible application/operator code form one deployment boundary. Old
admin/bootstrap writers take the admin advisory lock before auth writes; the new statement guards
take DM `810025`, then Voice `810030`. Mixing old and new writers can deadlock even without Voice
calls. Old import and maintenance paths introduce further inversions. This procedure is a rollout
gate, not evidence of deployment or Voice/E2EE activation.

1. Record immutable image digests and their exact reviewed Git SHA for web, migrate, bootstrap and
   maintenance/operator images. Require successful checks for that exact revision. Verify an
   encrypted pre-upgrade backup and rehearse its restore in an isolated database; record the
   recovery choice before downtime. Do not substitute an unreviewed tag or mutable `latest`.
2. Establish deployment-wide operational exclusion. Disable automatic deployments/restart overlap,
   schedules and admissions. Drain and stop every old web replica and admin/bootstrap/manual/
   maintenance writer using this database, including actual job containers and operator connections.
   Explicitly stop `opendiscord-maintenance.timer`, `opendiscord-voice-maintenance.timer` and
   their services; stop `opendiscord-voice-monitor.timer`/service while Voice is quiescent.
   A stopped timer alone does not stop an already running job container.
   The maintenance script's flock serializes maintenance only; it is not a deployment mutex.
   Stopping a Compose client does not prove its job container stopped.
3. With explicit bounded drain, lock and statement budgets, inspect `pg_stat_activity` and `pg_locks`
   by reviewed application identities. Report connection/transaction/lock metadata only, without
   SQL query text or parameters. Confirm old processes cannot resume writes and their transactions
   have drained. If they cannot drain within the budget, abort the upgrade. Do not blindly terminate
   connections; termination requires a separate operational decision.
4. Only then execute the exact pinned migrate image once under the same exclusion. Verify the
   migration journal includes `0032`; all seven enabled BEFORE STATEMENT guards on `user`, `session`,
   `account`, `verification`, `two_factor`, `passkey` and `dm_device` invoke
   `voice_auth_statement_guard`, whose order is `810025` then `810030`. Verify the enabled AFTER DELETE
   member backstop invokes `voice_member_delete_generation`. Trigger DDL can block. On timeout or
   runner failure keep writers stopped and inspect the actual journal/functions/triggers; runner
   failure alone does not prove atomic rollback.
5. Start only the recorded compatible web/operator/maintenance images and verify their revisions
   and absence of old replicas/jobs. Check readiness, real auth login/logout, admin policy/session
   revoke, DM registration/upload/revoke, profile/non-revoking edits and maintenance dry-run/apply
   under bounded conditions. Perform canonical cascade/generation acceptance in an isolated
   environment. Do not create production test accounts or mutate customer sessions without
   separately scoped authorization. Compose `depends_on` orders new startup only.
6. Reopen schedules and admissions only after compatibility and readback pass. Record the actual
   maintenance release image and cadence separately. Restart the hourly timer only against its
   compatible release. Enable/restart the Voice repair and Voice monitor timers only when the
   coherent Voice activation gates below pass; they are not installed by a source change.
   No rolling old/new writer period is permitted.

For recovery, quiesce and drain all compatible writers and schedules again first, explicitly
stopping both hourly and Voice repair timers/services and the Voice monitor timer/service.
Preserve labelled running containers until drained or explicitly stopped under the recovery plan. Prefer a known
compatible fix-forward image. Never routinely start old images against `0032` guards. Full restore
requires preserving the current database, the verified pre-upgrade backup and matching old
application/operator images, explicit acknowledgement of loss of all post-backup writes, and
restore/readiness/auth/admin/maintenance readback before reopening. Rehearse auth/config/key
compatibility. Never silently drop triggers or edit the migration journal; a reverse migration is a
separate reviewed change including its journal consistency and loss of generation protection.

### Unactivated generation-room ownership (migration 0033)

The internal bound-token path reserves an exact `voice:<channel UUID>:<call UUID>:<generation>`
room in `voice_sfu_room` under the Voice transaction lock before any SFU create or JWT delivery.
`active` means authorized to issue, not proof a token was delivered or a room exists. Explicit
CreateRoom happens after commit; a second locked enrollment/generation check precedes JWT signing.
No network request is made inside the database transaction. Revocation can still race response
signing, admitted SFU requests, or late completion of a timed-out create. A retired generation is
terminal: retrying it never restores registration or returns a fresh token.

The call generation/status/delete trigger retires registered rooms atomically, including native
session/anchor/user cascades. Ownership has no parent foreign key and survives channel/community
removal. Cleanup claims due rows with a 30-second lease and a unique claim UUID; an expired worker
cannot overwrite a newer claim. Requests use the public SDK timeout **0.5 seconds**, with region
failover disabled, and run sequentially. Each public bound-token invocation shares at most four RPCs and one monotonic 2.5-second
budget across both grants, explicit creation and failure cleanup. Successful first-reservation
cleanup is deferred to mandatory post-create revalidation; precreate authority denials also attempt
cleanup after retirement commits, using only the same remaining allowance. Exhaustion dispatches no
further RPC and leaves the retirement durably due.
Interactive standalone consumption allows at most four rooms/four requests with the same budget; maintenance allows at most sixteen rooms/32 requests and
20 seconds shared across lifecycle batches. Budgets include retries; failures are deferred durably,
not retried by generation-ledger timers. Fair ordering uses next-attempt time then exact name. Logs contain only
bounded aggregate counts/outcome categories. A missing room is successful cleanup only for the
SDK's actual `not_found` error. No list-all or prefix room discovery is performed.

Active ownership is checked independently from expired-call sweep eligibility, including current
call/generation, live account/session/anchor/lease, blocked pairs and channel permissions. Unknown
or overfull SFU rosters retire the whole owned room. This intentionally fails closed; the same
generation cannot be healed by issuing another token. Affected members must leave and enroll in
a fresh call generation through the normal control flow. Source permissions are narrowed from
current database authority intersected with existing effective SFU rights. LiveKit's empty source
list with publishing enabled means unrestricted publication; repair replaces it with the explicit
canonical sources. An empty intersection disables publishing, missing permissions disable all
publication and subscription, and repair never expands an existing explicit restriction or enables
data/metadata updates. This is eventual best-effort repair; neither
instant physical revocation nor prevention of all physical room resurrection is guaranteed.

Successful retired rows recur every five minutes when a consumer runs; active checks recur every
30 seconds. These are eligibility times, **not a scheduler**. The existing hosted maintenance
cadence must be monitored separately; an hourly job cannot promise five-minute cleanup.
The activation-only dedicated Voice runner described below is required before leased product activation. Inspect
count of due/leased/retired rows and oldest overdue time without exporting identities. SDK failure
or unavailable configuration must never undo a committed suspension, block, role loss or revoke.
The retained legacy channel-UUID room path remains separate, exact-name, best effort and is not
retroactively covered by generation ownership evidence. Its existing single 65-second delayed
reconciliation is preserved until coherent activation; this retry does not prove that refreshed
legacy tokens have expired. Legacy deletion/reconciliation visits all exact owned channel names
sequentially, with bounded individual RPCs, rather than dropping channels after the new ledger budget.

The registry has a hard application admission cap of **100000 rows**. Only a new-room reservation
counts under the shared Voice lock; existing active reservations do not scan/count the table.
At capacity, new room grants fail closed for operator capacity review. Tombstones currently remain
indefinitely, so storage is proportional to generations that might ever have received a capability.
Do not prune after the app JWT expiry: pinned LiveKit 1.13.10 refreshes session tokens every five
minutes with at least ten minutes validity. There is no automatic tombstone GC or prune command.
Any later finite retention policy requires a separately reviewed SFU quiescence/recovery proof.

**Later coherent activation gate, not applied by this change:** pin and verify the actual SFU
1.13.10 image/digest, then set official `room.auto_create: false` only while all issuers/writers
are quiesced and the legacy UI/token bypass is coherently removed or migrated to explicit server
creation. Existing basic voice currently depends on auto-create. Product JWTs omit roomCreate and
roomAdmin. Run isolated real absent-room rejection, explicit-create acceptance and authenticated
three-browser/media acceptance before release. auto_create false is an admission barrier, not a
cross-system atomic fence against already validated joins or late create completion.


### Activation-only frequent Voice repair

Current production basic Voice and migrations 0000–0029 do **not** imply this job is installed or
safe to start. Migrations 0031/0032/0033, compatible writers, coherent product activation and all
separate acceptance gates must be reviewed together. Do not install/enable these timers against
current production merely because their templates exist. In particular, 0032 requires the complete
writer/timer quiescence and compatible image readback above.

`pnpm --filter web maintenance:voice` is dry-run by default. `--apply` invokes exactly one existing
`sweepVoiceLifecycle` batch of at most eight eligible calls, with a fresh current time. It also runs
the existing due-room consumer even if that batch is empty: no second loop or whole retention job
is started. The shared SFU allowance stays 16 room claims, 32 sequential SDK requests and a
20-second monotonic **scheduling** window. SQL and total wall-clock work are not bounded by that
SDK window. The wrapper supplies 15-second SQL statement and 2-second lock timeouts, a 60-second
outer job deadline plus five seconds kill grace; systemd allows 90 seconds plus 20 seconds stop
cleanup. Claims abandoned by a crash remain recoverable after their existing 30-second leases.
CLI exit closes its actual PostgreSQL pool in `finally`; failures/unavailable SDK work produce
nonzero exit. CLI output explicitly allowlists only aggregate counts and flags, never IDs,
room names, identities, keys or opaque native payloads.

`scripts/production-voice-maintenance.sh` uses the already-built release `migrate` image with
`--pull never`, no dependencies and no build. `ops/voice-maintenance/compose.yml` passes only the
existing four `LIVEKIT_*` variables from the deployed protected `.env` through Compose and joins
the same existing `dokploy-network` as web, without exposed ports. Keep `.env` root-owned mode600;
never source, print or duplicate it. Before activation verify the chosen exact release image
contains the CLI/tsx and that its configured SFU API is reachable from that network. The operator
must record the resolved image digest/revision under deployment exclusion so a mutable image tag
cannot be changed by an overlapping deploy.

The Voice runner has its own flock and `opendiscord.voice-maintenance.project/run` labels. It
refuses a previous same-project Voice container without deleting it. Cleanup verifies the unique
run label then removes only that immutable container ID, including after a client timeout. A
SIGKILL/daemon outage can leave an orphan; the next invocation fails closed for operator review.
Never use broad container/orphan deletion. The hourly retention job uses different labels/lock;
its existing database locks serialize shared Voice work safely. Contention can cause a bounded
failure and retry; neither flock is a deployment-wide exclusion mechanism.

The frequent job does not require a new successful backup each tick. It expires ephemeral leased
membership and repairs already-authorized SFU revocation, using existing durable state; tying it
to backup availability would prolong stale SFU access during a backup outage. The separate hourly
destructive retention job retains its verified-backup gate. Backup/restore policy is unchanged:
the encrypted recovery bundle additionally captures installed Voice repair/monitor units, wrapper,
private operator environment/config and aggregate status when present. Restore these only with
the matching compatible release, review root-only modes and paths, and keep timers stopped until
restored database/readiness/auth/Voice acceptance passes. Do not blindly replay old status as
fresh execution evidence.

At coherent activation only, install the checked-in `.service`/`.timer` templates under
`/etc/systemd/system`, the reviewed wrapper as `/usr/local/sbin/opendiscord-voice-maintenance`,
and the existing monitor script as `/usr/local/sbin/opendiscord-operator-monitor`. Provision
`/etc/opendiscord-voice-maintenance/environment` root-owned mode600 containing only the verified
`OPENDISCORD_COMPOSE_DIR` and `OPENDISCORD_COMPOSE_PROJECT` settings (same checkout/project as the
hourly job). The service creates root-only `/var/lib/opendiscord-voice-maintenance`. The timer
uses `OnUnitInactiveSec=10s`, one second accuracy and no randomized delay, so its next run is
approximately ten seconds **after completion**, not ten seconds after the previous start.

Provision `/etc/opendiscord-monitor/voice.json` root-owned mode600 using the existing owner-only
SMTP configuration/destination with `mode` set to `voice`. No new mailbox or secret copies are
needed beyond the current per-mode JSON schema; never put values in Git/logs. The Voice monitor
timer checks each minute through existing SMTP suppression/recovery logic; per-mode locks keep
local backup checks independent. It alerts on missing/invalid status, completion older than 120
seconds, a failed service/job, six consecutive SDK-failure results, or six consecutive limited
results. `limited` is scheduling pressure (including an exactly full batch), **not proof of
backlog**. SDK failures are exposed by the real existing consumer metrics, never inferred as
success from a completed CLI. Job failure alerts also cover the first SDK failure. A backup,
monitor-host or SMTP outage has separate alerts/limits; SMTP acceptance alone is not inbox proof.
Do not enable Voice monitoring expectation before activation, or it would falsely alarm on the
intentionally absent job. Record actual unit enablement/status, last invocation, alert delivery
and recovery separately; this source change sends no mail and installs nothing.

Ten seconds is an initial operating cadence, **not a revocation SLA**. Effective removal depends
on room due times (active 30 seconds, tombstones five minutes), SQL contention, batch capacity,
SDK completion, backoff and recurring rechecks. Monitor pressure and privately inspect aggregate
count of due/leased/retired rows and oldest overdue age before changing capacity. Backlog or SFU/DB
outages can extend eventual cleanup without a hard upper bound. Frozen JS, native auth cascades
and crash recovery need this independent scheduler but still require isolated acceptance, plus
separate real browser/media and refresh/reconnect/TOCTOU acceptance before activation.

Canonical isolated CI checks wrapper locking/immutable cleanup with fake Docker, CLI pool closure
and failure handling with SDK-port mocks, and systemd syntax on Linux. After the existing LiveKit
startup, a CI-only real SDK/DB check creates an exact random room, starts its own actual CLI worker
through a bounded loopback HTTP proxy and intercepts only that room's public SDK DeleteRoom after
the durable claim commits. The proxy SIGKILLs only that child, without forwarding deletion or
returning a fake SDK success. The real room and committed claim survive; normal workers cannot
steal its unexpired lease while processing eight then one real calls. After the actual 30-second
lease expires naturally, a normal CLI invocation must delete that exact SFU room through the real
SDK, settle its claim and exit with its pool closed. No claim lease is shortened in SQL. Owned
children, proxy connections, fixture rows and exact room are cleaned up under the CI step's
outer deadline. This proves the isolated process-kill/lease-recovery path, not production timer
cadence, host/container-daemon failure, real media or authenticated browser acceptance.


### Private scanner operations (not installed by source)

The dedicated [scanner operations artifact](../ops/scanner/README.md) pins a private ClamAV daemon,
persistent freshclam definitions, a 4 GiB ordinary Compose cap and five-minute operator monitoring.
Its source alone does not prove production activation. Self-hosted integration stays optional;
the official instance adopts mandatory scanning only after the documented freshness/network/real
upload/import gates. Missing engine then closes new uploads/imports while existing downloads remain
unchanged. Loaded definitions older than 48 hours alarm; current app code has no age rejection gate.

The encrypted backup job calls adjacent `capture-scanner-recovery.py`. The documented optional
`OPENDISCORD_SCANNER_COMPOSE_DIR` becomes required when the captured running app has `CLAMAV_HOST`.
It captures exact scanner Compose/environment, actual app scanner endpoint and installed monitor
configuration/units, never signature databases. Install both backup scripts together; configure the
variable through the existing protected backup service EnvironmentFile. Restore private scanner
configuration and fresh definitions before app acceptance; retain failclosed policy during recovery.
