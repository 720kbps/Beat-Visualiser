import { describe, expect, it } from 'vitest'
import { createFrameSource, PEAK_COLUMNS } from './frame-data'

const RATE = 48000

// Only the parts of AudioBuffer that createFrameSource uses, so this runs in Node
function makeBuffer(channels: Float32Array[], sampleRate = RATE): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0].length,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer
}

// One section of a test signal: a sine of this frequency and amplitude, for this many seconds
type Section = { seconds: number; hz: number; amplitude: number }

// Mono signal made of sections back to back. amplitude 0 = silence.
function makeSignal(sections: Section[], sampleRate = RATE): Float32Array {
  let total = 0
  for (const s of sections) total += Math.round(s.seconds * sampleRate)
  const data = new Float32Array(total)
  let offset = 0
  for (const s of sections) {
    const n = Math.round(s.seconds * sampleRate)
    for (let i = 0; i < n; i++) {
      data[offset + i] =
        s.amplitude * Math.sin((2 * Math.PI * s.hz * i) / sampleRate)
    }
    offset += n
  }
  return data
}

describe('createFrameSource', () => {
  it('gives rms 0 and bass 0 for silence', () => {
    const source = createFrameSource(makeBuffer([new Float32Array(RATE * 2)]))
    for (const t of [0, 0.5, 1, 1.5, 2]) {
      const frame = source.getFrame(t)
      expect(frame.rms).toBe(0)
      expect(frame.bass).toBe(0)
    }
  })

  it('gives rms near 1 in the loudest section and scales the rest to it', () => {
    // 1 s silence, 1 s loud, 1 s quiet (1/8 of the loud amplitude)
    const signal = makeSignal([
      { seconds: 1, hz: 440, amplitude: 0 },
      { seconds: 1, hz: 440, amplitude: 0.8 },
      { seconds: 1, hz: 440, amplitude: 0.1 },
    ])
    const source = createFrameSource(makeBuffer([signal]))

    expect(source.getFrame(0.5).rms).toBe(0)
    expect(source.getFrame(1.5).rms).toBeCloseTo(1, 2)
    // Well after the release has settled: 0.1 / 0.8
    expect(source.getFrame(2.9).rms).toBeCloseTo(0.125, 2)
  })

  it('gives high bass for a 50 Hz sine and low bass for a 5 kHz sine', () => {
    // Same amplitude, so rms is about the same in both halves; only bass differs
    const signal = makeSignal([
      { seconds: 1, hz: 50, amplitude: 0.5 },
      { seconds: 1, hz: 5000, amplitude: 0.5 },
    ])
    const source = createFrameSource(makeBuffer([signal]))

    const low = source.getFrame(0.5)
    const high = source.getFrame(1.8) // past the release tail of the 50 Hz part

    expect(low.rms).toBeCloseTo(high.rms, 1)
    expect(low.bass).toBeGreaterThan(0.95)
    expect(high.bass).toBeLessThan(0.05)
  })

  it('gives progress 0 at the start and 1 at the end, and clamps time', () => {
    const signal = makeSignal([{ seconds: 2, hz: 440, amplitude: 0.5 }])
    const source = createFrameSource(makeBuffer([signal]))

    expect(source.duration).toBeCloseTo(2, 6)
    expect(source.getFrame(0).progress).toBe(0)
    expect(source.getFrame(1).progress).toBeCloseTo(0.5, 6)
    expect(source.getFrame(source.duration).progress).toBe(1)

    expect(source.getFrame(-1).time).toBe(0)
    expect(source.getFrame(99).time).toBe(source.duration)
    expect(source.getFrame(99).progress).toBe(1)
  })

  it('gives the same values for the same time (deterministic)', () => {
    const signal = makeSignal([
      { seconds: 1, hz: 60, amplitude: 0.9 },
      { seconds: 1, hz: 3000, amplitude: 0.2 },
    ])
    const a = createFrameSource(makeBuffer([signal]))
    const b = createFrameSource(makeBuffer([signal]))

    expect(a.getFrame(1.234)).toEqual(a.getFrame(1.234))
    expect(a.getFrame(1.234)).toEqual(b.getFrame(1.234))

    // A 30 fps export and a 60 fps export agree on every frame they share
    for (let i = 0; i < 60; i++) {
      expect(a.getFrame(i / 30)).toEqual(a.getFrame((2 * i) / 60))
    }
  })

  it('offsets time by the clip start and analyses only the clip', () => {
    // 1 s quiet, then 1 s loud. 2 kHz so every waveform column (47 samples here)
    // holds at least one full period and reaches the peak.
    const signal = makeSignal([
      { seconds: 1, hz: 2000, amplitude: 0.1 },
      { seconds: 1, hz: 2000, amplitude: 0.8 },
    ])
    const buffer = makeBuffer([signal])

    const whole = createFrameSource(buffer)
    expect(whole.getFrame(0.5).rms).toBeCloseTo(0.125, 2)
    expect(whole.getFrame(1.5).rms).toBeCloseTo(1, 2)

    // Clip = the loud second only: time 0 of the clip is 1 s into the buffer
    const clip = createFrameSource(buffer, 1, 2)
    expect(clip.duration).toBeCloseTo(1, 6)
    expect(clip.getFrame(0.5).rms).toBeCloseTo(1, 2)
    expect(clip.getFrame(clip.duration).progress).toBe(1)

    // Peaks cover the clip only: every column swings to about +-0.8
    const peaks = clip.getFrame(0).peaks
    expect(peaks.length).toBe(PEAK_COLUMNS * 2)
    for (let col = 0; col < PEAK_COLUMNS; col++) {
      expect(peaks[col * 2 + 1]).toBeGreaterThan(0.7)
    }
  })

  it('hands out the same peaks array every frame', () => {
    const signal = makeSignal([{ seconds: 1, hz: 440, amplitude: 0.5 }])
    const source = createFrameSource(makeBuffer([signal]))
    expect(source.getFrame(0).peaks).toBe(source.getFrame(0.7).peaks)
  })

  it('mixes stereo channels to mono', () => {
    // Sound in the left channel only still counts
    const left = makeSignal([
      { seconds: 0.5, hz: 440, amplitude: 0 },
      { seconds: 0.5, hz: 440, amplitude: 0.5 },
    ])
    const right = new Float32Array(left.length)
    const source = createFrameSource(makeBuffer([left, right]))
    expect(source.getFrame(0.2).rms).toBe(0)
    expect(source.getFrame(0.8).rms).toBeCloseTo(1, 2)
  })

  it('handles an empty clip range without crashing', () => {
    const signal = makeSignal([{ seconds: 1, hz: 440, amplitude: 0.5 }])
    const source = createFrameSource(makeBuffer([signal]), 0.5, 0.2)
    expect(source.duration).toBe(0)
    const frame = source.getFrame(0.1)
    expect(frame.time).toBe(0)
    expect(frame.progress).toBe(0)
    expect(frame.rms).toBe(0)
  })

  it('throws on a clip range that is not a number', () => {
    const buffer = makeBuffer([new Float32Array(100)])
    expect(() => createFrameSource(buffer, NaN)).toThrow()
  })
})
