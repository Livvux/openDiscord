# Roadmap and gap analysis

Status as of 2026-10-15 (branch `feat/mvp-core`). "Implemented" means implemented end-to-end and covered by
automated tests; anything less is listed as partial or missing. Nothing here is a claim of production
readiness: there has been no external security audit.

## Why openDiscord exists

We separate what is verifiable about Discord from what is opinion, and design against the verifiable parts.

| Shortcoming | Kind | Our answer |
| --- | --- | --- |
| Proprietary, cannot be self-hosted; communities depend on one company's policies and continuity | Verified (product fact) | AGPL-3.0, Docker Compose deployment, same release on the official instance |
| Text messages are not end-to-end encrypted; Discord added E2EE for audio/video calls (DAVE protocol, 2024), not for text | Verified (Discord announcement) | We say plainly what is and isn't E2EE ([PRIVACY.md](PRIVACY.md)); E2EE DMs are P1 |
| Features gated behind a subscription (upload size, stream quality) | Verified (Nitro feature list) | No artificial limits; operators set limits for cost reasons only |
| A third-party support vendor breach exposed government ID photos submitted for age appeals (disclosed by Discord, October 2025) | Verified (Discord disclosure) | Collect no identity documents; age safeguards must be privacy-preserving ([THREAT-MODEL.md](THREAT-MODEL.md)) |
| Community knowledge is locked inside the app and not findable on the web | Verified (content is not public by default) | Private by default; opt-in public, indexable channels (P2) |
| Bans and account actions with little explanation or appeal | Widely reported, anecdotal | Audit log with reasons now; ban explanations and appeals P1 |
| Heavy desktop client, notification noise, cluttered UI | Subjective | Lean web client, few notifications by default; measured, not assumed |

## Current assessment

Before this branch the repository contained a marketing site, email/password sign-up (Better Auth),
Postgres via Drizzle, Docker Compose with Caddy, and CI. There were no communities, no messaging and no
documentation beyond the README and brand guidelines.

This branch adds the text-chat MVP: communities, channels, roles with a permission hierarchy, invites,
moderation (kick, ban, message removal, audit log), realtime messaging over Server-Sent Events, GDPR
export and deletion, password reset, TOTP two-factor authentication, passkeys, security headers,
backup/restore scripts, and architecture, threat-model and privacy documentation.

## Requirements matrix

Legend: ✅ implemented and tested · 🟡 partial · ❌ missing · Priority for open items.

### 1. Privacy and data protection

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Collect only necessary data | 🟡 | Email, display name, password hash, sessions (user agent, no IP). User-agent minimisation P1 |
| No analytics, ads or trackers | ✅ | No third-party requests; CSP `connect-src 'self'` |
| Retention and deletion policies | 🟡 | Documented in PRIVACY.md; automated purge of expired sessions/verification rows and audit-log retention job P1 |
| GDPR access/export | ✅ | `/api/me/export`, JSON, tested |
| GDPR correction | 🟡 | Display name editable; email change flow P1 |
| GDPR deletion | ✅ | Deletes account, sessions, messages; blocked while owning a community |
| Consent | ✅ n/a | No optional processing that requires consent; no cookies besides the session |
| Minimise IPs, logs, metadata | ✅ | IPs not stored with sessions; Caddy access logs off; app logs errors only |
| Encryption in transit | ✅ | Caddy TLS + HSTS |
| Encryption at rest | 🟡 | TOTP secrets and backup codes encrypted by Better Auth; database relies on disk encryption (documented). Column-level encryption is not planned for message content because the server must read it to serve it |
| E2EE for private communication | ❌ | **P1**: DMs on an audited MLS (RFC 9420) or Signal-protocol implementation. Nothing is E2EE today, and the UI and docs say so |
| Private content out of search engines and public APIs | ✅ | `robots.txt`, `noindex` on `/app` and `/invite`; all APIs require membership |

### 2. Data ownership and self-hosting

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Independent instances | ✅ | Docker Compose stack verified end-to-end (TLS, auth, SSE through Caddy) |
| No mandatory proprietary services | ✅ | SMTP optional; no external APIs |
| Portable backup and restore | ✅ | `scripts/backup.sh` / `restore.sh`, round trip tested |
| Export per community (channels, messages, roles, settings) | ❌ | **P1** — whole-instance backup exists, per-community export does not |
| Migration and recovery docs | ✅ | [SELF-HOSTING.md](SELF-HOSTING.md) |
| Hosted service has no exclusive capabilities | ✅ | One codebase, no feature flags or license keys |
| Federation-ready design | 🟡 | UUID ids, no global user directory. Federation research P2 |

### 3. Messaging and communities

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Communities and channels | ✅ | |
| Categories | ❌ | P1 |
| Direct messages | ❌ | **P1** (with E2EE) |
| Realtime text messaging | ✅ | SSE + LISTEN/NOTIFY, gap recovery on reconnect |
| Replies, mentions, reactions | ❌ | P1 |
| Threads | ❌ | P2 |
| Attachments | ❌ | **P1**: local volume or S3-compatible storage, size/type validation, EXIF stripping, optional ClamAV |
| History and pagination | ✅ | Cursor pagination (UUIDv7) |
| Search | ❌ | P1: Postgres full-text search, membership-scoped |
| Notification preferences | ❌ | P1 (depends on mentions and unread state) |
| Roles and granular permissions | 🟡 | Community-level roles with hierarchy ✅; per-channel overrides P1 |
| Invites and onboarding | 🟡 | Expiring, limited-use invites ✅; rules/onboarding screen P2 |
| Presence and status | ❌ | P1 |
| Edit, delete, moderate messages | ✅ | Pinning P1 |
| Opt-in public, indexable channels | ❌ | P2 |

### 4. Voice, video and screen sharing

All ❌. Voice channels are **P1** (LiveKit, see [DECISIONS.md](DECISIONS.md)); video and screen sharing P2.
They are deliberately outside the text MVP: they bring an SFU, TURN and UDP ports to every deployment.

### 5. Security

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Threat model | ✅ | [THREAT-MODEL.md](THREAT-MODEL.md) |
| Authentication and recovery | ✅ | Password (min 10), email verification and reset when SMTP is set, sessions revoked on reset |
| Passkeys and TOTP 2FA | ✅ | Better Auth plugins; tested with a virtual authenticator and RFC 6238 codes |
| Rate limiting, anti-spam | 🟡 | Auth endpoints (Better Auth), messages (5 per 5 s per user), 30 mutations per 10 s per user, caps on communities/channels/roles/invites, 8 live streams per user. Limits other than messages are per process (shared store P1); per-community join limits P1 |
| Anti-raid | ❌ | P1: join-rate limits per community, invite pause, minimum account age option |
| Sessions and permission enforcement | ✅ | Every service call re-checks membership and permissions; integration-tested |
| IDOR, XSS, CSRF, SSRF, SQLi, privilege escalation | ✅ | Tests cover non-member access, role escalation and HTML injection; no server-side fetches (no SSRF surface yet) |
| Upload security | n/a | No uploads yet (see Attachments) |
| Audit logs | ✅ | Moderation and role changes; never message content |
| Secret management and key rotation | 🟡 | Env secrets; rotation procedure documented. Rotating `BETTER_AUTH_SECRET` invalidates sessions and TOTP secrets: multi-key rotation P2 |
| Dependency scanning | ✅ | `pnpm audit` in CI, Dependabot |
| Responsible disclosure | ✅ | [SECURITY.md](../SECURITY.md) |
| Secure-by-default deployment | ✅ | Secrets required, DB not exposed, non-root container, HTTPS only |

### 6. Moderation and trust

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Configurable moderation tools | 🟡 | Kick, ban with reason, unban, message removal, roles |
| Explanations for restrictions | 🟡 | Reasons recorded in the audit log; showing the reason to the affected person P1 |
| Appeals | ❌ | P1 |
| Role-based moderation access | ✅ | |
| Blocking and reporting | ❌ | **P1** — needed before DMs ship |
| Anti-harassment, anti-phishing, anti-grooming | ❌ | P1 (link warnings, DM restrictions by default); requires reporting first |
| Minor protection and age safeguards | ❌ | **P1 legal review** for the official instance. Self-attested minimum age at sign-up as a baseline; no ID collection |
| Rules for the official instance | ❌ | P1: published terms and community guidelines |

### 7. UX, performance and accessibility

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Minimal, consistent UI | ✅ | shadcn/ui on Base UI, dark theme |
| Keyboard navigation | ✅ | Enter/Shift+Enter, Escape, focus-visible styles, labelled controls |
| WCAG 2.2 AA | 🟡 | axe checks (WCAG 2.0–2.2 A/AA) pass on landing, auth, chat and settings; manual screen-reader audit pending |
| Responsive | ✅ | Off-canvas navigation on mobile, tested on Pixel 7 profile |
| Optimistic UI | ✅ | Pending messages, rollback with draft restore on failure |
| Virtualised history | 🟡 | Pagination + `content-visibility`; true windowing P1 when profiling shows a need |
| Reconnect and recovery | ✅ | Heartbeat watchdog, online/offline detection, gap-safe resync, visible connection state; offline recovery tested end-to-end |
| Loading, empty, offline, error states | ✅ | |

### 8. Open ecosystem

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Documented public API | ❌ | P1: versioned REST API with tokens; OpenAPI |
| Bots and integrations | ❌ | P1: bot accounts with scoped permissions, incoming webhooks |
| Contribution guidelines | ✅ | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Automated tests, reproducible builds | ✅ | CI: lint, types, audit, unit/integration, build, Playwright; lockfile-frozen Docker build |

### 9. Funding and sustainability

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Donations page with costs and goals | ❌ | P1 — needs real cost figures from the operator; we won't publish invented numbers |
| Governance and licensing | 🟡 | AGPL-3.0 core; governance document P1; trademark review of the name pending |
| Dependency license compatibility | 🟡 | All runtime dependencies are MIT/Apache-2.0/ISC/BSD; automated license check P2 |

## Prioritised plan

### P0 — text-chat MVP (done in this branch)

Communities, channels, roles and hierarchy, invites, kick/ban/audit, realtime messages, edit/delete,
GDPR export and deletion, password reset, 2FA, passkeys, security headers, backups, docs.
Acceptance: the Playwright suites in `apps/web/e2e` pass on desktop and mobile profiles.

### P1 — before inviting the public to the official instance

| Item | Depends on | Acceptance criteria |
| --- | --- | --- |
| Reporting and blocking | — | A member can report a message; moderators see a queue; blocked users' messages are hidden and DMs refused |
| Minimum-age attestation and published rules | legal review | Sign-up requires an age attestation; terms and guidelines linked from sign-up |
| Anti-raid controls | — | Per-community join-rate limit; owners can pause invites; tests simulate a burst of joins |
| Attachments | storage decision ([DECISIONS.md](DECISIONS.md)) | Type/size validated server-side, images re-encoded without EXIF, served with `Content-Disposition` and a sandboxed origin or strict CSP; delete with message/account |
| Replies, mentions, reactions, pins | — | Mentions notify only members who can read the channel |
| Per-channel permission overrides | — | Hidden channels never appear in lists, SSE or search for members without access (tests) |
| Direct messages with E2EE | blocking, audited protocol library | Server stores ciphertext only; key verification UI; docs state guarantees and limits |
| Search | per-channel permissions | Results limited to readable channels; tested |
| Presence and notification settings | mentions | Opt-in presence visibility |
| Voice channels (LiveKit) | — | Self-host compose profile with LiveKit + TURN; join/leave permissions enforced by short-lived server-issued tokens |
| Per-community export | — | JSON + attachments archive importable on another instance |
| Retention jobs | — | Expired sessions/verifications purged daily; audit log kept 180 days |
| Ban explanations and appeals | reporting | The banned person sees the reason and can submit one appeal |
| Public API, bot accounts, webhooks | per-channel permissions | Scoped tokens, rate limits, OpenAPI spec |
| Funding page | operator cost data | Real costs, recurring and one-time options, no dark patterns |

### P2 — later

Video and screen sharing, threads, opt-in public indexable channels,
federation research (ActivityPub/Matrix bridges), native app shells, secret multi-key rotation,
automated license checks.
