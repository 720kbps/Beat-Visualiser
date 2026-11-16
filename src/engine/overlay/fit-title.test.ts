import { describe, expect, it } from 'vitest'
import { fitTitle, type MeasureText } from './title'

// Fake font: every character is half the font size wide
const measure: MeasureText = (text, fontSize) => text.length * fontSize * 0.5

describe('fitTitle', () => {
  it('gives no lines for an empty or blank title', () => {
    expect(fitTitle('', 60, 800, measure).lines).toEqual([])
    expect(fitTitle('   ', 60, 800, measure).lines).toEqual([])
  })

  it('keeps a short title on one line at the asked size', () => {
    // 10 chars × 30 px = 300 px
    expect(fitTitle('one preset', 60, 800, measure)).toEqual({
      lines: ['one preset'],
      fontSize: 60,
    })
  })

  it('wraps onto a second line', () => {
    // 24 chars × 40 px = 960 px > 800
    const title = fitTitle("it's all just one preset", 80, 800, measure)
    expect(title.fontSize).toBe(80)
    expect(title.lines).toEqual(["it's all just one", 'preset'])
  })

  it('shrinks the font when two lines are not enough', () => {
    const text = 'a very long title that needs more than two lines at this size'
    const title = fitTitle(text, 100, 800, measure)
    expect(title.fontSize).toBeLessThan(100)
    expect(title.lines.length).toBeLessThanOrEqual(2)
    expect(title.lines.join(' ')).toBe(text)
    for (const line of title.lines) {
      expect(measure(line, title.fontSize)).toBeLessThanOrEqual(800)
    }
  })
})
