# Support and known limitations

The official instance accepts public registrations. The hosted web/PWA release `0.2.0-beta.1`
remains an unreleased candidate. Current work and evidence are recorded in
[BETA-STABILIZATION-2026-11-01.md](docs/BETA-STABILIZATION-2026-11-01.md);
[OPEN-BETA-READINESS.md](docs/OPEN-BETA-READINESS.md) retains the historical gate ledger.

Support is best effort by the project maintainers, without a response-time or uptime commitment.
Use [GitHub issues](https://github.com/Livvux/openDiscord/issues) for reproducible product bugs:
include the released version, browser/OS, steps and sanitized diagnostics. Do not attach credentials,
session cookies, private conversations or recovery files. For account/privacy/abuse concerns use the
official instance's published [support and operator contact](https://opendiscord.app/imprint).
Report security issues privately through [SECURITY.md](SECURITY.md), not public issues.

Once published, fixes target the latest beta release; there is no promise of backports or a stable
API/feature set during beta. Self-hosters operate their infrastructure, backups and upgrades.
Before relying on the service, check the current release notes and hosted-instance status.

Known acceptance limits:

- Chromium/Firefox/Edge/WebKit automation is evidence for the engines and cases actually run.
  iPhone/Android emulation is not iOS Safari/Android Chrome physical-device acceptance.
- PWA install/offline UX is the mobile scope. Native mobile applications are not implemented.
  Desktop builds are unsigned/unverified previews and are excluded from the hosted launch.
- Community content/attachments are readable by the operator. Private 1:1/group DM content and
  DM attachments are encrypted in the browser; browser device loss, identity changes and recovery
  have explicit limits. Supported Voice media uses E2EE. Independent integration review is still
  required; no external cryptographic audit or pentest is claimed.
- Physical-device screen sharing, hostile-network TURN/TLS, screen-reader acceptance and actual
  push/inbox alert delivery must be recorded separately. Synthetic media, axe and SMTP submission
  do not certify those outcomes.
- Backblaze B2 is the hosted recovery destination. Database snapshots and encrypted recovery
  archives have separate schedules; successful delivery is not an application-restore proof.
  No production concurrency or service-level objective has been established.
