// Records one window to a video file.
//
// macOS: ScreenCaptureKit's SCRecordingOutput (macOS 15+). We hand it the
// stream and a file path, and macOS encodes and writes the movie itself
// (hardware HEVC). No frames pass through our code.
//
// Note: SCRecordingOutput only offers H.264 and HEVC (checked on macOS 26),
// not ProRes. ProRes would need our own AVAssetWriter fed with the raw
// frames, which is a lot more code. HEVC is fine for the spike.

use std::path::Path;

/// Records the window with this id (the SCWindow windowID from
/// `list_windows`) for `seconds` seconds into a new .mov file inside
/// `folder`. Returns the full path of the file.
///
/// This blocks the calling thread for the whole recording, so call it from a
/// background thread.
#[cfg(target_os = "macos")]
pub fn record_window(window_id: u32, seconds: u32, folder: &Path) -> Result<String, String> {
    use screencapturekit::prelude::*;
    use screencapturekit::recording_output::{
        RecordingCallbacks, SCRecordingOutput, SCRecordingOutputCodec,
        SCRecordingOutputConfiguration, SCRecordingOutputFileType,
    };
    use screencapturekit::stream::configuration::SCCaptureResolutionType;
    use screencapturekit::stream::delegate_trait::StreamCallbacks;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    crate::window_list::check_screen_recording_permission()?;

    // Find the window again by id. It may have been closed since the list
    // was shown.
    let content = SCShareableContent::create()
        .get()
        .map_err(|e| format!("Could not list windows: {e}"))?;
    let window = content
        .windows()
        .into_iter()
        .find(|w| w.window_id() == window_id)
        .ok_or("That window no longer exists. Click \"List windows\" again.")?;

    // A minimized window (or one on another Space) delivers no frames, so the
    // file would be empty. Being covered by other windows is fine.
    if !window.is_on_screen() {
        return Err(
            "That window is not on screen (minimized or on another desktop). Bring it to the \
             front and try again."
                .to_string(),
        );
    }

    let filter = SCContentFilter::create()
        .with_window(&window)
        .build()
        .map_err(|e| format!("Could not set up capture for that window: {e}"))?;

    // Record at the window's real pixel size: points * scale (2.0 on Retina).
    let scale = f64::from(filter.point_pixel_scale());
    let frame = window.frame();
    let width = (frame.size.width * scale).round() as u32;
    let height = (frame.size.height * scale).round() as u32;

    // minimum_frame_interval = 1/60 s caps capture at 60 fps. macOS only
    // sends a frame when the window content changes, so a still window gives
    // fewer frames. Each frame keeps its real timestamp in the file, so the
    // timing is still correct (variable frame rate).
    let config = SCStreamConfiguration::new()
        .with_width(width)
        .with_height(height)
        .with_minimum_frame_interval(&CMTime::new(1, 60))
        .with_pixel_format(PixelFormat::BGRA)
        .with_shows_cursor(false)
        .with_capture_resolution_type(SCCaptureResolutionType::Best)
        .map_err(|e| format!("Could not configure capture: {e}"))?;
    // Phase 5: system audio for sync goes here:
    // .with_captures_audio(true).with_excludes_current_process_audio(true)
    // (needs SCRecordingOutput or a stream output that also writes audio).

    // Build the output file path, e.g. ~/Movies/Beat Visualiser/spike-1763112345.mov
    std::fs::create_dir_all(folder)
        .map_err(|e| format!("Could not create folder {}: {e}", folder.display()))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = folder.join(format!("spike-{timestamp}.mov"));

    let recording_config = SCRecordingOutputConfiguration::new()
        .map_err(|e| format!("Recording needs macOS 15 or newer: {e}"))?
        .with_output_url(&path)
        .map_err(|e| format!("Bad output path {}: {e}", path.display()))?
        .with_video_codec(SCRecordingOutputCodec::HEVC)
        .with_output_file_type(SCRecordingOutputFileType::MOV);

    // macOS reports failures through callbacks on its own threads. Both
    // callbacks write into this shared slot; we check it while waiting and
    // at the end. (Arc = shared ownership, Mutex = safe access from threads.)
    let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let recording_error = Arc::clone(&error);
    let recording = SCRecordingOutput::new_with_delegate(
        &recording_config,
        RecordingCallbacks::new().on_fail(move |e| {
            *recording_error.lock().unwrap() = Some(format!("Writing the video failed: {e}"));
        }),
    )
    .ok_or("Could not create the recording output (needs macOS 15 or newer).")?;

    // Fires if the stream stops by itself, e.g. the window was closed.
    let stream_error = Arc::clone(&error);
    let stream = SCStream::new_with_delegate(
        &filter,
        &config,
        StreamCallbacks::new().on_error(move |e| {
            *stream_error.lock().unwrap() = Some(format!("Capture stopped: {e}"));
        }),
    )
    .map_err(|e| format!("Could not create capture stream: {e}"))?;

    stream
        .add_recording_output(&recording)
        .map_err(|e| format!("Could not attach the recording output: {e}"))?;
    stream
        .start_capture()
        .map_err(|e| format!("Could not start capture: {e}"))?;

    // Wait for the recording length, but check every 100 ms whether
    // something failed so we can stop early.
    for _ in 0..seconds * 10 {
        std::thread::sleep(Duration::from_millis(100));
        if error.lock().unwrap().is_some() {
            break;
        }
    }

    // Removing the only recording output stops the stream and waits until
    // the movie file is finished and closed.
    let remove_result = stream.remove_recording_output(&recording);
    // Already stopped by the call above; this is a no-op safety net.
    let _ = stream.stop_capture();

    if let Some(e) = error.lock().unwrap().take() {
        return Err(e);
    }
    remove_result.map_err(|e| format!("Could not finish the video file: {e}"))?;

    // If no frame ever arrived, macOS may not have written a file at all.
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() > 0 => Ok(path.to_string_lossy().into_owned()),
        _ => Err("No video was written (no frames were captured from the window).".to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn record_window(_window_id: u32, _seconds: u32, _folder: &Path) -> Result<String, String> {
    Err("Window recording is only implemented on macOS for now.".to_string())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    // Records 2 s of the first on-screen window (e.g. an Ogun window) into
    // the system temp folder and prints the file path. Ignored by default because it really records
    // your screen. Run with:
    //   cargo test record_first_window -- --ignored --nocapture
    // Needs Screen Recording permission for the terminal you run it from.
    #[test]
    #[ignore]
    fn record_first_window() {
        crate::window_list::init_core_graphics_for_tests();

        let windows = crate::window_list::list_windows(None).expect("list windows");
        let window = windows
            .iter()
            .find(|w| w.on_screen)
            .expect("no on-screen window");
        println!(
            "recording [{}] {} ({}x{})",
            window.app_name, window.title, window.width, window.height
        );
        match super::record_window(window.id, 2, &std::env::temp_dir()) {
            Ok(path) => println!("saved: {path}"),
            Err(e) => panic!("recording failed: {e}"),
        }
    }
}
