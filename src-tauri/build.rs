fn main() {
    println!("cargo:rerun-if-env-changed=CODEX_PANEL_WINDOWS_CERTIFICATE_THUMBPRINT");
    println!("cargo:rerun-if-changed=resources/runtime-integrity.json");
    let manifest = match std::fs::read_to_string("resources/runtime-integrity.json") {
        Ok(manifest) => manifest,
        Err(error) if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") => {
            panic!("Windows runtime integrity manifest is required: {error}")
        }
        Err(_) => "{\"version\":1,\"files\":[]}".to_string(),
    };
    assert!(
        !manifest.contains(['\n', '\r']),
        "runtime-integrity.json must be compact JSON"
    );
    println!("cargo:rustc-env=CODEX_PANEL_RUNTIME_INTEGRITY_MANIFEST={manifest}");
    tauri_build::build()
}
