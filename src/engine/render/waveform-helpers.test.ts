import { describe, expect, it } from 'vitest'
import { formatTime, timeToX, xToTime } from './waveform-helpers'

describe('formatTime', () => {
  it('formats minutes, seconds and tenths', () => {
    expect(formatTime(0)).toBe('0:00.0')
    expect(formatTime(12.34)).toBe('0:12.3')
    expect(formatTime(165)).toBe('2:45.0')
    expect(formatTime(605.25)).toBe('10:05.3')
  })

  it('carries rounding into the next minute', () => {
    expect(formatTime(59.96)).toBe('1:00.0')
  })

  it('shows negative times as zero', () => {
    expect(formatTime(-1)).toBe('0:00.0')
  })
})

describe('timeToX / xToTime', () => {
  it('maps time to pixels and back', () => {
    expect(timeToX(30, 120, 1000)).toBe(250)
    expect(xToTime(250, 1000, 120)).toBe(30)
  })

  it('clamps to the canvas', () => {
    expect(timeToX(-5, 120, 1000)).toBe(0)
    expect(timeToX(500, 120, 1000)).toBe(1000)
    expect(xToTime(-10, 1000, 120)).toBe(0)
    expect(xToTime(2000, 1000, 120)).toBe(120)
  })

  it('returns 0 instead of NaN for zero duration or width', () => {
    expect(timeToX(1, 0, 1000)).toBe(0)
    expect(xToTime(1, 0, 120)).toBe(0)
  })
})
