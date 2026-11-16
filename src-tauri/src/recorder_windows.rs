// Windows version of Recording (included by recorder.rs, Windows only).
//
// STATUS: written blind on a Mac. It type-checks with
// `cargo clippy --target x86_64-pc-windows-msvc`, but has NEVER RUN.
// Every "TEST:" comment is something to check on a real Windows PC.
// The tests at the bottom: `cargo test` runs the automatic ones, and
// `cargo test -- --ignored` the one that really records (see
// docs/windows-testing.md).
//
// Video (Windows.Graphics.Capture, through the windows-capture crate):
// - start() runs the capture on its own thread (start_free_threaded).
//   Windows calls on_frame_arrived() for every new frame.
// - The first frame creates the encoder (at that frame's size) and marks
//   this file's time 0. Every frame goes to the encoder, which writes an
//   H.264 + AAC .mp4 through Media Foundation.
// - Windows only sends a frame when the window's picture changes, so the
//   video has a variable frame rate. The encoder stamps each frame with its
//   real time, so timing stays right.
//   TEST: record a window that doesn't change at the end of the take. The
//   video may then end early (at the last change). If that breaks the
//   preview or export, repeat the last frame before finishing.
//
// Audio (WASAPI "process loopback", through the wasapi crate; Windows 10
// version 2004 or newer):
// - A second thread captures only FL Studio's sound, like macOS records only
//   the window's app. It's what audio sync compares with the beat file.
// - FL's process, not necessarily the window's: a "bridged" plugin's window
//   belongs to ilbridge.exe, but its sound comes out of FL64.exe.
// - The encoder stamps audio by counting samples, so audio_clock.rs keeps
//   the count in step with the clock (silence for gaps where FL played
//   nothing). If FL's audio can't be opened, the track is all silence: the
//   take still works, with has_audio() false and the timing estimate.
//
// H.264 .mp4 instead of macOS' HEVC .mov: WebView2 (Chromium) plays H.264
// .mp4 reliably; HEVC and .mov are not guaranteed there.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindow};
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

use crate::audio_clock::{
    BYTES_PER_FRAME, CHANNELS, SAMPLE_RATE, SLACK_FRAMES, expected_frames, is_audible,
    silence_to_insert,
};
use crate::window_list_windows::{hwnd_from_id, is_fl_process};

// High bitrate: this file is an intermediate that gets compressed again at
// export (CLAUDE.md, Window capture). 40 Mbit/s ≈ 5 MB per second.
const BITRATE: u32 = 40_000_000;
// At most one frame per 1/60 s (frames still only come when something changes).
const MIN_FRAME_INTERVAL: Duration = Duration::from_micros(16_667);

/// What the capture threads and our thread share. (Arc = shared ownership,
/// Mutex = safe access from several threads, Atomic = a lock-free flag.)
struct Shared {
    path: PathBuf,
    // Created by the first frame, closed by finish(). Both the video and the
    // audio thread send into it.
    encoder: Mutex<Option<VideoEncoder>>,
    started_at: Mutex<Option<Instant>>,
    error: Mutex<Option<String>>,
    stop_audio: AtomicBool,
    heard_audio: AtomicBool,
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
    // Whose sound goes into the file (FL's, see the top of the file).
    audio_process: u32,
    shared: Arc<Shared>,
    // The running captures, between start() and finish().
    control: Mutex<Option<CaptureControl<Handler, String>>>,
    audio_thread: Mutex<Option<JoinHandle<()>>>,
}

impl Recording {
    /// Finds the window with this id (from `list_windows`) and sets up a
    /// recording into the .mp4 file at `path` (its folder must exist).
    /// Doesn't start capturing yet: call `start()`.
    pub fn prepare(window_id: u32, path: &Path) -> Result<Recording, String> {
        let hwnd = hwnd_from_id(window_id);
        if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return Err("That window no longer exists. Click \"List windows\" again.".to_string());
        }
        // A minimized window delivers no frames, so the file would be empty.
        if unsafe { IsIconic(hwnd) }.as_bool() {
            return Err(
                "That window is minimized. Bring it back on screen and try again.".to_string(),
            );
        }
        let window = Window::from_raw_hwnd(hwnd.0);
        let window_process = window.process_id().unwrap_or(0);
        Ok(Recording {
            window,
            audio_process: fl_process_id().unwrap_or(window_process),
            shared: Arc::new(Shared {
                path: path.to_path_buf(),
                encoder: Mutex::new(None),
                started_at: Mutex::new(None),
                error: Mutex::new(None),
                stop_audio: AtomicBool::new(false),
                heard_audio: AtomicBool::new(false),
            }),
            control: Mutex::new(None),
            audio_thread: Mutex::new(None),
        })
    }

    /// Starts capturing (video and audio, each on its own thread). Returns
    /// right away.
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

        let shared = Arc::clone(&self.shared);
        let process = self.audio_process;
        let audio = std::thread::spawn(move || capture_audio(&shared, process));
        *self.audio_thread.lock().unwrap() = Some(audio);
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

    /// True once FL played something audible during the take.
    pub fn has_audio(&self) -> bool {
        self.shared.heard_audio.load(Ordering::Relaxed)
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

    /// Stops both captures and closes the file. Returns its path.
    pub fn finish(self) -> Result<String, String> {
        // 1. Stop the audio thread and wait for it (it sends its last samples).
        self.shared.stop_audio.store(true, Ordering::Relaxed);
        let audio = self.audio_thread.lock().unwrap().take();
        if let Some(audio) = audio {
            let _ = audio.join();
        }

        // 2. Stop the video capture thread (no more frames after this).
        let control = self.control.lock().unwrap().take();
        if let Some(control) = control {
            control
                .stop()
                .map_err(|e| format!("Could not stop the capture: {e}"))?;
        }

        // 3. Close the encoder: it writes the rest of the .mp4.
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

/// Gets the frames on the video capture thread.
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
                // 48 kHz, stereo, 16-bit PCM in, AAC out: the format
                // capture_audio() delivers (audio_clock.rs)
                AudioSettingsBuilder::new()
                    .sample_rate(SAMPLE_RATE)
                    .channel_count(CHANNELS as u32)
                    .bit_per_sample(16),
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

// --- Audio ---

/// FL's sound, opened with WASAPI process loopback.
struct AppAudio {
    client: wasapi::AudioClient,
    capture: wasapi::AudioCaptureClient,
    event: wasapi::Handle,
}

/// Opens the sound of process `process_id` and everything it started
/// (bridged plugins), converted to our format (audio_clock.rs).
/// TEST: works with FL64.exe; the sound in the .mp4 is FL's only (play a
/// YouTube video at the same time: it must not be in the file).
fn open_app_audio(process_id: u32) -> Result<AppAudio, String> {
    use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat};

    let format = WaveFormat::new(
        16,
        16,
        SampleType::Int,
        SAMPLE_RATE as usize,
        CHANNELS,
        None,
    );
    let mut client = AudioClient::new_application_loopback_client(process_id, true)
        .map_err(|e| format!("Could not open the app's audio: {e}"))?;
    let mode = StreamMode::EventsShared {
        autoconvert: true, // Windows converts FL's output to our format
        buffer_duration_hns: 0,
    };
    client
        .initialize_client(&format, Direction::Capture, mode, None)
        .map_err(|e| format!("Could not set up audio capture: {e}"))?;
    let event = client
        .set_get_eventhandle()
        .map_err(|e| format!("Could not set up audio capture: {e}"))?;
    let capture = client
        .get_audiocaptureclient()
        .map_err(|e| format!("Could not set up audio capture: {e}"))?;
    client
        .start_stream()
        .map_err(|e| format!("Could not start audio capture: {e}"))?;
    Ok(AppAudio {
        client,
        capture,
        event,
    })
}

/// The audio thread: captures until stop_audio is set, feeding the encoder
/// so its audio time stays equal to the video time.
fn capture_audio(shared: &Shared, process_id: u32) {
    // WASAPI is COM: each thread that uses it initializes COM first.
    let _ = wasapi::initialize_mta();
    let audio = open_app_audio(process_id);
    if let Err(e) = &audio {
        // Not fatal: the track gets silence and sync falls back to the timing
        // estimate, like a silent take on macOS.
        log::warn!("No audio from process {process_id}: {e}");
    }

    let mut queue: VecDeque<u8> = VecDeque::new(); // captured, not sent yet
    let mut sent: u64 = 0; // frames sent to the encoder (sound + silence)

    while !shared.stop_audio.load(Ordering::Relaxed) {
        match &audio {
            Ok(audio) => {
                // Wakes when a packet is ready (~every 10 ms), or after 20 ms
                // when FL plays nothing (then no packets come at all).
                let _ = audio.event.wait_for_event(20);
                while let Ok(Some(frames)) = audio.capture.get_next_packet_size() {
                    if frames == 0 || audio.capture.read_from_device_to_deque(&mut queue).is_err() {
                        break;
                    }
                }
            }
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }

        // Nothing goes into the file before its time 0 (the first frame).
        let Some(started) = *shared.started_at.lock().unwrap() else {
            queue.clear();
            continue;
        };

        let incoming = (queue.len() / BYTES_PER_FRAME) as u64;
        let expected = expected_frames(started.elapsed());
        // The very first chunk lines up exactly (no slack): what came in
        // just now belongs at "now" in the video, so silence fills before it.
        let slack = if sent == 0 { 0 } else { SLACK_FRAMES };
        let silence = silence_to_insert(sent, incoming, expected, slack);
        if silence == 0 && incoming == 0 {
            continue;
        }

        let sound: Vec<u8> = queue.drain(..incoming as usize * BYTES_PER_FRAME).collect();
        if is_audible(&sound) {
            shared.heard_audio.store(true, Ordering::Relaxed);
        }
        let mut chunk = vec![0u8; silence as usize * BYTES_PER_FRAME];
        chunk.extend_from_slice(&sound);

        let mut slot = shared.encoder.lock().unwrap();
        if let Some(encoder) = slot.as_mut() {
            // The timestamp argument is ignored: the encoder counts samples.
            if let Err(e) = encoder.send_audio_buffer(&chunk, 0) {
                shared.fail(format!("Writing the audio failed: {e}"));
                break;
            }
            sent += silence + incoming;
        }
    }

    if let Ok(audio) = &audio {
        let _ = audio.client.stop_stream();
    }
}

/// The running FL Studio process (FL64.exe or FL.exe), if any.
fn fl_process_id() -> Option<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };

    // A snapshot of all running processes, walked one by one.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut found = None;
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while more {
        let name = &entry.szExeFile;
        let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
        if is_fl_process(&String::from_utf16_lossy(&name[..len])) {
            found = Some(entry.th32ProcessID);
            break;
        }
        more = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    let _ = unsafe { CloseHandle(snapshot) };
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    // Automatic (runs with plain `cargo test`, no setup).
    #[test]
    fn a_window_that_doesnt_exist_is_refused() {
        // Id 0 is the null window handle: never a real window.
        let error = Recording::prepare(0, Path::new("unused.mp4"))
            .err()
            .expect("prepare should fail");
        assert!(error.contains("no longer exists"), "got: {error}");
    }

    // Automatic: doesn't need FL, only checks the process walk doesn't fail.
    // Prints whether FL is running, for the log.
    #[test]
    fn finding_fl_does_not_crash() {
        println!("FL Studio process: {:?}", fl_process_id());
    }

    // Steps 1 and 3 of the Windows plan, without FL control: records 10 s of
    // the first window whose title contains RECORD_TEST_TITLE (e.g. "Serum"),
    // with FL's sound, and keeps the .mp4 in your temp folder. Ignored by
    // default because it really records your screen. In PowerShell:
    //   $env:RECORD_TEST_TITLE = "Serum"
    //   cargo test record_a_window -- --ignored --nocapture
    // Play something in FL while it runs.
    // TEST: the file plays in the Films & TV app, at the window's real size,
    // with the plugin's animation, FL's sound in sync, no cursor, no border.
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
        println!("audio from process {}", recording.audio_process);
        recording.start().unwrap();
        let started = recording
            .wait_until_started(Duration::from_secs(3))
            .unwrap();
        println!("first frame after {:?}", started.elapsed());
        std::thread::sleep(Duration::from_secs(10));
        recording.check_error().unwrap();
        let heard = recording.has_audio();
        let file = recording.finish().unwrap();
        let size = std::fs::metadata(&file).unwrap().len();
        println!("wrote {file} ({} KB), heard audio: {heard}", size / 1024);
        assert!(size > 0);
    }
}
