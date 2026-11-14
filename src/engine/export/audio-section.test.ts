import { describe, expect, it } from 'vitest'
import { applyFades, FADE_SECONDS, sliceSection } from './audio-section'

const RATE = 1000 // small rate keeps the arrays readable

// A channel where sample i has the value i
function ramp(length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => i)
}

describe('sliceSection', () => {
  it('copies exactly the section, per channel', () => {
    const left = ramp(5000)
    const right = ramp(5000).map((v) => -v)
    const [l, r] = sliceSection([left, right], RATE, 1, 2)
    expect(l.length).toBe(2000)
    expect(l[0]).toBe(1000)
    expect(l[1999]).toBe(2999)
    expect(r[0]).toBe(-1000)
  })

  it('does not change the input', () => {
    const left = ramp(3000)
    const [l] = sliceSection([left], RATE, 0, 1)
    l[0] = 99
    expect(left[0]).toBe(0)
  })

  it('pads with silence past the end of the beat', () => {
    const [l] = sliceSection([ramp(1500)], RATE, 1, 1)
    expect(l.length).toBe(1000)
    expect(l[499]).toBe(1499)
    expect(l[500]).toBe(0)
    expect(l[999]).toBe(0)
  })

  it('keeps at most two channels', () => {
    const out = sliceSection([ramp(10), ramp(10), ramp(10)], RATE, 0, 0.01)
    expect(out.length).toBe(2)
  })

  it('rounds the length to whole samples', () => {
    const [l] = sliceSection([ramp(100)], 44100, 0, 15)
    expect(l.length).toBe(661500)
  })
})

describe('applyFades', () => {
  it('fades in and out over FADE_SECONDS, leaves the middle alone', () => {
    const data = new Float32Array(1000).fill(1)
    applyFades([data], RATE)
    const fade = Math.round(FADE_SECONDS * RATE) // 50 samples
    expect(data[0]).toBe(0)
    expect(data[999]).toBe(0)
    expect(data[fade / 2]).toBeCloseTo(0.5, 5)
    expect(data[999 - fade / 2]).toBeCloseTo(0.5, 5)
    expect(data[fade]).toBe(1)
    expect(data[500]).toBe(1)
    expect(data[999 - fade]).toBe(1)
    // monotonic fade-in
    for (let i = 1; i < fade; i++) expect(data[i]).toBeGreaterThan(data[i - 1])
  })

  it('handles a clip shorter than two fades', () => {
    const data = new Float32Array(20).fill(1)
    applyFades([data], RATE) // 10-sample fades each way
    expect(data[0]).toBe(0)
    expect(data[19]).toBe(0)
    expect(data[9]).toBeCloseTo(0.9, 5)
    expect(data[10]).toBeCloseTo(0.9, 5)
  })
})
