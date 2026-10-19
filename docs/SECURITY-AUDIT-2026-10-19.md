# Security audit 2026-10-19

An internal code review of `main` at `52e9198`. It is not a penetration test or an external audit.
Everything below comes from reading the code, the local test suite (Postgres plus native MinIO), and
unauthenticated `GET` requests to https://opendiscord.app to check response headers. Voice
(`src/lib/voice/**`, `src/components/app/voice/**`, `/api/voice/control`) was out of scope; another
workstream covers it.

## Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| F1 | Low | `POST /api/channels/[channelId]/attachments` and `POST`/`DELETE /api/me/push` didn't check `Origin`. With a valid session cookie, a request from a foreign origin stored an upload or saved/removed a push subscription (reproduced in the new test before the fix). Two things limited the impact. Better Auth's default `SameSite=Lax` cookie keeps cross-site requests out. Push endpoints are restricted to known push services. A same-site, cross-origin page (for example a compromised subdomain) or a browser that ignores SameSite could still use up a victim's upload quota and pending-upload slots, or register a push subscription the attacker controls (on an allowed push service) and read the victim's mention notifications: author, channel, community and a 140-character excerpt of the message (`src/server/push.ts:104-109`). This also contradicted THREAT-MODEL T4. | Fixed: `assertSameOrigin` at the start of all three handlers. Test: `apps/web/tests/same-origin-routes.integration.test.ts` |
| F2 | Info | ClamAV fail-closed behaviour was correct, but only the stalled-scanner and bad-verdict cases had tests. | Tests added: connection refused, hang-up with no verdict, oversized or unterminated reply, invalid port (`tests/attachment-scanner.test.ts`). Also an end-to-end check that an unreachable scanner rejects file, image and avatar uploads and leaves no attachment row (`tests/media.integration.test.ts`). |
| F3 | Info | `reportContent` (`src/server/reports.ts:25-33`) answers "Message not found" for an unknown ID but "Channel not found" for a message in a channel you can't see. That confirms the ID exists, but message IDs are random UUIDv7 and no content is revealed. | Accepted, not changed |
| F4 | Info | `reportDirectMessage` stores the excerpt the reporter supplies, and there is no message franking. A reporter can attribute made-up text to a real DM ID. | Accepted. Moderators should treat DM excerpts as claims. |
| F5 | Info | `GET /api/dm?devices=<id>` shows a peer's device names and creation dates to anyone they share a community with. `DELETE /api/dm/backups` needs only a session and the same Origin, with no device secret and no rate limit. | Accepted (metadata and availability only) |

No Critical, High or Medium issues were found in scope.

## What was checked and found sound

**Authentication** (`apps/web/src/lib/auth.ts`, `src/server/session.ts`, `src/server/rate-limit-store.ts`)
- **CSRF and redirects:** Better Auth's origin and CSRF checks are on (no `disableOriginCheck`/`disableCSRFCheck`). They cover every cookie-carrying non-GET request, and `callbackURL`/`redirectTo` are validated against trusted origins.
- **Cookies:** httpOnly, `SameSite=Lax`, and `Secure` plus the `__Secure-` prefix over HTTPS.
- **Rate limits:** enabled in production and stored in Postgres with HMAC'd keys. The library defaults apply to sign-in, sign-up, password change, email change and password reset; a custom rule allows 5 sign-ups per 10 minutes.
- **Two-factor (TOTP):** 3 attempts per 10 seconds plus a per-account lock.
- **Proxy handling:** `TRUSTED_PROXIES` keeps CIDR entries only. The client IP is the rightmost untrusted `X-Forwarded-For` entry (`tests/client-ip.test.ts`).
- **Sessions:** revoked on password reset. Suspended accounts are rejected on every request (`requireUser` → `assertActiveUser`).
- **Email change:** needs a session younger than 1 hour and confirmation from the old address.
- **Passkeys:** the RP ID and origin are pinned to `BETTER_AUTH_URL`.
- **Account deletion:** needs the password, and is blocked for owners and instance admins.
- **Server actions** (`src/app/app/actions.ts`, `src/app/app/admin/actions.ts`): Next's default Origin/Host check applies (no `allowedOrigins`). Each action calls `requireUser` or `requireInstanceAdmin` and is rate limited.

**Authorization and IDOR** (`src/server/access.ts`, `permissions.ts`, `messages.ts`, `moderation.ts`, `communities.ts`)
- **Access checks:** every read and write calls `requireMember`/`requireChannel` again. Users you can't see return "not found". Role changes are bounded by `outranks`/`canManageRole`, so you can't grant permissions you don't have.
- **Attachments** (`media.ts` `readAttachment`): served only once linked to a message, and only to people who can read that channel.
- **Avatars** (`avatars.ts`): served only to users who share a community, a friendship or a DM.
- **Community assets** (`community-assets.ts`): members and channel readers only; changes need ManageCommunity, checked again under a lock.
- **Bot API** (`/api/v1`, `integrations.ts` `requireBot`): the token is matched on its SHA-256 hash, revoked tokens are rejected, requests are rate limited, and the bot gets only its roles' permissions.
- **Webhooks:** the token is looked up by SHA-256 hash, so no secret string is compared directly. Tokens are 256-bit, a wrong ID/token pair returns the same 404, and the token is checked again under the lock.
- **Export/import:** community export (`community-export.ts`, `community-archive.ts`) is owner-only and limited to 5 per hour. Import checks Origin and content type, caps the size and is rate limited. `/api/me/export` returns only your own data.
- **Live event streams (SSE):** `communities/[id]/events` re-checks membership on connect, on each event and on each heartbeat, and filters channel events per viewer. `me/events` is limited to your own topic, and DM notices carry IDs only.

**Uploads** (`src/server/media.ts`, `attachment-scanner.ts`, `attachment-storage.ts`)
- **Size limits:** `Content-Length` must be set and within the limit before anything is read. `readLimited` stops reading a body longer than it announced. At most 4 uploads are processed at once per process, and quotas (daily bytes, pending uploads) are enforced under an advisory lock.
- **Images:** the decoder decides the format (SVG, TIFF and PDF are refused). Pixel and frame limits apply, and images are re-encoded to WebP without EXIF.
- **Other files:** stored as `application/octet-stream`.
- **Download headers:** attachments, avatars and community assets are served with `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. Non-image files also get an `attachment` disposition with an RFC 5987 file name.
- **ClamAV:** all four entry points (message upload, archive staging, community asset, avatar) go through `storeUpload`, which scans before any database row or object is written. These all reject the upload: scanner unreachable, timeout (20 s), hang-up, oversized or garbled reply, the "INSTREAM size limit exceeded" reply, and an invalid port. Scanning is skipped only when `CLAMAV_HOST` is empty; the operator chooses that explicitly.
- **Storage keys:** keys are generated by the server and validated against a strict pattern. Local storage uses `O_NOFOLLOW` and mode 0600.

**API surface**
- **Production headers** (checked 2026-10-19 with a GET to `/` and `/api/health`): CSP with `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'` and `form-action 'self'`, plus HSTS, `nosniff`, Referrer-Policy, COOP and Permissions-Policy (`src/proxy.ts`, `next.config.ts`).
- **Errors:** `errorResponse`/`toResult` show only `AppError` messages. Anything unexpected is logged and returned as a generic 500.
- **Redirects:** `safeNextPath` (`src/lib/safe-redirect.ts`, `tests/safe-redirect.test.ts`) is the only place user input becomes a redirect target.
- **Push:** the endpoint allowlist (HTTPS, known hosts, no port) prevents SSRF.
- **Dependencies:** `pnpm audit --prod` reported "No known vulnerabilities found" on 2026-10-19.

**E2EE DMs** (`src/lib/dm/client.ts`, `src/server/direct-messages.ts`, `src/lib/dm/contracts.ts`, `src/server/push.ts`)
- **Sending:** refuses to send without a verified own identity, and refuses changed peer identities. There is no plaintext fallback.
- **Server storage:** the DM POST schema is strict and accepts only `m.megolm.v1.aes-sha2` base64 ciphertext bound to the authenticated device (`tests/direct-messages.integration.test.ts`). `dm_message.content` stores only that envelope.
- **Notifications and live events:** push payloads say "New encrypted message" and SSE DM events carry IDs only, so no plaintext preview leaves the client.
- **Device authentication:** the device secret is compared in constant time (`timingSafeEqual`). Crypto requests need an accepted, unblocked conversation.
- **Backups:** scoped to the user and capped in size and count. The server never receives the recovery key.
- **Reset:** needs a fresh session, the password, TOTP (when enabled) and the same Origin. It is rate limited and audit-logged.

## Remaining risks and what needs outside review

- **External cryptography integration audit:**
  - how the Matrix SDK is used (key-sharing strategy, session invalidation when the roster changes, trust and shield requirements);
  - the server's re-implementation of the Matrix key query, claim and to-device semantics (`handleCryptoRequest`);
  - the recovery and backup format, and device transfer;
  - the pinned `@matrix-org/matrix-sdk-crypto-wasm` 18.9.0.
- **Trust in the server (inherent to web E2EE):**
  - The server distributes identities and device keys (trust on first use). SAS verification is optional.
  - The operator delivers the JavaScript, and the CSP allows `'unsafe-inline'` scripts, so XSS or a malicious operator could read plaintext or the device secret stored in localStorage/IndexedDB.
- **Penetration test:** nothing was tested dynamically against a running instance beyond the header check. An external pentest should cover auth flows, upload parsing (sharp/libvips), SSE resource exhaustion and the voice stack.
- **Operations:**
  - Whether malware scanning is active depends on the operator setting `CLAMAV_HOST` and keeping signatures current (`ops/scanner/README.md`). Image decoding relies on keeping sharp/libvips patched.
  - Rate limits and the upload concurrency cap are per process or per database. A large multi-instance deployment needs a review.
- **Legal and compliance:** content moderation duties, DSA/GDPR processes, and how reporting works for E2EE content need review by counsel; this audit doesn't cover them.
- **Voice:** not audited here.
