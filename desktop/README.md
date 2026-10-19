# Desktop client (preview)

A Tauri 2 WebView for the existing HTTPS application on Windows, macOS and Linux. CI builds are unsigned previews; tagged releases are publisher-signed only when the operator has added the secrets listed under "Releases and updates". This is not a mobile application. Builds require internet access to the configured instance. No server or user data is embedded.

## Build and instance configuration

Use a Rust stable toolchain and Tauri 2's platform prerequisites: https://v2.tauri.app/start/prerequisites/. From this directory run `cargo install tauri-cli --version '^2' --locked`, then `cargo tauri icon ../apps/web/public/brand/symbol-flat.svg` and `cargo tauri build --ci`. Application dependencies are recorded in Cargo.lock; CI runs locked checks before bundling. The pnpm workspace and its lockfile are unchanged.

The default is `https://opendiscord.app`. Self-host operators set the build-time environment variable `OPENDISCORD_INSTANCE_URL=https://chat.example.org` before building. Only an HTTPS origin is accepted; an explicit port is allowed. Paths, credentials, queries and fragments are rejected at startup. This setting is compiled into the executable and cannot be changed by a remote page or runtime environment. Use a distinct application identifier when distributing a separate self-hosted client to avoid profile conflicts.

## Trust boundary

Main-window navigation stays on the configured origin, including redirects. Origin-bound blob URLs are allowed for client-generated exports; they retain the same web origin and receive no native permissions. Cross-origin authentication redirects are consequently blocked; use the instance's same-origin login. New-window requests are denied inside the application. HTTPS links opened with `target=_blank` are delegated to the system browser after scheme and credential validation. Other schemes are denied. Ordinary external same-window links are blocked. There are no custom command handlers, remote capabilities, filesystem access or shell grants. The only plugin is the updater, registered only in builds that carry an updater public key; no capability grants it to the page, so only Rust calls it. The internal Tauri bridge has no remote permissions.

Media permissions are handled explicitly. Microphone, camera and screen capture keep the WebView's own prompt on macOS (WKWebView) and Windows (WebView2); without a handler wry would grant macOS media requests silently. WebKitGTK has no prompt of its own and denies by default, so Linux shows a native Yes/No dialog per request. Geolocation is always denied; other kinds keep the WebView default. macOS needs `NSMicrophoneUsageDescription`/`NSCameraUsageDescription` (Info.plist) and, because bundles use the hardened runtime, the `audio-input`/`camera` entitlements in Entitlements.plist. Screen recording consent is the OS's own Screen Recording privacy setting. Web notifications are not bridged to native notifications; Web Push does not reach the shell. Normal TLS verification remains enabled and the server's CSP remains authoritative for remote content.

Downloads from the instance and blob exports bound to that origin require a native Save dialog; cancel denies the transfer. Only the suggested basename is used, and the user chooses the destination. The native dialog is called from Rust without exposing a filesystem or dialog command to remote JavaScript. Upload pickers remain WebView behavior. Download dialogs and blob exports still require per-OS runtime acceptance below.

## Evidence and release gates

The Desktop bundles workflow builds actual OS packages and uploads short-lived GitHub CI artifacts with SHA256SUMS. These are unsigned Windows/Linux and ad-hoc signed macOS developer previews, without notarization or an Apple-authenticated identity; OS trust prompts are expected. CI verifies the macOS app signature and the app inside the mounted read-only DMG; this verifies bundle coherence, not distribution trust or macOS UI acceptance. Artifact existence and compilation do not establish a safe release. Tagged releases and the updater are described below; no download listing is configured. Review the dependency license inventory and cargo-audit result; these are technical evidence, not legal approval.

Before public distribution, record OS/version/WebView and acceptance results for each of:

- Same-origin login, cookie persistence, logout and reconnect.
- Rejected cross-origin/custom-scheme navigation and denied native IPC.
- DM Web Locks, IndexedDB, WebAssembly crypto, device verification/recovery.
- Passkeys (platform authenticators may behave differently in embedded WebViews).
- Microphone, camera, screen sharing, permission prompts and TURN/media traversal.
- Notifications/background behavior (no native notification plugin is installed).
- Update prompt, signature rejection of a tampered artifact, install and restart per OS/bundle type.
- Uploads and explicit download/export consent behavior; including blob exports.
- Accessibility, keyboard navigation, mobile-width layout and restart recovery.

macOS notarization/Developer ID, Windows signing, store publication, security review, physical-device media/passkey tests and mobile binaries remain separate acceptance gates. Do not infer full app parity from CI or Linux-only runtime QA.

## Releases and updates

`.github/workflows/desktop-release.yml` runs on tags `desktop-vX.Y.Z`; the tag must equal `version` in tauri.conf.json (bump it, and Cargo.toml, first). It builds a universal macOS app/DMG, Windows NSIS/MSI and Linux AppImage/deb/rpm on Ubuntu 22.04 and attaches them to a **draft** GitHub Release. Nothing reaches users until an operator reviews the job summaries (which state per platform what was signed) and publishes the draft. Pull requests that change the workflow run the same builds without publishing.

Every secret is optional. Missing secrets produce a warning and a weaker build, never a failed one:

| Secret (Settings → Secrets → Actions) | Effect when absent |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | No `.sig` files and no `latest.json`; installed apps never see the release. |
| `APPLE_CERTIFICATE` (base64 Developer ID Application .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Name (TEAMID)`) | macOS stays ad-hoc signed; Gatekeeper blocks it. |
| `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID` | Signed but not notarized; Gatekeeper still blocks it. |
| `WINDOWS_CERTIFICATE` (base64 .pfx), `WINDOWS_CERTIFICATE_PASSWORD` | Unsigned installers; SmartScreen warns. HSM-only certificates (e.g. Azure Trusted Signing) need a `bundle.windows.signCommand` instead, which is not wired up. |

Updater setup, once, on the operator's machine (never in CI or this repository):

1. `cargo tauri signer generate -w ~/.tauri/opendiscord.key` and store the key and its password offline. Losing the key means installed apps can never be updated again; leaking it lets anyone with release access ship code to every installation.
2. Add the key file's content as `TAURI_SIGNING_PRIVATE_KEY` and the password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Commit the content of `~/.tauri/opendiscord.key.pub` as `plugins.updater.pubkey` in tauri.conf.json (public by design). A release fails if the private key is present but the public key is empty.

Behaviour: once per launch the app fetches `https://github.com/Livvux/openDiscord/releases/latest/download/latest.json` over TLS, then asks before installing a newer version. The plugin verifies the minisign signature against the compiled-in public key, and `requireSignedVersion` rejects a manifest whose version differs from the version inside the signature (prevents downgrade by manifest tampering). Windows exits into the passive installer; macOS and Linux restart. Builds with an empty public key, and every build with `OPENDISCORD_INSTANCE_URL` set, never register or run the updater, so a self-hosted client never installs upstream releases compiled for opendiscord.app. `releases/latest` must remain a desktop release: publishing any other GitHub Release as "latest" breaks update discovery.

## Isolated Linux application-flow acceptance

`Native Linux application flows` runs the production standalone web app with a fresh PostgreSQL service and private local storage on a disposable hosted Ubuntu runner. A loopback-only TLS proxy exposes `https://localhost:9443`; an ephemeral certificate is trusted only on that runner, then removed. The unchanged native binary is compiled for that origin. There are no TLS bypasses, remote capabilities, embedded WebDriver plugins, crypto mocks or replacement browser pages.

The Python standard-library WebDriver harness starts three independent Tauri/WebKit processes with isolated profiles. It checks Web Locks, IndexedDB, WebAssembly and profile isolation, then actual signup/sign-in, community navigation, native private-file save, community export, two-party DM SAS verification, ciphertext transport, reload persistence and recovery-file import into a clean profile. File upload uses the real application input through WebDriver. Unsupported native-driver capabilities fail the stage; later cases remain `not-run`. Console endpoint unavailability is recorded explicitly and is not evidence of an error-free console.

The flow step is bounded to twelve minutes and the job to forty-five. Native cleanup signals every captured owned process group before waiting and uses one ten-second budget; it does not send potentially hung WebDriver session-delete requests. Complete download checks require exact attachment bytes or a parsed export/recovery shape before use. Only explicit W3C unsupported-command responses mark console capture unavailable; other driver failures fail acceptance. Separate hosted transport tests exercise real TLS upstream truncation and downstream SSE cancellation, without substituting for application acceptance. Artifacts contain incremental case outcomes, platform metadata, attachment digest/size and a disposable community screenshot. No recovery files, SAS values, session material, private message payloads or driver/application logs are uploaded. A failed job proves only its individually passed cases; Windows/macOS, physical devices, signing and full platform parity remain separate gates.
