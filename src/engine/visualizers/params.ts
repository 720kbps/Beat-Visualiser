// Helpers for a theme's param schema (the list of controls it exposes).
import type { ParamSchema, ParamValues } from './types'

// Design principle 4: "one strong look per theme". A theme is a finished look
// with a few controls, not a pile of effect sliders. More than this is a bug.
export const MAX_PARAMS = 5

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/ // '#rrggbb', what <input type="color"> uses

// The starting values for a schema: every param at its default.
export function defaultParams(schema: ParamSchema): ParamValues {
  const values: ParamValues = {}
  for (const def of schema) {
    values[def.id] = def.default
  }
  return values
}

// Throws an Error describing the first problem found, otherwise does nothing.
// Meant to catch mistakes in a theme's schema early (in tests), not user errors.
export function validateSchema(schema: ParamSchema): void {
  if (schema.length > MAX_PARAMS) {
    throw new Error(
      `A theme can have at most ${MAX_PARAMS} params, got ${schema.length}`,
    )
  }

  const seen = new Set<string>()
  for (const def of schema) {
    if (def.id === '') {
      throw new Error('Param id must not be empty')
    }
    if (seen.has(def.id)) {
      throw new Error(`Duplicate param id "${def.id}"`)
    }
    seen.add(def.id)

    if (def.type === 'number') {
      if (
        !Number.isFinite(def.min) ||
        !Number.isFinite(def.max) ||
        !Number.isFinite(def.default)
      ) {
        throw new Error(
          `Param "${def.id}": min, max and default must be numbers`,
        )
      }
      if (def.min > def.max) {
        throw new Error(
          `Param "${def.id}": min (${def.min}) > max (${def.max})`,
        )
      }
      if (!(def.step > 0)) {
        throw new Error(`Param "${def.id}": step must be > 0, got ${def.step}`)
      }
      if (def.default < def.min || def.default > def.max) {
        throw new Error(
          `Param "${def.id}": default ${def.default} is outside ${def.min}..${def.max}`,
        )
      }
    } else if (def.type === 'color') {
      if (!COLOR_PATTERN.test(def.default)) {
        throw new Error(
          `Param "${def.id}": color must look like '#rrggbb', got '${def.default}'`,
        )
      }
    }
    // 'toggle' has nothing to check: TypeScript already makes default a boolean.
  }
}

// Typed reads of one value, for themes. They fall back to `fallback` when the
// value is missing or has the wrong type (e.g. values left over from another
// theme for one frame while the UI switches themes).
export function numberParam(
  values: ParamValues,
  id: string,
  fallback: number,
): number {
  const v = values[id]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function colorParam(
  values: ParamValues,
  id: string,
  fallback: string,
): string {
  const v = values[id]
  return typeof v === 'string' && COLOR_PATTERN.test(v) ? v : fallback
}

export function toggleParam(
  values: ParamValues,
  id: string,
  fallback: boolean,
): boolean {
  const v = values[id]
  return typeof v === 'boolean' ? v : fallback
}
