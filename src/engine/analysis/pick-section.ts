// Picks the strongest section of a beat (CLAUDE.md, Highlight detection):
//
//   for each candidate start (every bar with a BPM, every second without):
//     skip it if the window touches the first or last 10% (intro, outro,
//     producer tag), unless no window fits otherwise
//     value = mean score over the window
//   pick the best (the earliest on a tie)
//
// Candidates are bar starts, so the result is already "snapped to the
// downbeat"; the length comes from bars.ts (a whole number of bars).
import { barSeconds } from './bars'
import type { HighlightScore } from './features'

export const EDGE_SKIP = 0.1 // share of the beat skipped at each end

// Start of the best `length`-second window, in seconds.
export function pickSection(
  highlight: HighlightScore,
  duration: number,
  length: number,
  bpm: number | null,
): number {
  if (length >= duration) return 0

  const { hopSeconds, score } = highlight
  // prefix[i] = sum of score[0..i), so a window's sum is two lookups.
  const prefix = new Float64Array(score.length + 1)
  for (let i = 0; i < score.length; i++) prefix[i + 1] = prefix[i] + score[i]

  function meanScore(start: number): number {
    const from = Math.min(Math.round(start / hopSeconds), score.length)
    const to = Math.min(Math.round((start + length) / hopSeconds), score.length)
    return to > from ? (prefix[to] - prefix[from]) / (to - from) : 0
  }

  const step = bpm === null ? 1 : barSeconds(bpm)
  const candidates: number[] = []
  for (let start = 0; start + length <= duration + 1e-6; start += step) {
    candidates.push(start)
  }

  const skipFrom = duration * EDGE_SKIP
  const skipTo = duration * (1 - EDGE_SKIP)
  const inMiddle = candidates.filter(
    (start) => start >= skipFrom - 1e-6 && start + length <= skipTo + 1e-6,
  )
  const pool = inMiddle.length > 0 ? inMiddle : candidates

  let best = pool[0] ?? 0
  let bestValue = -Infinity
  for (const start of pool) {
    const value = meanScore(start)
    if (value > bestValue) {
      bestValue = value
      best = start
    }
  }
  return best
}
