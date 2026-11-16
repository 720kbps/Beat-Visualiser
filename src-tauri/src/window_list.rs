// Lists open windows so the user can pick the plugin window to record.
//
// macOS uses ScreenCaptureKit. The `id` we return is the SCWindow windowID
// (the same number as the CoreGraphics CGWindowID), so the capture code can
// find the same window again later.

use serde::Serialize;

#[derive(Serialize)]
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub app_name: String,
    // Size in real pixels (points * display scale, so 2x on Retina).
    // This is the size the recording should use.
    pub width: u32,
    pub height: u32,
    pub on_screen: bool,
    // True when the window belongs to FL Studio.
    pub is_fl: bool,
}

// Windows smaller than this (in points) are status items, tooltips, etc.
#[cfg(target_os = "macos")]
const MIN_SIZE: f64 = 50.0;

// Window layers at or above the Dock (20) are system UI: Dock, menu bar,
// status items, overlays. Normal windows are layer 0; floating plugin
// windows can be slightly above 0, so we don't require exactly 0.
#[cfg(target_os = "macos")]
const DOCK_LAYER: i32 = 20;

// FL Studio on macOS shows up as "FL Studio 2024", "FL Studio 21", ...
// and older versions ran as a process called "OsxFL". The bundle id
// ("com.image-line.flstudio") is the most stable check.
#[cfg(target_os = "macos")]
fn is_fl_studio(app_name: &str, bundle_id: &str) -> bool {
    let name = app_name.to_lowercase();
    name.contains("fl studio") || name.contains("osxfl") || bundle_id.contains("image-line")
}

/// Returns an error if the app doesn't have Screen Recording permission.
/// Used by both window listing and recording.
#[cfg(target_os = "macos")]
pub fn check_screen_recording_permission() -> Result<(), String> {
    use objc2_core_graphics::{CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess};

    // CGRequestScreenCaptureAccess shows the system prompt (only the first
    // time) and adds the app to the list in System Settings.
    if !CGPreflightScreenCaptureAccess() {
        CGRequestScreenCaptureAccess();
        return Err(
            "Screen Recording permission is missing. Enable it in System Settings > \
             Privacy & Security > Screen & System Audio Recording, then restart the app."
                .to_string(),
        );
    }
    Ok(())
}

/// Returns open windows with a title. If `title_filter` is given (and not
/// empty), only windows whose title contains it are returned (case-insensitive).
#[cfg(target_os = "macos")]
pub fn list_windows(title_filter: Option<String>) -> Result<Vec<WindowInfo>, String> {
    use screencapturekit::prelude::*;

    // Without Screen Recording permission macOS hides other apps' window
    // titles, so fail loudly instead of returning a useless list.
    check_screen_recording_permission()?;

    let filter = title_filter.unwrap_or_default().to_lowercase();

    let content = SCShareableContent::create()
        .with_exclude_desktop_windows(true)
        .get()
        .map_err(|e| format!("Could not list windows: {e}"))?;

    let mut result = Vec::new();
    for window in content.windows() {
        let title = window.title().unwrap_or_default();
        let frame = window.frame(); // in points

        if title.is_empty()
            || window.window_layer() >= DOCK_LAYER
            || frame.size.width < MIN_SIZE
            || frame.size.height < MIN_SIZE
        {
            continue;
        }
        if !filter.is_empty() && !title.to_lowercase().contains(&filter) {
            continue;
        }

        let (app_name, bundle_id) = match window.owning_application() {
            Some(app) => (app.application_name(), app.bundle_identifier()),
            None => (String::new(), String::new()),
        };

        // Ask ScreenCaptureKit for the points-to-pixels scale of this window
        // (2.0 on Retina). Fall back to 1.0 if the filter can't be built.
        let scale = match SCContentFilter::create().with_window(&window).build() {
            Ok(f) => f64::from(f.point_pixel_scale()),
            Err(_) => 1.0,
        };

        result.push(WindowInfo {
            id: window.window_id(),
            is_fl: is_fl_studio(&app_name, &bundle_id),
            title,
            app_name,
            width: (frame.size.width * scale).round() as u32,
            height: (frame.size.height * scale).round() as u32,
            on_screen: window.is_on_screen(),
        });
    }

    Ok(result)
}

// Windows: in window_list_windows.rs (UNTESTED).
#[cfg(target_os = "windows")]
pub use crate::window_list_windows::list_windows;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn list_windows(_title_filter: Option<String>) -> Result<Vec<WindowInfo>, String> {
    Err("Window listing only works on macOS and Windows.".to_string())
}

/// Tests only. A test binary has no NSApplication, so CoreGraphics isn't set
/// up and ScreenCaptureKit aborts with "CGS_REQUIRE_INIT". Calling any CG
/// display function first sets it up. (The real app doesn't need this.)
#[cfg(all(test, target_os = "macos"))]
pub fn init_core_graphics_for_tests() {
    unsafe extern "C" {
        fn CGMainDisplayID() -> u32;
    }
    unsafe { CGMainDisplayID() };
}

#[cfg(test)]
mod tests {
    // Prints the real window list. Run with:
    //   cargo test list_windows -- --nocapture
    // Needs Screen Recording permission for the terminal you run it from.
    #[test]
    fn list_windows_prints_something() {
        #[cfg(target_os = "macos")]
        super::init_core_graphics_for_tests();

        match super::list_windows(None) {
            Ok(windows) => {
                for w in &windows {
                    println!(
                        "{:>6}  {}x{}  on_screen={} fl={}  [{}] {}",
                        w.id, w.width, w.height, w.on_screen, w.is_fl, w.app_name, w.title
                    );
                }
                println!("{} windows", windows.len());
            }
            Err(e) => println!("error: {e}"),
        }
    }
}
