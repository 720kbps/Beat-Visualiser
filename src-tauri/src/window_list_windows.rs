// Windows version of list_windows (included by window_list.rs, Windows only).
//
// STATUS: written blind on a Mac. It type-checks with
// `cargo check --target x86_64-pc-windows-msvc`, but has NEVER RUN.
// Every "TEST:" comment is something to check on a real Windows PC.
//
// The `id` is the window handle (HWND) cut to 32 bits. Windows keeps window
// handles within 32 bits (so 32- and 64-bit apps can share them), so cutting
// is safe, and recorder_windows.rs turns it back into an HWND.
// TEST: the ids round-trip: recording a listed window finds the same window.

use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GWL_STYLE, GetWindowLongPtrW, IsIconic, IsWindowVisible, WS_CHILD,
};
use windows::core::BOOL;
use windows_capture::window::Window;

use crate::window_list::WindowInfo;

// Windows smaller than this (in pixels) are tooltips, tray popups, etc.
const MIN_SIZE: i32 = 50;

pub fn list_windows(title_filter: Option<String>) -> Result<Vec<WindowInfo>, String> {
    let filter = title_filter.unwrap_or_default().to_lowercase();

    let mut result = Vec::new();
    for hwnd in top_level_windows()? {
        let window = Window::from_raw_hwnd(hwnd.0);
        let title = window.title().unwrap_or_default();
        if title.is_empty() {
            continue;
        }
        if !filter.is_empty() && !title.to_lowercase().contains(&filter) {
            continue;
        }

        let Some((width, height)) = visible_size(hwnd) else {
            continue;
        };
        if width < MIN_SIZE || height < MIN_SIZE {
            continue;
        }

        // "FL64.exe" -> "FL64". Some processes can't be opened (e.g. ones
        // running as admin); they still get listed, without a name.
        let process = window.process_name().unwrap_or_default();
        let app_name = process.trim_end_matches(".exe").to_string();

        result.push(WindowInfo {
            id: hwnd.0 as usize as u32,
            is_fl: is_fl_studio(&process, &title),
            title,
            app_name,
            width: width as u32,
            height: height as u32,
            // A minimized window delivers no frames, like on macOS.
            on_screen: !unsafe { IsIconic(hwnd) }.as_bool(),
        });
    }
    Ok(result)
}

// Every visible top-level window. Unlike windows-capture's
// Window::enumerate(), tool windows (WS_EX_TOOLWINDOW) are kept: floating
// plugin windows may be tool windows.
// TEST: a Detached FL plugin window shows up in the list; a docked one doesn't
// (docked windows are children of FL's main window, WS_CHILD).
fn top_level_windows() -> Result<Vec<HWND>, String> {
    unsafe extern "system" fn collect(hwnd: HWND, list: LPARAM) -> BOOL {
        // SAFETY: `list` is the &mut Vec passed to EnumWindows below, alive
        // for the whole EnumWindows call.
        let list = unsafe { &mut *(list.0 as *mut Vec<HWND>) };
        let visible = unsafe { IsWindowVisible(hwnd) }.as_bool();
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32;
        if visible && style & WS_CHILD.0 == 0 {
            list.push(hwnd);
        }
        BOOL(1) // keep going
    }

    let mut list: Vec<HWND> = Vec::new();
    unsafe { EnumWindows(Some(collect), LPARAM(&mut list as *mut Vec<HWND> as isize)) }
        .map_err(|e| format!("Could not list windows: {e}"))?;
    Ok(list)
}

// The window's size in pixels as you see it. GetWindowRect would include an
// invisible resize border (~7 px per side on Windows 10/11); the "extended
// frame bounds" from DWM don't, and that's the size the capture delivers.
// TEST: on a 150% display the size is in real pixels, not scaled (Tauri marks
// the app as DPI-aware, so it should be).
fn visible_size(hwnd: HWND) -> Option<(i32, i32)> {
    let mut rect = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
    }
    .ok()?;
    Some((rect.right - rect.left, rect.bottom - rect.top))
}

// FL Studio's process is FL64.exe (64-bit) or FL.exe; its windows' titles
// usually contain "FL Studio".
// TEST: check the real process name in Task Manager (Details tab).
fn is_fl_studio(process: &str, title: &str) -> bool {
    let process = process.to_lowercase();
    process == "fl64.exe" || process == "fl.exe" || title.to_lowercase().contains("fl studio")
}

/// Turns a WindowInfo id back into the window handle.
pub fn hwnd_from_id(id: u32) -> HWND {
    // Sign-extend like Windows does when a 32-bit handle goes to 64 bits.
    HWND(id as i32 as isize as *mut std::ffi::c_void)
}
