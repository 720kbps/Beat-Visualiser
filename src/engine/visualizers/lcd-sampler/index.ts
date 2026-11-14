// "LCD Sampler": the first theme. A brushed-metal hardware sampler with a big
// blue LCD (for the plugin recording, later) and a waveform LCD with a playhead.
// All the drawing is in lcd-sampler.frag.glsl; this file only creates the
// material and feeds it uniforms.
//
// Nothing here touches WebGL or the DOM when the module is imported (the param
// tests import every theme in Node). GPU objects only exist between init() and
// dispose().
import * as THREE from 'three'
import { PEAK_COLUMNS } from '../../frame/frame-data'
import {
  createFullscreenQuad,
  FULLSCREEN_VERTEX_SHADER,
  type FullscreenQuad,
} from '../../render/fullscreen-quad'
import type { RenderContext } from '../../render/renderer'
import { colorParam, numberParam, toggleParam } from '../params'
import type { FrameData, ParamSchema, ParamValues, Visualizer } from '../types'
import fragmentShader from './lcd-sampler.frag.glsl?raw'

const DEFAULT_SCREEN_COLOR = '#3a8dff'
const DEFAULT_GLOW = 0.6
const DEFAULT_SCANLINES = 0.5
const DEFAULT_METAL_TONE = 0.55
const DEFAULT_GRID = true

const params: ParamSchema = [
  {
    id: 'screenColor',
    label: 'Screen color',
    type: 'color',
    default: DEFAULT_SCREEN_COLOR,
  },
  {
    id: 'glow',
    label: 'Glow',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: DEFAULT_GLOW,
  },
  {
    id: 'scanlines',
    label: 'Scanlines',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: DEFAULT_SCANLINES,
  },
  {
    id: 'metalTone',
    label: 'Metal (dark/light)',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: DEFAULT_METAL_TONE,
  },
  { id: 'grid', label: 'Grid', type: 'toggle', default: DEFAULT_GRID },
]

// Uniforms are plain { value } objects; Three.js uploads `.value` on every
// render. Names match the `uniform` declarations in the shader.
type Uniforms = {
  uResolution: { value: THREE.Vector2 }
  uTime: { value: number }
  uProgress: { value: number }
  uRms: { value: number }
  uBass: { value: number }
  uPeaks: { value: THREE.DataTexture }
  uPeakColumns: { value: number }
  uHasPlugin: { value: number }
  uScreenColor: { value: THREE.Color }
  uGlow: { value: number }
  uScanlines: { value: number }
  uMetalTone: { value: number }
  uGrid: { value: number }
}

// Everything init() creates. null = not initialized (or disposed).
type GpuState = {
  ctx: RenderContext
  quad: FullscreenQuad
  uniforms: Uniforms
  peaksTexture: THREE.DataTexture
  peaks: Float32Array | null // the array currently in peaksTexture
  screenColor: string // the hex currently in uScreenColor
}

let gpu: GpuState | null = null

// The waveform as a 1-row float texture: one texel per column, R = min, G = max.
// NEAREST filtering and no mipmaps: linear filtering of 32-bit float textures
// isn't guaranteed in WebKit, and the shader reads exact texels with texelFetch.
function createPeaksTexture(peaks: Float32Array): THREE.DataTexture {
  const columns = Math.floor(peaks.length / 2)
  const texture = new THREE.DataTexture(
    peaks,
    columns,
    1,
    THREE.RGFormat,
    THREE.FloatType,
  )
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true // upload on the next render
  return texture
}

function init(ctx: RenderContext): void {
  if (gpu) dispose() // init twice = start over

  // Flat waveform until the first real frame arrives
  const peaksTexture = createPeaksTexture(new Float32Array(PEAK_COLUMNS * 2))

  const uniforms: Uniforms = {
    uResolution: { value: new THREE.Vector2(ctx.width, ctx.height) },
    uTime: { value: 0 },
    uProgress: { value: 0 },
    uRms: { value: 0 },
    uBass: { value: 0 },
    uPeaks: { value: peaksTexture },
    uPeakColumns: { value: PEAK_COLUMNS },
    // TODO(plugin video): set to 1 and bind the clip as a THREE.VideoTexture
    // (uPlugin) when frame.plugin exists. See mainScreenContent() in the shader.
    uHasPlugin: { value: 0 },
    // ColorManagement is off (render/renderer.ts), so this holds the hex value / 255.
    uScreenColor: { value: new THREE.Color(DEFAULT_SCREEN_COLOR) },
    uGlow: { value: DEFAULT_GLOW },
    uScanlines: { value: DEFAULT_SCANLINES },
    uMetalTone: { value: DEFAULT_METAL_TONE },
    uGrid: { value: DEFAULT_GRID ? 1 : 0 },
  }

  const material = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX_SHADER,
    fragmentShader,
    uniforms,
  })

  gpu = {
    ctx,
    quad: createFullscreenQuad(material),
    uniforms,
    peaksTexture,
    peaks: null,
    screenColor: DEFAULT_SCREEN_COLOR,
  }
}

// Called every frame: only copies numbers into the uniforms, no allocations,
// except when the peaks array or the screen color changes (new beat / user edit).
function render(frame: FrameData, values: ParamValues): void {
  if (!gpu) return
  const u = gpu.uniforms

  // A new peaks array means a new beat (or clip): upload it once.
  if (frame.peaks !== gpu.peaks && frame.peaks.length >= 2) {
    gpu.peaksTexture.dispose()
    gpu.peaksTexture = createPeaksTexture(frame.peaks)
    gpu.peaks = frame.peaks
    u.uPeaks.value = gpu.peaksTexture
    u.uPeakColumns.value = Math.floor(frame.peaks.length / 2)
  }

  u.uTime.value = frame.time
  u.uProgress.value = frame.progress
  u.uRms.value = frame.rms
  u.uBass.value = frame.bass

  const screenColor = colorParam(values, 'screenColor', DEFAULT_SCREEN_COLOR)
  if (screenColor !== gpu.screenColor) {
    u.uScreenColor.value.set(screenColor) // parses the string, so only on change
    gpu.screenColor = screenColor
  }
  u.uGlow.value = numberParam(values, 'glow', DEFAULT_GLOW)
  u.uScanlines.value = numberParam(values, 'scanlines', DEFAULT_SCANLINES)
  u.uMetalTone.value = numberParam(values, 'metalTone', DEFAULT_METAL_TONE)
  u.uGrid.value = toggleParam(values, 'grid', DEFAULT_GRID) ? 1 : 0

  gpu.quad.render(gpu.ctx.renderer)
}

// Safe to call more than once.
function dispose(): void {
  if (!gpu) return
  gpu.quad.dispose() // geometry + material
  gpu.peaksTexture.dispose() // the quad doesn't own textures
  gpu = null
}

export const lcdSampler: Visualizer = {
  id: 'lcd-sampler',
  name: 'LCD Sampler',
  params,
  init,
  render,
  dispose,
}
