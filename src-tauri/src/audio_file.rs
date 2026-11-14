// Reads a dropped beat file (WAV or MP3) and sends its bytes to the UI.

use std::path::Path;

// Big enough for a long 24-bit stereo WAV (about 200 MB ≈ 13 min at 48 kHz),
// small enough that we don't try to push gigabytes through IPC by mistake.
const MAX_SIZE_MB: u64 = 200;
const MAX_SIZE_BYTES: u64 = MAX_SIZE_MB * 1024 * 1024;

// Returns the raw file bytes. `tauri::ipc::Response` sends them as binary
// (application/octet-stream), so JavaScript gets an `ArrayBuffer`. A plain
// `Vec<u8>` return would be turned into a JSON array of numbers instead,
// which is several times bigger and slow to parse.
//
// `async` so Tauri runs it off the main thread and the UI stays responsive
// while a large file is read.
#[tauri::command]
pub async fn read_audio_file(path: String) -> Result<tauri::ipc::Response, String> {
    let path = Path::new(&path);
    check_extension(path)?;

    // metadata() fails if the file doesn't exist or we can't access it.
    let meta =
        std::fs::metadata(path).map_err(|e| format!("Can't open {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file.", path.display()));
    }
    check_size(meta.len())?;

    let bytes = std::fs::read(path).map_err(|e| format!("Can't read {}: {e}", path.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

// Only .wav and .mp3, any letter case (.WAV is common on Windows).
fn check_extension(path: &Path) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext == "wav" || ext == "mp3" {
        Ok(())
    } else {
        Err("Unsupported file type. Drop a WAV or MP3 file.".to_string())
    }
}

fn check_size(len: u64) -> Result<(), String> {
    if len == 0 {
        return Err("The file is empty.".to_string());
    }
    if len > MAX_SIZE_BYTES {
        let mb = len / (1024 * 1024);
        return Err(format!(
            "The file is {mb} MB. The limit is {MAX_SIZE_MB} MB."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_wav_and_mp3_in_any_case() {
        assert!(check_extension(Path::new("/beats/a.wav")).is_ok());
        assert!(check_extension(Path::new("/beats/a.MP3")).is_ok());
        assert!(check_extension(Path::new(r"C:\Beats\a.Wav")).is_ok());
    }

    #[test]
    fn rejects_other_files() {
        assert!(check_extension(Path::new("/beats/a.flac")).is_err());
        assert!(check_extension(Path::new("/beats/wav")).is_err());
        assert!(check_extension(Path::new("/beats/a.wav.txt")).is_err());
    }

    #[test]
    fn checks_size() {
        assert!(check_size(0).is_err());
        assert!(check_size(1).is_ok());
        assert!(check_size(MAX_SIZE_BYTES).is_ok());
        assert!(check_size(MAX_SIZE_BYTES + 1).is_err());
    }
}
