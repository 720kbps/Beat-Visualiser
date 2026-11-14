mod recorder;
mod window_list;

use tauri::Manager; // gives `app.path()`

// `async` makes Tauri run this on a background thread instead of the main
// thread, so the UI doesn't freeze while macOS collects the window list.
#[tauri::command]
async fn list_windows(
    title_filter: Option<String>,
) -> Result<Vec<window_list::WindowInfo>, String> {
    window_list::list_windows(title_filter)
}

// Records a window for `seconds` and returns the saved file path.
// The recording blocks for the whole duration, so it runs on a separate
// "blocking" thread (spawn_blocking). That keeps both the UI thread and
// Tauri's async worker threads free while we wait.
#[tauri::command]
async fn record_window(
    app: tauri::AppHandle,
    window_id: u32,
    seconds: u32,
) -> Result<String, String> {
    if !(1..=60).contains(&seconds) {
        return Err(format!("Length must be 1 to 60 seconds, got {seconds}."));
    }

    // ~/Movies/Beat Visualiser on macOS.
    let folder = app
        .path()
        .video_dir()
        .map_err(|e| format!("Could not find the Movies folder: {e}"))?
        .join("Beat Visualiser");

    tauri::async_runtime::spawn_blocking(move || {
        recorder::record_window(window_id, seconds, &folder)
    })
    .await
    .map_err(|e| format!("Recording thread crashed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![list_windows, record_window])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
