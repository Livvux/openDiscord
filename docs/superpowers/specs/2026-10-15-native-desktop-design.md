# Prepared native desktop delivery design

Remaining roadmap native shells: a small Tauri2 desktop wrapper for the existing HTTPS application,
Windows/macOS/Linux. Retain the app/server architecture and origin-local auth/crypto; no bundled
secret, cross-origin IPC permission, filesystem/shell plugin, custom auth, custom crypto or updater.
Current primary docs consulted: https://v2.tauri.app/security/capabilities/ and
https://v2.tauri.app/distribute/pipelines/github/ (2026-10-15).

Default official instance; allow operators a documented build-time HTTPS instance URL without
editing application source. Validate scheme/host/port/credentials, pin WebView navigation to the
configured origin, reject local-file/data/javascript/custom schemes, and keep untrusted remote web
content outside native capabilities. Keep normal TLS trust; never add certificate-ignore switches.
External links should use an explicitly safe system-browser path rather than grant remote pages
arbitrary native commands. Preserve server CSP and cookie/session boundary.

Build only in GitHub Actions OS matrix; lock Rust deps and use frozen pnpm if a JS tool is needed.
Prefer cargo tauri CLI without new JS dependencies. Publish unsigned/ad-hoc build artifacts with
SHA256 and clear status; no fabricated signing/notarization or store acceptance. Signing keys,
notarization accounts and real OS media/passkey/notification acceptance are separate gates. Do not
create stores/accounts or pay fees. No automatic updater until a reviewed signed channel exists.

Required: independent Rust/security review; URL-policy unit tests; remote cargo fmt/clippy/test +
actual OS bundles; Linux WebDriver launch with an isolated local HTTPS fixture if feasible and no
TLS bypass; screenshot/title/navigation rejection/native IPC denial. CI Linux is not macOS/Windows
runtime acceptance. Attachments/download dialogs, passkeys, mic/camera/screen, notifications and DM
crypto WebLocks/IndexedDB/WASM need explicit WebView compatibility evidence; no parity claim from
an executable existing. A native shell alone does not complete every native feature.

This is prepared design, not implemented or released. Use a separate branch/worktree and coordinate
with root for final reviews/CI. No product public download link until actual artifacts are built and
verified; signing limits must be visible. Mobile native delivery remains separate from desktop.
