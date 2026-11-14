// Frame timing for the export. Pure functions, so they're tested in Node.
//
// Export never looks at a clock. Frame i of the video shows the moment
// t = i / fps seconds into the clip, whatever time it is and however long
// rendering that frame took. That's what makes the export deterministic.

export const EXPORT_FPS_OPTIONS = [30, 60] as const
export type ExportFps = (typeof EXPORT_FPS_OPTIONS)[number]

// How many frames a clip of `seconds` has. Rounded, so 15 s at 30 fps is
// exactly 450 frames, and floating-point noise (14.999999) doesn't lose one.
export function frameCount(seconds: number, fps: number): number {
  if (!(seconds > 0) || !(fps > 0)) return 0
  return Math.round(seconds * fps)
}

// Seconds into the clip shown by frame i. Also the frame's timestamp in the
// MP4 (Mediabunny takes seconds; WebCodecs itself counts in microseconds,
// and Mediabunny converts).
export function frameTime(i: number, fps: number): number {
  return i / fps
}

// Where frame i is in the plugin recording, in video seconds.
// The beat's second 0 is at `offset` seconds in the video (the take's
// play_offset), and the clip starts `sectionStart` seconds into the beat.
// Not clamped: the frame reader holds the first/last frame outside the video.
export function pluginVideoTime(
  i: number,
  fps: number,
  sectionStart: number,
  offset: number,
): number {
  return sectionStart + frameTime(i, fps) + offset
}

// Calls `report` at most every `intervalMs` (plus always for the final
// value 1), so the UI isn't updated for every single frame.
export function createProgressThrottle(
  report: (progress: number) => void,
  intervalMs = 100,
  now: () => number = () => performance.now(),
): (progress: number) => void {
  let last = -Infinity
  return (progress: number) => {
    const t = now()
    if (progress >= 1 || t - last >= intervalMs) {
      last = t
      report(Math.min(Math.max(progress, 0), 1))
    }
  }
}
