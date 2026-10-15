# Native desktop delivery plan

1. Add isolated Tauri 2 Rust crate with pinned HTTPS origin, no remote capabilities, no native command handlers or plugins, and URL policy tests.
2. Document operator configuration and acceptance boundaries. Add independent OS build matrix with locked dependencies, lint, tests, license inventory and unsigned bundle checksums.
3. Run remote CI, repair failures, request independent Rust/security review, and publish a draft PR with artifact evidence. Keep signing and real-device acceptance explicit.

API references verified 2026-10-15: https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html (on_navigation, on_new_window), https://v2.tauri.app/reference/config/ and https://v2.tauri.app/security/capabilities/. No JS dependency is required.
