use tauri_plugin_updater::UpdaterExt;

/// Checks once per launch. The plugin verifies the minisign signature against the compiled-in
/// public key before installing; nothing is installed without the user's confirmation.
pub async fn check(app: tauri::AppHandle) {
    if let Err(error) = run(&app).await {
        eprintln!("[desktop] Update check failed: {error}");
    }
}

async fn run(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };
    let (answer, mut accepted) = tauri::async_runtime::channel(1);
    let version = update.version.clone();
    // Native dialogs must run on the main thread on macOS and GTK.
    app.run_on_main_thread(move || {
        let _ = answer.blocking_send(crate::confirm_update(&version));
    })?;
    if accepted.recv().await != Some(true) {
        return Ok(());
    }
    update.download_and_install(|_, _| {}, || {}).await?;
    // Windows exits inside install() to run the installer; macOS and Linux restart here.
    app.restart();
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, process::Command};
    use tauri_plugin_updater::UpdaterExt;

    const PASSWORD: &str = "throwaway-test-password";

    fn tauri_cli(args: &[&str]) -> Option<std::process::Output> {
        let output = Command::new("cargo")
            .arg("tauri")
            .args(args)
            .output()
            .ok()?;
        assert!(
            output.status.success(),
            "cargo tauri {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Some(output)
    }

    /// A keypair generated for this test run only; nothing is committed.
    fn keypair(dir: &Path) -> Option<(String, String)> {
        let key = dir.join("updater.key");
        tauri_cli(&[
            "signer",
            "generate",
            "--ci",
            "-p",
            PASSWORD,
            "-w",
            key.to_str()?,
        ])?;
        Some((
            fs::read_to_string(&key).ok()?,
            fs::read_to_string(dir.join("updater.key.pub")).ok()?,
        ))
    }

    fn sign(dir: &Path, private_key: &str, version: &str, bytes: &[u8]) -> String {
        let artifact = dir.join(format!("artifact-{version}"));
        fs::write(&artifact, bytes).unwrap();
        tauri_cli(&[
            "signer",
            "sign",
            "-k",
            private_key,
            "-p",
            PASSWORD,
            "--app-version",
            version,
            artifact.to_str().unwrap(),
        ])
        .expect("Tauri CLI disappeared");
        fs::read_to_string(dir.join(format!("artifact-{version}.sig"))).unwrap()
    }

    /// Builds an Update through the real plugin, using the committed updater config with `pubkey`.
    fn update_for(pubkey: &str, version: &str, signature: &str) -> tauri_plugin_updater::Update {
        let committed: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut updater = committed["plugins"]["updater"].clone();
        updater["pubkey"] = pubkey.into();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), updater);
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let manifest = serde_json::json!({
            "version": version,
            "platforms": { "test-target": { "url": "https://example.invalid/update", "signature": signature } }
        });
        app.updater_builder()
            .target("test-target")
            .build()
            .unwrap()
            .restore_update(manifest)
            .unwrap()
            .expect("newer version")
    }

    #[test]
    fn updater_installs_only_artifacts_signed_by_the_configured_key() {
        let dir =
            std::env::temp_dir().join(format!("opendiscord-updater-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("other")).unwrap();
        let Some((private_key, pubkey)) = keypair(&dir) else {
            assert!(
                std::env::var_os("CI").is_none(),
                "CI must install the Tauri CLI for this test"
            );
            eprintln!("skipped: Tauri CLI (cargo tauri) is not installed");
            return;
        };
        let (other_private_key, _) = keypair(&dir.join("other")).unwrap();
        let artifact = b"genuine update bundle";
        let signature = sign(&dir, &private_key, "0.2.0", artifact);

        assert!(update_for(&pubkey, "0.2.0", &signature)
            .verify(artifact)
            .is_ok());
        // Tampered bytes, a signature from another key, and a manifest announcing another version.
        assert!(update_for(&pubkey, "0.2.0", &signature)
            .verify(b"tampered update bundle")
            .is_err());
        let foreign = sign(&dir.join("other"), &other_private_key, "0.2.0", artifact);
        assert!(update_for(&pubkey, "0.2.0", &foreign)
            .verify(artifact)
            .is_err());
        assert!(update_for(&pubkey, "0.3.0", &signature)
            .verify(artifact)
            .is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
