mod window_list;

// `async` makes Tauri run this on a background thread instead of the main
// thread, so the UI doesn't freeze while macOS collects the window list.
#[tauri::command]
async fn list_windows(
    title_filter: Option<String>,
) -> Result<Vec<window_list::WindowInfo>, String> {
    window_list::list_windows(title_filter)
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
        .invoke_handler(tauri::generate_handler![list_windows])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
