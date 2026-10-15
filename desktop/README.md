# Desktop client (preview)

A Tauri 2 WebView for the existing HTTPS application on Windows, macOS and Linux. This is an unsigned preview, not a signed public distribution or mobile application. Builds require internet access to the configured instance. No server or user data is embedded.

## Build and instance configuration

Use a Rust stable toolchain and Tauri 2's platform prerequisites: https://v2.tauri.app/start/prerequisites/. From this directory run `cargo install tauri-cli --version '^2' --locked`, then `cargo tauri build --ci`. Application dependencies are recorded in Cargo.lock; CI runs locked checks before bundling. The pnpm workspace and its lockfile are unchanged.

The default is `https://opendiscord.app`. Self-host operators set the build-time environment variable `OPENDISCORD_INSTANCE_URL=https://chat.example.org` before building. Only an HTTPS origin is accepted; an explicit port is allowed. Paths, credentials, queries and fragments are rejected at startup. This setting is compiled into the executable and cannot be changed by a remote page or runtime environment. Use a distinct application identifier when distributing a separate self-hosted client to avoid profile conflicts.

## Trust boundary

Main-window navigation stays on the configured origin, including redirects. Cross-origin authentication redirects are consequently blocked; use the instance's same-origin login. New-window requests are denied inside the application. HTTPS links opened with `target=_blank` are delegated to the system browser after scheme and credential validation. Other schemes are denied. Ordinary external same-window links are blocked. There are no custom command handlers, plugins, remote capabilities, filesystem access, shell grants or updater. The internal Tauri bridge has no remote permissions. Normal TLS verification remains enabled and the server's CSP remains authoritative for remote content.

Downloads are deliberately denied until native destination/consent behavior has cross-platform acceptance. Use the browser for attachment downloads and data exports. Upload pickers remain WebView behavior and require acceptance below.

## Evidence and release gates

The Desktop bundles workflow builds actual OS packages and uploads short-lived GitHub CI artifacts with SHA256SUMS. These are unsigned (macOS may be ad-hoc signed), unnotarized developer previews; OS trust prompts are expected. Artifact existence and compilation do not establish a safe release. No automatic updates, public release or download listing is configured. Review the dependency license inventory and cargo-audit result; these are technical evidence, not legal approval.

Before public distribution, record OS/version/WebView and acceptance results for each of:

- Same-origin login, cookie persistence, logout and reconnect.
- Rejected cross-origin/custom-scheme navigation and denied native IPC.
- DM Web Locks, IndexedDB, WebAssembly crypto, device verification/recovery.
- Passkeys (platform authenticators may behave differently in embedded WebViews).
- Microphone, camera, screen sharing, permission prompts and TURN/media traversal.
- Notifications/background behavior (no native notification plugin is installed).
- Uploads and explicit download/export consent behavior; downloads currently blocked.
- Accessibility, keyboard navigation, mobile-width layout and restart recovery.

macOS notarization/Developer ID, Windows signing, store publication, security review, physical-device media/passkey tests and mobile binaries remain separate acceptance gates. Do not infer full app parity from CI or Linux-only runtime QA.
