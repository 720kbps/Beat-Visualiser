// Word-wrapping for the title card (title-card.ts). Pure, so it can be
// tested in Node; the card passes in canvas measureText as `measure`.

export const TITLE_MAX_LINES = 2
export const TITLE_LINE_HEIGHT = 1.2 // times the font size
const MIN_FONT_SIZE = 24

export type TitleLines = {
  lines: string[] // 0..TITLE_MAX_LINES lines
  fontSize: number // may be smaller than asked, so the text fits
}

// Width of `text` in pixels at `fontSize` (in the app: canvas measureText)
export type MeasureText = (text: string, fontSize: number) => number

// Word-wraps `text` into at most TITLE_MAX_LINES lines of at most `maxWidth`
// pixels. If it doesn't fit at `fontSize`, the font gets 10% smaller until it
// does (or MIN_FONT_SIZE is reached; then extra lines are dropped).
export function fitTitle(
  text: string,
  fontSize: number,
  maxWidth: number,
  measure: MeasureText,
): TitleLines {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '')
  if (words.length === 0) return { lines: [], fontSize }

  let size = fontSize
  for (;;) {
    const lines = wrapWords(words, maxWidth, (t) => measure(t, size))
    const fits =
      lines.length <= TITLE_MAX_LINES &&
      lines.every((line) => measure(line, size) <= maxWidth)
    if (fits || size <= MIN_FONT_SIZE) {
      return { lines: lines.slice(0, TITLE_MAX_LINES), fontSize: size }
    }
    size = Math.max(Math.floor(size * 0.9), MIN_FONT_SIZE)
  }
}

// Greedy wrap: put words on a line until the next one doesn't fit.
// A single word wider than maxWidth still gets its own line.
function wrapWords(
  words: string[],
  maxWidth: number,
  width: (text: string) => number,
): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line === '' ? word : line + ' ' + word
    if (line === '' || width(candidate) <= maxWidth) {
      line = candidate
    } else {
      lines.push(line)
      line = word
    }
  }
  lines.push(line)
  return lines
}
