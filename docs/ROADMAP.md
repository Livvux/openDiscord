# Roadmap and gap analysis

Readiness reconciliation: 2026-10-21 against baseline `f4bb1f3` and the pending readiness PRs.
Implementation, automated acceptance, deployment and external review are separate evidence states.
A checkmark describes the stated implementation/test scope; it does not establish production readiness
or an external audit. See the [evidence ledger](superpowers/plans/2026-10-15-roadmap-completion.md#main-acceptance-checkpoint-2026-10-16).

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

**Open Beta is NO-GO.** The current production checkout equals baseline `f4bb1f3`, and all 40 ordered
migration hashes match its SQL journal through `0039_dm_calls`. The running immutable web image
has no source-revision label, so checkout equality does not prove which commit serves traffic.
Public health/readiness respond successfully. The current off-host backup was restored in isolation
with app login and authenticated avatar readback. Capacity, failed retention (missing migrate image),
Voice scheduling, actual alert delivery and external/device gates remain open in
[OPEN-BETA-READINESS.md](OPEN-BETA-READINESS.md). No beta release is published or authorized.

Encrypted DMs, private complete archives, custom emoji/stickers, explicit public channels/discovery,
operator policies, 16-year signup self-attestation, funding disclosure and auth-key rotation support
are implemented. Desktop/mobile automated web acceptance passes. Real HTTP/SSE characterization,
real ClamAV-engine rejection and populated operational-backup recovery now have isolated CI evidence.
The official instance has ClamAV configured in the app and a healthy private scanner/monitor
(verified 2026-10-21). Isolated real-engine CI is green; current clean/EICAR production uploads through
an authenticated browser remain an explicit acceptance gate. See [ops/scanner](../ops/scanner/README.md)
and [OPEN-BETA-READINESS.md](OPEN-BETA-READINESS.md).

Production SFU and forced TURN/TLS transport passed controlled two-Chromium synthetic-media checks.
Voice E2EE passes the three-account product acceptance workflow in CI (synthetic Chromium media).
Physical devices, additional browsers and a production activation record remain open. Native desktop bundles are preview artifacts;
full native application-flow acceptance remains open. Physical-device media, actual inbox delivery, real push-service delivery,
manual screen-reader acceptance and independent security/crypto/legal/license reviews remain open.

## Requirements matrix

Legend: ✅ implemented and tested · 🟡 partial · ❌ missing · Priority for open items.

### 1. Privacy and data protection

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Collect only necessary data | ✅ | Email, display name, password hash and sessions; coarse browser/platform labels, no raw session user-agent or IP. Legacy metadata minimized by maintenance |
| No analytics, ads or trackers | ✅ | No application analytics. Cloudflare RUM injection disabled for the official hostname and browser-verified; optional Turnstile and configured media services still make external requests |
| Retention and deletion policies | 🟡 production failure | Bounded dry-run/apply policy exists; expired credentials/limits and resolved moderation/audit retention 180 days. Hourly production job currently fails because its migrate image is missing; repair and completion proof required |
| GDPR access/export | ✅ | `/api/me/export`, JSON, tested |
| GDPR correction | ✅ | Display name editable; SMTP-gated email change confirms current address and verifies new address; recent-session guard. Real inbox acceptance remains separate |
| GDPR deletion | ✅ | Deletes account, sessions, messages; blocked while owning a community |
| Explicit public posting acknowledgement | ✅ | Publication is opt-in per channel; each author or integration acknowledges the current publication generation. No birth dates or identity documents are collected |
| Minimise IPs, logs, metadata | ✅ | IPs not stored with sessions; Caddy access logs off; app logs errors only |
| Encryption in transit | ✅ | HTTPS + HSTS; official instance uses Cloudflare/Traefik, standalone deployment uses Caddy |
| Encryption at rest | 🟡 | TOTP secrets and backup codes encrypted by Better Auth; database relies on disk encryption (documented). Column-level encryption is not planned for message content because the server must read it to serve it |
| E2EE for private communication | 🟡 external review open | 1:1/group DMs and DM attachments use Matrix crypto; supported Voice calls encrypt media frames. Community text and its attachments remain server-readable. Independent integration audit and physical-device acceptance remain open. |
| Private content out of search engines and public APIs | ✅ | `robots.txt`, `noindex` on `/app` and `/invite`; private content APIs require membership; anonymous public HTML exposes only explicitly published text channels |

### 2. Data ownership and self-hosting

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Independent instances | ✅ | Docker Compose stack verified end-to-end (TLS, auth, SSE through Caddy) |
| No mandatory proprietary services | ✅ | SMTP optional; no external APIs |
| Portable backup and restore | ✅ | `scripts/backup.sh` / `restore.sh` round trip tested; unchanged operational production-backup script rehearsed with a populated private attachment, separate DB/S3 and retrieval/negative controls (#71). Newest production-data restore remains separately gated |
| Export per community (channels, messages, roles, settings) | ✅ | Owner-only JSON export (roles, categories, channels, overrides, messages; mentions as names, no account ids), audited; import creates a new community with messages marked as imported. JSON excludes attachment bytes. Complete gzip file archives shipped in PR #39 with private storage, checksummed streams, atomic import and desktop/mobile acceptance; library-complete archive v3 shipped in PR #41 |
| Migration and recovery docs | ✅ | [SELF-HOSTING.md](SELF-HOSTING.md) |
| Hosted service has no exclusive capabilities | ✅ | One codebase, no feature flags or license keys |
| Federation research | ✅ research only | [DECISIONS.md D13](DECISIONS.md#d13-federation-research-retain-instance-boundaries): retain instance boundaries; future opt-in Matrix bridge requires separate consent, permissions and acceptance. No federation implemented |

### 3. Messaging and communities

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Communities and channels | ✅ | |
| Categories | ✅ | Collapsible sidebar groups managed with *Manage channels*; no permissions of their own |
| Direct messages | ✅ | Encrypted requests, verified devices, recovery and desktop/mobile acceptance shipped in #30; external cryptographic audit remains open |
| Realtime text messaging | ✅ | SSE + LISTEN/NOTIFY, gap recovery on reconnect |
| Replies, mentions, reactions | ✅ | Mentions with autocomplete, badges and opt-in desktop notifications; replies with previews; emoji reactions (quick set, max 20 per message) |
| Threads | ✅ | Threads on top-level messages, shown in a side panel; the channel shows a reply summary |
| Attachments | ✅ | Images re-encoded without EXIF (8 MB); other files up to 25 MB stored unchanged and only served as downloads; S3-compatible storage (R2, MinIO, Garage). Local private volume and optional fail-closed ClamAV protocol integration implemented; production uses R2 without a scanner |
| History and pagination | ✅ | Cursor pagination (UUIDv7) |
| Search | ✅ | Postgres full-text search (`simple` configuration, word-prefix matching), limited to channels the person can read; blocked authors excluded; Ctrl/Cmd+K |
| Notification preferences | ✅ | Opt-in desktop notifications per browser; per-community Mentions/Muted |
| Roles and granular permissions | ✅ | Community roles with hierarchy; per-channel allow/deny overrides per role (view, send, delete others' messages) for private and read-only channels |
| Invites and onboarding | ✅ | Expiring/revocable invites, join requirements and versioned rules acknowledgement, enforced on joins and content mutations |
| Presence and status | ✅ | Opt-in online status (off by default), heartbeat from open tabs, shown on avatars and member lists |
| Edit, delete, moderate messages | ✅ | Pinning (max 50 per channel, audited); safe Markdown subset (code, quotes, bold/italic/strike, http(s) links) rendered without raw HTML |
| Opt-in public, indexable channels | ✅ | Explicit publication, separate public title, current-generation author acknowledgement, text-only anonymous pages, reporting, discovery and terminal unpublish shipped in #44; existing channels remain private |

### 4. Voice, video and screen sharing

Voice channels ✅ on self-hosted LiveKit as an optional compose profile ([DECISIONS.md](DECISIONS.md) D8): permission-checked
short-lived tokens, *Join voice*/*Speak* per channel, removal on loss of access, calls survive navigation.
Video and screen-share publication paths are implemented (separate *Video* permission, per channel).
Supported browsers encrypt media frames before LiveKit transport; unsupported browsers fail closed.
Successful screen-share publication/reception, real-device acceptance and independent crypto review
remain gates in [OPEN-BETA-READINESS.md](OPEN-BETA-READINESS.md).

### 5. Security

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Threat model | ✅ | [THREAT-MODEL.md](THREAT-MODEL.md) |
| Authentication and recovery | ✅ | Password (min 10), email verification and reset when SMTP is set, sessions revoked on reset |
| Passkeys and TOTP 2FA | ✅ | Better Auth plugins; tested with a virtual authenticator and RFC 6238 codes |
| Rate limiting, anti-spam | ✅ | PostgreSQL-backed auth/mutation counters and expiring SSE leases; per-user, per-scope 8-stream caps, community caps and shared anti-raid controls; concurrent integration tests |
| Anti-raid | ✅ | Per-community invite pause, minimum account age, raid protection that auto-pauses invites after N joins in 10 minutes (default 30); all audited |
| Sessions and permission enforcement | ✅ | Every service call re-checks membership and permissions; integration-tested |
| IDOR, XSS, CSRF, SSRF, SQLi, privilege escalation | 🟡 release review | Tests cover non-member access, role escalation and HTML injection. User push endpoints are allowlisted; storage/SFU fetches use operator configuration. Confirmed mutation-authorization races have a tested fix in #126 pending merge/deploy; external pentest remains open |
| Upload security | 🟡 | Images re-encoded, private authorized delivery; fail-closed ClamAV real-engine cases (#68). Production web namespace passed clean/EICAR with fresh loaded signatures on 2026-10-21; authenticated production upload acceptance remains separate (THREAT-MODEL T23) |
| Audit logs | ✅ | Moderation and role changes; never message content |
| Secret management and key rotation | ✅ support | Native Better Auth versioned encryption keys, legacy fallback and Compose passthrough. Real TOTP/backup-code and browser tests; retain keys needed by old ciphertext/backups. Primary-key changes can invalidate cookies/tokens. No automatic bulk re-encryption or scheduled key retirement |
| Dependency scanning | ✅ | `pnpm audit` in CI, Dependabot |
| Responsible disclosure | ✅ | [SECURITY.md](../SECURITY.md) |
| Secure-by-default deployment | ✅ | Secrets required, DB not exposed, non-root container, HTTPS only |

### 6. Moderation and trust

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Configurable moderation tools | ✅ | Kick, ban with reason, unban, message removal, pins, roles, channel overrides, AutoMod (blocked words, links); instance admins suspend accounts and communities |
| Explanations for restrictions | ✅ | Affected members can read their private community restriction reason; permission-scoped and tested |
| Appeals | ✅ | One appeal per ban issuance, private moderator resolution and audited optional unban; no automatic rejoin |
| Role-based moderation access | ✅ | |
| Blocking and reporting | ✅ | Reporting of messages and communities with an instance-admin queue; personal blocking (messages collapsed, mentions silent, not disclosed to the blocked person). DM refusal ships with DMs |
| Anti-harassment, anti-phishing, anti-grooming | 🟡 | Blocking, reporting and per-community AutoMod (blocked words, links) ✅; DM restrictions by default ship with DMs |
| Minor protection and age safeguards | 🟡 | Required 16-year self-attestation on the official instance, enforced before signup. No DOB/ID collection; self-attestation is not proof of age. External legal review remains open |
| Rules for the official instance | ✅ published | Public terms, guidelines, privacy notice and operator-supplied imprint; external legal review not claimed |

### 7. UX, performance and accessibility

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Minimal, consistent UI | ✅ | shadcn/ui on Base UI, dark theme |
| Keyboard navigation | ✅ | Enter/Shift+Enter, Escape, focus-visible styles, labelled controls |
| WCAG 2.2 AA | 🟡 | axe checks (WCAG 2.0–2.2 A/AA) pass on landing, auth, chat and settings; manual screen-reader audit pending |
| Responsive | ✅ | Off-canvas navigation on mobile, tested on Pixel 7 profile |
| Optimistic UI | ✅ | Pending messages, rollback with draft restore on failure |
| Virtualised history | 🟡 | Pagination + `content-visibility`; true windowing P1 when profiling shows a need |
| Measured scaling | 🟡 bounded characterization | #67: real HTTP/SSE, 20 readers, 100 history reads, 16 writes plus reconnect sentinel, 320 fanout receipts. Single process; no production/multi-replica capacity, application CPU/RSS or SLO claim |
| Reconnect and recovery | ✅ | Heartbeat watchdog, online/offline detection, gap-safe resync, visible connection state; offline recovery tested end-to-end |
| Loading, empty, offline, error states | ✅ | |

### 8. Open ecosystem

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Documented public API | ✅ | `/api/v1` for bot tokens with OpenAPI 3.1 ([API.md](API.md)) |
| Bots and integrations | ✅ | Bot accounts as role-scoped members; incoming webhooks per channel; hashed tokens; audited |
| Contribution guidelines | ✅ | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Automated tests, reproducible builds | ✅ | CI: lint, types, audit, unit/integration, build, Playwright; lockfile-frozen Docker build |

### 9. Funding and sustainability

| Requirement | Status | Notes / priority |
| --- | --- | --- |
| Donations page with costs and goals | ✅ | Public /funding: operator-reported EUR250/month and supplied GitHub Sponsors link; no invented cost breakdown or donation progress |
| Governance and licensing | ✅ | AGPL-3.0 core and GOVERNANCE.md; paid support does not buy moderation powers |
| Dependency license compatibility | 🟡 | CI declaration inventory and acknowledgement gate implemented, including MPL-2.0 and CC-BY declarations. This is not professional legal compatibility review |

## Prioritised plan

The goal is a minimal, polished, self-hostable Discord alternative, not a feature-for-feature clone.
Each item ships with a migration (if needed), integration tests, a Playwright flow and docs.

### P0 — closed alpha essentials

| Item | Status | Acceptance criteria |
| --- | --- | --- |
| Private channels with granular role permissions | ✅ | Hidden channels never appear in lists, message APIs, reports or the realtime stream for members without access (tests) |
| Unread state, @mentions, notifications | ✅ | Unread markers per channel, community and private conversation; mentions notify only members who can read the channel; new DMs notify by sender only (desktop and Web Push, never text); opt-in desktop notifications |
| Blocking, anti-raid, invite controls | ✅ | Blocked users' messages collapsed and their mentions silent; owners pause invites; join-rate limit and minimum account age per community |
| Production readiness | ✅ | Lint, types, unit/integration, build, Playwright, `pnpm audit` and Docker build green; full Compose stack smoke-tested locally (fresh migrations, TLS, sign-up, export, SSE through Caddy); HSTS sent by the app behind any proxy. Rolling the release out to opendiscord.app is an operator step |

### P1 — core Discord replacement

| Item | Status | Acceptance criteria |
| --- | --- | --- |
| Voice channels (LiveKit) | ✅ | Optional compose profile with LiveKit; join/speak permissions enforced by short-lived server-issued tokens (official TURN/TLS relay on TCP443 accepted with synthetic two-client Chromium media; physical devices and voice E2EE remain open) |
| Direct messages with audited E2EE | 🟡 external audit open | Matrix crypto WASM18.9.0 device verification, ciphertext transport and bounded recovery merged in #30. Exact-head desktop/mobile runtime acceptance passed; independent integration audit remains open. No plaintext fallback. Unread counts, live list/Home updates over the personal event stream and content-free push added 2026-10-17. Group DMs (#112) and encrypted files (#110) added; E2EE voice/video calls with screen sharing in 1:1 and group conversations reuse the Voice call stack (conversation membership instead of channel permissions, revocation on leave/removal/block/suspension, content-free ringing and missed calls kept in the browser; Chromium and Firefox product e2e, no physical-device or Safari acceptance) |
| Search | ✅ | Postgres full-text search limited to readable channels |
| Replies, reactions, pins, Markdown | ✅ | Safe Markdown subset rendered without raw HTML |
| Presence and notification preferences | ✅ | Opt-in presence; per-community Mentions/Muted |
| Basic AutoMod | ✅ | Per-community blocked words and link rules, audited |

### P2 — important improvements

~~Screen sharing and video calls~~ ✅, ~~threads~~ ✅, ~~channel categories~~ ✅, ~~non-image file attachments~~ ✅, ~~bot accounts,
incoming webhooks and a versioned public API (OpenAPI)~~ ✅, ~~Web Push notifications (VAPID)~~ ✅, ~~per-community export/import~~ ✅, ~~retention jobs~~ ✅, ~~ban explanations and appeals~~ ✅, ~~funding page and governance~~ ✅.
Published operator rules and minimum-age attestation shipped in #34; legal review remains external.

### P3 — later

Private custom emoji/stickers and library-complete archives shipped in #41. Explicit public channels and community discovery shipped in #44. Native desktop shells shipped as a preview without a trusted publisher signature in #45: Windows/macOS/Linux bundles pass remote build checks, and the Linux native fixture passes navigation, IPC denial, HTTPS/blob save and cancellation. Publisher signing, notarization, full application flows and Windows/macOS runtime/device acceptance remain open. Mobile native clients are not implemented; the web app is installable as a PWA (manifest, offline fallback, safe areas), checked only in emulation, and docs/MOBILE-STRATEGY.md recommends PWA first with an optional Capacitor shell. Native auth multi-key rotation and automated
license declaration checks and federation research (D13) are complete; professional compatibility review and any future federation implementation remain separate.
