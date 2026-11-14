import { describe, expect, it } from 'vitest'
import { computePeaks, peaksFromBuffer } from './peaks'

// Peaks are interleaved [min0, max0, min1, max1, ...]; these helpers read one column
function minAt(peaks: Float32Array, col: number): number {
  return peaks[col * 2]
}
function maxAt(peaks: Float32Array, col: number): number {
  return peaks[col * 2 + 1]
}

describe('computePeaks', () => {
  it('gives min/max per column for a ramp', () => {
    // 8 samples, 4 columns of 2 samples each: [-1, -0.75], [-0.5, -0.25], [0, 0.25], [0.5, 0.75]
    const ramp = new Float32Array([-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75])
    const peaks = computePeaks([ramp], 4)

    expect(peaks.length).toBe(8)
    expect(Array.from(peaks)).toEqual([
      -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75,
    ])
  })

  it('gives the full -1..1 swing for each column of a sine', () => {
    // 4 full periods of a sine, one period per column: every column reaches about -1 and 1
    const samplesPerPeriod = 100
    const sine = new Float32Array(samplesPerPeriod * 4)
    for (let i = 0; i < sine.length; i++) {
      sine[i] = Math.sin((2 * Math.PI * i) / samplesPerPeriod)
    }
    const peaks = computePeaks([sine], 4)

    for (let col = 0; col < 4; col++) {
      expect(minAt(peaks, col)).toBeCloseTo(-1, 3)
      expect(maxAt(peaks, col)).toBeCloseTo(1, 3)
    }
  })

  it('mixes stereo by taking min and max over both channels', () => {
    // Left only goes up, right only goes down: the column should show both
    const left = new Float32Array([0.5, 0.25, 0, 0])
    const right = new Float32Array([0, 0, -0.5, -0.75])
    const peaks = computePeaks([left, right], 2)

    expect(Array.from(peaks)).toEqual([0, 0.5, -0.75, 0])
  })

  it('has no holes when there are fewer samples than columns', () => {
    const samples = new Float32Array([0.5, -0.5, 0.25])
    const peaks = computePeaks([samples], 10)

    // Every column shows one of the samples, none is left at 0
    for (let col = 0; col < 10; col++) {
      expect(minAt(peaks, col)).not.toBe(0)
      expect(minAt(peaks, col)).toBe(maxAt(peaks, col))
    }
    // First and last column show the first and last sample
    expect(minAt(peaks, 0)).toBe(0.5)
    expect(minAt(peaks, 9)).toBe(0.25)
  })

  it('only looks at the start/end sub-range', () => {
    // Loud spikes outside the range must not show up
    const samples = new Float32Array([1, 1, 0.25, -0.25, 0.5, -0.5, -1, -1])
    const peaks = computePeaks([samples], 2, 2, 6)

    expect(Array.from(peaks)).toEqual([-0.25, 0.25, -0.5, 0.5])
  })

  it('puts every sample in exactly one column', () => {
    // A length that does not divide evenly into the columns.
    // Move a single spike through every position: it must show up in exactly one column.
    const length = 1000
    const columns = 7
    const samples = new Float32Array(length)
    for (let spike = 0; spike < length; spike++) {
      samples.fill(0)
      samples[spike] = 1
      const peaks = computePeaks([samples], columns)

      let columnsWithSpike = 0
      for (let col = 0; col < columns; col++) {
        if (maxAt(peaks, col) === 1) columnsWithSpike++
      }
      expect(columnsWithSpike).toBe(1)
    }
  })

  it('clamps start/end and returns zeros for an empty range or no channels', () => {
    const samples = new Float32Array([0.5, -0.5])

    // Out of range start/end are clamped to the whole array
    expect(Array.from(computePeaks([samples], 1, -10, 99))).toEqual([-0.5, 0.5])

    // Empty range and no channels give a flat line
    expect(Array.from(computePeaks([samples], 2, 1, 1))).toEqual([0, 0, 0, 0])
    expect(Array.from(computePeaks([], 2))).toEqual([0, 0, 0, 0])
  })

  it('throws when columns is not a positive integer', () => {
    const samples = new Float32Array(10)
    expect(() => computePeaks([samples], 0)).toThrow()
    expect(() => computePeaks([samples], -3)).toThrow()
    expect(() => computePeaks([samples], 2.5)).toThrow()
  })
})

describe('peaksFromBuffer', () => {
  it('uses every channel of the buffer', () => {
    const left = new Float32Array([0.5, 0])
    const right = new Float32Array([0, -0.5])
    // Only the parts of AudioBuffer that peaksFromBuffer uses, so this runs in Node
    const buffer = {
      numberOfChannels: 2,
      getChannelData: (c: number) => (c === 0 ? left : right),
    } as unknown as AudioBuffer

    expect(Array.from(peaksFromBuffer(buffer, 1))).toEqual([-0.5, 0.5])
  })
})
