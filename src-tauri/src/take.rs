// One "take": FL plays the song from the start while we record the plugin
// window. This is the one-button flow (CLAUDE.md, User flow step 4).
//
// Order:
//   1. check everything we can (length, MIDI port, permission, window)
//   2. FL: stop, rewind to the song start
//   3. start the window recording, wait for its first frame (= video time 0)
//   4. FL: play, and note how long after video time 0 that was (play_offset)
//   5. record `seconds` plus a short tail
//   6. FL: stop (always, also after an error), close the file

use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::fl_midi::{self, FlPort};
use crate::recorder::Recording;

/// What the UI gets back. Field names stay snake_case in JS.
#[derive(Serialize, Debug)]
pub struct Take {
    /// Full path of the .mov file.
    pub path: String,
    /// Seconds from the start of the video to the moment we sent "play".
    /// FL's audio starts at roughly this time in the video, so the preview
    /// shows video time = beat time + play_offset.
    ///
    /// This is the coarse sync anchor. It doesn't include MIDI latency or the
    /// time FL needs to actually start its audio. Phase 5 refines it by
    /// cross-correlating recorded system audio with the beat file.
    pub play_offset: f64,
}

// Keep recording a little after the section ends, so the last frames are
// there even if FL started its audio a few ms late.
const TAIL: Duration = Duration::from_millis(300);

// How long to wait for the first captured frame before giving up.
const START_TIMEOUT: Duration = Duration::from_secs(3);

/// Runs a whole take and returns the file and its play offset. Blocks for
/// the full length, so call it from a background thread.
pub fn record_take(
    port: &FlPort,
    window_id: u32,
    seconds: u32,
    folder: &Path,
) -> Result<Take, String> {
    // 1. Checks first, so a bad take never touches FL.
    if !(1..=60).contains(&seconds) {
        return Err(format!("Length must be 1 to 60 seconds, got {seconds}."));
    }
    fl_midi::check_port(port)?;
    // Checks permission and that the window still exists and is on screen.
    let recording = Recording::prepare(window_id, folder)?;

    // 2. FL to the song start, not playing. The script handles the notes in
    // the order they arrive, so the rewind lands before the play below.
    fl_midi::send_to_fl(port, fl_midi::send_stop)?;
    fl_midi::send_to_fl(port, fl_midi::send_rewind)?;

    // 3 to 5.
    let result = play_and_record(port, &recording, seconds);

    // 6. Stop FL whatever happened above. Harmless if play was never sent.
    if let Err(e) = fl_midi::send_to_fl(port, fl_midi::send_stop) {
        log::error!("Could not stop FL after the take: {e}");
    }
    let path = recording.finish();

    // Report the first failure: the take itself, then closing the file.
    let play_offset = result?;
    Ok(Take {
        path: path?,
        play_offset,
    })
}

// Starts the recording, sends play, records. Returns the play offset.
fn play_and_record(port: &FlPort, recording: &Recording, seconds: u32) -> Result<f64, String> {
    recording.start()?;
    let video_start = recording.wait_until_started(START_TIMEOUT)?;

    // Instant is a monotonic clock: it never jumps when the system time changes.
    let play_sent = Instant::now();
    fl_midi::send_to_fl(port, fl_midi::send_play)?;
    let play_offset = play_sent.duration_since(video_start).as_secs_f64();
    log::info!("Take: sent play {play_offset:.3} s after the video started");

    recording.record_for(Duration::from_secs(seconds.into()) + TAIL)?;
    Ok(play_offset)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::sync::Mutex;

    use super::*;

    // A 2 s take of the first on-screen window, without FL: the notes go to a
    // test MIDI port nobody listens to. Proves the timing path and that the
    // file is written. Ignored by default because it really records your
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

        let windows = crate::window_list::list_windows(None).expect("list windows");
        let window = windows
            .iter()
            .find(|w| w.on_screen)
            .expect("no on-screen window");
        println!("recording [{}] {}", window.app_name, window.title);

        let take = record_take(&port, window.id, 2, &std::env::temp_dir()).expect("take failed");
        println!("saved: {}", take.path);
        println!("play_offset: {:.3} s", take.play_offset);
        assert!(take.play_offset >= 0.0 && take.play_offset < 1.0);
        std::fs::remove_file(&take.path).ok();
    }
}
