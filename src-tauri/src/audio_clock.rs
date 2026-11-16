// Keeps a Windows recording's audio track in step with its video
// (recorder_windows.rs uses this). Plain math with no Windows calls, so it's
// compiled and tested on every system.
//
// Why it's needed: the encoder stamps audio by counting samples, not by the
// clock. Windows' app-audio capture only delivers sound while the app
// actually plays something, so a quiet stretch would simply be missing and
// everything after it would slide earlier. To keep audio time = video time,
// we compare how many samples we sent with how many should exist by now
// (clock time since the video's first frame) and fill the difference with
// silence.

// Only the Windows recorder calls these outside the tests.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use std::time::Duration;

/// The format the audio is captured in and handed to the encoder: 48 kHz,
/// stereo, 16-bit signed integers, interleaved (left, right, left, ...).
pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;
pub const BYTES_PER_FRAME: usize = CHANNELS * 2; // one 16-bit sample per channel

/// How far audio may fall behind the clock before silence is inserted.
/// Capture arrives in ~10 ms packets, so a smaller gap is normal jitter.
pub const SLACK_FRAMES: u64 = SAMPLE_RATE as u64 / 20; // 50 ms

/// Audio frames (one sample per channel) that should exist `elapsed` after
/// the video's first frame.
pub fn expected_frames(elapsed: Duration) -> u64 {
    (elapsed.as_secs_f64() * f64::from(SAMPLE_RATE)) as u64
}

/// Frames of silence to send before `incoming` new frames, so that after
/// them the track has `expected` frames. Nothing while the track is within
/// `slack` of the clock (small jitter isn't a gap).
pub fn silence_to_insert(sent: u64, incoming: u64, expected: u64, slack: u64) -> u64 {
    let after = sent + incoming;
    if after + slack < expected {
        expected - after
    } else {
        0
    }
}

/// True if this 16-bit PCM contains real sound, not silence or dither. The
/// threshold is about -60 dBFS (32 of 32768).
pub fn is_audible(pcm: &[u8]) -> bool {
    // Pairs of bytes = one little-endian 16-bit sample each
    let (samples, _) = pcm.as_chunks::<2>();
    samples
        .iter()
        .any(|bytes| i16::from_le_bytes(*bytes).unsigned_abs() > 32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expected_frames_follow_the_clock() {
        assert_eq!(expected_frames(Duration::ZERO), 0);
        assert_eq!(expected_frames(Duration::from_secs(2)), 96_000);
        assert_eq!(expected_frames(Duration::from_millis(10)), 480);
    }

    #[test]
    fn silence_fills_gaps_but_not_jitter() {
        // In step: nothing to fill
        assert_eq!(silence_to_insert(48_000, 480, 48_480, SLACK_FRAMES), 0);
        // 20 ms behind: jitter, nothing
        assert_eq!(silence_to_insert(48_000, 0, 48_960, SLACK_FRAMES), 0);
        // 1 s of nothing played: fill it all
        assert_eq!(silence_to_insert(48_000, 0, 96_000, SLACK_FRAMES), 48_000);
        // The first packet arrives 100 ms after the video started: with no
        // slack, the start is padded so audio lines up from frame 0
        assert_eq!(silence_to_insert(0, 480, 4_800, 0), 4_320);
        // Ahead of the clock: never negative
        assert_eq!(silence_to_insert(96_000, 480, 48_000, SLACK_FRAMES), 0);
    }

    #[test]
    fn audible_means_above_the_noise_floor() {
        let silence = vec![0u8; 400];
        assert!(!is_audible(&silence));
        let dither: Vec<u8> = [3i16, -2, 5, -4]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        assert!(!is_audible(&dither));
        let sound: Vec<u8> = [0i16, 1200, -800, 0]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        assert!(is_audible(&sound));
    }
}
