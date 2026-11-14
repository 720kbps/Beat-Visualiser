// Saves the exported MP4 and shows it in Finder / Explorer.
//
// The video is encoded in the webview (WebCodecs); Rust only writes the
// finished bytes to disk. They arrive as the raw request body: JS calls
// `invoke('save_export', bytes)` with a Uint8Array as the whole argument,
// and Tauri hands it over as `InvokeBody::Raw` instead of turning it into a
// JSON array of numbers (several times bigger and slow to parse).

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::ipc::{InvokeBody, Request};

/// "export-1794680000.mp4" for the given Unix time in seconds.
pub fn export_file_name(unix_secs: u64) -> String {
    format!("export-{unix_secs}.mp4")
}

/// A path in `folder` that doesn't exist yet: export-<ts>.mp4, or
/// export-<ts>-2.mp4 etc. if two exports finish within the same second.
pub fn unused_export_path(folder: &Path, unix_secs: u64) -> PathBuf {
    let first = folder.join(export_file_name(unix_secs));
    if !first.exists() {
        return first;
    }
    let mut n = 2;
    loop {
        let path = folder.join(format!("export-{unix_secs}-{n}.mp4"));
        if !path.exists() {
            return path;
        }
        n += 1;
    }
}

/// Writes the MP4 into `folder` (created if needed) and returns its path.
pub fn save_export(folder: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("The exported video is empty.".to_string());
    }
    std::fs::create_dir_all(folder)
        .map_err(|e| format!("Can't create {}: {e}", folder.display()))?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = unused_export_path(folder, now);
    std::fs::write(&path, bytes).map_err(|e| format!("Can't write {}: {e}", path.display()))?;
    Ok(path)
}

/// The raw bytes of a `save_export` request. A JSON body means the JS side
/// passed something other than a Uint8Array/ArrayBuffer.
pub fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.as_slice()),
        InvokeBody::Json(_) => Err("save_export expects the video as raw bytes.".to_string()),
    }
}

/// True if `path` is a file inside `folder` (after resolving `..` and
/// symlinks). Keeps show_in_folder from being used to reveal arbitrary paths.
pub fn is_inside(folder: &Path, path: &Path) -> bool {
    let (Ok(folder), Ok(path)) = (folder.canonicalize(), path.canonicalize()) else {
        return false; // one of them doesn't exist
    };
    path.is_file() && path.starts_with(&folder)
}

/// Opens Finder (macOS) or Explorer (Windows) with the file selected.
pub fn show_in_folder(folder: &Path, path: &Path) -> Result<(), String> {
    if !is_inside(folder, path) {
        return Err(format!(
            "{} is not a file in {}.",
            path.display(),
            folder.display()
        ));
    }
    reveal(path)
}

#[cfg(target_os = "macos")]
fn reveal(path: &Path) -> Result<(), String> {
    // `open -R` = "reveal in Finder".
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open Finder: {e}"))
}

#[cfg(target_os = "windows")]
fn reveal(path: &Path) -> Result<(), String> {
    // `/select,<path>` must be ONE argument. Explorer's exit code is 1 even
    // when it worked, so we only check that it started.
    let mut arg = std::ffi::OsString::from("/select,");
    arg.push(path);
    std::process::Command::new("explorer")
        .arg(arg)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open Explorer: {e}"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn reveal(path: &Path) -> Result<(), String> {
    Err(format!(
        "Show in folder isn't supported on this system. The file is {}",
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // A fresh, empty folder in the system temp dir, unique per test.
    fn temp_folder(test_name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!(
            "beat-visualiser-export-test-{test_name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn names_the_file_after_the_time() {
        assert_eq!(export_file_name(1_794_680_000), "export-1794680000.mp4");
    }

    #[test]
    fn saves_and_never_overwrites() {
        let folder = temp_folder("save");
        let a = save_export(&folder, b"first").unwrap();
        let b = save_export(&folder, b"second").unwrap();
        assert_ne!(a, b); // same second: the second one gets a -2 suffix
        assert_eq!(std::fs::read(&a).unwrap(), b"first");
        assert_eq!(std::fs::read(&b).unwrap(), b"second");
        assert!(save_export(&folder, b"").is_err());
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn only_files_inside_the_folder_count() {
        let folder = temp_folder("inside");
        let file = save_export(&folder, b"x").unwrap();
        assert!(is_inside(&folder, &file));
        // `..` out of the folder, to an existing file elsewhere
        let outside = folder.join("..").join(folder.file_name().unwrap());
        assert!(!is_inside(&folder, &outside)); // a folder, not a file
        assert!(!is_inside(&folder, &folder.join("missing.mp4")));
        let other = temp_folder("inside-other");
        let elsewhere = save_export(&other, b"y").unwrap();
        assert!(!is_inside(&folder, &elsewhere));
        std::fs::remove_dir_all(&folder).unwrap();
        std::fs::remove_dir_all(&other).unwrap();
    }
}
