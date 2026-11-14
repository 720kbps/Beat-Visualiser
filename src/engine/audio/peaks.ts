// Waveform peaks: the min and max sample value per column, used to draw the waveform.
// Each column is drawn as a vertical line from its min to its max.

// Returns 2 * columns values, interleaved: [min0, max0, min1, max1, ...], each in -1..1.
//
// - columns must be a positive integer, otherwise this throws.
// - start/end are clamped to the valid sample range.
// - No channels or an empty range returns all zeros (a flat line), so the caller can
//   always draw something without special cases.
//
// Cost: one pass over every sample of every channel in the range, O(channels * samples),
// plus O(columns) for the output. No allocations except the result array.
export function computePeaks(
  channels: Float32Array[],
  columns: number,
  start = 0,
  end?: number,
): Float32Array {
  if (!Number.isInteger(columns) || columns <= 0) {
    throw new Error(`columns must be a positive integer, got ${columns}`)
  }

  const peaks = new Float32Array(columns * 2)
  if (channels.length === 0) {
    return peaks
  }

  // Channels should have the same length. Use the shortest one so we never read past an array.
  let totalSamples = channels[0].length
  for (let c = 1; c < channels.length; c++) {
    totalSamples = Math.min(totalSamples, channels[c].length)
  }

  // Clamp the range to whole samples inside the audio
  const first = clamp(Math.floor(start), 0, totalSamples)
  const last = clamp(Math.floor(end ?? totalSamples), first, totalSamples)
  const length = last - first
  if (length === 0) {
    return peaks
  }

  for (let col = 0; col < columns; col++) {
    // Integer bucket boundaries. Column col covers [bucketStart, bucketEnd).
    // The next column starts exactly where this one ends, so every sample is in exactly one column.
    const bucketStart = first + Math.floor((col * length) / columns)
    let bucketEnd = first + Math.floor(((col + 1) * length) / columns)

    // With fewer samples than columns some buckets are empty. Use the single sample at
    // bucketStart instead (always a valid index here), so the drawing has no holes.
    if (bucketEnd === bucketStart) {
      bucketEnd = bucketStart + 1
    }

    // Mix channels by taking the lowest min and the highest max over all channels.
    // Averaging channels would cancel out a sound that is only in one ear (or out of phase),
    // this way a hard-panned sound still shows.
    let min = Infinity
    let max = -Infinity
    for (let c = 0; c < channels.length; c++) {
      const data = channels[c]
      for (let i = bucketStart; i < bucketEnd; i++) {
        const v = data[i]
        if (v < min) min = v
        if (v > max) max = v
      }
    }

    // Decoded audio can go slightly past -1..1 (clipping), keep the output in range
    peaks[col * 2] = clamp(min, -1, 1)
    peaks[col * 2 + 1] = clamp(max, -1, 1)
  }

  return peaks
}

// Convenience: computePeaks over all channels of a decoded AudioBuffer.
// Only uses the AudioBuffer type, so this file also runs in Node (tests) without Web Audio.
export function peaksFromBuffer(
  buffer: AudioBuffer,
  columns: number,
  start?: number,
  end?: number,
): Float32Array {
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c))
  }
  return computePeaks(channels, columns, start, end)
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}
