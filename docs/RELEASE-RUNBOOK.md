# Hosted web and PWA release runbook

Candidate version: **0.2.0-beta.1, unreleased**. Current decision: **NO-GO**.
The [readiness checklist](OPEN-BETA-READINESS.md) is the gate ledger. This runbook does not authorize
turning off Closed Alpha, publishing an Open Beta announcement or exposing native preview downloads.

## Review and build

1. Merge small PRs only after the protected checks and a separate approving GitHub review pass.
   `main` requires `check`, `voice-product` and `real-engine`, an up-to-date branch, one approving
   review, approval after the latest push, resolved discussions and admin enforcement. Do not use
   an admin bypass, self-review or direct write to satisfy this gate.
2. Record the **final main SHA** and successful main workflow URLs after all merges. PR-head CI and
   a synthetic PR merge SHA are distinct evidence. Re-run acceptance on the final integration.
3. On the selected checkout verify `git rev-parse HEAD` is that reviewed SHA and
   `git status --porcelain --untracked-files=all` is empty. Ignored owner-only `.env` is not source
   provenance. Record the build inputs, workflow and immutable web/migrate image IDs. Both Docker
   targets accept `SOURCE_COMMIT`; Dokploy Compose forwards `OPENDISCORD_SOURCE_COMMIT` as that
   build argument. Set it to the verified SHA before building, and build **both** targets.
   The default `unverified` deliberately cannot satisfy the smoke gate.
4. An OCI revision label is a declarative operator/build binding, not cryptographic attestation.
   Never apply a new label to an old image as a substitute for a clean build. Verify every serving
   replica and the reverse-proxy routing; one selected container cannot establish the whole fleet.

## Backup, deploy and readback

1. Check [OPERATIONS.md](OPERATIONS.md): a fresh encrypted off-host bundle, independent recovery
   identity, retention, available RAM/storage and a recent isolated restore with application/media
   readback. Resolve the aggregate backup-capacity failure before increased admissions. Record the
   pre-deploy web/migrate image IDs, configuration version and migration journal for rollback.
2. Use the compatible-writer rollout in OPERATIONS for database/auth/Voice changes. Stop conflicting
   writers and actual maintenance containers under bounded drain budgets; do not assume stopping a
   timer stops an already-running job. Abort on unknown lock state. Do not terminate sessions or
   overwrite production data as an acceptance test.
3. Apply only reviewed backward-compatible migrations, using the pinned migrate image. Compare
   the complete ordered journal hashes with that checkout, not just the newest migration name.
   Start only compatible app/operator images; keep the migrate image available to scheduled jobs.
   Product Voice also requires explicit `room.auto_create: false` in the actual SFU configuration,
   not just the repository's standalone template. Follow the coherent issuer/SFU rollout in OPERATIONS;
   the hosted inline configuration currently differs and must not be switched under old issuers.
4. From the clean deployed repository, run the read-only gate with the recorded SHA and the actual
   serving web/database container names:

   ```sh
   python3 scripts/production-smoke.py --expected-sha "$RELEASE_SHA" \
     --web-container "$WEB_CONTAINER" --database-container "$DATABASE_CONTAINER" \
     --origin https://opendiscord.app
   ```

   It rejects dirty/mismatched checkouts, stopped/unlabelled/mismatched web images, any migration
   hash/order difference, failed/non-JSON health, cacheable probes, a malformed PWA manifest, invalid
   icon paths/types and missing or permissive tested security headers. The JSON result contains only
   stable status codes, SHA and image ID. Header checks include inline event-attribute denial;
   retaining Next's inline bootstrap support is an explicit residual CSP risk.
5. Check from an external browser as well: landing, sign-in/out, authorized chat/realtime/media,
   DM ciphertext/attachments, unread/reconnect, denied outsider access and PWA offline recovery.
   Check console and relevant network failures. Use dedicated approved QA accounts; no customer
   sessions. Repeat supported-engine acceptance for the exact release and retain workflow/browser
   versions, screenshots and traces. Emulated iPhone/Android profiles do not replace physical tests.
6. Verify fresh ClamAV signatures and clean/EICAR/failure behavior through the application; verify
   the actual LiveKit/TURN/TLS deployment, email and push delivery. Re-enable schedules only against
   pinned compatible images. Inspect last completion **and** active timer for backup, retention,
   Voice repair and monitors. Send a synthetic alert, confirm its receipt at the designated inbox,
   then prove recovery notification after a safe isolated failure. SMTP acceptance alone is insufficient.

## Capacity and rollback

Existing bounded characterization covers 20 SSE readers and synthetic CI workloads. It does not
establish production user capacity, CPU/RSS, pool pressure, media bandwidth or an SLO. Keep current
Closed Alpha admissions until a measured load run on an isolated representative stack establishes
reader/writer/voice targets and alerts for latency, database pool/locks, memory, disk, backup projection
and media egress. Retain the measured limits and abort thresholds in the readiness ledger. Never
stress production or buy/raise storage budgets to infer a beta capacity number.

For a failing deployment, keep admissions closed, preserve failure evidence and the current database,
and stop the new writers. Return to the recorded previous immutable application image only when its
schema compatibility is proven. These readiness patches add no migrations; future schema changes
need their own rollback decision. If compatibility is unknown, maintain the outage and recover into
an isolated database first. Production restore is a separate destructive operator action: preserve the
current state, stop writers, select a verified recovery point, obtain the scoped recovery authorization,
then follow OPERATIONS. Do not roll back the database automatically after an application error.

For a security incident: close affected admissions, revoke the specific compromised credentials or
sessions under the incident plan, preserve access-restricted evidence, contact the operator through
the private channel in [SECURITY.md](../SECURITY.md), and assess user/legal notifications with the
responsible external reviewer. Do not publish keys, recovery bundles or private message excerpts.

## Publication and support

After every P0 is PASS, obtain explicit owner approval to disable Closed Alpha and publish. Only then
tag the exact validated SHA as `v0.2.0-beta.1`, attach the changelog, verified deployed revision,
support/known limitations and recovery date, and repeat post-deploy smoke after the policy change.
Keep unsigned or unverified desktop installers unpublished; native mobile apps are outside scope.
See [SUPPORT.md](../SUPPORT.md) and [SECURITY.md](../SECURITY.md). External cryptography/pentest,
legal sign-off and physical-device evidence must be linked by reviewer/date/scope, never inferred
from internal review or a green build.
