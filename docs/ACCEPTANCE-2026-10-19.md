# Production acceptance report, 2026-10-19

Evidence only. "Not tested" means exactly that; CI success, deployment and production use are separate states.

## Production vs. `main`

| Check | Result |
| --- | --- |
| Deployed revision (start of day) | `52e9198` (#107) = `main` at that time; read from the Dokploy checkout |
| Migrations | 36 applied = 36 journal entries |
| `/api/health`, `/api/ready` | 200 / 200 |
| Containers | web, db (healthy), private ClamAV scanner (healthy), LiveKit up |
| Logs, 24 h web / 72 h LiveKit | two malformed Server Action probes (bot noise); no LiveKit errors |
| Scanner wiring | `CLAMAV_HOST`/`CLAMAV_PORT` set in the web container |
| Security headers | HSTS, CSP (`frame-ancestors 'none'`, `object-src 'none'`), nosniff, COOP, Permissions-Policy, Referrer-Policy present |
| Unauthenticated `/app` | 307 to `/sign-in` |
| PWA manifest | **missing in production**: `/manifest.webmanifest` returned the HTML error page with status 200 → fixed in #111, not yet deployed |

`main` advanced during the day to `acb30f5` with migrations up to `0039`. **None of today's changes are deployed**; deployment remains an operator step
(Dokploy compose redeploy, migrations `0036`–`0039`, verify with the commands in the operator notes).

Public pages (`/`, `/sign-in`, `/sign-up`, `/funding`, `/privacy`) were loaded in Playwright Chromium, Firefox and WebKit at
1366×860 and iPhone 13 / 390×844 against production: all 200, no horizontal overflow. Console errors seen on `/sign-up` come from the
Cloudflare Turnstile iframe's own CSP, not from the app. Authenticated journeys in production were **not** tested: Turnstile blocks
headless browsers by design. They are covered by CI on `main` (desktop and Pixel 7 profiles), which is not production evidence.

## CI on `main`

Every merged PR passed CI, browser shards, voice product acceptance, real ClamAV engine, Linux native app flows and media recovery
before merge, and `main` stayed green after each merge.

## Security and backups

- Code audit with fixes: [SECURITY-AUDIT-2026-10-19.md](SECURITY-AUDIT-2026-10-19.md) (#108). One Low finding (missing same-origin
  checks on upload/push routes) fixed with a regression test; ClamAV fail-closed paths (refused connection, hang-up, oversized or
  unterminated reply, invalid port, unreachable scanner for file/image/avatar uploads) are now tested.
- Independent security reviews of #112 (group DMs: 2 Medium, 4 Low, all fixed before merge), #113 (voice browser support: no
  plaintext path; one latent fail-open fixed before merge) and #114 (DM calls: one Medium fixed).
- Encrypted off-host backup: daily run succeeded 2026-10-19 03:11 UTC with full read-back hash; backup and scanner monitors report
  `healthy` every 5 minutes; `daily/` expires after 30 days by bucket lifecycle rule.
- Isolated restore with the real bundle: see [OPERATIONS.md](OPERATIONS.md#hosted-instance-restore-evidence-2026-10-19). Counts matched
  production; the referenced media object was present.

## Delivered today

| PR | Change |
| --- | --- |
| #108 | Same-origin checks on upload/push routes, scanner fail-closed tests, audit report |
| #109 | Desktop: signed auto-update (off until a key is configured), tag-driven release workflow (draft releases), macOS/Linux mic/camera permission handling, hardened-runtime entitlements |
| #110 | E2EE DM file and image attachments (client-side Matrix attachment encryption, ciphertext-only storage) |
| #111 | Installable PWA (manifest, icons, offline page without caching private data), iOS safe areas, no input zoom; [MOBILE-STRATEGY.md](MOBILE-STRATEGY.md) |
| #112 | E2EE group DMs (3–10 people), Megolm rotation on membership/device change, removal and block rules |
| #113 | E2EE voice in Firefox (RTCRtpScriptTransform), fewer verification clicks, clearer call states and Rejoin |
| #114 | E2EE voice/video calls in 1:1 and group DMs with ringing, push and revocation |
| #115 | WebKit voice acceptance passes locally, DM storage persistence request with iOS hint, unverified browsers no longer clear unread state, actionable decryption reasons, AutoMod test flake root-caused |

## Platform compatibility matrix

| Platform | Evidence | Status |
| --- | --- | --- |
| Chromium (desktop, Linux CI) | 3-account E2EE voice product acceptance, DM call e2e, full browser suite | ✅ automated |
| Firefox (desktop, Linux CI) | Same voice acceptance and DM call e2e in CI | ✅ automated (loopback ICE pref is test-only) |
| WebKit (Playwright, macOS local) | 3-account voice spec and DM call spec passed 3/3 locally | 🟡 local only |
| WebKit (Playwright, Linux) | No `RTCRtpScriptTransform`/`createEncodedStreams`: Voice correctly refuses to start (no plaintext); CI would need a macOS runner | ❌ unsupported build |
| Real Safari macOS/iOS | — | ❌ not tested |
| Edge | Uses the Chromium path per livekit-client | ❌ not tested |
| Android (Pixel 7 emulation, Chromium) | Browser suite and PWA checks | 🟡 emulation only |
| iOS (iPhone 13 emulation, WebKit) | PWA/safe-area checks | 🟡 emulation only |
| Desktop macOS | Local build: entitlements, Info.plist; CI bundles | 🟡 built, runtime partly checked |
| Desktop Windows | CI bundles only | 🟡 built, not run |
| Desktop Linux | CI native app flows (existing harness) | 🟡 new permission/update dialogs not run |
| Physical microphones/cameras, real TURN on hostile networks | — | ❌ not tested |

## Remaining blockers and risks

- **Deploy** today's `main` (migrations `0036`–`0039`). Old browser tabs see group conversations fail closed until reload.
- **Backup capacity**: E2EE DM attachments (up to 4 × 25 MB per message) count toward the 512 MB in-memory media budget and the
  1 GiB encrypted backup budget; both fail closed. Review capacity before encouraging large file use.
- **Signing**: no Apple/Windows certificates or updater key yet, so desktop releases are unsigned and auto-update stays off.
- **iOS storage**: the app now requests persistent storage and explains home-screen install and recovery backups when refused; whether real iOS Safari grants it is untested.
- **External reviews still required**: crypto integration audit (DMs, groups, attachments, voice), penetration test, legal review
  (DSA/GDPR, reporting of encrypted content). The CSP allows inline scripts, so XSS or a malicious operator could read plaintext in the browser.
- **Voice limits**: 8 devices per call (9–10 person group calls refuse the next join); 10-second keying deadline on slow networks; WebKit not in CI. DM missed calls are per browser and declining does not notify the caller.
- **Manual production checks owed**: real browser upload of a clean file and EICAR through the app, authenticated journeys on
  physical desktop/mobile devices, push delivery.
