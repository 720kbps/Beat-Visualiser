// One frame of the video: the theme, then the title card on top.
// The preview's frame loop and the export both call this, so they draw the
// same layers in the same order (CLAUDE.md: "What you see is what you get").
import type { TitleCard, TitleText } from '../overlay/title-card'
import type { FrameData, ParamValues, Visualizer } from '../visualizers/types'

export function renderFrame(
  visualizer: Visualizer,
  frame: FrameData,
  params: ParamValues,
  titleCard: TitleCard,
  title: TitleText,
): void {
  visualizer.render(frame, params)
  titleCard.render(title)
}
