mod audio_file;
mod fl_midi;
mod recorder;
mod window_list;

use std::sync::Mutex;

use midir::MidiOutputConnection;
use tauri::Manager; // gives `app.path()` and `app.manage()`

// The MIDI connection to FL, kept in Tauri "managed state".
//
// `app.manage(value)` hands one value to Tauri, which keeps it alive until
// the app quits. Any command can then ask for it by adding a
// `tauri::State<'_, FlPort>` argument; Tauri fills it in (you don't pass it
// from JavaScript). State is looked up by type, hence the small wrapper type.
//
// - Mutex: commands can run on different threads, and sending MIDI needs
//   `&mut`, so only one command may use the connection at a time.
// - Result: holds the error text if creating the port failed at startup,
//   so the commands can show the reason instead of a vague message.
struct FlPort(Mutex<Result<MidiOutputConnection, String>>);

// Sends one FL command (play or stop) through the shared port.
fn send_to_fl(
    port: &FlPort,
    send: fn(&mut MidiOutputConnection) -> Result<(), String>,
) -> Result<(), String> {
    // lock() only fails if another thread panicked while holding the lock.
    let mut guard = port
        .0
        .lock()
        .map_err(|_| "MIDI port is unusable after an earlier crash.".to_string())?;
    match guard.as_mut() {
        Ok(conn) => send(conn),
        Err(startup_error) => Err(format!("No MIDI port: {startup_error}")),
    }
}

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

            // Create the virtual MIDI port once, for the whole app run: FL
            // only sees the port while it exists. If it fails we keep the app
            // running; fl_play / fl_stop will then return this error.
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
            record_window,
            fl_play,
            fl_stop,
            audio_file::read_audio_file
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
