mod audio_file;
mod export_file;
mod fl_midi;
mod recorder;
mod recordings;
mod take;
mod window_list;

use std::sync::Mutex;

use fl_midi::{FlPort, send_to_fl};
use tauri::Manager; // gives `app.path()`, `app.manage()` and `app.state()`

// Not `async`, so Tauri runs these on the main thread. That's fine here:
// sending a few bytes of MIDI takes microseconds and won't freeze the UI.
#[tauri::command]
fn fl_play(port: tauri::State<'_, FlPort>) -> Result<(), String> {
    send_to_fl(&port, fl_midi::send_play)
}

#[tauri::command]
fn fl_stop(port: tauri::State<'_, FlPort>) -> Result<(), String> {
    send_to_fl(&port, fl_midi::send_stop)
}

// `async` makes Tauri run this on a background thread instead of the main
// thread, so the UI doesn't freeze while macOS collects the window list.
#[tauri::command]
async fn list_windows(
    title_filter: Option<String>,
) -> Result<Vec<window_list::WindowInfo>, String> {
    window_list::list_windows(title_filter)
}

// The one-button take: FL plays from the song start while we record the
// window for `seconds`, then FL stops. Returns the file and the play offset
// (see take.rs).
//
// The take blocks for the whole duration, so it runs on a separate
// "blocking" thread (spawn_blocking). That keeps both the UI thread and
// Tauri's async worker threads free while we wait.
#[tauri::command]
async fn record_take(
    app: tauri::AppHandle,
    window_id: u32,
    seconds: u32,
) -> Result<take::Take, String> {
    let folder = recordings_folder(&app)?;

    // `move` gives the closure its own `app` (an AppHandle is a cheap handle
    // that can be moved to another thread). Inside, we look up the MIDI port
    // in managed state, like a command's `State` argument would.
    tauri::async_runtime::spawn_blocking(move || {
        let port = app.state::<FlPort>();
        take::record_take(&port, window_id, seconds, &folder)
    })
    .await
    .map_err(|e| format!("Recording thread crashed: {e}"))?
}

// Where recordings are saved: ~/Movies/Beat Visualiser on macOS,
// %USERPROFILE%\Videos\Beat Visualiser on Windows. The asset protocol scope in
// tauri.conf.json (`$VIDEO/Beat Visualiser/**`) allows the webview to load
// files from exactly this folder, so the two must stay the same.
fn recordings_folder(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let videos = app
        .path()
        .video_dir()
        .map_err(|e| format!("Could not find the Movies folder: {e}"))?;
    Ok(videos.join(recordings::FOLDER_NAME))
}

// The newest recording's full path, or None (null in JS) if there is none.
// `async` so the folder scan runs off the main thread.
#[tauri::command]
async fn latest_recording(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let folder = recordings_folder(&app)?;
    let newest = recordings::newest_mov(&folder)?;
    // to_string_lossy: paths aren't guaranteed to be valid UTF-8, JS strings are.
    Ok(newest.map(|path| path.to_string_lossy().into_owned()))
}

// Writes the exported MP4 (the raw request body, see export_file.rs) to
// ~/Movies/Beat Visualiser/export-<unix time>.mp4 and returns the full path.
// `async` so writing tens of MB doesn't block the main thread. (An async
// command that borrows its arguments, like `request` here, must return a
// Result; Tauri requires that.)
#[tauri::command]
async fn save_export(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let bytes = export_file::raw_body(&request)?;
    let folder = recordings_folder(&app)?;
    let path = export_file::save_export(&folder, bytes)?;
    log::info!("Saved export: {} ({} bytes)", path.display(), bytes.len());
    Ok(path.to_string_lossy().into_owned())
}

// Opens Finder / Explorer with the exported file selected. Only for files in
// the recordings folder.
#[tauri::command]
fn show_in_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let folder = recordings_folder(&app)?;
    export_file::show_in_folder(&folder, std::path::Path::new(&path))
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

            // Create the virtual MIDI port once, for the whole app run: FL
            // only sees the port while it exists. If it fails we keep the app
            // running; fl_play / fl_stop / record_take will then return this error.
            let port = fl_midi::create_port(fl_midi::PORT_NAME);
            match &port {
                Ok(_) => log::info!("Created MIDI port \"{}\"", fl_midi::PORT_NAME),
                Err(e) => log::error!("{e}"),
            }
            app.manage(FlPort(Mutex::new(port)));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_windows,
            record_take,
            latest_recording,
            fl_play,
            fl_stop,
            save_export,
            show_in_folder,
            audio_file::read_audio_file
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
