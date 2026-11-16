// Installs our FL Studio script (fl-script/BeatVisualiser/) into FL's
// Settings/Hardware folder, so the user doesn't copy files by hand.
//
// The script is compiled INTO the app (include_str!), so the installed copy
// always matches this build of the app. "Up to date" = the file on disk has
// exactly the same text.
//
// FL's data folder is Documents/Image-Line/FL Studio by default (macOS and
// Windows). Users can move it in FL; then the UI asks for the folder once and
// lib.rs remembers it.

use std::path::{Path, PathBuf};

use serde::Serialize;

pub const SCRIPT: &str = include_str!("../../fl-script/BeatVisualiser/device_BeatVisualiser.py");

// FL wants one folder per script, and the file name must start with "device_".
const SCRIPT_FOLDER: &str = "BeatVisualiser";
const SCRIPT_FILE: &str = "device_BeatVisualiser.py";

/// What the setup screen shows. Field names stay snake_case in JS.
#[derive(Serialize, Debug, PartialEq)]
pub struct ScriptStatus {
    /// FL's Settings/Hardware folder, or None if we couldn't find FL's data folder.
    pub hardware_folder: Option<String>,
    /// A file is there (maybe an older version).
    pub installed: bool,
    /// The file is there and identical to the script in this app.
    pub up_to_date: bool,
}

/// Documents/Image-Line/FL Studio/Settings/Hardware
pub fn default_hardware_folder(documents: &Path) -> PathBuf {
    documents
        .join("Image-Line")
        .join("FL Studio")
        .join("Settings")
        .join("Hardware")
}

/// The user may pick FL's data folder ("FL Studio"), its Settings folder,
/// or the Hardware folder itself; all three lead to the Hardware folder.
pub fn hardware_folder_from_pick(picked: &Path) -> PathBuf {
    match picked.file_name().and_then(|n| n.to_str()) {
        Some("Hardware") => picked.to_path_buf(),
        Some("Settings") => picked.join("Hardware"),
        _ => picked.join("Settings").join("Hardware"),
    }
}

/// True if `hardware` sits in a real FL data folder: its Settings folder
/// exists. (Hardware itself may not exist yet; install creates it.)
pub fn looks_like_fl(hardware: &Path) -> bool {
    hardware.parent().is_some_and(|settings| settings.is_dir())
}

pub fn status(hardware: Option<&Path>) -> ScriptStatus {
    let Some(hardware) = hardware else {
        return ScriptStatus {
            hardware_folder: None,
            installed: false,
            up_to_date: false,
        };
    };
    let file = hardware.join(SCRIPT_FOLDER).join(SCRIPT_FILE);
    // A file we can't read counts as not installed; install overwrites it.
    let on_disk = std::fs::read_to_string(&file).ok();
    ScriptStatus {
        hardware_folder: Some(hardware.to_string_lossy().into_owned()),
        installed: on_disk.is_some(),
        up_to_date: on_disk.as_deref() == Some(SCRIPT),
    }
}

/// Writes the script to Hardware/BeatVisualiser/device_BeatVisualiser.py,
/// creating the folders. Overwrites an older version.
pub fn install(hardware: &Path) -> Result<(), String> {
    let folder = hardware.join(SCRIPT_FOLDER);
    std::fs::create_dir_all(&folder)
        .map_err(|e| format!("Could not create {}: {e}", folder.display()))?;
    let file = folder.join(SCRIPT_FILE);
    std::fs::write(&file, SCRIPT).map_err(|e| format!("Could not write {}: {e}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_lead_to_the_hardware_folder() {
        let expected = Path::new("/x/FL Studio/Settings/Hardware");
        assert_eq!(
            hardware_folder_from_pick(Path::new("/x/FL Studio")),
            expected
        );
        assert_eq!(
            hardware_folder_from_pick(Path::new("/x/FL Studio/Settings")),
            expected
        );
        assert_eq!(hardware_folder_from_pick(expected), expected);
    }

    #[test]
    fn install_then_status_is_up_to_date() {
        let root = std::env::temp_dir().join(format!("bv-fl-script-test-{}", std::process::id()));
        let hardware = root.join("Settings").join("Hardware");
        std::fs::create_dir_all(root.join("Settings")).unwrap();
        assert!(looks_like_fl(&hardware));

        let before = status(Some(&hardware));
        assert!(!before.installed && !before.up_to_date);

        install(&hardware).unwrap();
        let after = status(Some(&hardware));
        assert!(after.installed && after.up_to_date);

        // An older version on disk: installed, not up to date
        std::fs::write(hardware.join(SCRIPT_FOLDER).join(SCRIPT_FILE), "# old").unwrap();
        let old = status(Some(&hardware));
        assert!(old.installed && !old.up_to_date);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_script_names_itself() {
        // FL shows the script under this name in its MIDI settings.
        assert!(SCRIPT.starts_with("# name=Beat Visualiser"));
    }
}
