# Threat model

Scope: the text-chat MVP (web app, Postgres, Caddy) as deployed by `docker-compose.yml`.
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
  instance they use. This is why E2EE for private conversations is on the roadmap and why we say
  clearly that community messages are readable by the operator today.
- **Network attacker**: on-path between browser and server.

## Trust boundaries

1. Browser ↔ Caddy (internet, TLS).
2. Caddy ↔ web (Docker network). `web` trusts `X-Forwarded-For` from Caddy for rate limiting (Caddy
   overwrites it with the client IP, honouring `Cf-Connecting-Ip` only from `TRUSTED_PROXIES`); `web` is
   not published on a host port, so clients can't spoof it. **Operators who expose `web` directly
   must strip `X-Forwarded-For` at their own proxy.**
3. web ↔ Postgres (Docker network, password auth, not exposed).
4. Service layer ↔ UI: every server action and route handler calls a service that authorises.

## Threats and mitigations

| # | Threat (STRIDE) | Mitigation | Status |
| --- | --- | --- | --- |
| T1 | Spoofing: credential stuffing, brute force | Better Auth per-IP rate limits on sign-in/sign-up; min. password length 10; optional TOTP; passkeys | ✅ (shared across replicas: D4) |
| T2 | Spoofing: session theft | HttpOnly, Secure, SameSite cookies; HSTS; sessions revocable in settings; all sessions revoked on password reset | ✅ |
| T3 | Spoofing: phishing via open redirect after sign-in | `safeNextPath` parses like a browser and rejects `//`, `\`, control characters | ✅ tested |
| T4 | Tampering: CSRF on mutations | Server Actions enforce same-origin; Better Auth checks `Origin`; no state-changing GET routes | ✅ |
| T5 | Tampering: SQL injection | Drizzle parameterised queries only; no string-built SQL with user input | ✅ |
| T6 | Tampering/EoP: moderator escalates via roles | Strict rank comparison, permission subset rule, community-row lock in every role/member mutation | ✅ tested |
| T7 | EoP: lower moderator lifts a higher moderator's ban | Unban requires outranking the issuing moderator | ✅ tested |
| T8 | Info disclosure: IDOR across communities | `requireMember`/`requireChannel` on every read and write; non-members get 404 | ✅ tested |
| T9 | Info disclosure: realtime events to removed members | Membership checked on connect; stream closed on removal events; re-checked after LISTEN reconnects; 10-minute stream lifetime | ✅ |
| T10 | Info disclosure: emails exposed to members | Member lists and messages carry display names only | ✅ |
| T11 | Info disclosure: private content indexed | `robots.txt` + `noindex` for `/app`, `/invite`, `/api` | ✅ |
| T12 | Info disclosure: secrets in data export | Export excludes password hash, tokens, TOTP secrets and passkey keys | ✅ tested |
| T13 | XSS through messages or names | React escapes all text; no `dangerouslySetInnerHTML` with user data; Markdown is a small subset parsed into React elements, links only for http(s) with `noopener noreferrer nofollow`; CSP restricts sources to self | ✅ tested (CSP allows inline scripts, see D-notes) |
| T14 | Clickjacking | `frame-ancestors 'none'` | ✅ |
| T15 | DoS: message spam | 5 messages / 5 s per user (Postgres-counted), 4000-character limit | ✅ |
| T16 | DoS: resource creation loops | Burst limit of 30 mutations per 10 s per user; caps on owned communities, channels, roles, active invites | ✅ (burst limit per process) |
| T17 | DoS: SSE connection flood | 8 streams per user per process; heartbeats; one message load per event | ✅ |
| T18 | DoS: raids (mass joins via a leaked invite) | Expiring and limited-use invites; bans block rejoin; per-community raid protection auto-pauses invites after N joins in 10 minutes (joins serialised per community); manual invite pause; minimum account age | ✅ |
| T19 | Repudiation: moderators deny actions | Audit log of kicks, bans, unbans, role and channel changes, moderator message deletions | ✅ |
| T20 | Info disclosure: operator or database compromise | TLS, DB not exposed, TOTP secrets encrypted; message content is plaintext in the DB | 🟡 E2EE for DMs P1; disk encryption is the operator's job |
| T21 | Supply chain: vulnerable dependency | Lockfile-frozen builds, `pnpm audit` in CI, Dependabot | ✅ |
| T22 | SSRF | The server makes no requests to user-supplied URLs (no link previews or webhooks yet) | ✅ n/a; required review before link previews/webhooks |
| T23 | Malicious uploads | Images only; type decided by the decoder, not the client; re-encoded to WebP (no EXIF/GPS, no polyglots, no SVG); size checked before the body is read; pixel and frame caps; per-user upload rate and pending-upload caps; private bucket; served with `nosniff`, `Content-Security-Policy: sandbox` and membership checks | ✅ images (no malware scanning; ClamAV P1) |
| T24 | Spam sign-ups / account farming | Cloudflare Turnstile verified server-side on sign-up (when configured); 5 sign-ups per 10 min per IP; optional Closed Alpha: new accounts need admin approval before any session is issued | ✅ (shared across replicas: D4) |
| T24 | Account enumeration | Password reset answers identically for unknown emails. Sign-up reveals that an email is taken (accepted trade-off for usability) | 🟡 |
| T26 | Voice: joining without permission, staying after removal, eavesdropping | Tokens only after channel checks (Join voice/Speak), 60-second lifetime (tokens can't be revoked), microphone-only grants, no data channel; participants re-checked and removed on kick/ban/suspension/transfer/role or override changes, again after the token lifetime; LiveKit server API not exposed publicly; DTLS-SRTP in transit | 🟡 not end-to-end encrypted; removal is best effort if LiveKit is unreachable |
| T25 | Child safety, grooming, harassment | Blocking and reporting ✅; age attestation and DM restrictions pending | 🟡 age attestation and DM restrictions required before public launch of the official instance |

## Residual risks we accept for the MVP

- `script-src 'unsafe-inline'`: a nonce-based CSP would force every page to render dynamically. XSS
  defence relies on React escaping and on never rendering user HTML. Revisit before rich text or embeds.
- The mutation burst limit and stream caps are per process (auth limits are shared). With several replicas, share them too (D4).
- Not-found pages inside streamed routes return HTTP 200 (D12); no data is rendered.

## Verification

`pnpm test` and `pnpm test:e2e` contain the regression tests referenced above. An external review is
recommended before the official instance opens to the public.
