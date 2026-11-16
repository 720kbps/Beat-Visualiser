// macOS Screen Recording permission, for the setup screen.
// (window_list::check_screen_recording_permission is the check that guards
// listing and recording; these are for showing the state and asking.)
//
// macOS caches the answer per process: after the user turns the permission
// on in System Settings, `granted()` usually stays false until the app is
// restarted. The setup screen says so and offers a restart button.

#[cfg(target_os = "macos")]
pub fn granted() -> bool {
    objc2_core_graphics::CGPreflightScreenCaptureAccess()
}

/// Shows the system prompt (macOS only does this once per app; afterwards it
/// returns false right away) and adds the app to the list in System Settings.
#[cfg(target_os = "macos")]
pub fn request() -> bool {
    objc2_core_graphics::CGRequestScreenCaptureAccess()
}

/// Opens System Settings > Privacy & Security > Screen & System Audio Recording.
#[cfg(target_os = "macos")]
pub fn open_settings() -> Result<(), String> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open System Settings: {e}"))
}

// Windows has no such permission for window capture.
#[cfg(not(target_os = "macos"))]
pub fn granted() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
pub fn request() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
pub fn open_settings() -> Result<(), String> {
    Ok(())
}
