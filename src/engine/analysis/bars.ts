// Bar math for picking a section (CLAUDE.md: "Musically correct").
//
// The user types the BPM; we don't detect it. A beat exported from FL starts
// on bar 1 at 0 s, so bar k starts at k * barSeconds(bpm). That's all the
// "downbeat detection" we need. 4/4 time is assumed (beats almost always are).
// Without a BPM, sections are whole seconds and not snapped to anything.

export const BEATS_PER_BAR = 4

// The BPM field's text as a number, or null when it isn't a usable tempo.
// Accepts "140" and "92.5"; ignores spaces.
export function parseBpm(text: string): number | null {
  const value = Number(text.trim())
  if (text.trim() === '' || !Number.isFinite(value)) return null
  if (value < 40 || value > 300) return null
  return value
}

export function barSeconds(bpm: number): number {
  return (BEATS_PER_BAR * 60) / bpm
}

// How long the section is, for a chosen length (15/30/60 s) and a beat of
// `duration` seconds:
// - with a BPM: a whole number of bars, a multiple of 4 bars when at least
//   4 fit, never longer than the chosen length (so a "15 s" video stays
//   under 15 s). 15 s at 140 BPM = 8 bars = 13.71 s.
// - without: whole seconds, at least 1.
// Never longer than the beat.
export function sectionLength(
  target: number,
  bpm: number | null,
  duration: number,
): number {
  const max = Math.min(target, duration)
  const seconds = Math.max(1, Math.floor(max))
  if (bpm === null) return Math.min(seconds, duration)

  const bar = barSeconds(bpm)
  let bars = Math.floor(max / bar + 1e-9)
  if (bars >= 4) bars -= bars % 4
  if (bars < 1) return Math.min(seconds, duration) // the beat is shorter than a bar
  return bars * bar
}

// Moves a section start to where it's allowed: inside the beat (the whole
// section must fit) and, with a BPM, onto the nearest bar start.
export function snapStart(
  start: number,
  length: number,
  duration: number,
  bpm: number | null,
): number {
  const latest = Math.max(0, duration - length)
  if (bpm === null) {
    // No grid: tenths of a second are fine enough to drag with.
    return clamp(Math.round(start * 10) / 10, 0, latest)
  }
  const bar = barSeconds(bpm)
  const lastBar = Math.floor(latest / bar + 1e-9) // the latest bar the section fits from
  const index = clamp(Math.round(start / bar), 0, lastBar)
  return index * bar
}

// 1-based bar number of a bar start, for labels ("bars 33-40").
export function barNumber(time: number, bpm: number): number {
  return Math.round(time / barSeconds(bpm)) + 1
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
