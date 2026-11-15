import { describe, expect, it } from 'vitest'
import { layoutStack, type Rect, type Size, type StackOptions } from './layout'

// The real numbers from stack/index.ts: an 820 px column centered on x = 540,
// windows between the title (~y 1500) and the safe zone's bottom (y 384)
const options: StackOptions = {
  centerX: 540,
  width: 820,
  top: 1500,
  bottom: 384,
  gap: 16,
}

const synth: Size = { width: 1300, height: 1000 }
const pianoRoll: Size = { width: 1300, height: 900 }
const audioClip: Size = { width: 1300, height: 300 }

const width = (r: Rect) => r.x1 - r.x0
const height = (r: Rect) => r.y1 - r.y0
// Edges are rounded to whole pixels, so allow 1 px
const expectNear = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1)

describe('layoutStack', () => {
  it('gives nothing for no windows', () => {
    expect(layoutStack([], options)).toEqual([])
  })

  it('centers a single window that fits, at the full width', () => {
    const [r] = layoutStack([audioClip], options)
    expect(width(r)).toBe(820)
    expect(r.x0).toBe(130)
    expect(r.x1).toBe(950)
    expectNear(height(r), (820 * 300) / 1300)
    // vertically centered between bottom and top
    expectNear((r.y0 + r.y1) / 2, (384 + 1500) / 2)
  })

  it('stacks top to bottom with the gap between windows', () => {
    const rects = layoutStack([audioClip, audioClip], options)
    expectNear(rects[0].y0 - rects[1].y1, 16)
    expect(rects[0].y1).toBeGreaterThan(rects[1].y1) // first one is on top
  })

  it('gives every window the same width, centered', () => {
    const rects = layoutStack([synth, pianoRoll, audioClip], options)
    expect(rects).toHaveLength(3)
    for (const r of rects) {
      expect(width(r)).toBe(width(rects[0]))
      expectNear((r.x0 + r.x1) / 2, 540)
    }
  })

  it('keeps each window aspect ratio', () => {
    const sizes = [synth, pianoRoll, audioClip]
    const rects = layoutStack(sizes, options)
    rects.forEach((r, i) => {
      const expected = sizes[i].height / sizes[i].width
      expect(height(r) / width(r)).toBeCloseTo(expected, 2)
    })
  })

  it('scales everything down uniformly when the stack is too tall', () => {
    // At 820 px wide these are 631 + 568 + 189 + 2 gaps = 1420 px, more than
    // the 1116 px between bottom and top
    const rects = layoutStack([synth, pianoRoll, audioClip], options)
    expect(width(rects[0])).toBeLessThan(820)
    expect(rects[0].y1).toBeLessThanOrEqual(1500)
    expect(rects[2].y0).toBeGreaterThanOrEqual(384)
    // it fills the space exactly (within rounding)
    expect(rects[0].y1 - rects[2].y0).toBeGreaterThan(1116 - 2)
  })

  it('stays inside the safe zone (x <= 950, y >= 384)', () => {
    const cases: Size[][] = [
      [synth],
      [synth, pianoRoll],
      [synth, pianoRoll, audioClip],
      [{ width: 400, height: 3000 }], // very tall window
      [{ width: 3000, height: 100 }], // very wide strip
    ]
    for (const sizes of cases) {
      for (const r of layoutStack(sizes, options)) {
        expect(r.x0).toBeGreaterThanOrEqual(130)
        expect(r.x1).toBeLessThanOrEqual(950)
        expect(r.y0).toBeGreaterThanOrEqual(384)
        expect(r.y1).toBeLessThanOrEqual(1500)
      }
    }
  })

  it('uses a narrower column when asked', () => {
    const [r] = layoutStack([audioClip], { ...options, width: 410 })
    expect(width(r)).toBe(410)
    expect((r.x0 + r.x1) / 2).toBe(540)
  })
})
