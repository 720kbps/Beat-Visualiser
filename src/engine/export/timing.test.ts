import { describe, expect, it } from 'vitest'
import {
  createProgressThrottle,
  frameCount,
  frameTime,
  pluginVideoTime,
} from './timing'

describe('frameCount', () => {
  it('is length × fps for the spec lengths', () => {
    expect(frameCount(15, 30)).toBe(450)
    expect(frameCount(30, 60)).toBe(1800)
    expect(frameCount(60, 30)).toBe(1800)
  })

  it('rounds away floating-point noise', () => {
    expect(frameCount(14.999999, 30)).toBe(450)
    expect(frameCount(0.1 + 0.2, 10)).toBe(3)
  })

  it('is 0 for an empty or invalid clip', () => {
    expect(frameCount(0, 30)).toBe(0)
    expect(frameCount(-1, 30)).toBe(0)
    expect(frameCount(NaN, 30)).toBe(0)
    expect(frameCount(10, 0)).toBe(0)
  })
})

describe('frameTime', () => {
  it('is i / fps, starting at 0', () => {
    expect(frameTime(0, 30)).toBe(0)
    expect(frameTime(30, 30)).toBe(1)
    expect(frameTime(449, 30)).toBeCloseTo(14.9667, 4)
  })

  it('agrees between 30 and 60 fps at shared times', () => {
    for (let i = 0; i < 100; i++) {
      expect(frameTime(i, 30)).toBeCloseTo(frameTime(i * 2, 60), 12)
    }
  })
})

describe('pluginVideoTime', () => {
  it('adds the section start and the play offset', () => {
    expect(pluginVideoTime(0, 30, 0, 0.25)).toBeCloseTo(0.25, 12)
    expect(pluginVideoTime(30, 30, 8, 0.25)).toBeCloseTo(9.25, 12)
  })
})

describe('createProgressThrottle', () => {
  it('reports at most once per interval, but always the final 1', () => {
    let clock = 0
    const reported: number[] = []
    const progress = createProgressThrottle(
      (p) => reported.push(p),
      100,
      () => clock,
    )
    progress(0.1) // first call: reported
    clock = 50
    progress(0.2) // too soon
    clock = 120
    progress(0.3) // reported
    clock = 130
    progress(1) // final: always reported
    expect(reported).toEqual([0.1, 0.3, 1])
  })
})
