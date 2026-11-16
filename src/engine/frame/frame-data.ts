// Turns a decoded beat into the per-frame values the themes draw with (FrameData).
//
// Everything is computed ONCE from the samples, up front. After that getFrame(t)
// is just a lookup, and its result depends only on t: not on the audio clock, not
// on the display or export frame rate. Preview and export ask for the same t and
// get the same values, so a 30 fps and a 60 fps export agree at every shared time.
//
// Only uses the AudioBuffer fields getChannelData, sampleRate, length and
// numberOfChannels, so this runs in Node (tests) with a stub buffer.
import { createLowPass } from '../audio/low-pass'
import { peaksFromBuffer } from '../audio/peaks'
import type { FrameData } from '../visualizers/types'

// Waveform resolution handed to the themes. 1024 columns is about one column per
// pixel of the 1080 px wide video.
export const PEAK_COLUMNS = 1024

// Analysis hop: one rms/bass value per 10 ms (441 samples at 44.1 kHz, 480 at 48 kHz).
// - Fixed in seconds, not in samples, so a beat decoded at 44.1 or 48 kHz gives
//   the same values at the same time.
// - Finer than a 60 fps frame (16.7 ms), so the values never step visibly; getFrame
//   interpolates between hops anyway.
// - A 10 ms window is short for bass (a 50 Hz period is 20 ms), which makes the
//   raw values ripple a bit. The release smoothing below irons that out.
const HOP_SECONDS = 0.01

const BASS_CUTOFF_HZ = 150 // kick and 808 live below this

// Smoothing ("envelope follower"): values jump UP instantly (so a kick hits on
// time) but fall back DOWN slowly, with this time constant. Without it the
// visuals flicker on every hop.
const RELEASE_SECONDS = 0.15

// The low-pass filter needs a few ms of input before its output is right. Start
// it this much before the clip (when there is audio there) so the first hops are
// correct instead of starting from a cold filter.
const FILTER_WARMUP_SECONDS = 0.05

// Below this the clip counts as silent (about -80 dBFS) and the feature stays 0,
// instead of normalizing noise up to 1.
const SILENCE_LEVEL = 1e-4

export type FrameSource = {
  duration: number // seconds, length of the clip
  getFrame(time: number): FrameData // time = seconds into the clip, clamped to 0..duration
}

// clipStart/clipEnd are seconds in the buffer (default: the whole buffer). They are
// clamped to the buffer. Throws if either is not a finite number.
//
// Cost: one pass over the clip's samples (mix to mono, biquad, two squares per
// sample) plus the peaks pass. A 60 s stereo clip at 48 kHz is 2.88 M sample
// frames and took about 50 ms in total (measured in Node on this Mac). That's
// once per clip, not per frame; getFrame itself is a few array reads. Memory: two Float32Arrays
// of 6000 values (60 s / 10 ms) plus the 2048-value peaks array.
export function createFrameSource(
  buffer: AudioBuffer,
  clipStart = 0,
  clipEnd?: number,
): FrameSource {
  const sampleRate = buffer.sampleRate
  const totalSamples = buffer.length
  const totalSeconds = totalSamples / sampleRate

  const requestedEnd = clipEnd ?? totalSeconds
  if (!Number.isFinite(clipStart) || !Number.isFinite(requestedEnd)) {
    throw new Error(`Clip range must be numbers, got ${clipStart}..${clipEnd}`)
  }

  // Clip range in whole samples: [first, last)
  const startSeconds = clamp(clipStart, 0, totalSeconds)
  const endSeconds = clamp(requestedEnd, startSeconds, totalSeconds)
  const first = Math.min(Math.round(startSeconds * sampleRate), totalSamples)
  const last = Math.min(Math.round(endSeconds * sampleRate), totalSamples)
  const duration = (last - first) / sampleRate

  // Waveform of the clip only, computed once and handed out with every frame
  const peaks = peaksFromBuffer(buffer, PEAK_COLUMNS, first, last)

  const hop = Math.max(1, Math.round(sampleRate * HOP_SECONDS)) // samples per hop
  const hopSeconds = hop / sampleRate
  const hopCount = Math.max(1, Math.ceil((last - first) / hop))
  const rms = new Float32Array(hopCount)
  const bass = new Float32Array(hopCount)

  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c))
  }

  // Mono mix = average of the channels. (A sound that is exactly out of phase
  // between left and right would cancel out; that's rare in a finished beat.)
  function monoAt(i: number): number {
    let sum = 0
    for (let c = 0; c < channels.length; c++) {
      sum += channels[c][i]
    }
    return channels.length > 0 ? sum / channels.length : 0
  }

  const lowPass = createLowPass(BASS_CUTOFF_HZ, sampleRate)

  // Warm up the filter on the audio just before the clip (output is thrown away)
  const warmupStart = Math.max(
    0,
    first - Math.round(FILTER_WARMUP_SECONDS * sampleRate),
  )
  for (let i = warmupStart; i < first; i++) {
    lowPass(monoAt(i))
  }

  // The one pass: per hop, the RMS of the mono signal and of the low-passed signal.
  // RMS = sqrt(mean of the squared samples), the usual "loudness" of a chunk of audio.
  let hopIndex = 0
  let sumSquares = 0
  let sumBassSquares = 0
  let count = 0
  for (let i = first; i < last; i++) {
    const x = monoAt(i)
    const low = lowPass(x)
    sumSquares += x * x
    sumBassSquares += low * low
    count++

    // End of a hop, or the last (possibly shorter) hop of the clip
    if (count === hop || i === last - 1) {
      rms[hopIndex] = Math.sqrt(sumSquares / count)
      bass[hopIndex] = Math.sqrt(sumBassSquares / count)
      hopIndex++
      sumSquares = 0
      sumBassSquares = 0
      count = 0
    }
  }

  smoothRelease(rms, hopSeconds)
  smoothRelease(bass, hopSeconds)
  normalizeToMax(rms)
  normalizeToMax(bass)

  // Linear interpolation between hops. Hop i holds the value for the middle of
  // its 10 ms, at time (i + 0.5) * hopSeconds.
  function sample(values: Float32Array, time: number): number {
    const position = clamp(time / hopSeconds - 0.5, 0, values.length - 1)
    const i0 = Math.floor(position)
    const i1 = Math.min(i0 + 1, values.length - 1)
    const frac = position - i0
    return values[i0] + (values[i1] - values[i0]) * frac
  }

  function getFrame(time: number): FrameData {
    const t = clamp(time, 0, duration)
    return {
      time: t,
      progress: duration > 0 ? t / duration : 0,
      peaks, // the same array every frame: don't modify it
      rms: sample(rms, t),
      bass: sample(bass, t),
      beat: false, // Phase 4: beat detection
      plugins: [], // filled in by the caller (preview or export)
    }
  }

  return { duration, getFrame }
}

// In place: instant attack, exponential release (see RELEASE_SECONDS).
function smoothRelease(values: Float32Array, hopSeconds: number): void {
  const keep = Math.exp(-hopSeconds / RELEASE_SECONDS) // share of the old value kept per hop
  let envelope = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    envelope = v >= envelope ? v : v + (envelope - v) * keep
    values[i] = envelope
  }
}

// In place: divide by the clip's maximum, so 1 = the loudest moment of the clip.
// The max (not a percentile) is fine here: RMS over 10 ms already averages away
// single-sample clicks, so one stray spike can't squash the rest of the clip.
// A silent clip stays all zeros.
// Note: bass is normalized by its OWN max, so bass = 1 means "the strongest bass
// moment of this clip", even in a clip with very little bass overall.
function normalizeToMax(values: Float32Array): void {
  let max = 0
  for (let i = 0; i < values.length; i++) {
    if (values[i] > max) max = values[i]
  }
  if (max < SILENCE_LEVEL) {
    values.fill(0)
    return
  }
  for (let i = 0; i < values.length; i++) {
    values[i] /= max
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}
