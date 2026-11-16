mod audio_file;
mod export_file;
mod fl_midi;
mod fl_script;
mod permission;
mod recorder;
// Windows versions of the recorder and window list. Not compiled on macOS.
#[cfg(target_os = "windows")]
mod recorder_windows;
mod recordings;
mod take;
mod window_list;
#[cfg(target_os = "windows")]
mod window_list_windows;

use std::sync::Mutex;

use fl_midi::{FlListener, FlPort, send_to_fl};
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

// The one-button take: FL plays from `start_seconds` into the song while we
// record 1 to 3 windows for `seconds`, then FL stops. Returns one clip (file
// + play offset) per window, in the same order as `window_ids` (see take.rs).
// JS: invoke('record_take', { windowIds, startSeconds, seconds })
//
// The take blocks for the whole duration, so it runs on a separate
// "blocking" thread (spawn_blocking). That keeps both the UI thread and
// Tauri's async worker threads free while we wait.
#[tauri::command]
async fn record_take(
    app: tauri::AppHandle,
    window_ids: Vec<u32>,
    start_seconds: f64,
    seconds: f64,
) -> Result<take::Take, String> {
    let folder = recordings_folder(&app)?;

    // `move` gives the closure its own `app` (an AppHandle is a cheap handle
    // that can be moved to another thread). Inside, we look up the MIDI port
    // in managed state, like a command's `State` argument would.
    tauri::async_runtime::spawn_blocking(move || {
        let port = app.state::<FlPort>();
        let listener = app.state::<FlListener>();
        take::record_take(
            &port,
            &listener,
            &window_ids,
            start_seconds,
            seconds,
            &folder,
        )
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
    let newest = recordings::newest_recording(&folder)?;
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

// --- Setup (onboarding) ---

// Everything the setup screen checks, in one call.
#[derive(serde::Serialize)]
struct SetupStatus {
    script: fl_script::ScriptStatus,
    /// Why the MIDI ports couldn't be created, None = both are there.
    midi_error: Option<String>,
    screen_permission: bool,
    platform: &'static str, // "macos" or "windows"
}

#[tauri::command]
fn setup_status(
    app: tauri::AppHandle,
    port: tauri::State<'_, FlPort>,
    listener: tauri::State<'_, FlListener>,
) -> SetupStatus {
    let hardware = fl_hardware_folder(&app);
    let midi_error = fl_midi::check_port(&port)
        .and_then(|_| listener.check())
        .err();
    SetupStatus {
        script: fl_script::status(hardware.as_deref()),
        midi_error,
        screen_permission: permission::granted(),
        platform: if cfg!(target_os = "macos") {
            "macos"
        } else {
            "windows"
        },
    }
}

// Copies the FL script into FL's Settings/Hardware folder. `picked`: a folder
// the user chose because FL's data folder isn't in the default place; it's
// remembered for next time.
// JS: invoke('install_fl_script', { picked: '/path' | null })
#[tauri::command]
fn install_fl_script(
    app: tauri::AppHandle,
    picked: Option<String>,
) -> Result<fl_script::ScriptStatus, String> {
    let hardware = match picked {
        Some(picked) => {
            let hardware = fl_script::hardware_folder_from_pick(std::path::Path::new(&picked));
            if !fl_script::looks_like_fl(&hardware) {
                return Err(format!(
                    "{picked} doesn't look like FL Studio's data folder (there's no Settings \
                     folder in it). Pick the folder called \"FL Studio\", by default in \
                     Documents/Image-Line."
                ));
            }
            save_fl_hardware_folder(&app, &hardware)?;
            hardware
        }
        None => fl_hardware_folder(&app)
            .ok_or("Couldn't find FL Studio's data folder. Choose it with \"Choose folder\".")?,
    };
    fl_script::install(&hardware)?;
    log::info!("Installed the FL script in {}", hardware.display());
    Ok(fl_script::status(Some(&hardware)))
}

// The file that remembers a folder the user picked.
fn fl_folder_setting(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("fl-hardware-folder.txt"))
}

fn save_fl_hardware_folder(
    app: &tauri::AppHandle,
    hardware: &std::path::Path,
) -> Result<(), String> {
    let file = fl_folder_setting(app).ok_or("Could not find the app's settings folder.")?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not save the setting: {e}"))?;
    }
    std::fs::write(&file, hardware.to_string_lossy().as_bytes())
        .map_err(|e| format!("Could not save the setting: {e}"))
}

// FL's Settings/Hardware folder: the one the user picked earlier if it's
// still valid, otherwise the default one if FL's data folder is there.
fn fl_hardware_folder(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let saved = fl_folder_setting(app)
        .and_then(|file| std::fs::read_to_string(file).ok())
        .map(|text| std::path::PathBuf::from(text.trim()));
    if let Some(saved) = saved
        && fl_script::looks_like_fl(&saved)
    {
        return Some(saved);
    }
    let documents = app.path().document_dir().ok()?;
    let default = fl_script::default_hardware_folder(&documents);
    fl_script::looks_like_fl(&default).then_some(default)
}

// "Test connection": pings the FL script and waits for its answer (up to
// 1.5 s, on a blocking thread). Returns the round trip in milliseconds.
#[tauri::command]
async fn fl_ping(app: tauri::AppHandle) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let port = app.state::<FlPort>();
        let listener = app.state::<FlListener>();
        fl_midi::ping(&port, &listener).map(|d| d.as_millis() as u32)
    })
    .await
    .map_err(|e| format!("Connection test crashed: {e}"))?
}

// Shows the macOS permission prompt (only the first time). Returns whether
// the permission is granted now.
#[tauri::command]
fn request_screen_permission() -> bool {
    permission::request()
}

#[tauri::command]
fn open_screen_permission_settings() -> Result<(), String> {
    permission::open_settings()
}

// macOS only applies a newly granted Screen Recording permission after a restart.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Native "choose folder" dialog, for FL's data folder in setup
        .plugin(tauri_plugin_dialog::init())
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

            // The input FL answers on (for "Test connection"). Same name, so
            // in FL's MIDI settings both are called "Beat Visualiser".
            let listener = fl_midi::create_listener(fl_midi::PORT_NAME);
            if let Err(e) = listener.check() {
                log::error!("{e}");
            }
            app.manage(listener);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_windows,
            record_take,
            latest_recording,
            fl_play,
            fl_stop,
            fl_ping,
            setup_status,
            install_fl_script,
            request_screen_permission,
            open_screen_permission_settings,
            restart_app,
            save_export,
            show_in_folder,
            audio_file::read_audio_file
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
