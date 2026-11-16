import { describe, expect, it } from 'vitest'
import { EMPTY_TITLE, metaLine, TITLE_AREA } from './title-card'

describe('metaLine', () => {
  it('joins the parts that are filled in', () => {
    expect(metaLine({ name: 'x', bpm: '140', key: 'F#m', tag: 'kylo' })).toBe(
      '140 BPM · F#m · prod. kylo',
    )
  })

  it('leaves out empty and blank parts', () => {
    expect(metaLine({ ...EMPTY_TITLE, key: 'Am' })).toBe('Am')
    expect(metaLine({ ...EMPTY_TITLE, bpm: ' 92 ', tag: '  ' })).toBe('92 BPM')
    expect(metaLine(EMPTY_TITLE)).toBe('')
  })
})

describe('TITLE_AREA', () => {
  it('stays inside the TikTok safe zone', () => {
    // GL y up: the bottom 20% is y < 384, the right 12% is x > 950
    expect(TITLE_AREA.y0).toBeGreaterThanOrEqual(384)
    expect(TITLE_AREA.x1).toBeLessThanOrEqual(950)
    expect(TITLE_AREA.x0).toBeGreaterThanOrEqual(0)
    expect(TITLE_AREA.y1).toBeLessThanOrEqual(1920)
  })
})
