// "LCD Sampler": the first theme. A brushed-metal hardware sampler with a big
// blue LCD showing the recorded plugin window and a waveform LCD with a playhead.
// All the drawing is in the .glsl files next to this one; this file only
// builds the shader from them, creates the material and feeds it uniforms.
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
import { colorParam, numberParam } from '../params'
import type {
  FrameData,
  ParamSchema,
  ParamValues,
  VideoFrameSource,
  Visualizer,
} from '../types'
import commonGlsl from './common.glsl?raw'
import hardwareGlsl from './hardware.glsl?raw'
import mainGlsl from './main.glsl?raw'
import metalGlsl from './metal.glsl?raw'
import screensGlsl from './screens.glsl?raw'

// The fragment shader is split into files by responsibility, but WebGL takes
// one source string and GLSL has no #include. So the files are glued together
// here, in dependency order: GLSL needs a function declared before it's used,
// so each file may only use what the files before it define.
//   common    uniforms, layout constants, SDF / noise / shading helpers
//   metal     backdrop, brushed metal, the body and its chamfers
//   screens   the LCD effects, both screens, the acrylic display panel
//   hardware  meter, pads, buttons, knobs, grille, side column, screws
//   main      deviceFace() (places everything) and main()
const fragmentShader = [
  commonGlsl,
  metalGlsl,
  screensGlsl,
  hardwareGlsl,
  mainGlsl,
].join('\n')

const DEFAULT_SCREEN_COLOR = '#3a8dff'
const DEFAULT_GLOW = 0.6
const DEFAULT_SCANLINES = 0.5
const DEFAULT_LIGHT_LEAK = 0.5
const DEFAULT_METAL_TONE = 0.55

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
    id: 'lightLeak',
    label: 'Light leak',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: DEFAULT_LIGHT_LEAK,
  },
  {
    // Starts at 0.2: darker than that, the lower plate vanishes into the
    // background.
    id: 'metalTone',
    label: 'Metal (dark/light)',
    type: 'number',
    min: 0.2,
    max: 1,
    step: 0.01,
    default: DEFAULT_METAL_TONE,
  },
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
  uPlugin: { value: THREE.Texture | null } // null = Three.js binds an empty texture
  uPluginSize: { value: THREE.Vector2 } // video size in pixels
  uHasPlugin: { value: number }
  uPluginCropTop: { value: number } // video pixels cut off the top (title bar)
  uScreenColor: { value: THREE.Color }
  uGlow: { value: number }
  uScanlines: { value: number }
  uLightLeak: { value: number }
  uMetalTone: { value: number }
}

// Everything init() creates. null = not initialized (or disposed).
type GpuState = {
  ctx: RenderContext
  quad: FullscreenQuad
  uniforms: Uniforms
  peaksTexture: THREE.DataTexture
  peaks: Float32Array | null // the array currently in peaksTexture
  screenColor: string // the hex currently in uScreenColor
  pluginSource: VideoFrameSource | null // the video or canvas currently in pluginTexture
  pluginTexture: THREE.Texture | null
  pluginUploadedTime: number // video.currentTime of the last uploaded frame
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
    // The recorded plugin clip (frame.plugins[0]), see updatePluginTexture()
    uPlugin: { value: null },
    uPluginSize: { value: new THREE.Vector2(1, 1) },
    uHasPlugin: { value: 0 },
    // Nothing sets this yet; a later task can crop FL's window title bar.
    uPluginCropTop: { value: 0 },
    // ColorManagement is off (render/renderer.ts), so this holds the hex value / 255.
    uScreenColor: { value: new THREE.Color(DEFAULT_SCREEN_COLOR) },
    uGlow: { value: DEFAULT_GLOW },
    uScanlines: { value: DEFAULT_SCANLINES },
    uLightLeak: { value: DEFAULT_LIGHT_LEAK },
    uMetalTone: { value: DEFAULT_METAL_TONE },
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
    pluginSource: null,
    pluginTexture: null,
    pluginUploadedTime: -1,
  }
}

// The plugin clip as a texture: a VideoTexture for the preview's <video>, a
// CanvasTexture for the export's canvas. Linear filtering (the clip is shown
// scaled down a bit), no mipmaps (they'd be rebuilt on every frame).
// colorSpace stays at the default, so the shader gets the clip's own sRGB
// values (see render/renderer.ts).
function createPluginTexture(source: VideoFrameSource): THREE.Texture {
  const texture =
    source instanceof HTMLVideoElement
      ? new THREE.VideoTexture(source)
      : new THREE.CanvasTexture(source)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  return texture
}

// Keeps uPlugin in step with frame.plugins[0]: a new texture when the source
// (video or canvas) changes, and a fresh upload when its picture changed.
function updatePluginTexture(state: GpuState, source: VideoFrameSource | null) {
  const u = state.uniforms

  if (source !== state.pluginSource) {
    state.pluginTexture?.dispose()
    state.pluginTexture = source ? createPluginTexture(source) : null
    state.pluginSource = source
    state.pluginUploadedTime = -1
    u.uPlugin.value = state.pluginTexture
  }

  if (source instanceof HTMLCanvasElement) {
    updateCanvasTexture(state, source)
  } else {
    updateVideoTexture(state, source)
  }
}

// Export: the exporter drew the right frame into the canvas just before
// render(), so upload it every frame (one texImage2D of the clip's size).
function updateCanvasTexture(state: GpuState, canvas: HTMLCanvasElement) {
  const u = state.uniforms
  if (!state.pluginTexture || canvas.width === 0 || canvas.height === 0) {
    u.uHasPlugin.value = 0
    return
  }
  state.pluginTexture.needsUpdate = true
  u.uPluginSize.value.set(canvas.width, canvas.height)
  u.uHasPlugin.value = 1
}

// Preview: the <video> element plays or seeks on its own clock.
function updateVideoTexture(state: GpuState, video: HTMLVideoElement | null) {
  const u = state.uniforms

  // HAVE_CURRENT_DATA: there is a decoded frame to show.
  const texture = state.pluginTexture
  if (
    !video ||
    !texture ||
    video.readyState < video.HAVE_CURRENT_DATA ||
    video.videoWidth === 0
  ) {
    u.uHasPlugin.value = 0
    return
  }

  // When to upload: VideoTexture already marks itself for upload on every new
  // frame while the video plays (requestVideoFrameCallback). We also upload
  // whenever the video's time changed since the last upload, but not during
  // a seek (the new frame isn't decoded yet). That covers a seek while paused,
  // and browsers that don't call requestVideoFrameCallback for a video that
  // isn't on the page.
  if (!video.seeking && video.currentTime !== state.pluginUploadedTime) {
    texture.needsUpdate = true
    state.pluginUploadedTime = video.currentTime
  }

  u.uPluginSize.value.set(video.videoWidth, video.videoHeight)
  u.uHasPlugin.value = 1
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

  updatePluginTexture(gpu, frame.plugins[0] ?? null)

  const screenColor = colorParam(values, 'screenColor', DEFAULT_SCREEN_COLOR)
  if (screenColor !== gpu.screenColor) {
    u.uScreenColor.value.set(screenColor) // parses the string, so only on change
    gpu.screenColor = screenColor
  }
  u.uGlow.value = numberParam(values, 'glow', DEFAULT_GLOW)
  u.uScanlines.value = numberParam(values, 'scanlines', DEFAULT_SCANLINES)
  u.uLightLeak.value = numberParam(values, 'lightLeak', DEFAULT_LIGHT_LEAK)
  u.uMetalTone.value = numberParam(values, 'metalTone', DEFAULT_METAL_TONE)

  gpu.quad.render(gpu.ctx.renderer)
}

// Safe to call more than once.
function dispose(): void {
  if (!gpu) return
  gpu.quad.dispose() // geometry + material
  gpu.peaksTexture.dispose() // the quad doesn't own textures
  gpu.pluginTexture?.dispose() // the video/canvas itself belongs to the caller
  gpu = null
}

export const lcdSampler: Visualizer = {
  id: 'lcd-sampler',
  name: 'LCD Sampler',
  params,
  pluginSlots: 1,
  init,
  render,
  dispose,
}
