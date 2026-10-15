fn main() {
    println!("cargo:rerun-if-env-changed=OPENDISCORD_INSTANCE_URL");
    tauri_build::build()
}
