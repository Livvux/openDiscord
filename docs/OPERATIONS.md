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
