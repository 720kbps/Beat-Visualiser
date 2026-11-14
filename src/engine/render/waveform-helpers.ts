// Small pure helpers for the waveform view. No DOM here, so they run in Node tests.

// Seconds -> "m:ss.t", e.g. 12.34 -> "0:12.3", 165 -> "2:45.0".
// Rounds to tenths first, so 59.96 becomes "1:00.0" and not "0:60.0".
export function formatTime(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10))
  const minutes = Math.floor(tenths / 600)
  const secondsPart = (tenths % 600) / 10
  return `${minutes}:${secondsPart.toFixed(1).padStart(4, '0')}`
}

// Time -> horizontal position (pixels) for a waveform `width` pixels wide.
// Clamped so the playhead never leaves the canvas.
export function timeToX(time: number, duration: number, width: number): number {
  if (duration <= 0) return 0
  return Math.min(Math.max(time / duration, 0), 1) * width
}

// Horizontal position (pixels) -> time. The inverse of timeToX, used for click-to-seek.
export function xToTime(x: number, width: number, duration: number): number {
  if (width <= 0) return 0
  return Math.min(Math.max(x / width, 0), 1) * duration
}
