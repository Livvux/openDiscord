# Roadmap and gap analysis

Status as of 2026-10-15, audited against the code on `main` plus the open feature PRs that update this
file. "Implemented" means implemented end-to-end and covered by automated tests (Vitest and Playwright);
anything less is listed as partial or missing. Nothing here is a claim of production readiness: there has
been no external security audit.

## Why openDiscord exists

We separate what is verifiable about Discord from what is opinion, and design against the verifiable parts.

| Shortcoming | Kind | Our answer |
| --- | --- | --- |
| Proprietary, cannot be self-hosted; communities depend on one company's policies and continuity | Verified (product fact) | AGPL-3.0, Docker Compose deployment, same release on the official instance |
| Text messages are not end-to-end encrypted; Discord added E2EE for audio/video calls (DAVE protocol, 2024), not for text | Verified (Discord announcement) | We say plainly what is and isn't E2EE ([PRIVACY.md](PRIVACY.md)); E2EE DMs are P1 |
| Features gated behind a subscription (upload size, stream quality) | Verified (Nitro feature list) | No artificial limits; operators set limits for cost reasons only |
| A third-party support vendor breach exposed government ID photos submitted for age appeals (disclosed by Discord, October 2025) | Verified (Discord disclosure) | Collect no identity documents; age safeguards must be privacy-preserving ([THREAT-MODEL.md](THREAT-MODEL.md)) |
| Community knowledge is locked inside the app and not findable on the web | Verified (content is not public by default) | Private by default; opt-in public, indexable channels (P2) |
| Bans and account actions with little explanation or appeal | Widely reported, anecdotal | Audit log with reasons now; ban explanations and appeals P2 |
| Heavy desktop client, notification noise, cluttered UI | Subjective | Lean web client, few notifications by default; measured, not assumed |

## Current assessment

`main` runs the text-chat MVP in production (opendiscord.app, closed alpha): communities, channels,
roles with a permission hierarchy, invites, moderation (kick, ban, message removal, audit log), realtime
messaging over Server-Sent Events, image attachments in S3-compatible storage, reporting of messages and
communities, instance administration (closed-alpha approval queue, account and community suspension,
invite policy, caps, instance audit log), Turnstile on sign-up, GDPR export and deletion, password reset,
TOTP and passkeys, backups, and architecture, threat-model and privacy documentation.

The gaps below are ordered by the priorities in the [prioritised plan](#prioritised-plan).

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
| Export per community (channels, messages, roles, settings) | ❌ | **P2** — whole-instance backup exists, per-community export does not |
| Migration and recovery docs | ✅ | [SELF-HOSTING.md](SELF-HOSTING.md) |
| Hosted service has no exclusive capabilities | ✅ | One codebase, no feature flags or license keys |
| Federation-ready design | 🟡 | UUID ids, no global user directory. Federation research P3 |

### 3. Messaging and communities

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Communities and channels | ✅ | |
| Categories | ❌ | P2 |
| Direct messages | ❌ | **P1** (with E2EE) |
| Realtime text messaging | ✅ | SSE + LISTEN/NOTIFY, gap recovery on reconnect |
| Replies, mentions, reactions | 🟡 | Mentions with autocomplete, badges and opt-in desktop notifications ✅; replies and reactions P1 |
| Threads | ❌ | P2 |
| Attachments | 🟡 | Images in S3-compatible storage (R2) with server-side validation and EXIF stripping; other file types, local volume, optional ClamAV P2 |
| History and pagination | ✅ | Cursor pagination (UUIDv7) |
| Search | ❌ | P1: Postgres full-text search, membership-scoped |
| Notification preferences | 🟡 | Opt-in desktop notifications per browser ✅; per-community all/mentions/nothing P1 |
| Roles and granular permissions | ✅ | Community roles with hierarchy; per-channel allow/deny overrides per role (view, send, delete others' messages) for private and read-only channels |
| Invites and onboarding | 🟡 | Expiring, limited-use invites ✅; rules/onboarding screen P2 |
| Presence and status | ❌ | P1 |
| Edit, delete, moderate messages | ✅ | Pinning P1 |
| Opt-in public, indexable channels | ❌ | P3 |

### 4. Voice, video and screen sharing

All ❌. Voice channels are **P1** (LiveKit, see [DECISIONS.md](DECISIONS.md)); video and screen sharing P2.
They are deliberately outside the text MVP: they bring an SFU, TURN and UDP ports to every deployment.

### 5. Security

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Threat model | ✅ | [THREAT-MODEL.md](THREAT-MODEL.md) |
| Authentication and recovery | ✅ | Password (min 10), email verification and reset when SMTP is set, sessions revoked on reset |
| Passkeys and TOTP 2FA | ✅ | Better Auth plugins; tested with a virtual authenticator and RFC 6238 codes |
| Rate limiting, anti-spam | 🟡 | Auth endpoints (Better Auth), messages (5 per 5 s per user), 30 mutations per 10 s per user, caps on communities/channels/roles/invites, 8 live streams per user. Auth limits are shared in Postgres; the mutation burst limit and stream caps are per process (shared store P1); per-community join limits P0 |
| Anti-raid | ❌ | **P0**: join-rate limits per community, invite pause, minimum account age option |
| Sessions and permission enforcement | ✅ | Every service call re-checks membership and permissions; integration-tested |
| IDOR, XSS, CSRF, SSRF, SQLi, privilege escalation | ✅ | Tests cover non-member access, role escalation and HTML injection; no server-side fetches (no SSRF surface yet) |
| Upload security | 🟡 | Images re-encoded server-side, private storage, membership-checked delivery (THREAT-MODEL T23) |
| Audit logs | ✅ | Moderation and role changes; never message content |
| Secret management and key rotation | 🟡 | Env secrets; rotation procedure documented. Rotating `BETTER_AUTH_SECRET` invalidates sessions and TOTP secrets: multi-key rotation P2 |
| Dependency scanning | ✅ | `pnpm audit` in CI, Dependabot |
| Responsible disclosure | ✅ | [SECURITY.md](../SECURITY.md) |
| Secure-by-default deployment | ✅ | Secrets required, DB not exposed, non-root container, HTTPS only |

### 6. Moderation and trust

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Configurable moderation tools | 🟡 | Kick, ban with reason, unban, message removal, roles, channel overrides; instance admins suspend accounts and communities |
| Explanations for restrictions | 🟡 | Reasons recorded in the audit log; showing the reason to the affected person P2 |
| Appeals | ❌ | P2 |
| Role-based moderation access | ✅ | |
| Blocking and reporting | 🟡 | Reporting of messages and communities with an instance-admin queue ✅; blocking **P0** |
| Anti-harassment, anti-phishing, anti-grooming | ❌ | P1 (link warnings, DM restrictions by default); requires reporting first |
| Minor protection and age safeguards | ❌ | **P1 legal review** for the official instance. Self-attested minimum age at sign-up as a baseline; no ID collection |
| Rules for the official instance | ❌ | P2: published terms and community guidelines |

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
| Documented public API | ❌ | P2: versioned REST API with tokens; OpenAPI |
| Bots and integrations | ❌ | P2: bot accounts with scoped permissions, incoming webhooks |
| Contribution guidelines | ✅ | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Automated tests, reproducible builds | ✅ | CI: lint, types, audit, unit/integration, build, Playwright; lockfile-frozen Docker build |

### 9. Funding and sustainability

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Donations page with costs and goals | ❌ | P2 — needs real cost figures from the operator; we won't publish invented numbers |
| Governance and licensing | 🟡 | AGPL-3.0 core; governance document P2 |
| Dependency license compatibility | 🟡 | All runtime dependencies are MIT/Apache-2.0/ISC/BSD; automated license check P2 |

## Prioritised plan

The goal is a minimal, polished, self-hostable Discord alternative, not a feature-for-feature clone.
Each item ships with a migration (if needed), integration tests, a Playwright flow and docs.

### P0 — closed alpha essentials

| Item | Status | Acceptance criteria |
| --- | --- | --- |
| Private channels with granular role permissions | ✅ | Hidden channels never appear in lists, message APIs, reports or the realtime stream for members without access (tests) |
| Unread state, @mentions, notifications | ✅ | Unread markers per channel and community; mentions notify only members who can read the channel; opt-in desktop notifications |
| Blocking, anti-raid, invite controls | ❌ | Blocked users' messages collapsed and their mentions silent; owners pause invites; join-rate limit and minimum account age per community |
| Production readiness | ❌ | Lint, types, unit/integration, build, Playwright and Docker build green; deployment smoke-tested |

### P1 — core Discord replacement

| Item | Depends on | Acceptance criteria |
| --- | --- | --- |
| Voice channels (LiveKit) | — | Optional compose profile with LiveKit + TURN; join/speak permissions enforced by short-lived server-issued tokens |
| Direct messages with audited E2EE | blocking, audited protocol library ([D10](DECISIONS.md)) | Server stores ciphertext only; key verification UI; docs state guarantees and limits |
| Search | channel permissions | Postgres full-text search limited to readable channels |
| Replies, reactions, pins, Markdown | — | Safe Markdown subset rendered without raw HTML |
| Presence and notification preferences | mentions | Opt-in presence; per-community all/mentions/nothing |
| Basic AutoMod | — | Per-community blocked words and link rules, audited |

### P2 — important improvements

Screen sharing and video calls, threads, channel categories, non-image file attachments, bot accounts,
incoming webhooks and a versioned public API (OpenAPI), Web Push notifications (VAPID, no third-party
service), per-community export/import, retention jobs, ban explanations and appeals, published rules and
minimum-age attestation (needs legal review), funding page (needs real operator cost data).

### P3 — later

Custom emojis and stickers, native app shells, federation research (ActivityPub/Matrix bridges),
opt-in public indexable channels and community discovery, secret multi-key rotation, automated
license checks.
