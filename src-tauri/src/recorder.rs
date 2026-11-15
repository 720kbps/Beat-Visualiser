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
use std::time::{Duration, Instant};

// How a take uses this (see take.rs):
//   let rec = Recording::prepare(id, &path)?;   // checks, builds the stream
//   rec.start()?;                               // capture begins
//   let t0 = rec.wait_until_started(..)?;       // the file's time 0
//   ... send play to FL ...
//   rec.check_error()?;                         // every 50 ms while waiting
//   let heard = rec.has_audio();                // any sound in the take?
//   let path = rec.finish()?;                   // closes the file
// Always call finish() once start() was called, also after an error, so the
// stream stops and the file gets closed. Several Recordings can run at the
// same time, one per window (take.rs records up to 3).

/// One window recording into a .mov file.
#[cfg(target_os = "macos")]
pub struct Recording {
    stream: screencapturekit::prelude::SCStream,
    output: screencapturekit::recording_output::SCRecordingOutput,
    path: std::path::PathBuf,
    // macOS reports failures and "recording started" through callbacks on its
    // own threads. They write into these shared slots; we read them while
    // waiting. (Arc = shared ownership, Mutex = safe access from threads.)
    error: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    started_at: std::sync::Arc<std::sync::Mutex<Option<Instant>>>,
    // Set by the audio callback once a buffer with real sound (not silence)
    // arrived. A plain bool shared between threads is an AtomicBool.
    heard_audio: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[cfg(target_os = "macos")]
impl Recording {
    /// Finds the window with this id (the SCWindow windowID from
    /// `list_windows`) and sets up a recording into the .mov file at `path`
    /// (its folder must exist). Checks permission and that the window is on
    /// screen. Doesn't start capturing yet: call `start()`.
    pub fn prepare(window_id: u32, path: &Path) -> Result<Recording, String> {
        use screencapturekit::prelude::*;
        use screencapturekit::recording_output::{
            RecordingCallbacks, SCRecordingOutput, SCRecordingOutputCodec,
            SCRecordingOutputConfiguration, SCRecordingOutputFileType,
        };
        use screencapturekit::stream::configuration::SCCaptureResolutionType;
        use screencapturekit::stream::delegate_trait::StreamCallbacks;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Mutex};

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
                "That window is not on screen (minimized or on another desktop). Bring it to \
                 the front and try again."
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
            // Audio for sync (CLAUDE.md, Sync): the recording output writes
            // it as an AAC track in the same .mov. With a single-window
            // filter macOS captures the audio of the app that owns the
            // window (FL Studio), not the whole system. Our own process is
            // excluded so the preview's sound never ends up in the take.
            .with_captures_audio(true)
            .with_excludes_current_process_audio(true)
            .with_sample_rate(48000)
            .with_channel_count(2)
            .with_capture_resolution_type(SCCaptureResolutionType::Best)
            .map_err(|e| format!("Could not configure capture: {e}"))?;

        let recording_config = SCRecordingOutputConfiguration::new()
            .map_err(|e| format!("Recording needs macOS 15 or newer: {e}"))?
            .with_output_url(path)
            .map_err(|e| format!("Bad output path {}: {e}", path.display()))?
            .with_video_codec(SCRecordingOutputCodec::HEVC)
            .with_output_file_type(SCRecordingOutputFileType::MOV);

        let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let started_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));

        // on_start: macOS calls this once the recording output has really
        // started writing, i.e. when the first frame goes into the file. We
        // take that moment as the file's time 0.
        let start_slot = Arc::clone(&started_at);
        let recording_error = Arc::clone(&error);
        let output = SCRecordingOutput::new_with_delegate(
            &recording_config,
            RecordingCallbacks::new()
                .on_start(move || {
                    *start_slot.lock().unwrap() = Some(Instant::now());
                })
                .on_fail(move |e| {
                    *recording_error.lock().unwrap() =
                        Some(format!("Writing the video failed: {e}"));
                }),
        )
        .ok_or("Could not create the recording output (needs macOS 15 or newer).")?;

        // Fires if the stream stops by itself, e.g. the window was closed.
        let stream_error = Arc::clone(&error);
        let mut stream = SCStream::new_with_delegate(
            &filter,
            &config,
            StreamCallbacks::new().on_error(move |e| {
                *stream_error.lock().unwrap() = Some(format!("Capture stopped: {e}"));
            }),
        )
        .map_err(|e| format!("Could not create capture stream: {e}"))?;

        // The recording output writes the audio track by itself. This extra
        // audio callback only looks at the samples to tell whether the
        // window's app made any sound during the take (FL may be muted, or
        // the user picked a window of another app).
        let heard_audio = Arc::new(AtomicBool::new(false));
        let heard_slot = Arc::clone(&heard_audio);
        stream
            .add_output_handler(
                move |sample: CMSampleBuffer, _kind: SCStreamOutputType| {
                    if !heard_slot.load(Ordering::Relaxed) && is_audible(&sample) {
                        heard_slot.store(true, Ordering::Relaxed);
                    }
                },
                SCStreamOutputType::Audio,
            )
            .map_err(|e| format!("Could not set up audio capture: {e}"))?;

        stream
            .add_recording_output(&output)
            .map_err(|e| format!("Could not attach the recording output: {e}"))?;

        Ok(Recording {
            stream,
            output,
            path: path.to_path_buf(),
            error,
            started_at,
            heard_audio,
        })
    }

    /// Starts capturing. Returns once macOS accepted the start; the first
    /// frame may arrive a little later (see `wait_until_started`).
    pub fn start(&self) -> Result<(), String> {
        self.stream
            .start_capture()
            .map_err(|e| format!("Could not start capture: {e}"))
    }

    /// Waits until the recording has really started (first frame written)
    /// and returns that moment. That's time 0 in the video file.
    pub fn wait_until_started(&self, timeout: Duration) -> Result<Instant, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(at) = *self.started_at.lock().unwrap() {
                return Ok(at);
            }
            self.check_error()?;
            if Instant::now() >= deadline {
                return Err(
                    "The recording didn't start: no frames came from the window. Is it \
                     visible on screen?"
                        .to_string(),
                );
            }
            // Short steps: this only decides how soon we notice. The moment
            // itself is stored by the callback, so the offset stays exact.
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// True once the window's app played something audible during the take.
    /// The file always gets an audio track; without sound it's just silence.
    pub fn has_audio(&self) -> bool {
        self.heard_audio.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Stops capturing, closes the file and returns its full path.
    pub fn finish(self) -> Result<String, String> {
        // Removing the only recording output stops the stream and waits until
        // the movie file is finished and closed.
        let remove_result = self.stream.remove_recording_output(&self.output);
        // Already stopped by the call above; this is a no-op safety net.
        let _ = self.stream.stop_capture();

        self.check_error()?;
        remove_result.map_err(|e| format!("Could not finish the video file: {e}"))?;

        // If no frame ever arrived, macOS may not have written a file at all.
        match std::fs::metadata(&self.path) {
            Ok(meta) if meta.len() > 0 => Ok(self.path.to_string_lossy().into_owned()),
            _ => Err("No video was written (no frames were captured from the window).".to_string()),
        }
    }

    /// The first error a callback reported, if any (window closed, writing
    /// failed). Call it regularly while recording.
    pub fn check_error(&self) -> Result<(), String> {
        match self.error.lock().unwrap().as_ref() {
            Some(e) => Err(e.clone()),
            None => Ok(()),
        }
    }
}

// True if any sample in this audio buffer is louder than about -60 dB.
// ScreenCaptureKit delivers 32-bit float samples, one buffer per channel.
// Silence from an app that plays nothing comes through as exact zeros.
#[cfg(target_os = "macos")]
fn is_audible(sample: &screencapturekit::cm::CMSampleBuffer) -> bool {
    let Ok(list) = sample.audio_buffer_list() else {
        return false;
    };
    for buffer in list.iter() {
        // Split the raw bytes into groups of 4, each one f32.
        let (samples, _rest) = buffer.data().as_chunks::<4>();
        for bytes in samples {
            if f32::from_ne_bytes(*bytes).abs() > 0.001 {
                return true;
            }
        }
    }
    false
}

// Windows: not implemented yet (Windows.Graphics.Capture comes later). Same
// methods so the take code compiles; prepare() fails before anything happens.
#[cfg(not(target_os = "macos"))]
pub struct Recording;

#[cfg(not(target_os = "macos"))]
impl Recording {
    pub fn prepare(_window_id: u32, _path: &Path) -> Result<Recording, String> {
        Err("Window recording is only implemented on macOS for now.".to_string())
    }

    pub fn start(&self) -> Result<(), String> {
        Err("Window recording is only implemented on macOS for now.".to_string())
    }

    pub fn wait_until_started(&self, _timeout: Duration) -> Result<Instant, String> {
        Err("Window recording is only implemented on macOS for now.".to_string())
    }

    pub fn check_error(&self) -> Result<(), String> {
        Err("Window recording is only implemented on macOS for now.".to_string())
    }

    pub fn has_audio(&self) -> bool {
        false
    }

    pub fn finish(self) -> Result<String, String> {
        Err("Window recording is only implemented on macOS for now.".to_string())
    }
}
