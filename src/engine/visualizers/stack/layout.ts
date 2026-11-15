// Where the "Stack" theme puts things. Pure math, no DOM or WebGL, so it's
// easy to test (layout.test.ts).
//
// Coordinates are output pixels with GL's convention: (0, 0) is the
// BOTTOM-left corner of the 1080×1920 frame and y grows upwards, the same as
// gl_FragCoord in the shader.

export type Size = { width: number; height: number }

// A rectangle in output pixels: (x0, y0) bottom-left, (x1, y1) top-right.
export type Rect = { x0: number; y0: number; x1: number; y1: number }

export type StackOptions = {
  centerX: number // the column's horizontal center
  width: number // width every window is scaled to (before any scale-down)
  top: number // highest y the stack may reach
  bottom: number // lowest y the stack may reach
  gap: number // pixels between two windows
}

// One rect per size, in the same order, top to bottom. All windows get the
// same width and keep their aspect ratio. The stack is centered horizontally
// on centerX and vertically between bottom and top. If it's too tall, every
// window is scaled down by the same factor (widths stay equal) so the stack
// fits exactly; the gaps keep their size.
// Edges are rounded to whole pixels so the windows are drawn crisp.
export function layoutStack(sizes: Size[], options: StackOptions): Rect[] {
  const count = sizes.length
  if (count === 0) return []

  const { centerX, top, bottom, gap } = options

  // Heights at the full column width
  const heights = sizes.map((s) => (options.width * s.height) / s.width)
  const totalHeight = sum(heights)
  const totalGaps = gap * (count - 1)

  // Scale down (never up) when windows + gaps don't fit
  const available = top - bottom
  let scale = 1
  if (totalHeight + totalGaps > available) {
    scale = Math.max(available - totalGaps, 0) / totalHeight
  }

  const width = options.width * scale
  const stackHeight = totalHeight * scale + totalGaps

  // Center the stack vertically in the available space
  let y = bottom + (available + stackHeight) / 2 // top edge of the first window
  const x0 = Math.round(centerX - width / 2)
  const x1 = x0 + Math.round(width) // round once, so all widths are equal

  const rects: Rect[] = []
  for (const h of heights) {
    const y1 = y
    const y0 = y - h * scale
    rects.push({ x0, y0: Math.round(y0), x1, y1: Math.round(y1) })
    y = y0 - gap
  }
  return rects
}

function sum(values: number[]): number {
  let total = 0
  for (const v of values) total += v
  return total
}
