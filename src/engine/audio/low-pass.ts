// Shared by frame/frame-data.ts (the bass value themes draw with) and
// analysis/features.ts (the bass part of the highlight score).

// Biquad low-pass ("Audio EQ Cookbook" by R. Bristow-Johnson, Q = 0.707 =
// Butterworth, no resonance bump). It removes about 12 dB per octave above the
// cutoff: at 150 Hz cutoff a 1.2 kHz hi-hat/snare tone is ~36 dB quieter. A
// simpler one-pole filter only does 6 dB per octave, which lets too much
// of the snare through. Returns a function: feed it one sample, get one sample.
export function createLowPass(cutoffHz: number, sampleRate: number) {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate
  const cosW0 = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2) // sin(w0) / (2 * Q)
  const a0 = 1 + alpha
  const b0 = (1 - cosW0) / 2 / a0
  const b1 = (1 - cosW0) / a0
  const b2 = b0
  const a1 = (-2 * cosW0) / a0
  const a2 = (1 - alpha) / a0

  // Last two inputs and outputs
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0

  return function (x: number): number {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    return y
  }
}
