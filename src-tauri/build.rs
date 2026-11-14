fn main() {
    // The screencapturekit crate contains a small Swift library, which needs
    // the Swift runtime from /usr/lib/swift. A dependency can't add that
    // search path (rpath) to our binary, so we add it here. Without it the
    // app crashes on start with "Library not loaded: @rpath/libswift_...".
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    tauri_build::build()
}
