# Threat model

Scope: hosted web/PWA, PostgreSQL, private media, Matrix DM integration and optional LiveKit Voice.
Default Compose uses Caddy; Dokploy uses its operator-managed reverse proxy. Configuration examples
do not prove current production activation; see [OPEN-BETA-READINESS.md](OPEN-BETA-READINESS.md).
Method: assets → actors → trust boundaries → threats (STRIDE) with mitigation and status.
Review this document whenever a feature crosses a trust boundary (uploads, DMs, voice, bots, federation).

## Assets

| Asset | Why it matters |
| --- | --- |
| Message content and community membership | Private conversations; membership itself can be sensitive |
| Account credentials: password hashes, sessions, TOTP secrets, passkeys | Account takeover |
| Email addresses | Personal data; never shown to other members |
| Roles, bans, audit log | Integrity of community governance |
| `BETTER_AUTH_SECRET`, database password | Session forgery, decryption of TOTP secrets, full data access |
| Backups | Contain everything above |

## Actors

- **Anonymous internet user**: can reach `/`, auth endpoints, invite previews.
- **Signed-in user**: can create communities and join through invites.
- **Community member / moderator / owner**: increasing authority inside one community.
- **Malicious member**: spam, harassment, attempts to escalate or read other communities.
- **Instance operator**: full access to the database and logs. Users must trust the operator of the
  instance they use. Private 1:1/group messages and attachments use browser E2EE; community content
  remains operator-readable. A malicious operator can replace delivered JavaScript and defeat
  browser confidentiality; independent integration review remains required.
- **Network attacker**: on-path between browser and server.

## Trust boundaries

1. Browser ↔ Caddy (internet, TLS).
2. Caddy ↔ web (Docker network). `web` trusts `X-Forwarded-For` from Caddy for rate limiting (Caddy
   overwrites it with the client IP, honouring `Cf-Connecting-Ip` only from `TRUSTED_PROXIES`); `web` is
   not published on a host port, so clients can't spoof it. **Operators who expose `web` directly
   must strip `X-Forwarded-For` at their own proxy.**
3. web ↔ Postgres (Docker network, password auth, not exposed).
4. Service layer ↔ UI: every server action and route handler calls a service that authorises.
5. Browser Matrix device ↔ ciphertext store: current account/session/device and conversation
   authority are separate from native key trust, browser recovery state and identity verification.
6. Browser Voice crypto/media ↔ app control ↔ SFU: current membership, admitted peers, generation
   and worker key installation must agree before capture/publication. A short JWT alone is not
   revocation of an established SFU session. Private storage, scanner, SMTP and push each have
   their own operator configuration and authorization boundaries.

## Threats and mitigations

| # | Threat (STRIDE) | Mitigation | Status |
| --- | --- | --- | --- |
| T1 | Spoofing: credential stuffing, brute force | Better Auth per-IP rate limits on sign-in/sign-up; min. password length 10; optional TOTP; passkeys | ✅ (shared across replicas: D4) |
| T2 | Spoofing: session theft | HttpOnly, Secure, SameSite cookies; HSTS; sessions revocable in settings; all sessions revoked on password reset | ✅ |
| T3 | Spoofing: phishing via open redirect after sign-in | `safeNextPath` parses like a browser and rejects `//`, `\`, control characters | ✅ tested |
| T4 | Tampering: CSRF on mutations | Server Actions enforce same-origin; Better Auth checks `Origin`; cookie-authenticated route handlers call `assertSameOrigin`/`assertDmOrigin` (tests/same-origin-routes.integration.test.ts); no state-changing GET routes | ✅ |
| T5 | Tampering: SQL injection | Drizzle parameterised queries only; no string-built SQL with user input | ✅ |
| T6 | Tampering/EoP: moderator escalates via roles | Strict rank comparison, permission subset rule, community-row lock in every role/member mutation | ✅ tested |
| T7 | EoP: lower moderator lifts a higher moderator's ban | Unban requires outranking the issuing moderator | ✅ tested |
| T8 | Info disclosure: IDOR across communities | `requireMember`/`requireChannel` on every read and write; non-members get 404 | ✅ tested |
| T9 | Info disclosure: realtime events to removed members | Membership checked on connect; stream closed on removal events; re-checked after LISTEN reconnects; 10-minute stream lifetime | ✅ |
| T10 | Info disclosure: emails exposed to members | Member lists and messages carry display names only | ✅ |
| T11 | Info disclosure: private content indexed | `robots.txt` + `noindex` for `/app`, `/invite`, `/api` | ✅ |
| T12 | Info disclosure: secrets in data export | Export excludes password hash, tokens, TOTP secrets and passkey keys | ✅ tested |
| T13 | XSS through messages or names | React escapes all text; no `dangerouslySetInnerHTML` with user data; Markdown is a small subset parsed into React elements, links only for http(s) with `noopener noreferrer nofollow`; CSP restricts sources to self and named configured providers; inline event attributes denied | ✅ tested (inline bootstrap still allowed; see residual risks) |
| T14 | Clickjacking | `frame-ancestors 'none'` | ✅ |
| T15 | DoS: message spam | 5 messages / 5 s per user, 4000-character limit; atomic shared counter correction in #126 | 🟡 baseline count/insert race; fix requires merge/deploy |
| T16 | DoS: resource creation loops | Burst limit of 30 mutations per 10 s per user; caps on owned communities, channels, roles, active invites | ✅ (atomic PostgreSQL counter shared across web processes) |
| T17 | DoS: SSE connection flood | PostgreSQL-backed expiring leases enforce 8 streams per user per scope across processes; bounded stream lifetime, heartbeats and cancellation cleanup; one message load per event | ✅ |
| T18 | DoS: raids (mass joins via a leaked invite) | Expiring and limited-use invites; bans block rejoin; per-community raid protection auto-pauses invites after N joins in 10 minutes (joins serialised per community); manual invite pause; minimum account age | ✅ |
| T19 | Repudiation: moderators deny actions | Audit log of kicks, bans, unbans, role and channel changes, moderator message deletions | ✅ |
| T20 | Info disclosure: operator or database compromise | TLS, DB not exposed, TOTP secrets encrypted; community/public message content is plaintext in the DB. DMs store Matrix-encrypted envelopes, with no plaintext fallback between verified devices; a recipient can disclose plaintext in a report | 🟡 DM integration is not independently audited; malicious operator-delivered JavaScript or compromised clients can expose plaintext. Disk encryption is the operator's job |
| T21 | Supply chain: vulnerable dependency | Lockfile-frozen builds, `pnpm audit` in CI, Dependabot | ✅ |
| T22 | SSRF | No link previews or outgoing webhooks. The only user-supplied URLs fetched are Web Push endpoints, restricted to known push services over HTTPS on the default port | ✅ n/a; required review before link previews/webhooks |
| T23 | Malicious uploads | Images: type decided by the decoder, not the client; re-encoded to WebP (no EXIF/GPS, no polyglots, no SVG); size checked before the body is read; pixel and frame caps; per-user upload rate and pending-upload caps; private bucket; served with `nosniff`, `Content-Security-Policy: sandbox` and membership checks Other files: stored unchanged but always served as `application/octet-stream` with `Content-Disposition: attachment` (RFC 5987 name), `nosniff` and `sandbox`, so uploaded HTML/SVG never renders on the app origin; file names stripped of paths, control and bidi characters | 🟡 Optional fail-closed ClamAV tested with real clean/EICAR/unavailable upload/import cases. Production web namespace accepted clean/rejected EICAR with fresh loaded signatures on 2026-10-21; authenticated production upload acceptance remains separate. Scanning is not universal malware detection. E2EE DM attachments cannot be scanned/re-encoded by the server and remain opaque downloads decrypted in the browser |
| T24 | Spam sign-ups / account farming | Cloudflare Turnstile verified server-side on sign-up (when configured); 5 sign-ups per 10 min per IP; optional Closed Alpha: new accounts need admin approval before any session is issued | ✅ (shared across replicas: D4) |
| T24 | Account enumeration | Password reset answers identically for unknown emails. Sign-up reveals that an email is taken (accepted trade-off for usability) | 🟡 |
| T26 | Voice: joining without permission, staying after removal, eavesdropping | Current product Voice checks account/session/device and channel or conversation authority; exact generation/room grants, native admitted peers, verified key installation and fail-closed media fencing are described in [voice/call-session.md](voice/call-session.md). Media frames use E2EE on supported browsers; SFU transport alone is not that guarantee. | 🟡 independent integration audit, exact production image/configuration, recurring room cleanup, physical devices and hostile-network acceptance remain release gates. The current running image has no verified source-revision label; historical deployed SHAs are not current proof |
| T27 | Integrations: leaked or guessed tokens, bots escalating | 256-bit random tokens stored as SHA-256; revocable at once; bots are members bound by roles and channel overrides, webhooks can only post plain text into one channel; per-token and message rate limits; AutoMod; audited | ✅ |
| T25 | Child safety, grooming, harassment | Blocking/reporting and restricted DM requests implemented; official signup requires 16-year self-attestation, not proof of age | 🟡 external legal/safeguarding review required before public launch |

## Residual risks we accept for the MVP

- `script-src 'unsafe-inline'`: a nonce-based CSP would force every page to render dynamically. XSS
  defence relies on React escaping and on never rendering user HTML. Revisit before rich text or embeds.
- Auth/mutation burst counters and expiring SSE leases are PostgreSQL-backed across processes.
  Concurrent upload slots remain process-local; quotas and daily byte reservations are shared.
- Not-found pages inside streamed routes return HTTP 200 (D12); no data is rendered.

## Verification

`pnpm test` and `pnpm test:e2e` contain the regression tests referenced above. An external review is
recommended before the official instance opens to the public.
