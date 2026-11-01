# Changelog

## 0.2.0-beta.1 — unreleased candidate

Scope: hosted web application and installable PWA. Public registration is enabled on the official
instance. This entry describes an unreleased candidate, not a validated release or announcement.

Implemented candidate capabilities:

- Run cross-browser acceptance in the protected CI gate; independent assurance remains a release gate.
- Recheck current moderation authority inside serialized mutations; enforce atomic message/push
  limits and preserve the message budget when an attachment transaction rolls back.
- Deny inline script event attributes while retaining Next.js bootstrap compatibility; align public
  encryption claims with 1:1/group DM files, supported Voice E2EE and readable community content.
- Bind web/migrate images to the reviewed source revision, compare ordered production migration
  hashes, run a read-only public deployment smoke and detect failed/stale scheduled maintenance.
- Disable implicit room creation in the standalone LiveKit default; verify the actual hosted SFU
  configuration and compatible issuer on each release.
- Record isolated recovery of the current production backup with authenticated media readback.

Candidate follow-up adds optional error diagnostics that omit private context, corrects outdated admission copy
and permits the incremental recovery producer to use the existing Backblaze B2 destination.
Current evidence: [stabilization record](docs/BETA-STABILIZATION-2026-11-01.md).

Release commit/deployment: **not established**. See the
[readiness checklist](docs/OPEN-BETA-READINESS.md), [runbook](docs/RELEASE-RUNBOOK.md),
[support policy and limitations](SUPPORT.md) and [security disclosure process](SECURITY.md).
