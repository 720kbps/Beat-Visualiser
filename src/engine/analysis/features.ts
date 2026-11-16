// The "how much is going on" score of a whole beat, one value per 50 ms
// (CLAUDE.md, Highlight detection):
//
//   score(t) = 0.5 * rms(t) + 0.3 * bass(t) + 0.2 * onsets(t)
//
// - rms: loudness. Drops and hooks are louder.
// - bass: energy below 150 Hz (kick, 808). Tells a real drop from a loud but
//   empty breakdown.
// - onsets: spectral flux, how much the spectrum changes from one moment to
//   the next. High in busy sections (drums, chops), low in pads and intros.
// Each is normalized to 0..1 first, so the weights mean what they say.
//
// Runs once per dropped beat. A 3 minute beat is 3600 hops with one
// 1024-point FFT each: well under a second. Only uses getChannelData,
// sampleRate, length and numberOfChannels, so it runs in Node tests.
import { createLowPass } from '../audio/low-pass'
import { magnitudeSpectrum } from './fft'

export const SCORE_HOP_SECONDS = 0.05

// Tune these (and only these) when the picks feel wrong.
export const SCORE_WEIGHTS = { rms: 0.5, bass: 0.3, onsets: 0.2 }

const BASS_CUTOFF_HZ = 150
const FFT_SIZE = 1024 // ~21 ms at 48 kHz: short enough to see single hits

export type HighlightScore = {
  hopSeconds: number
  score: Float32Array // 0..1, one value per hop
}

export function computeHighlightScore(buffer: AudioBuffer): HighlightScore {
  const sampleRate = buffer.sampleRate
  const hop = Math.max(1, Math.round(sampleRate * SCORE_HOP_SECONDS))
  const hopCount = Math.max(1, Math.ceil(buffer.length / hop))

  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c))
  }
  function monoAt(i: number): number {
    if (i < 0 || i >= buffer.length) return 0
    let sum = 0
    for (const channel of channels) sum += channel[i]
    return channels.length > 0 ? sum / channels.length : 0
  }

  const rms = new Float32Array(hopCount)
  const bass = new Float32Array(hopCount)
  const onsets = new Float32Array(hopCount)

  // RMS of the signal and of its low-passed copy, per hop
  const lowPass = createLowPass(BASS_CUTOFF_HZ, sampleRate)
  for (let h = 0; h < hopCount; h++) {
    const first = h * hop
    const last = Math.min(first + hop, buffer.length)
    let sumSquares = 0
    let sumBass = 0
    for (let i = first; i < last; i++) {
      const x = monoAt(i)
      const low = lowPass(x)
      sumSquares += x * x
      sumBass += low * low
    }
    const count = Math.max(1, last - first)
    rms[h] = Math.sqrt(sumSquares / count)
    bass[h] = Math.sqrt(sumBass / count)
  }

  // Spectral flux: for each hop, a Hann-windowed FFT of the samples starting
  // there; the flux is the sum of how much each frequency got LOUDER than in
  // the previous hop (getting quieter isn't an onset). log1p compresses the
  // magnitudes, so a quiet hi-hat still counts next to a loud 808.
  const window = new Float32Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))
  }
  const frame = new Float32Array(FFT_SIZE)
  const spectrum = new Float32Array(FFT_SIZE / 2 + 1)
  const previous = new Float32Array(FFT_SIZE / 2 + 1)
  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  for (let h = 0; h < hopCount; h++) {
    const first = h * hop
    for (let i = 0; i < FFT_SIZE; i++) frame[i] = monoAt(first + i) * window[i]
    magnitudeSpectrum(frame, spectrum, re, im)
    let flux = 0
    for (let k = 0; k < spectrum.length; k++) {
      const value = Math.log1p(spectrum[k])
      if (h > 0) flux += Math.max(0, value - previous[k])
      previous[k] = value
    }
    onsets[h] = flux
  }

  normalize(rms)
  normalize(bass)
  normalize(onsets)

  const score = new Float32Array(hopCount)
  for (let h = 0; h < hopCount; h++) {
    score[h] =
      SCORE_WEIGHTS.rms * rms[h] +
      SCORE_WEIGHTS.bass * bass[h] +
      SCORE_WEIGHTS.onsets * onsets[h]
  }
  return { hopSeconds: hop / sampleRate, score }
}

// In place, to 0..1: divided by the 95th percentile (not the maximum, so one
// clipped hit doesn't squash everything else), then capped at 1. A silent
// beat stays all zeros.
function normalize(values: Float32Array): void {
  const sorted = Float32Array.from(values).sort()
  const reference = sorted[Math.floor((sorted.length - 1) * 0.95)]
  if (!(reference > 1e-9)) {
    values.fill(0)
    return
  }
  for (let i = 0; i < values.length; i++) {
    values[i] = Math.min(values[i] / reference, 1)
  }
}
