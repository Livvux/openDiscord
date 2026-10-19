#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod policy;
mod update;

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

const UPDATE_PROMPT: &str = "Install it and restart OpenDiscord now? Active calls will end.";

#[cfg(target_os = "linux")]
fn confirm_update(version: &str) -> bool {
    use gtk::prelude::*;

    let dialog = gtk::MessageDialog::new(
        None::<&gtk::Window>,
        gtk::DialogFlags::MODAL,
        gtk::MessageType::Question,
        gtk::ButtonsType::YesNo,
        &format!("OpenDiscord {version} is available"),
    );
    dialog.set_secondary_text(Some(UPDATE_PROMPT));
    let accepted = dialog.run() == gtk::ResponseType::Yes;
    dialog.destroy();
    accepted
}

#[cfg(not(target_os = "linux"))]
fn confirm_update(version: &str) -> bool {
    rfd::MessageDialog::new()
        .set_title(format!("OpenDiscord {version} is available"))
        .set_description(UPDATE_PROMPT)
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        == rfd::MessageDialogResult::Yes
}

use tauri::webview::{PermissionKind, PermissionResponse};

/// WebKitGTK denies media requests without a handler and has no prompt of its own.
#[cfg(target_os = "linux")]
fn media_permission(kind: &PermissionKind) -> PermissionResponse {
    use gtk::prelude::*;

    let device = match kind {
        PermissionKind::Microphone => "microphone",
        PermissionKind::Camera => "camera",
        _ => "screen",
    };
    let dialog = gtk::MessageDialog::new(
        None::<&gtk::Window>,
        gtk::DialogFlags::MODAL,
        gtk::MessageType::Question,
        gtk::ButtonsType::YesNo,
        &format!("Allow OpenDiscord to use your {device}?"),
    );
    let allowed = dialog.run() == gtk::ResponseType::Yes;
    dialog.destroy();
    if allowed {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Deny
    }
}

/// WKWebView and WebView2 show their own per-origin prompt; wry's macOS default would grant silently.
#[cfg(not(target_os = "linux"))]
fn media_permission(_: &PermissionKind) -> PermissionResponse {
    PermissionResponse::Default
}

fn main() {
    let instance = policy::instance(
        option_env!("OPENDISCORD_INSTANCE_URL").unwrap_or("https://opendiscord.app"),
    )
    .expect("Invalid build-time OPENDISCORD_INSTANCE_URL");
    let context = tauri::generate_context!();
    let pubkey = context
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str());
    let updates =
        policy::updates_enabled(pubkey, option_env!("OPENDISCORD_INSTANCE_URL").is_some());
    let mut builder = tauri::Builder::default();
    if updates {
        // No capability grants it to the remote page; only Rust calls the updater.
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .setup(move |app| {
            if updates {
                tauri::async_runtime::spawn(update::check(app.handle().clone()));
            }
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
            .on_permission_request(|_, kind| match kind {
                PermissionKind::Microphone
                | PermissionKind::Camera
                | PermissionKind::DisplayCapture => media_permission(&kind),
                PermissionKind::Geolocation => PermissionResponse::Deny,
                _ => PermissionResponse::Default,
            })
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
        .run(context)
        .expect("OpenDiscord desktop runtime failed");
}
