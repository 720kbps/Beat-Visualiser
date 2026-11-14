// Checks, before anything is rendered, that this webview can encode the MP4.
//
// Encoding uses WebCodecs, the browser's built-in access to the system's
// video/audio encoders (VideoToolbox on macOS, Media Foundation on Windows).
// No ffmpeg, nothing for the user to install. But support differs per
// webview version, so every piece is checked at runtime and a missing one
// becomes a readable error instead of a broken file:
// - macOS WKWebView: VideoEncoder (H.264) since Safari 16.4; AudioEncoder
//   (AAC) only since Safari 26. macOS 15 gets Safari 26 as an update.
// - Windows WebView2 (Chromium): both.
import { canEncodeAudio, canEncodeVideo, Quality } from 'mediabunny'
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from '../render/renderer'

// H.264 bitrate. TikTok/Instagram re-encode every upload, so the file should
// be clearly better than what they'll make of it, but not huge.
// 60 fps gets a bit more because there are twice the frames.
export function videoBitrate(fps: number): number {
  return fps > 30 ? 16_000_000 : 12_000_000
}

// AAC bitrate (spec: 192 to 320 kbps).
export const AUDIO_BITRATE = 256_000

// Constant bitrate: with 'variable', WebKit's AAC encoder went far below the
// target (≈ 50 kbps for a simple test beat).
export function audioQuality(): Quality {
  return new Quality({ bitrate: AUDIO_BITRATE, bitrateMode: 'constant' })
}

// Sample rates AAC in MP4 is used with everywhere. Others get resampled to 48 kHz.
export const AAC_SAMPLE_RATES = [44100, 48000]

const UPDATE_HINT =
  'On macOS, update Safari (or macOS) to version 26 or newer; the app uses the same engine.'

// Throws an Error with a user-readable message if something is missing.
export async function checkExportSupport(
  fps: number,
  sampleRate: number,
  channels: number,
): Promise<void> {
  // WebCodecs only exists in "secure contexts" (https, localhost, the app's
  // own tauri:// page). Plain http pages from other hosts don't get it.
  if (!window.isSecureContext) {
    throw new Error('Video export needs a secure page (WebCodecs is disabled).')
  }
  if (typeof VideoEncoder === 'undefined') {
    throw new Error(
      `This system has no WebCodecs video encoder. ${UPDATE_HINT}`,
    )
  }
  if (typeof AudioEncoder === 'undefined') {
    throw new Error(
      `This system can't encode audio in the app (no WebCodecs AudioEncoder), so the video would have no sound. ${UPDATE_HINT}`,
    )
  }

  // Mediabunny builds the exact codec string and asks
  // VideoEncoder.isConfigSupported() / AudioEncoder.isConfigSupported().
  const videoOk = await canEncodeVideo('avc', {
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    quality: new Quality({ bitrate: videoBitrate(fps) }),
    frameRate: fps,
  })
  if (!videoOk) {
    throw new Error(
      `This system can't encode H.264 video at ${OUTPUT_WIDTH}×${OUTPUT_HEIGHT}, ${fps} fps.`,
    )
  }

  const audioOk = await canEncodeAudio('aac', {
    numberOfChannels: Math.min(channels, 2),
    sampleRate: AAC_SAMPLE_RATES.includes(sampleRate) ? sampleRate : 48000,
    quality: audioQuality(),
  })
  if (!audioOk) {
    throw new Error(`This system can't encode AAC audio. ${UPDATE_HINT}`)
  }
}
