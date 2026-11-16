// A small radix-2 FFT, enough for the onset feature (one 1024-point
// transform per 50 ms of audio). No library: it's ~30 lines and has no
// license to think about.

// Magnitudes |X[k]| for k = 0..n/2 of the real signal `input` (length n, a
// power of two), written into `out` (length n/2 + 1). `re` and `im` are
// scratch arrays of length n, passed in so a caller looping over thousands of
// frames doesn't allocate each time.
export function magnitudeSpectrum(
  input: Float32Array,
  out: Float32Array,
  re: Float64Array,
  im: Float64Array,
): void {
  const n = input.length
  if (n & (n - 1)) throw new Error(`FFT size must be a power of two, got ${n}`)

  // Bit-reversed copy: the order the butterflies below need.
  const bits = Math.log2(n)
  for (let i = 0; i < n; i++) {
    let j = 0
    for (let b = 0; b < bits; b++) j |= ((i >> b) & 1) << (bits - 1 - b)
    re[j] = input[i]
    im[j] = 0
  }

  // Butterflies: combine transforms of size `size / 2` into size `size`.
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2
    const angle = (-2 * Math.PI) / size
    // k outside: the twiddle factor (cos, sin) only depends on k
    for (let k = 0; k < half; k++) {
      const wr = Math.cos(angle * k)
      const wi = Math.sin(angle * k)
      for (let start = 0; start < n; start += size) {
        const a = start + k
        const b = a + half
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }

  for (let k = 0; k <= n / 2; k++) out[k] = Math.hypot(re[k], im[k])
}
