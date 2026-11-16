import { describe, expect, it } from 'vitest'
import {
  barNumber,
  barSeconds,
  parseBpm,
  sectionLength,
  snapStart,
} from './bars'
import { computeHighlightScore, type HighlightScore } from './features'
import { magnitudeSpectrum } from './fft'
import { pickSection } from './pick-section'

describe('parseBpm', () => {
  it('reads plain and decimal tempos', () => {
    expect(parseBpm('140')).toBe(140)
    expect(parseBpm(' 92.5 ')).toBe(92.5)
  })
  it('rejects empty, junk and silly values', () => {
    expect(parseBpm('')).toBeNull()
    expect(parseBpm('fast')).toBeNull()
    expect(parseBpm('5')).toBeNull()
    expect(parseBpm('999')).toBeNull()
  })
})

describe('sectionLength', () => {
  const bar140 = barSeconds(140) // 1.714 s

  it('is a multiple of 4 bars, not longer than asked', () => {
    // 15 s = 8.75 bars -> 8 bars
    expect(sectionLength(15, 140, 200)).toBeCloseTo(8 * bar140)
    // 30 s = 17.5 bars -> 16 bars
    expect(sectionLength(30, 140, 200)).toBeCloseTo(16 * bar140)
    // 60 s = 35 bars -> 32 bars
    expect(sectionLength(60, 140, 200)).toBeCloseTo(32 * bar140)
  })

  it('uses single bars when fewer than 4 fit', () => {
    // 60 BPM: a bar is 4 s, 15 s fits 3 bars
    expect(sectionLength(15, 60, 200)).toBeCloseTo(12)
  })

  it('stays inside a short beat', () => {
    // 10 s beat at 140: 5.8 bars -> 4 bars
    expect(sectionLength(30, 140, 10)).toBeCloseTo(4 * bar140)
    // shorter than one bar: whole seconds
    expect(sectionLength(15, 60, 3.5)).toBe(3)
  })

  it('is whole seconds without a BPM', () => {
    expect(sectionLength(15, null, 200)).toBe(15)
    expect(sectionLength(30, null, 12.4)).toBe(12)
  })
})

describe('snapStart', () => {
  const bar = barSeconds(120) // 2 s

  it('snaps to the nearest bar start', () => {
    expect(snapStart(4.9, 8, 100, 120)).toBe(4)
    expect(snapStart(5.1, 8, 100, 120)).toBe(6)
  })

  it('keeps the whole section inside the beat', () => {
    // 100 s beat, 8 s section: the latest start is 92 s (bar 47)
    expect(snapStart(99, 8, 100, 120)).toBe(92)
    expect(snapStart(-3, 8, 100, 120)).toBe(0)
    // 99 s beat: 91 s isn't a bar start, so 90 s
    expect(snapStart(95, 8, 99, 120)).toBe(90)
  })

  it('rounds to tenths without a BPM', () => {
    expect(snapStart(12.34, 15, 100, null)).toBe(12.3)
    expect(snapStart(99, 15, 100, null)).toBe(85)
  })

  it('numbers bars from 1', () => {
    expect(barNumber(0, 120)).toBe(1)
    expect(barNumber(10 * bar, 120)).toBe(11)
  })
})

describe('pickSection', () => {
  // 100 s at 10 values per second: quiet, except a loud stretch 60..72 s
  function fakeScore(loudFrom: number, loudTo: number): HighlightScore {
    const score = new Float32Array(1000).fill(0.1)
    for (let i = loudFrom * 10; i < loudTo * 10; i++) score[i] = 0.9
    return { hopSeconds: 0.1, score }
  }

  it('finds the loud part, on a bar', () => {
    // 120 BPM, 8 s section: the window 60..68 s is fully loud
    const start = pickSection(fakeScore(60, 72), 100, 8, 120)
    expect(start).toBeGreaterThanOrEqual(60)
    expect(start + 8).toBeLessThanOrEqual(72)
    expect(start % 2).toBe(0)
  })

  it('skips the intro and outro', () => {
    // Loudest at the very end (95..100 s): the outro is skipped, so the pick
    // ends by 90 s
    const start = pickSection(fakeScore(95, 100), 100, 8, 120)
    expect(start + 8).toBeLessThanOrEqual(90)
  })

  it('uses the edges when nothing else fits', () => {
    // 10 s beat, 9 s section: no window avoids both edges
    expect(pickSection(fakeScore(0, 10), 10, 9, null)).toBe(0)
  })

  it('starts at 0 when the section is the whole beat', () => {
    expect(pickSection(fakeScore(60, 72), 100, 100, null)).toBe(0)
  })
})

describe('magnitudeSpectrum', () => {
  it('puts a sine into its bin', () => {
    const n = 64
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 5 * i) / n)
    const out = new Float32Array(n / 2 + 1)
    magnitudeSpectrum(input, out, new Float64Array(n), new Float64Array(n))
    expect(out[5]).toBeCloseTo(n / 2, 3)
    expect(out[4]).toBeCloseTo(0, 3)
    expect(out[6]).toBeCloseTo(0, 3)
  })
})

describe('computeHighlightScore', () => {
  // A stub AudioBuffer: 20 s at 8 kHz. 0..10 s a quiet high tone, 10..20 s
  // loud kicks (60 Hz bursts, 2 per second) plus noise hits.
  function stubBuffer(): AudioBuffer {
    const sampleRate = 8000
    const data = new Float32Array(20 * sampleRate)
    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate
      if (t < 10) {
        data[i] = 0.05 * Math.sin(2 * Math.PI * 1000 * t)
      } else {
        const sinceKick = t % 0.5
        const kick = sinceKick < 0.15 ? Math.sin(2 * Math.PI * 60 * t) : 0
        const hit =
          sinceKick > 0.25 && sinceKick < 0.27
            ? (Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1) - 0.5
            : 0
        data[i] = 0.8 * kick + 0.5 * hit
      }
    }
    return {
      sampleRate,
      length: data.length,
      numberOfChannels: 1,
      getChannelData: () => data,
    } as unknown as AudioBuffer
  }

  it('scores the busy, bassy half higher', () => {
    const { hopSeconds, score } = computeHighlightScore(stubBuffer())
    expect(hopSeconds).toBeCloseTo(0.05)
    expect(score.length).toBe(400)
    const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length
    const quiet = mean(score.subarray(0, 200))
    const busy = mean(score.subarray(200, 400))
    expect(busy).toBeGreaterThan(quiet * 2)
    for (const v of score) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})
