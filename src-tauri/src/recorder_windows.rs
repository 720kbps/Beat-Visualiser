// Windows version of Recording (included by recorder.rs, Windows only).
//
// STATUS: written blind on a Mac. It type-checks with
// `cargo check --target x86_64-pc-windows-msvc`, but has NEVER RUN.
// Every "TEST:" comment is something to check on a real Windows PC.
// How to test it without FL or MIDI: the ignored test at the bottom.
//
// How it works (Windows.Graphics.Capture through the windows-capture crate):
// - start() runs the capture on its own thread (start_free_threaded).
//   Windows calls on_frame_arrived() for every new frame.
// - The first frame creates the encoder (at that frame's size) and marks
//   this file's time 0. Every frame goes to the encoder, which writes an
//   H.264 .mp4 through Media Foundation (hardware encoder when there is one).
// - finish() stops the capture, then closes the encoder, which writes the
//   end of the .mp4.
//
// Differences from macOS, on purpose for this first step:
// - Video only. No audio yet, so has_audio() is false and the app falls back
//   to the play_offset timing estimate instead of audio sync. FL's audio
//   (WASAPI process loopback) is step 3 of the Windows plan.
// - H.264 .mp4 instead of HEVC .mov: WebView2 (Chromium) plays H.264 .mp4
//   reliably; HEVC and .mov are not guaranteed there.
// - Windows only sends a frame when the window's picture changes, so the
//   video has a variable frame rate. The encoder stamps each frame with its
//   real time, so timing stays right.
//   TEST: record a window that doesn't change at the end of the take. The
//   video may then end early (at the last change). If that breaks the
//   preview or export, repeat the last frame before finishing.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows::Win32::UI::WindowsAndMessaging::IsIconic;
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
    VideoSettingsSubType,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use crate::window_list_windows::hwnd_from_id;

// High bitrate: this file is an intermediate that gets compressed again at
// export (CLAUDE.md, Window capture). 40 Mbit/s ≈ 5 MB per second.
const BITRATE: u32 = 40_000_000;
// At most one frame per 1/60 s (frames still only come when something changes).
const MIN_FRAME_INTERVAL: Duration = Duration::from_micros(16_667);

/// What the capture thread and our thread share. (Arc = shared ownership,
/// Mutex = safe access from both threads.)
struct Shared {
    path: PathBuf,
    // Created by the first frame, closed by finish().
    encoder: Mutex<Option<VideoEncoder>>,
    started_at: Mutex<Option<Instant>>,
    error: Mutex<Option<String>>,
}

impl Shared {
    fn fail(&self, message: String) {
        let mut error = self.error.lock().unwrap();
        // Keep the first error: later ones are usually caused by it.
        if error.is_none() {
            *error = Some(message);
        }
    }
}

/// One window recording into an .mp4 file.
pub struct Recording {
    window: Window,
    shared: Arc<Shared>,
    // The running capture, between start() and finish().
    control: Mutex<Option<CaptureControl<Handler, String>>>,
}

impl Recording {
    /// Finds the window with this id (from `list_windows`) and sets up a
    /// recording into the .mp4 file at `path` (its folder must exist).
    /// Doesn't start capturing yet: call `start()`.
    pub fn prepare(window_id: u32, path: &Path) -> Result<Recording, String> {
        let hwnd = hwnd_from_id(window_id);
        let window = Window::from_raw_hwnd(hwnd.0);
        if window.title().is_err() || window.width().is_err() {
            return Err("That window no longer exists. Click \"List windows\" again.".to_string());
        }
        // A minimized window delivers no frames, so the file would be empty.
        if unsafe { IsIconic(hwnd) }.as_bool() {
            return Err(
                "That window is minimized. Bring it back on screen and try again.".to_string(),
            );
        }
        Ok(Recording {
            window,
            shared: Arc::new(Shared {
                path: path.to_path_buf(),
                encoder: Mutex::new(None),
                started_at: Mutex::new(None),
                error: Mutex::new(None),
            }),
            control: Mutex::new(None),
        })
    }

    /// Starts capturing on a separate thread. Returns right away.
    pub fn start(&self) -> Result<(), String> {
        let settings = Settings::new(
            self.window,
            CursorCaptureSettings::WithoutCursor,
            // The yellow "being recorded" border. Turning it off works on
            // Windows 11; TEST: on Windows 10 this may fail or be ignored.
            DrawBorderSettings::WithoutBorder,
            // Popups of the plugin (menus, dropdowns) are separate windows.
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Custom(MIN_FRAME_INTERVAL),
            DirtyRegionSettings::Default,
            // Same format as the windows-capture example that feeds frames
            // to the encoder. TEST: colors look right in the .mp4 (not
            // red/blue swapped).
            ColorFormat::Rgba8,
            Arc::clone(&self.shared),
        );
        let control = Handler::start_free_threaded(settings)
            .map_err(|e| format!("Could not start capture: {e}"))?;
        *self.control.lock().unwrap() = Some(control);
        Ok(())
    }

    /// Blocks until the first frame was encoded, which is time 0 of the
    /// file. Returns that moment.
    /// TEST: Windows sends a first frame right away even for a window that
    /// doesn't change (it should).
    pub fn wait_until_started(&self, timeout: Duration) -> Result<Instant, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(at) = *self.shared.started_at.lock().unwrap() {
                return Ok(at);
            }
            self.check_error()?;
            if Instant::now() >= deadline {
                return Err(
                    "The recording didn't start: no frames came from the window. \
                     Is it visible on screen?"
                        .to_string(),
                );
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Video only for now (see the top of this file).
    pub fn has_audio(&self) -> bool {
        false
    }

    /// The first error the capture reported, if any.
    pub fn check_error(&self) -> Result<(), String> {
        if let Some(e) = self.shared.error.lock().unwrap().as_ref() {
            return Err(e.clone());
        }
        // The capture thread ended by itself (e.g. the capture failed).
        let control = self.control.lock().unwrap();
        if control.as_ref().is_some_and(|c| c.is_finished()) {
            return Err("Recording stopped: the window was closed or hidden. Click \
                 \"List windows\" and try again."
                .to_string());
        }
        Ok(())
    }

    /// Stops the capture and closes the file. Returns its path.
    pub fn finish(self) -> Result<String, String> {
        // 1. Stop the capture thread (no more frames after this).
        let control = self.control.lock().unwrap().take();
        if let Some(control) = control {
            control
                .stop()
                .map_err(|e| format!("Could not stop the capture: {e}"))?;
        }

        // 2. Close the encoder: it writes the rest of the .mp4.
        // TEST: closing it here, on another thread than the one that made
        // it, works (Media Foundation objects are usually fine with that).
        let encoder = self.shared.encoder.lock().unwrap().take();
        let Some(encoder) = encoder else {
            return Err(
                "No video was written (no frames were captured from the window).".to_string(),
            );
        };
        encoder
            .finish()
            .map_err(|e| format!("Could not finish the video file: {e}"))?;

        if let Some(e) = self.shared.error.lock().unwrap().clone() {
            return Err(e);
        }
        Ok(self.shared.path.to_string_lossy().into_owned())
    }
}

/// Gets the frames on the capture thread.
struct Handler {
    shared: Arc<Shared>,
}

impl GraphicsCaptureApiHandler for Handler {
    type Flags = Arc<Shared>;
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Handler { shared: ctx.flags })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let mut slot = self.shared.encoder.lock().unwrap();

        // The first frame makes the encoder, at the frame's size. H.264 wants
        // even sizes; the encoder pads frames that don't match exactly.
        if slot.is_none() {
            if self.shared.started_at.lock().unwrap().is_some() {
                return Ok(()); // finish() already took the encoder
            }
            let width = frame.width() & !1;
            let height = frame.height() & !1;
            let encoder = VideoEncoder::new(
                VideoSettingsBuilder::new(width, height)
                    .sub_type(VideoSettingsSubType::H264)
                    .bitrate(BITRATE)
                    .frame_rate(60),
                AudioSettingsBuilder::default().disabled(true),
                ContainerSettingsBuilder::default(), // MPEG-4 (.mp4)
                &self.shared.path,
            );
            match encoder {
                Ok(encoder) => *slot = Some(encoder),
                Err(e) => {
                    self.shared
                        .fail(format!("Could not create the video file: {e}"));
                    return Ok(());
                }
            }
        }

        if let Some(encoder) = slot.as_mut() {
            if let Err(e) = encoder.send_frame(frame) {
                self.shared.fail(format!("Writing the video failed: {e}"));
                return Ok(());
            }
            // The first encoded frame is the file's time 0 (the encoder
            // counts timestamps from it).
            let mut started = self.shared.started_at.lock().unwrap();
            if started.is_none() {
                *started = Some(Instant::now());
            }
        }
        Ok(())
    }

    // The window was closed while recording.
    fn on_closed(&mut self) -> Result<(), Self::Error> {
        self.shared.fail(
            "Recording stopped: the window was closed. Click \"List windows\" and try again."
                .to_string(),
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Step 1 of the Windows plan, without FL or MIDI: records 10 s of the
    // first window whose title contains RECORD_TEST_TITLE (e.g. "Serum" or
    // "Fruity"), and keeps the .mp4 in your temp folder. Ignored by default
    // because it really records your screen. In PowerShell:
    //   $env:RECORD_TEST_TITLE = "Serum"
    //   cargo test record_a_window -- --ignored --nocapture
    // TEST: the file plays in the Films & TV app, at the window's real size,
    // with the plugin's animation, no cursor, no yellow border.
    #[test]
    #[ignore]
    fn record_a_window_for_10_seconds() {
        let title = std::env::var("RECORD_TEST_TITLE").unwrap_or_default();
        let windows = crate::window_list::list_windows(Some(title.clone())).unwrap();
        for w in &windows {
            println!(
                "{:>10}  {}x{}  [{}] {}",
                w.id, w.width, w.height, w.app_name, w.title
            );
        }
        let window = windows
            .iter()
            .find(|w| w.on_screen)
            .unwrap_or_else(|| panic!("no on-screen window with \"{title}\" in its title"));

        let path = std::env::temp_dir().join("beat-visualiser-test.mp4");
        let recording = Recording::prepare(window.id, &path).unwrap();
        recording.start().unwrap();
        let started = recording
            .wait_until_started(Duration::from_secs(3))
            .unwrap();
        println!("first frame after {:?}", started.elapsed());
        std::thread::sleep(Duration::from_secs(10));
        recording.check_error().unwrap();
        let file = recording.finish().unwrap();
        let size = std::fs::metadata(&file).unwrap().len();
        println!("wrote {file} ({} KB)", size / 1024);
        assert!(size > 0);
    }
}
