# Private scanner operations (source only)

This artifact installs nothing. Production scanner activation, timer installation, real mail delivery
and acceptance are separate operator actions after exact-head CI/reviews and fresh capacity evidence.
The official instance adopts mandatory scanning when activated; self-hosting remains optional.
Configured engine failure closes **new uploads/imports**; existing downloads remain unchanged.
Signatures reduce known malware risk; they do not prove files safe or provide privacy isolation.

## Pinned engine and defaults

Official seeded `clamav/clamav:1.5.4`, verified 2026-10-16 through Docker Hub and registry API:

- Multi-platform index `sha256:638d90201ee7ee6a82d249a2fc23b132e578673b5f1f2766852b127676ca1ef6`.
- Linux amd64 manifest `sha256:705e0723f02fc13bf6e5e8a8e13a8c44420acf5e7ed06dfa2197081da00c7a73`.
- Image config: `/init`, `TZ=Etc/UTC`, `clamdcheck.sh` healthcheck with six-minute start allowance.
- Official Docker source commit [`f13ba12`](https://github.com/Cisco-Talos/clamav-docker/tree/f13ba12f771801fbe318c469496ca7c248318dc2/clamav/1.5/alpine)
  starts `freshclam --checks=12 --daemon --foreground --stdout --user=clamav` with this environment.
  It starts clamd normally and notifies it of updates. No competing updater/cron is supported.
  Retain database testing and concurrent reload defaults. No CI freshclam-disable setting is copied.

[Official Docker guidance](https://docs.clamav.net/manual/Installing/Docker.html) recommends 4 GiB,
persistent `/var/lib/clamav`, and warns about update/reload peaks and unauthenticated TCP.
[Protocol documentation](https://docs.clamav.net/manual/Usage/ClamdProtocol.html) defines PING/VERSION.
The [1.5.4 VERSION implementation](https://github.com/Cisco-Talos/clamav/blob/clamav-1.5.4/clamd/session.c)
uses **loaded** engine DB time through `cli_ctime`; the monitor verifies container UTC before parsing
its fixed English ctime representation. Image definitions are only a seed, never freshness evidence.
Check vendor EOL/security advisories weekly; update the exact digest through isolated engine tests
and a bounded reviewed rollout, not unattended image updates. Verify source/defaults again on upgrades.

## Deployment gates

1. Record reviewed source/image revisions and rollback configuration. Disable and read back overlapping
   automatic deployments before changing any coherent application stack. Do not merge unaccepted
   Voice migrations to obtain this standalone artifact. Keep existing hourly/Voice behavior intact.
2. Recheck host MemAvailable, memory/IO PSI, active swap-in/out, recent OOM events and other workload
   demand. Cold historical swap is distinct from active pressure. Reserve at least 5 GiB disk for
   image, persistent signatures and update temporaries. Hold on pressure or inadequate capacity.
   This service caps RAM **and total RAM+swap** at 4294967296 bytes in ordinary Compose; it cannot
   borrow swap to mask insufficient RAM. Observe update/reload peaks before acceptance.
3. Resolve the exact web Compose project/service and existing private default network from deployment
   labels/inspect. Never guess the app network prefix. Configure that exact name in this deployment's
   protected `.env` as `OPENDISCORD_APP_PRIVATE_NETWORK`. Reject `dokploy-network`. The scanner gets
   the unique alias `opendiscord-private-scanner` on the app-private network and its own ordinary
   bridge for updater egress. The app-private network includes its database: scanner shares that L2
   boundary but receives no DB credentials/mounts. Stronger web-only network isolation is separate work.
4. Deploy only `ops/scanner/compose.yml` as a dedicated **ordinary Compose** project. It has no
   published ports, domain, Traefik labels, Docker socket, customer-file mount or host network.
   Do not substitute a shared global network or transient `docker network connect`.
   Keep named `signatures` volume across recreations. Let the single freshclam daemon update it.
   Inspect actual HostConfig.Memory and MemorySwap = 4294967296, image digest, mounts, private
   networks/alias, bounded json-file logs and no published 3310/7357. Swarm is not this contract;
   stop and adapt/review resource semantics if the deployment platform uses Swarm.
5. Leave app `CLAMAV_HOST` unset until the engine is healthy, freshclam has successfully checked/
   updated/reloaded official definitions, loaded VERSION is <=48 hours old and not >5 minutes future,
   and app-namespace PING/VERSION succeeds. Inspect private updater logs; process presence proves
   liveness only, never successful fetching. Do not run a second freshclam command against its volume.
6. Set app `CLAMAV_HOST=opendiscord-private-scanner`, `CLAMAV_PORT=3310` in the persisted deployment
   environment and redeploy only the approved app revision, without unrelated migrations. Verify
   real authenticated clean upload/import success, EICAR upload/import rejection, and a bounded
   coordinated scanner outage producing existing failure with no stored object, staged row or import
   mutation. Restore service and prove recovery/clean success. Existing-object downloads remain
   usable; this is not retroactive scanning evidence. Record console/network and public readback.

`unless-stopped` does not restart a merely unhealthy running process. Monitoring is required.
The app's public readiness remains DB-only. **A loaded DB older than 48h alarms and blocks activation;
it does not cause current application uploads to reject solely because of age.** Runtime stale
signatures continue scanning until repaired. Continuous stale-age failclosed enforcement would need
a separately scoped application policy. Do not silently unset scanner configuration during failure.

## Monitor installation contract

After activation, install the reviewed `scripts/operator-monitor.py` to
`/usr/local/sbin/opendiscord-operator-monitor` and these service/timer templates under
`/etc/systemd/system`. Existing health/backup/Voice modes and per-mode locks remain independent.
Create `/etc/opendiscord-monitor/scanner.json`, root-owned mode600, using the existing operator
SMTP destination/credentials privately (never in Git/logs):

```json
{
  "mode": "scanner",
  "smtp_url": "<existing private SMTP URL>",
  "from": "<existing sender>",
  "to": "<existing operator destination>",
  "web_project": "<exact deployed app Compose project>",
  "web_service": "web",
  "scanner_project": "<exact dedicated scanner Compose project>",
  "private_network": "<exact app-private network>"
}
```

Selectors come from actual labels and must resolve to exactly one container, including stopped
containers; ambiguity fails closed for operator repair. Scanner service name is exactly `scanner`.
The root monitor checks scanner state/health/OOM, immutable image, 4 GiB applied RAM+swap cap, no port
bindings, UTC, named signature mount, rotating log contract and network/alias. It verifies updater
presence using Docker's process listing and the pinned entrypoint's actual daemon identity.
The only application command is fixed Node PING/VERSION through the app's actual configured endpoint:
5-second overall deadline, 2-second socket timeout, 4096-byte NUL-terminated ASCII reply limit.
Docker commands have individual 10-second bounds; systemd kills the whole monitor after 90 seconds.
No keys, endpoints, process text or file contents appear in alert output.

Enable `opendiscord-scanner-monitor.timer` only after activation. Its first check is five minutes
after boot, then five minutes after each completion. One failure alarms, repeat mail is suppressed
for one hour across failure categories; recovery requires all checks and loaded freshness to pass.
SMTP failure leaves delivery retryable; SMTP acceptance is not inbox receipt. Prove failed-probe
submission and real recovery using controlled fixtures/outage, and record actual inbox receipt.
Do not poison production signatures or change the host clock to test staleness. Host/SMTP failure
can prevent alerts; a timer template alone is no operational monitoring evidence.

## Encrypted backup and recovery

Install `capture-scanner-recovery.py` adjacent to `production-backup.sh` when updating the backup
installation. Set `OPENDISCORD_SCANNER_COMPOSE_DIR` to this deployment's absolute directory in the
existing protected backup service environment (the same EnvironmentFile/passthrough used for the
four documented backup variables). No scanner daemon unit reads this variable. Both `compose.yml`
and its actual `.env` must exist and be nonempty. Before activation it may be omitted. Once the
captured running app has nonempty `CLAMAV_HOST`, omission/missing files **fails the backup**.
A deliberately staged scanner directory can also be captured while app host remains unset.

The encrypted recovery bundle includes `config/scanner/compose.yml`, `.env`, captured app endpoint
`app-scanner.json`, a restore note and existing scanner monitor unit/timer/config/script under
`config/scanner/installed/<absolute path without leading slash>`. It also retains the separate
existing `config/app.env`. Monitor files are copied when installed; absence does not prove monitor
acceptance. Definition databases and scanner customer mounts are never included. The 1 GiB backup
budget is unchanged. Verify these paths after an isolated decrypt/restore rehearsal, without
printing their private contents. Restore the helper with the matching backup script.

Recovery order: restore reviewed private network/config and compatible pinned engine; regenerate
signatures in a fresh persistent volume from the official updater; establish fresh loaded
VERSION/PING from the app namespace; restore/redeploy the configured app; repeat clean/EICAR/failure
acceptance; then restore root-only monitor files and enable timer after SMTP/recovery verification.
Do not replay monitor state as fresh evidence. An unavailable scanner means uploads remain closed
while repairing. Preserve old digest/config and copy/isolate the signature volume before engine
downgrades; format compatibility is not assumed. Never restore a stale DB as healthy. Emergency
scanner bypass is a separately recorded operator policy exception, never automatic rollback.
