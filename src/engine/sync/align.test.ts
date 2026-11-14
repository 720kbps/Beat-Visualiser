import { describe, expect, it } from 'vitest'
import { alignOffset, boxResample, mixToMono, SYNC_RATE } from './align'

const BEAT_RATE = 44100
const REC_RATE = 48000

// Small seeded random generator (mulberry32), so every run uses the same "random" beat.
function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A beat as a function of time (seconds), so it can be sampled at any rate.
// Kicks (pitch-swept sine) on an irregular 16th-note pattern, a sliding 808
// bass, a melody that changes note every 8th, and metallic hats. Silence
// before time 0.
function makeBeat(seed: number): (t: number) => number {
  const rand = random(seed)
  const step = 60 / 140 / 4 // a 16th note at 140 BPM
  const steps = 200
  const sub = 45 + rand() * 15 // the 808 note, Hz
  const kicks: number[] = []
  const hats: number[] = []
  const notes: number[] = []
  for (let s = 0; s < steps; s++) {
    if (s % 4 === 0 || rand() < 0.2) kicks.push(s * step)
    hats.push(rand())
    notes.push(220 * Math.pow(2, Math.floor(rand() * 12) / 12))
  }

  return (t: number) => {
    if (t < 0) return 0
    const s = Math.floor(t / step)
    if (s >= steps) return 0
    let v = 0
    for (const k of kicks) {
      const dt = t - k
      if (dt < 0 || dt > 0.4) continue
      const phase =
        2 * Math.PI * (50 * dt + (100 / 30) * (1 - Math.exp(-30 * dt)))
      v += 0.7 * Math.sin(phase) * Math.exp(-6 * dt)
    }
    v += 0.3 * Math.sin(2 * Math.PI * sub * t) // 808-ish sub bass, always on
    const note = notes[Math.floor(s / 2) * 2]
    v +=
      0.15 * Math.sin(2 * Math.PI * note * t) +
      0.08 * Math.sin(4 * Math.PI * note * t)
    const dh = t - s * step
    const hat =
      Math.sin(2 * Math.PI * 3100 * t) + Math.sin(2 * Math.PI * 4700 * t)
    v += 0.1 * hats[s] * hat * Math.exp(-40 * dh)
    return v
  }
}

function sample(f: (t: number) => number, rate: number, seconds: number) {
  const out = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < out.length; i++) out[i] = f(i / rate)
  return out
}

// What the take would record: the beat starting at video time `offset`
// (silence before), quieter, plus noise.
function record(
  f: (t: number) => number,
  offset: number,
  seconds: number,
  gain = 0.4,
  noise = 0.05,
) {
  const rand = random(99)
  return sample(
    (v) => gain * f(v - offset) + noise * (rand() * 2 - 1),
    REC_RATE,
    seconds,
  )
}

const beatFn = makeBeat(1)
const beat = sample(beatFn, BEAT_RATE, 20)

describe('alignOffset', () => {
  it('finds the true offset at a different rate, with noise and lower gain', () => {
    const recorded = record(beatFn, 0.062, 15)
    const result = alignOffset(beat, BEAT_RATE, recorded, REC_RATE, 0.015)
    expect(result.ok).toBe(true)
    expect(Math.abs(result.offset - 0.062)).toBeLessThan(0.002)
    expect(result.correction).toBeCloseTo(0.047, 2)
    expect(result.confidence).toBeGreaterThan(0.5)
  })

  it('is sub-millisecond accurate for an offset between two samples', () => {
    const recorded = record(beatFn, 0.0731234, 15)
    const result = alignOffset(beat, BEAT_RATE, recorded, REC_RATE, 0.02)
    expect(result.ok).toBe(true)
    expect(Math.abs(result.offset - 0.0731234)).toBeLessThan(0.0005)
  })

  it('handles a negative correction (FL started before the estimate)', () => {
    const recorded = record(beatFn, 0.03, 15)
    const result = alignOffset(beat, BEAT_RATE, recorded, REC_RATE, 0.1)
    expect(result.ok).toBe(true)
    expect(Math.abs(result.offset - 0.03)).toBeLessThan(0.002)
    expect(result.correction).toBeLessThan(0)
  })

  it('finds a large offset with a wide search (leading silence)', () => {
    // "Use latest recording": no estimate (0), FL started 1.3 s in.
    const recorded = record(beatFn, 1.3, 15)
    const result = alignOffset(beat, BEAT_RATE, recorded, REC_RATE, 0, {
      searchSeconds: 2,
    })
    expect(result.ok).toBe(true)
    expect(Math.abs(result.offset - 1.3)).toBeLessThan(0.002)
  })

  it('finds a negative offset (the recording started after the beat)', () => {
    const recorded = record(beatFn, -0.4, 15)
    const result = alignOffset(beat, BEAT_RATE, recorded, REC_RATE, 0, {
      searchSeconds: 2,
    })
    expect(result.ok).toBe(true)
    expect(Math.abs(result.offset + 0.4)).toBeLessThan(0.002)
  })

  it('works when the recording is shorter than the analyzed part', () => {
    const recorded = record(beatFn, 0.05, 3)
    const result = alignOffset(beat, BEAT_RATE, recorded, REC_RATE, 0.015)
    expect(result.ok).toBe(true)
    expect(Math.abs(result.offset - 0.05)).toBeLessThan(0.002)
  })

  it('is not ok for a recording that is too short', () => {
    const recorded = record(beatFn, 0.05, 0.6)
    const result = alignOffset(beat, BEAT_RATE, recorded, REC_RATE, 0.015)
    expect(result.ok).toBe(false)
    expect(result.offset).toBe(0.015)
    expect(result.correction).toBe(0)
  })

  it('is not ok for a silent recording (FL muted)', () => {
    const recorded = new Float32Array(15 * REC_RATE)
    const result = alignOffset(beat, BEAT_RATE, recorded, REC_RATE, 0.015)
    expect(result).toEqual({
      offset: 0.015,
      correction: 0,
      confidence: 0,
      ok: false,
    })
  })

  it('is not ok for a different song', () => {
    const recorded = record(makeBeat(2), 0.062, 15)
    const result = alignOffset(beat, BEAT_RATE, recorded, REC_RATE, 0.015)
    expect(result.ok).toBe(false)
    expect(result.offset).toBe(0.015)
    expect(result.confidence).toBeLessThan(0.4)
  })

  it('is not ok for noise only', () => {
    const recorded = record(beatFn, 0.062, 15, 0, 0.3)
    const result = alignOffset(beat, BEAT_RATE, recorded, REC_RATE, 0.015)
    expect(result.ok).toBe(false)
  })

  it('is not ok when two shifts fit equally well (an exactly repeating loop)', () => {
    // One kick per beat at 140 BPM and nothing else: shifting by one beat
    // (0.43 s, inside the ±0.5 s search) matches just as well.
    const loop = (t: number) => {
      if (t < 0) return 0
      const dt = t % (60 / 140)
      return Math.sin(2 * Math.PI * 300 * dt) * Math.exp(-20 * dt)
    }
    const loopBeat = sample(loop, BEAT_RATE, 20)
    const recorded = record(loop, 0.25, 15)
    const result = alignOffset(loopBeat, BEAT_RATE, recorded, REC_RATE, 0.015)
    expect(result.ok).toBe(false)
  })

  it('runs well under a second at the defaults (8 s, ±0.5 s)', () => {
    const recorded = record(beatFn, 0.062, 15)
    const start = performance.now()
    alignOffset(beat, BEAT_RATE, recorded, REC_RATE, 0.015)
    const ms = performance.now() - start
    const startWide = performance.now()
    alignOffset(beat, BEAT_RATE, recorded, REC_RATE, 0, { searchSeconds: 2 })
    const msWide = performance.now() - startWide
    console.log(
      `alignOffset: ${ms.toFixed(0)} ms (±0.5 s), ${msWide.toFixed(0)} ms (±2 s)`,
    )
    expect(ms).toBeLessThan(1000)
  })
})

describe('mixToMono', () => {
  it('averages the channels and pads with silence', () => {
    const left = Float32Array.from([1, 1, 1])
    const right = Float32Array.from([0, 1, -1])
    expect(Array.from(mixToMono([left, right]))).toEqual([0.5, 1, 0])
    expect(Array.from(mixToMono([left, right], 2, 3))).toEqual([0, 0, 0])
  })
})

describe('boxResample', () => {
  it('keeps a slow signal and its timing', () => {
    // A 10 Hz sine at 48 kHz, resampled: still the same sine at SYNC_RATE.
    const rate = 48000
    const x = Float32Array.from({ length: rate }, (_, i) =>
      Math.sin((2 * Math.PI * 10 * i) / rate),
    )
    const y = boxResample(x, rate, 0, SYNC_RATE / 2)
    // 0.25 s is a zero crossing, where a timing error shows most: 1 µs late
    // would read about -0.00006.
    const k = SYNC_RATE / 4
    expect(Math.abs(y[k])).toBeLessThan(0.0001)
    // 0.025 s is the top: the box filter barely lowers a slow sine.
    expect(y[SYNC_RATE / 40]).toBeCloseTo(1, 3)
  })
})
