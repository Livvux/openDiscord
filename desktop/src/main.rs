#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod policy;

#[cfg(target_os = "linux")]
fn save_destination(filename: &str) -> Option<std::path::PathBuf> {
    use gtk::prelude::*;

    // Wry calls this on the existing GTK main thread. A second GTK event thread
    // would deadlock while the synchronous download callback waits for its result.
    let dialog = gtk::FileChooserNative::new(
        Some("Save OpenDiscord download"),
        None::<&gtk::Window>,
        gtk::FileChooserAction::Save,
        Some("Save"),
        Some("Cancel"),
    );
    dialog.set_current_name(filename);
    dialog.set_do_overwrite_confirmation(true);
    let destination = (dialog.run() == gtk::ResponseType::Accept)
        .then(|| dialog.filename())
        .flatten();
    dialog.destroy();
    destination
}

#[cfg(not(target_os = "linux"))]
fn save_destination(filename: &str) -> Option<std::path::PathBuf> {
    rfd::FileDialog::new()
        .set_title("Save OpenDiscord download")
        .set_file_name(filename)
        .save_file()
}

fn main() {
    let instance = policy::instance(
        option_env!("OPENDISCORD_INSTANCE_URL").unwrap_or("https://opendiscord.app"),
    )
    .expect("Invalid build-time OPENDISCORD_INSTANCE_URL");
    tauri::Builder::default()
        .setup(move |app| {
            let pinned = instance.clone();
            let downloads = instance.clone();
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(instance.clone()),
            )
            .title("OpenDiscord")
            .inner_size(1200.0, 800.0)
            .min_inner_size(360.0, 600.0)
            .on_navigation(move |target| policy::allowed_origin(&pinned, target))
            .on_new_window(|target, _| {
                if policy::safe_https(&target) && open::that_detached(target.as_str()).is_err() {
                    eprintln!("[desktop] Could not open the link in the system browser.");
                }
                tauri::webview::NewWindowResponse::Deny
            })
            .on_download(move |_, event| match event {
                tauri::webview::DownloadEvent::Requested { url, destination } => {
                    if !policy::allowed_origin(&downloads, &url) {
                        return false;
                    }
                    let filename = destination
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("download");
                    if let Some(path) = save_destination(filename) {
                        *destination = path;
                        true
                    } else {
                        false
                    }
                }
                _ => true,
            })
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("OpenDiscord desktop runtime failed");
}
