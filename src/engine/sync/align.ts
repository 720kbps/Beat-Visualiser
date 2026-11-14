// Fine sync: finds exactly when FL started playing in a take, from its sound.
//
// A take's `play_offset` is when the app *sent* "play" to FL. FL starts a
// little later (MIDI, script, audio buffer), so the video and the beat can be
// tens of milliseconds apart. The take also records the system audio, which
// is FL playing the beat. So we slide the beat file along the recorded audio
// and look for the shift where the two match best: that shift is the offset.
//
// Definitions (same as PluginClip.offset): video time = beat time + offset.
// The sound at video time v should be the beat at beat time v - offset.
//
// Method, in four steps:
//   1. Resample both signals to one low rate (SYNC_RATE), so they share a
//      sample grid and the search is cheap. A box filter (the average of the
//      input samples around each output time) is the low-pass in front.
//   2. Pre-emphasis: replace each sample by its difference to the previous
//      one. That boosts high frequencies and cuts the bass. Bass is a problem
//      for matching: a 50 Hz 808 also "matches" when shifted by one period
//      (20 ms), so it gives several almost equal peaks. Cutting it makes the
//      real peak stand out.
//   3. Normalized cross-correlation (NCC) for every whole-sample shift in the
//      search range: the dot product of the two signals, divided by both
//      energies. 1 = identical shape (any volume), 0 = unrelated.
//   4. Parabolic interpolation around the best shift, for a precision finer
//      than one sample (1 / SYNC_RATE = 0.25 ms here).
//
// Cost: (number of shifts) × (samples analyzed) multiply-adds. Defaults:
// 4001 shifts (±0.5 s at 4 kHz) × 32 000 samples (8 s) ≈ 128 million, about
// 0.1 s in JS. Plain loops are enough; an FFT would only pay off for much
// longer searches.

export type AlignResult = {
  offset: number // video seconds at beat time 0 (the refined clip offset)
  correction: number // offset - coarseOffset, seconds
  confidence: number // 0..1, NCC value at the best shift
  ok: boolean // false: no trustworthy match, offset = coarseOffset
}

export type AlignOptions = {
  searchSeconds?: number // look for the offset within ±this around the coarse one
  analyzeSeconds?: number // how much of the recording to compare
}

// The common rate both signals are resampled to. Keeps the sound below 2 kHz
// (kick, 808, snare, most of the melody), which is plenty to line them up.
export const SYNC_RATE = 4000

const DEFAULT_SEARCH_SECONDS = 0.5
const DEFAULT_ANALYZE_SECONDS = 8

// Less overlap than this and the match means little.
const MIN_ANALYZE_SECONDS = 1

// Below this RMS (-80 dBFS) a signal counts as silent.
const SILENCE_RMS = 1e-4

// A match must reach this NCC. The real beat in a clean recording scores
// ~0.9; a different beat with the same tempo and kick scores ~0.2.
const MIN_CONFIDENCE = 0.4

// The best peak must beat every other peak (outside PEAK_WIDTH_SECONDS of it)
// by this factor. Otherwise two shifts fit about equally well (e.g. a beat
// that repeats exactly), and we can't tell which one is right.
const MIN_PEAK_RATIO = 1.15
const PEAK_WIDTH_SECONDS = 0.005

// `beat`: mono beat samples, index 0 = beat time 0 (the section start).
// `recorded`: mono recorded samples, index 0 = video time 0.
// `coarseOffset`: the timing estimate (the take's play_offset).
export function alignOffset(
  beat: Float32Array,
  beatRate: number,
  recorded: Float32Array,
  recordedRate: number,
  coarseOffset: number,
  opts: AlignOptions = {},
): AlignResult {
  const searchSeconds = opts.searchSeconds ?? DEFAULT_SEARCH_SECONDS
  const analyzeSeconds = opts.analyzeSeconds ?? DEFAULT_ANALYZE_SECONDS
  const failed: AlignResult = {
    offset: coarseOffset,
    correction: 0,
    confidence: 0,
    ok: false,
  }

  // Shifts to try, in SYNC_RATE samples. Shift `lag` means offset = lag / SYNC_RATE.
  const minLag = Math.round((coarseOffset - searchSeconds) * SYNC_RATE)
  const maxLag = Math.round((coarseOffset + searchSeconds) * SYNC_RATE)

  // The part of the recording we compare, in SYNC_RATE samples of video time.
  // It starts where the beat starts at the earliest possible offset, so it
  // includes the jump from silence to sound, which is easy to match.
  const recordedSamples = Math.floor(
    (recorded.length / recordedRate) * SYNC_RATE,
  )
  const windowStart = Math.max(0, minLag)
  const windowLength = Math.min(
    Math.round(analyzeSeconds * SYNC_RATE),
    recordedSamples - windowStart,
  )
  if (windowLength < MIN_ANALYZE_SECONDS * SYNC_RATE) return failed

  // The beat samples any shift can reach: beat time (windowStart - maxLag)
  // to (windowStart + windowLength - minLag). Before beat time 0 is silence.
  const beatLength = Math.min(
    Math.floor((beat.length / beatRate) * SYNC_RATE),
    windowStart + windowLength - minLag,
  )
  if (beatLength <= 0) return failed

  const rec = preEmphasis(
    boxResample(recorded, recordedRate, windowStart, windowLength),
  )
  const ref = preEmphasis(boxResample(beat, beatRate, 0, beatLength))
  if (isSilent(rec) || isSilent(ref)) return failed

  const scores = correlate(rec, windowStart, ref, minLag, maxLag)
  const best = indexOfMax(scores)
  const confidence = Math.max(0, scores[best])
  const second = secondPeak(scores, best, PEAK_WIDTH_SECONDS * SYNC_RATE)

  const distinct = second <= 0 || scores[best] >= MIN_PEAK_RATIO * second
  if (confidence < MIN_CONFIDENCE || !distinct) {
    return { ...failed, confidence }
  }

  const offset = (minLag + best + parabolicPeak(scores, best)) / SYNC_RATE
  return { offset, correction: offset - coarseOffset, confidence, ok: true }
}

// Mixes channels to mono (their average), for `count` samples from `start`.
// Past the end of the data the result is silence.
export function mixToMono(
  channels: Float32Array[],
  start = 0,
  count = channels[0]?.length ?? 0,
): Float32Array {
  const out = new Float32Array(Math.max(0, count))
  if (channels.length === 0) return out
  for (const data of channels) {
    const end = Math.min(start + out.length, data.length)
    for (let i = Math.max(start, 0); i < end; i++) out[i - start] += data[i]
  }
  for (let i = 0; i < out.length; i++) out[i] /= channels.length
  return out
}

// Resamples `samples` (at `rate`) to SYNC_RATE: output k is the average of
// the input samples within half an output sample of time (first + k) /
// SYNC_RATE. Averaging is a simple low-pass, so high frequencies don't fold
// down (alias) into the low-rate signal. Input outside the array is silence.
export function boxResample(
  samples: Float32Array,
  rate: number,
  first: number,
  count: number,
): Float32Array {
  const out = new Float32Array(count)
  const step = rate / SYNC_RATE // input samples per output sample
  for (let k = 0; k < count; k++) {
    const center = (first + k) * step
    // Input samples from center - step/2 to center + step/2, both ends
    // included, so the average is centered on the output time.
    const from = Math.ceil(center - step / 2)
    const to = Math.floor(center + step / 2) + 1 // exclusive
    let sum = 0
    for (let i = Math.max(from, 0); i < Math.min(to, samples.length); i++) {
      sum += samples[i]
    }
    out[k] = sum / (to - from)
  }
  return out
}

// y[i] = x[i] - x[i-1]. Applied to both signals the same way, so it doesn't
// shift one against the other. y[0] is 0: the signal may start mid-sound, and
// "x[0] minus nothing" would be one huge spike.
export function preEmphasis(x: Float32Array): Float32Array {
  const y = new Float32Array(x.length)
  let previous = x[0] ?? 0
  for (let i = 0; i < x.length; i++) {
    y[i] = x[i] - previous
    previous = x[i]
  }
  return y
}

function isSilent(x: Float32Array): boolean {
  let energy = 0
  for (let i = 0; i < x.length; i++) energy += x[i] * x[i]
  return Math.sqrt(energy / Math.max(1, x.length)) < SILENCE_RMS
}

// NCC for every shift from minLag to maxLag. `rec[i]` is at video sample
// windowStart + i; `ref[j]` at beat sample j. For shift `lag`, video sample n
// is compared with beat sample n - lag:
//
//   score(lag) = Σ rec[n]·ref[n-lag] / sqrt(Σ rec[n]² · Σ ref[n-lag]²)
//
// Both sums run over the window; beat samples outside 0..ref.length are
// silence, so they add nothing and are skipped. The beat's energy changes
// with the shift, so it comes from a running sum (refEnergy).
function correlate(
  rec: Float32Array,
  windowStart: number,
  ref: Float32Array,
  minLag: number,
  maxLag: number,
): Float32Array {
  let recEnergy = 0
  for (let i = 0; i < rec.length; i++) recEnergy += rec[i] * rec[i]

  // refEnergy[j] = sum of ref[0..j-1]², so the energy of ref[a..b-1] is
  // refEnergy[b] - refEnergy[a]. Float64 so the subtraction stays precise.
  const refEnergy = new Float64Array(ref.length + 1)
  for (let j = 0; j < ref.length; j++) {
    refEnergy[j + 1] = refEnergy[j] + ref[j] * ref[j]
  }

  const scores = new Float32Array(maxLag - minLag + 1)
  for (let lag = minLag; lag <= maxLag; lag++) {
    // Window indices i whose beat sample j = windowStart + i - lag exists.
    const shift = windowStart - lag
    const from = Math.max(0, -shift)
    const to = Math.min(rec.length, ref.length - shift)
    if (to <= from) continue // no overlap: score stays 0

    let dot = 0
    for (let i = from; i < to; i++) dot += rec[i] * ref[i + shift]
    const energy = refEnergy[to + shift] - refEnergy[from + shift]
    if (energy > 0) scores[lag - minLag] = dot / Math.sqrt(recEnergy * energy)
  }
  return scores
}

function indexOfMax(x: Float32Array): number {
  let best = 0
  for (let i = 1; i < x.length; i++) if (x[i] > x[best]) best = i
  return best
}

// The highest local maximum that is more than `width` samples away from the
// best one (closer than that counts as the same peak).
function secondPeak(scores: Float32Array, best: number, width: number): number {
  let second = 0
  for (let i = 1; i < scores.length - 1; i++) {
    if (Math.abs(i - best) <= width) continue
    const isPeak = scores[i] >= scores[i - 1] && scores[i] >= scores[i + 1]
    if (isPeak && scores[i] > second) second = scores[i]
  }
  return second
}

// Fits a parabola through the best score and its two neighbours and returns
// where its top is, relative to `i` (-0.5..0.5 samples). The true peak
// usually lies between two samples; the parabola finds it.
function parabolicPeak(scores: Float32Array, i: number): number {
  if (i <= 0 || i >= scores.length - 1) return 0
  const left = scores[i - 1]
  const mid = scores[i]
  const right = scores[i + 1]
  const curve = left - 2 * mid + right // < 0 at a peak
  if (curve >= 0) return 0
  const delta = (0.5 * (left - right)) / curve
  return Math.min(0.5, Math.max(-0.5, delta))
}
