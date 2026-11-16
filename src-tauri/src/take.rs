// One "take": FL plays the song from the start while we record up to 3
// windows at the same time (e.g. Serum, the piano roll, a clip window). This
// is the one-button flow (CLAUDE.md, User flow step 4).
//
// Order:
//   1. check everything we can (window list, length, MIDI port, FL answers
//      a ping, and for every window: permission, exists, on screen)
//   2. FL: stop, jump to the section start
//   3. start every recording, wait until each one has its first frame
//      (= that file's video time 0)
//   4. FL: play, once. Each clip's play_offset is measured from its own
//      video time 0 to that one moment.
//   5. record `seconds` plus a short tail
//   6. FL: stop (always, also after an error), close every file. If anything
//      failed, delete this take's files and return the first error.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::fl_midi::{self, FlListener, FlPort};
use crate::recorder::Recording;

/// What the UI gets back. Field names stay snake_case in JS.
#[derive(Serialize, Debug)]
pub struct Take {
    /// One clip per window, in the same order as the window ids we got.
    pub clips: Vec<TakeClip>,
}

/// One window's recording.
#[derive(Serialize, Debug)]
pub struct TakeClip {
    pub window_id: u32,
    /// Full path of the .mov file.
    pub path: String,
    /// Seconds from the start of THIS video to the moment we sent "play".
    /// FL's audio starts at roughly this time in the video, so the preview
    /// shows video time = beat time + play_offset.
    ///
    /// This is the coarse sync anchor. It doesn't include MIDI latency or the
    /// time FL needs to actually start its audio. The frontend refines it by
    /// cross-correlating the clip's audio with the beat file.
    pub play_offset: f64,
    /// True if the window's app made an audible sound during the take. The
    /// .mov always has an audio track (AAC, 48 kHz stereo, same time 0 as
    /// the video); when this is false that track is silent, so audio sync
    /// can't work and only `play_offset` is left.
    pub has_audio: bool,
}

// The recording's file type: what each platform's recorder writes.
#[cfg(target_os = "macos")]
const RECORDING_EXTENSION: &str = "mov";
#[cfg(not(target_os = "macos"))]
const RECORDING_EXTENSION: &str = "mp4";

/// The most windows one take can record.
pub const MAX_WINDOWS: usize = 3;

// Keep recording a little after the section ends, so the last frames are
// there even if FL started its audio a few ms late.
const TAIL: Duration = Duration::from_millis(300);

// How long to wait for each recording's first frame before giving up.
const START_TIMEOUT: Duration = Duration::from_secs(3);

/// Runs a whole take and returns one clip per window. Blocks for the full
/// length, so call it from a background thread.
pub fn record_take(
    port: &FlPort,
    listener: &FlListener,
    window_ids: &[u32],
    start_seconds: f64,
    seconds: f64,
    folder: &Path,
) -> Result<Take, String> {
    // 1. Checks first, so a bad take never touches FL.
    check_window_ids(window_ids)?;
    // Lengths are a whole number of bars, so not whole seconds (8 bars at
    // 140 BPM = 13.71 s).
    if !(1.0..=60.0).contains(&seconds) {
        return Err(format!("Length must be 1 to 60 seconds, got {seconds:.2}."));
    }
    let start_ms = (start_seconds * 1000.0).round();
    if !(0.0..=fl_midi::MAX_JUMP_MS as f64).contains(&start_ms) {
        return Err(format!(
            "The section start ({start_seconds:.2} s) is out of range."
        ));
    }
    fl_midi::check_port(port)?;
    // FL must really be listening, or we'd record a silent, still take.
    fl_midi::ping(port, listener)?;

    // Each prepare checks permission and that the window still exists and is
    // on screen. If one fails, the ones already prepared are simply dropped:
    // nothing was started, so no file exists yet.
    std::fs::create_dir_all(folder)
        .map_err(|e| format!("Could not create folder {}: {e}", folder.display()))?;
    let paths = take_paths(folder, window_ids.len());
    let mut recordings = Vec::new();
    for (i, &window_id) in window_ids.iter().enumerate() {
        let recording = Recording::prepare(window_id, &paths[i])
            .map_err(|e| label_error(window_ids.len(), i, e))?;
        recordings.push(recording);
    }

    // 2. FL to the section start, not playing. The script handles the
    // messages in the order they arrive, so the jump lands before the play.
    // FL's song position in ms matches the beat file's time because the beat
    // was exported from the song start.
    fl_midi::send_to_fl(port, fl_midi::send_stop)?;
    fl_midi::send_to_fl(port, |conn| fl_midi::send_jump(conn, start_ms as u32))?;

    // 3 to 5.
    let result = play_and_record(port, &recordings, seconds);

    // 6. Stop FL whatever happened above. Harmless if play was never sent.
    if let Err(e) = fl_midi::send_to_fl(port, fl_midi::send_stop) {
        log::error!("Could not stop FL after the take: {e}");
    }

    // Finish every recording, even after an error, so all streams stop and
    // all files get closed. Remember the first error.
    let mut first_error = result.as_ref().err().cloned();
    let mut finished = Vec::new(); // (path, has_audio) per window
    for (i, recording) in recordings.into_iter().enumerate() {
        let has_audio = recording.has_audio();
        match recording.finish() {
            Ok(path) => finished.push((path, has_audio)),
            Err(e) => {
                if first_error.is_none() {
                    first_error = Some(label_error(window_ids.len(), i, e));
                }
            }
        }
    }

    // A take with a missing clip is no use to the UI, so throw away all of
    // its files (also the ones that were written fine) and report the error.
    if let Some(error) = first_error {
        for path in &paths {
            // The file may not exist (never started), so ignore failures.
            let _ = std::fs::remove_file(path);
        }
        return Err(error);
    }

    // No error, so `result` is Ok and every window has a finished file.
    let play_offsets = result?;
    let mut clips = Vec::new();
    for (i, (path, has_audio)) in finished.into_iter().enumerate() {
        clips.push(TakeClip {
            window_id: window_ids[i],
            path,
            play_offset: play_offsets[i],
            has_audio,
        });
    }
    Ok(Take { clips })
}

// Starts all recordings, sends play, records. Returns the play offset of
// each recording, in the same order.
fn play_and_record(
    port: &FlPort,
    recordings: &[Recording],
    seconds: f64,
) -> Result<Vec<f64>, String> {
    let count = recordings.len();

    // Start them all first, then wait: the streams warm up in parallel, so
    // their start moments end up close together.
    for (i, recording) in recordings.iter().enumerate() {
        recording.start().map_err(|e| label_error(count, i, e))?;
    }
    let mut video_starts = Vec::new();
    for (i, recording) in recordings.iter().enumerate() {
        let started = recording
            .wait_until_started(START_TIMEOUT)
            .map_err(|e| label_error(count, i, e))?;
        video_starts.push(started);
    }

    // One "play" for all clips. Instant is a monotonic clock: it never jumps
    // when the system time changes.
    let play_sent = Instant::now();
    fl_midi::send_to_fl(port, fl_midi::send_play)?;

    // Every recording started before play_sent, so no offset is negative.
    let mut play_offsets = Vec::new();
    for (i, started) in video_starts.iter().enumerate() {
        let offset = play_sent.duration_since(*started).as_secs_f64();
        log::info!(
            "Take: window {} sent play {offset:.3} s after its video started",
            i + 1
        );
        play_offsets.push(offset);
    }

    // Keep recording, checking every 50 ms that no recording failed (e.g. a
    // window was closed), so a broken take stops early.
    let deadline = Instant::now() + Duration::from_secs_f64(seconds) + TAIL;
    loop {
        for (i, recording) in recordings.iter().enumerate() {
            recording
                .check_error()
                .map_err(|e| label_error(count, i, e))?;
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(play_offsets);
        }
        std::thread::sleep((deadline - now).min(Duration::from_millis(50)));
    }
}

// 1 to MAX_WINDOWS ids, no window twice.
fn check_window_ids(window_ids: &[u32]) -> Result<(), String> {
    if window_ids.is_empty() {
        return Err("Pick at least one window to record.".to_string());
    }
    if window_ids.len() > MAX_WINDOWS {
        return Err(format!(
            "A take can record at most {MAX_WINDOWS} windows, got {}.",
            window_ids.len()
        ));
    }
    for (i, id) in window_ids.iter().enumerate() {
        if window_ids[..i].contains(id) {
            return Err("The same window was picked twice.".to_string());
        }
    }
    Ok(())
}

// One file per window, all with the same timestamp and a number, so three
// windows recorded in the same second don't collide:
// ~/Movies/Beat Visualiser/take-1763112345-1.mov, -2.mov, -3.mov
// (.mp4 on Windows, see recorder_windows.rs)
fn take_paths(folder: &Path, count: usize) -> Vec<PathBuf> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut paths = Vec::new();
    for n in 1..=count {
        paths.push(folder.join(format!("take-{timestamp}-{n}.{RECORDING_EXTENSION}")));
    }
    paths
}

// With several windows, says which one an error is about ("Window 2: ...").
fn label_error(count: usize, index: usize, error: String) -> String {
    if count > 1 {
        format!("Window {}: {error}", index + 1)
    } else {
        error
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_ids_are_checked() {
        assert!(check_window_ids(&[]).is_err());
        assert!(check_window_ids(&[1]).is_ok());
        assert!(check_window_ids(&[1, 2, 3]).is_ok());
        assert!(check_window_ids(&[1, 2, 3, 4]).is_err());
        assert!(check_window_ids(&[1, 2, 1]).is_err());
    }

    #[test]
    fn take_paths_are_numbered() {
        let paths = take_paths(Path::new("/x"), 3);
        assert_eq!(paths.len(), 3);
        for (i, path) in paths.iter().enumerate() {
            let name = path.file_name().unwrap().to_str().unwrap();
            assert!(name.starts_with("take-"));
            assert!(name.ends_with(&format!("-{}.mov", i + 1)));
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use std::sync::Mutex;

    use super::*;

    // A 2 s take of up to 2 on-screen windows, without FL: the notes go to a
    // test MIDI port, and a fake "FL" thread answers the ping. Proves the timing path and that the
    // files are written. Ignored by default because it really records your
    // screen. Run with:
    //   cargo test take_without_fl -- --ignored --nocapture
    // Needs Screen Recording permission for the terminal you run it from.
    #[test]
    #[ignore]
    fn take_without_fl() {
        crate::window_list::init_core_graphics_for_tests();

        // Own port name so a running FL never reacts to this test.
        let name = format!("Beat Visualiser Take Test {}", std::process::id());
        let port = FlPort(Mutex::new(fl_midi::create_port(&name)));
        let listener = fl_midi::create_listener(&name);
        // Fake FL: answers every ping on our input with note-on 62.
        let output = midir::MidiOutput::new("Fake FL").unwrap();
        let target = output
            .ports()
            .into_iter()
            .find(|p| output.port_name(p).ok().as_deref() == Some(name.as_str()))
            .expect("virtual input not found");
        let mut fake_fl = output.connect(&target, "fake fl").unwrap();
        std::thread::spawn(move || {
            for _ in 0..40 {
                std::thread::sleep(std::time::Duration::from_millis(50));
                if fake_fl.send(&[0x90, 62, 127]).is_err() {
                    break;
                }
            }
        });

        // TAKE_TEST_APP=Music picks windows of an app whose name contains
        // that text. Handy for checking audio: only the window's own app is
        // heard. TAKE_TEST_KEEP=1 keeps the files so they can be inspected.
        let app = std::env::var("TAKE_TEST_APP").unwrap_or_default();
        let windows = crate::window_list::list_windows(None).expect("list windows");
        let picked: Vec<_> = windows
            .iter()
            .filter(|w| w.on_screen && w.app_name.contains(&app))
            .take(2)
            .collect();
        assert!(!picked.is_empty(), "no matching on-screen window");
        for w in &picked {
            println!("recording [{}] {}", w.app_name, w.title);
        }
        let ids: Vec<u32> = picked.iter().map(|w| w.id).collect();

        let take = record_take(&port, &listener, &ids, 0.0, 2.0, &std::env::temp_dir())
            .expect("take failed");
        assert_eq!(take.clips.len(), ids.len());
        for clip in &take.clips {
            println!(
                "window {}: {} play_offset {:.3} s, has_audio {}",
                clip.window_id, clip.path, clip.play_offset, clip.has_audio
            );
            assert!(clip.play_offset >= 0.0 && clip.play_offset < 1.0);
        }
        if std::env::var("TAKE_TEST_KEEP").is_err() {
            for clip in &take.clips {
                std::fs::remove_file(&clip.path).ok();
            }
        }
    }
}
