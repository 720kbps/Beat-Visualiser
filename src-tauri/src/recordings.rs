// Finds recordings in the app's recordings folder (~/Movies/Beat Visualiser).

use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// The folder the recorder saves into and the asset protocol is allowed to
/// read from. Keep it in sync with `assetProtocol.scope` in tauri.conf.json
/// (`$VIDEO/Beat Visualiser/**`).
pub const FOLDER_NAME: &str = "Beat Visualiser";

/// Returns the newest `.mov` file in `folder` (by modified time), or None if
/// there is none. A folder that doesn't exist yet (nothing recorded) is not
/// an error, it just has no recordings.
pub fn newest_mov(folder: &Path) -> Result<Option<PathBuf>, String> {
    let entries = match std::fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Can't read {}: {e}", folder.display())),
    };

    let mut newest: Option<(SystemTime, PathBuf)> = None;
    for entry in entries {
        // Skip entries we can't read instead of failing the whole search.
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !is_mov(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let is_newer = match &newest {
            Some((best, _)) => modified > *best,
            None => true,
        };
        if is_newer {
            newest = Some((modified, path));
        }
    }
    Ok(newest.map(|(_, path)| path))
}

// .mov in any letter case.
fn is_mov(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mov"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::time::{Duration, UNIX_EPOCH};

    // Creates an empty file with the given modified time (seconds since 1970).
    fn touch(folder: &Path, name: &str, modified_secs: u64) {
        let file = File::create(folder.join(name)).unwrap();
        file.set_modified(UNIX_EPOCH + Duration::from_secs(modified_secs))
            .unwrap();
    }

    // A fresh, empty folder in the system temp dir, unique per test.
    fn temp_folder(test_name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!(
            "beat-visualiser-test-{test_name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn picks_the_newest_mov() {
        let folder = temp_folder("newest");
        touch(&folder, "old.mov", 1_000);
        touch(&folder, "new.MOV", 3_000);
        touch(&folder, "middle.mov", 2_000);
        // Newer, but not a .mov: ignored
        touch(&folder, "notes.txt", 9_000);
        // A folder named like a recording: ignored
        std::fs::create_dir(folder.join("folder.mov")).unwrap();

        let newest = newest_mov(&folder).unwrap();
        assert_eq!(newest, Some(folder.join("new.MOV")));
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn empty_or_missing_folder_gives_none() {
        let folder = temp_folder("empty");
        assert_eq!(newest_mov(&folder).unwrap(), None);
        std::fs::remove_dir_all(&folder).unwrap();
        assert_eq!(newest_mov(&folder).unwrap(), None); // now missing
    }
}
