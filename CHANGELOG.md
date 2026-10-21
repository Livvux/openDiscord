# Changelog

## 0.2.0-beta.1 — unreleased candidate

Scope: hosted web application and installable PWA. Closed Alpha remains enabled. This entry is a
release plan, not a tag, deployment or Open Beta announcement.

Pending reviewed readiness changes:

- Require cross-browser acceptance and independent review before merging to protected main.
- Recheck current moderation authority inside serialized mutations; enforce atomic message/push
  limits and preserve the message budget when an attachment transaction rolls back.
- Deny inline script event attributes while retaining Next.js bootstrap compatibility; align public
  encryption claims with 1:1/group DM files, supported Voice E2EE and readable community content.
- Bind web/migrate images to the reviewed source revision, compare ordered production migration
  hashes, run a read-only public deployment smoke and detect failed/stale scheduled maintenance.
- Record isolated recovery of the current production backup with authenticated media readback.

Release commit/deployment: **not established**. See the
[readiness checklist](docs/OPEN-BETA-READINESS.md), [runbook](docs/RELEASE-RUNBOOK.md),
[support policy and limitations](SUPPORT.md) and [security disclosure process](SECURITY.md).
