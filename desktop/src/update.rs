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
