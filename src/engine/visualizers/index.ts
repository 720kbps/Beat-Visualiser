// All themes the app knows about. To add a theme: import it and put it in this
// list. The first one is the default.
import { lcdSampler } from './lcd-sampler'
import { testPattern } from './test-pattern'
import type { Visualizer } from './types'

export const visualizers: Visualizer[] = [lcdSampler, testPattern]

// The theme with this id, or undefined if there is none.
export function getVisualizer(id: string): Visualizer | undefined {
  return visualizers.find((v) => v.id === id)
}
