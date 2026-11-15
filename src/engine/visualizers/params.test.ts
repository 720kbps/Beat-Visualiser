import { describe, expect, it } from 'vitest'
import {
  colorParam,
  defaultParams,
  numberParam,
  textParam,
  toggleParam,
  validateSchema,
} from './params'
import type { ParamSchema } from './types'
import { visualizers } from './index'

const goodSchema: ParamSchema = [
  {
    id: 'glow',
    label: 'Glow',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.5,
  },
  { id: 'tint', label: 'LCD tint', type: 'color', default: '#3fa9ff' },
  { id: 'scanlines', label: 'Scanlines', type: 'toggle', default: true },
  {
    id: 'title',
    label: 'Title',
    type: 'text',
    default: 'My beat',
    maxLength: 40,
  },
]

describe('defaultParams', () => {
  it('gives every param its default', () => {
    expect(defaultParams(goodSchema)).toEqual({
      glow: 0.5,
      tint: '#3fa9ff',
      scanlines: true,
      title: 'My beat',
    })
  })

  it('gives an empty object for an empty schema', () => {
    expect(defaultParams([])).toEqual({})
  })
})

describe('validateSchema', () => {
  it('accepts a good schema', () => {
    expect(() => validateSchema(goodSchema)).not.toThrow()
  })

  it('rejects duplicate ids', () => {
    const schema: ParamSchema = [
      { id: 'a', label: 'A', type: 'toggle', default: true },
      { id: 'a', label: 'A again', type: 'toggle', default: false },
    ]
    expect(() => validateSchema(schema)).toThrow(/Duplicate/)
  })

  it('rejects an empty id', () => {
    const schema: ParamSchema = [
      { id: '', label: 'A', type: 'toggle', default: true },
    ]
    expect(() => validateSchema(schema)).toThrow(/empty/)
  })

  it('rejects min > max', () => {
    const schema: ParamSchema = [
      {
        id: 'a',
        label: 'A',
        type: 'number',
        min: 2,
        max: 1,
        step: 1,
        default: 1,
      },
    ]
    expect(() => validateSchema(schema)).toThrow(/min/)
  })

  it('rejects a step of 0 or less', () => {
    const schema: ParamSchema = [
      {
        id: 'a',
        label: 'A',
        type: 'number',
        min: 0,
        max: 1,
        step: 0,
        default: 0,
      },
    ]
    expect(() => validateSchema(schema)).toThrow(/step/)
  })

  it('rejects a default outside min..max', () => {
    const schema: ParamSchema = [
      {
        id: 'a',
        label: 'A',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.1,
        default: 2,
      },
    ]
    expect(() => validateSchema(schema)).toThrow(/outside/)
  })

  it('rejects colors that are not #rrggbb', () => {
    for (const bad of ['red', '#fff', '3fa9ff', '#3fa9ffaa', '#3fa9fg']) {
      const schema: ParamSchema = [
        { id: 'c', label: 'C', type: 'color', default: bad },
      ]
      expect(() => validateSchema(schema)).toThrow(/rrggbb/)
    }
  })

  it('rejects a text default longer than maxLength', () => {
    const schema: ParamSchema = [
      { id: 't', label: 'T', type: 'text', default: 'too long', maxLength: 3 },
    ]
    expect(() => validateSchema(schema)).toThrow(/longer/)
  })

  it('rejects a text maxLength outside 1..200', () => {
    for (const bad of [0, -1, 201, 2.5]) {
      const schema: ParamSchema = [
        { id: 't', label: 'T', type: 'text', default: '', maxLength: bad },
      ]
      expect(() => validateSchema(schema)).toThrow(/maxLength/)
    }
  })

  it('rejects more than 5 params (one strong look per theme)', () => {
    const schema: ParamSchema = []
    for (let i = 0; i < 6; i++) {
      schema.push({
        id: `p${i}`,
        label: `P${i}`,
        type: 'toggle',
        default: true,
      })
    }
    expect(() => validateSchema(schema)).toThrow(/at most 5/)
    expect(() => validateSchema(schema.slice(0, 5))).not.toThrow()
  })
})

// Every theme in the registry must have a unique id and a valid schema
describe('registered visualizers', () => {
  it('have unique ids', () => {
    const ids = visualizers.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('have a whole number of plugin slots, 0 or more', () => {
    for (const v of visualizers) {
      expect(Number.isInteger(v.pluginSlots) && v.pluginSlots >= 0, v.id).toBe(
        true,
      )
    }
  })

  it('have valid param schemas', () => {
    for (const v of visualizers) {
      expect(() => validateSchema(v.params), v.id).not.toThrow()
    }
  })
})

describe('typed param reads', () => {
  const values = {
    glow: 0.3,
    tint: '#112233',
    grid: false,
    bad: 'x',
    title: 'Hello',
  }

  it('return the value when it has the right type', () => {
    expect(numberParam(values, 'glow', 1)).toBe(0.3)
    expect(colorParam(values, 'tint', '#ffffff')).toBe('#112233')
    expect(toggleParam(values, 'grid', true)).toBe(false)
    expect(textParam(values, 'title', '')).toBe('Hello')
  })

  it('return the fallback when the value is missing or the wrong type', () => {
    expect(numberParam(values, 'missing', 1)).toBe(1)
    expect(numberParam(values, 'tint', 1)).toBe(1)
    expect(colorParam(values, 'bad', '#ffffff')).toBe('#ffffff')
    expect(toggleParam(values, 'glow', true)).toBe(true)
    expect(textParam(values, 'missing', 'x')).toBe('x')
    expect(textParam(values, 'glow', 'x')).toBe('x')
  })
})
