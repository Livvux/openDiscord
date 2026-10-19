# Mobile strategy (Android and iOS)

Status: recommendation, October 2026. Nothing in this document is a claim of tested device support unless it appears under "What was tested".

## Recommendation

1. **Now: the installable PWA is the mobile client.** The web app already carries the whole product (communities, E2EE DMs, voice, Web Push). The manifest, icons, iOS home-screen tags, safe-area handling and offline fallback make it installable on Android (Chrome) and iOS/iPadOS 16.4+ (Add to Home Screen). One codebase, no store review, and security fixes ship with the server.
2. **Next, only if store presence or native push becomes a requirement: a thin Capacitor shell around the hosted origin**, published to the Play Store first. Not Tauri 2 mobile, and not a native rewrite.
3. **Not recommended:** React Native/Flutter/native rewrites (a second implementation of E2EE, voice and moderation), or bundling the Next.js app into the binary (server-rendered app; it would fork from the server's release cadence).

### Why Capacitor over Tauri 2 mobile for a store build

Both are WebView shells (Android System WebView, iOS WKWebView), so web-platform behaviour is the same. The difference is the native edge:

| Concern | Capacitor | Tauri 2 mobile |
|---|---|---|
| Push (FCM/APNs) | Official `@capacitor/push-notifications`, widely used | No official push plugin; community plugins or own Swift/Kotlin |
| Remote origin loading | `server.url` supported, but documented as dev-oriented; production use needs `allowNavigation` discipline | Same pattern as the desktop shell (remote URL + `on_navigation` allowlist) |
| Reuse of desktop shell | None | Policy code (`desktop/src/policy.rs`) could be shared |
| Maturity on mobile | Years of store apps | Mobile support stable since 2.0 but a thinner plugin ecosystem |
| Team skills | JS/TS config, small native glue | Rust plus Swift/Kotlin glue |

Push is the main reason to ship a store app at all, and that is where Capacitor is clearly ahead. If push stays on Web Push, there is little reason to ship a store app.

## Trade-offs that decide the shell

### E2EE (matrix-sdk-crypto-wasm, IndexedDB, Web Locks)

The DM client requires a secure context, WebAssembly, IndexedDB and Web Locks, with one tab owning the crypto store (`apps/web/src/lib/dm/client.ts`, docs/PRIVATE-MESSAGES.md).

- **WebAssembly:** available in Chrome Android, Android System WebView, Safari and WKWebView. CSP already allows `'wasm-unsafe-eval'`.
- **Web Locks:** Safari/WKWebView 15.4+, Chrome/WebView 69+. A WKWebView in a Capacitor/Tauri shell uses the system WebKit, so iOS 15.4+ is the floor. The single-owner lock is per origin: an installed PWA and a Safari tab on the same origin compete for the same lock, which the existing "only one tab" handling already covers. Not observed on a device.
- **IndexedDB persistence is the real risk.** Safari deletes script-writable storage (including IndexedDB) for websites not interacted with in 7 days; home-screen web apps are exempt, and Safari 17+ also grants `navigator.storage.persist()`. The app does not currently call `navigator.storage.persist()`. Losing IndexedDB means losing local DM keys and history unless the user exported a recovery file. Recommended follow-up (DM code owners): request persistent storage after DM enrollment and steer iOS users to install to the Home Screen or keep a recovery file. A native shell's WKWebView data store is not subject to the 7-day rule but is still deleted with the app.
- **Process kills:** iOS suspends and kills background WebViews freely. The crypto store must tolerate being killed mid-transaction, which the existing transactional design targets; not tested on devices.

### Push

- **Web Push (current):** works in Chrome/Firefox on Android and, on iOS/iPadOS 16.4+, **only for web apps added to the Home Screen**, after a user gesture. Not in Safari tabs and not inside a WKWebView shell. No silent/background push on iOS. In the EU, iOS 17.4 briefly removed home-screen web apps and Apple reverted that; this policy can change again.
- **Native (FCM/APNs) via a shell:** needed for store apps and for reliable iOS delivery outside home-screen web apps. Requires a server-side sender alongside `web-push`, device-token storage and, for E2EE DMs, payloads that carry no plaintext (the current DM push already sends no message content). APNs needs an Apple Developer account and key; FCM needs a Firebase project, which some privacy-focused self-hosters will reject. That argues for keeping Web Push as the default and making native push an opt-in hosted-only feature.

### Background behaviour

- Neither the PWA nor a WebView shell keeps a realtime connection in the background. The app reconnects and catches up on resume (realtime stream plus unread state).
- **Voice:** a browser/PWA call stops or mutes when the screen locks or the app is backgrounded on iOS; Android Chrome usually keeps audio while the tab lives. Background calls in a store app need native work (iOS `audio` background mode, CallKit; Android foreground service). A Capacitor shell can add this later; a PWA cannot.
- **Screen sharing:** `getDisplayMedia` is not available in mobile Safari, iOS WKWebView or Android WebView. Mobile is receive-only for screen share in every web-based option.

### Store requirements

- **Apple App Store, guideline 4.2 (minimum functionality):** a shell that only loads a website is commonly rejected. A store build needs native value: push, CallKit/background audio, share sheet, native media permission prompts. **Guideline 1.2 (user-generated content)** requires reporting, blocking and moderation, which exist. Account deletion must be possible in-app (exists in account settings; verify before submission). Privacy nutrition labels are required; Sign in with Apple becomes mandatory only if third-party social login is added.
- **Google Play:** a WebView app is accepted when it is the operator's own service; needs the Data safety form, account-deletion URL, target-SDK updates every year and UGC moderation.
- **Self-hosters:** store builds are pinned to one origin (as the desktop shell is). Self-hosted instances use the PWA; a configurable-origin store app is a separate policy and trust question.

## Implementation notes for a shell (when started)

Carry over the desktop shell's rules: one pinned HTTPS origin, navigation allowlist, external links in the system browser, no IPC exposed to the remote page beyond explicitly reviewed plugins, explicit media permission handling (`NSMicrophoneUsageDescription`, `NSCameraUsageDescription`, Android `RECORD_AUDIO`/`CAMERA` runtime permissions plus WebView `onPermissionRequest`). Keep the PWA as the reference client; the shell adds only what the web cannot.

## What was tested

Tested on 2026-10-19 on a Mac against a local production build (`e2e/pwa.spec.ts`), using emulation, not devices:

| Check | Chromium desktop | Chromium Pixel 7 emulation | WebKit iPhone 13 emulation |
|---|---|---|---|
| Manifest fields, icons (any + maskable, real PNG sizes), shortcuts | pass | pass | pass |
| Manifest link, apple-touch-icon, iOS web-app meta tags | pass | pass | pass |
| No Chromium installability errors (`Page.getInstallabilityErrors`) | pass | pass | n/a |
| App-shell and off-canvas nav pad for emulated safe-area insets | pass | pass | not emulable |
| Offline navigation shows the offline page; Cache Storage holds only `/offline.html` | pass | pass | pass |
| Message composer at ≥16px on touch devices (no iOS focus zoom) | n/a | pass | pass |

An exploratory pass on Pixel 7 and iPhone 13 emulation (sign-up, home, channel, open navigation, messages, settings) found no horizontal overflow; the only defect found, the 14px composer that iOS zooms into, is fixed.

**Not tested:** any physical Android or iOS device; real iOS Safari (Playwright WebKit on macOS is not iOS Safari); Add to Home Screen and standalone launch; Web Push delivery on iOS; IndexedDB eviction; Web Locks, WASM crypto and DM flows on mobile WebKit; voice and camera on mobile; any Capacitor or Tauri mobile build. These are acceptance gates before advertising mobile support.
