// The contract between the engine and a theme ("visualizer").
//
// A theme is one object that implements Visualizer. It declares its own controls
// in `params`; the UI builds sliders/pickers from that list, so adding a theme
// never touches the UI. Preview and export both call the same render(frame, params).
import type { RenderContext } from '../render/renderer'

// One control a theme exposes. `type` decides which UI control is shown and what
// kind of value it produces (number, '#rrggbb' string, boolean, or text).
export type ParamDef =
  | {
      id: string
      label: string
      type: 'number'
      min: number
      max: number
      step: number
      default: number
    }
  | { id: string; label: string; type: 'color'; default: string } // '#rrggbb'
  | { id: string; label: string; type: 'toggle'; default: boolean }
  // A short line of text, e.g. a title. maxLength caps what the user can type.
  | {
      id: string
      label: string
      type: 'text'
      default: string
      maxLength: number
    }

export type ParamSchema = ParamDef[]

// Current value of every param, by id. Built with defaultParams(schema).
export type ParamValues = Record<string, number | string | boolean>

// One recorded plugin window as the theme gets it:
// - preview: the <video> element (video/plugin-clip.ts), already on the right frame
// - export: a canvas the exporter draws each decoded frame into (export/plugin-frames.ts)
export type VideoFrameSource = HTMLVideoElement | HTMLCanvasElement

// Everything a theme needs to draw one frame. Computed from the time only (see
// frame/frame-data.ts), never from the live audio clock, so export is deterministic.
export type FrameData = {
  time: number // seconds into the clip
  progress: number // 0..1, drives the playhead
  peaks: Float32Array // waveform of the whole clip, [min0,max0,...], PEAK_COLUMNS columns, computed once
  rms: number // current loudness, 0..1 (normalized)
  bass: number // current low-frequency energy (< ~150 Hz), 0..1 (normalized)
  beat: boolean // true on a beat frame (always false until Phase 4 beat detection)
  // The recorded plugin windows, one per slot: plugins[0] is slot 1 (top).
  // May be shorter than the theme's pluginSlots (fewer windows recorded), and
  // empty when there is no recording. Read the size from the element:
  // videoWidth/videoHeight for a <video>, width/height for a canvas.
  plugins: VideoFrameSource[]
}

export interface Visualizer {
  id: string
  name: string
  params: ParamSchema
  // How many plugin windows the theme shows (0 = none). The window picker
  // lets the user pick up to this many, in order.
  pluginSlots: number
  init(ctx: RenderContext): void // create GPU resources once
  render(frame: FrameData, params: ParamValues): void // draw one frame
  dispose(): void // free everything init created
}
