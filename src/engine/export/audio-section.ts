// Cuts the exported section out of the beat's samples and fades its edges.
// Pure functions on Float32Arrays (one per channel), so they're tested in Node.
//
// The exported audio always comes from the beat file, never from the
// recording (CLAUDE.md, Output spec). It's the decoded AudioBuffer, at the
// AudioContext's rate (usually 48 kHz, sometimes 44.1 kHz); both are fine for AAC.

// Short fades on the cut, so the clip doesn't start or end with a click
// (cutting a waveform mid-swing is an instant jump = a click).
export const FADE_SECONDS = 0.05

// AAC in MP4 is stereo at most here: a beat with more channels keeps the
// first two (front left/right in every standard layout).
export const MAX_CHANNELS = 2

// Copies `lengthSeconds` of audio starting at `startSeconds`. The result
// always has exactly round(lengthSeconds * sampleRate) samples per channel,
// so audio and video end together; anything past the end of the beat is
// silence (zeros). Returns new arrays, the input is not changed.
export function sliceSection(
  channels: Float32Array[],
  sampleRate: number,
  startSeconds: number,
  lengthSeconds: number,
): Float32Array[] {
  const first = Math.max(0, Math.round(startSeconds * sampleRate))
  const count = Math.max(0, Math.round(lengthSeconds * sampleRate))
  const kept = channels.slice(0, MAX_CHANNELS)

  return kept.map((source) => {
    const out = new Float32Array(count) // starts as zeros
    const end = Math.min(first + count, source.length)
    if (end > first) out.set(source.subarray(first, end))
    return out
  })
}

// In place: linear fade-in over the first `fadeSeconds`, fade-out over the
// last. A clip shorter than two fades gets two half-length fades.
export function applyFades(
  channels: Float32Array[],
  sampleRate: number,
  fadeSeconds = FADE_SECONDS,
): void {
  for (const data of channels) {
    const fade = Math.min(
      Math.round(fadeSeconds * sampleRate),
      Math.floor(data.length / 2),
    )
    for (let i = 0; i < fade; i++) {
      const gain = i / fade // 0 at the very edge, almost 1 at the fade's end
      data[i] *= gain
      data[data.length - 1 - i] *= gain
    }
  }
}
