// "Stack": a deliberately plain theme. Black background, a bold white title
// near the top, and up to 3 recorded plugin windows stacked below it, shown
// unchanged and all at the same width (the "FL Studio windows" TikTok look).
//
// layout.ts decides where the windows go, title.ts draws the title into a
// 2D canvas, slot-texture.ts turns each recording into a texture, and
// stack.frag.glsl fills the rectangles.
//
// Safe zone (CLAUDE.md): nothing goes into the bottom 20% (y < 384, GL y up)
// or the right 12% (x > 950). The column is centered on x = 540, so it can be
// at most 2 × (950 − 540) = 820 px wide.
//
// Nothing here touches WebGL or the DOM when the module is imported (the param
// tests import every theme in Node). Canvases and textures are made in init().
import * as THREE from 'three'
import {
  createFullscreenQuad,
  FULLSCREEN_VERTEX_SHADER,
  type FullscreenQuad,
} from '../../render/fullscreen-quad'
import {
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  type RenderContext,
} from '../../render/renderer'
import { colorParam, numberParam, textParam } from '../params'
import type { FrameData, ParamSchema, ParamValues, Visualizer } from '../types'
import { layoutStack, type Size } from './layout'
import {
  createSlotTexture,
  disposeSlotTexture,
  updateSlotTexture,
  type SlotTexture,
} from './slot-texture'
import fragmentShader from './stack.frag.glsl?raw'
import {
  drawTitle,
  fitTitle,
  TITLE_LINE_HEIGHT,
  TITLE_MAX_LINES,
  titleFont,
  type TitleLines,
} from './title'

const SLOTS = 3

// Layout, in output pixels
const SAFE_RIGHT = OUTPUT_WIDTH - 130 // 950
const SAFE_BOTTOM = 384 // 20% of 1920
const CENTER_X = OUTPUT_WIDTH / 2
const COLUMN_MAX_WIDTH = 2 * (SAFE_RIGHT - CENTER_X) // 820
const TOP_MARGIN = 170 // from the top edge to the first title line (clear of TikTok's top bar)
const TITLE_GAP = 56 // between the title and the first window

// The title canvas spans the column and fits 2 lines at the biggest size.
// TITLE_PAD leaves room for the text shadow.
const TITLE_PAD = 24
const MAX_TITLE_SIZE = 110
const TITLE_CANVAS_WIDTH = COLUMN_MAX_WIDTH
const TITLE_CANVAS_HEIGHT =
  Math.ceil(MAX_TITLE_SIZE * TITLE_LINE_HEIGHT * TITLE_MAX_LINES) +
  2 * TITLE_PAD

const DEFAULT_TITLE = "it's all just one preset"
const DEFAULT_TITLE_SIZE = 72
const DEFAULT_BACKGROUND = '#000000'
const DEFAULT_WIDTH = 1
const DEFAULT_GAP = 16

const params: ParamSchema = [
  {
    id: 'title',
    label: 'Title',
    type: 'text',
    default: DEFAULT_TITLE,
    maxLength: 80,
  },
  {
    id: 'titleSize',
    label: 'Title size',
    type: 'number',
    min: 40,
    max: MAX_TITLE_SIZE,
    step: 1,
    default: DEFAULT_TITLE_SIZE,
  },
  {
    id: 'background',
    label: 'Background',
    type: 'color',
    default: DEFAULT_BACKGROUND,
  },
  {
    // Fraction of the widest column the safe zone allows (820 px)
    id: 'width',
    label: 'Window width',
    type: 'number',
    min: 0.5,
    max: 1,
    step: 0.01,
    default: DEFAULT_WIDTH,
  },
  {
    id: 'gap',
    label: 'Gap',
    type: 'number',
    min: 0,
    max: 64,
    step: 1,
    default: DEFAULT_GAP,
  },
]

// Names match the `uniform` declarations in stack.frag.glsl
type Uniforms = {
  uBackground: { value: THREE.Color }
  uSlotCount: { value: number }
  uSlotRect: { value: THREE.Vector4[] }
  uSlot0: { value: THREE.Texture | null } // null = Three.js binds an empty texture
  uSlot1: { value: THREE.Texture | null }
  uSlot2: { value: THREE.Texture | null }
  uTitle: { value: THREE.CanvasTexture }
  uTitleRect: { value: THREE.Vector4 }
}

// Everything init() creates. null = not initialized (or disposed).
type GpuState = {
  ctx: RenderContext
  quad: FullscreenQuad
  uniforms: Uniforms
  slots: SlotTexture[] // one per plugin slot, index = slot
  titleCanvas: HTMLCanvasElement
  titleTexture: THREE.CanvasTexture
  titleKey: string // text + size currently drawn in titleCanvas
  title: TitleLines
  background: string // the hex currently in uBackground
}

let gpu: GpuState | null = null

function init(ctx: RenderContext): void {
  if (gpu) dispose() // init twice = start over

  const titleCanvas = document.createElement('canvas')
  titleCanvas.width = TITLE_CANVAS_WIDTH
  titleCanvas.height = TITLE_CANVAS_HEIGHT
  const titleTexture = new THREE.CanvasTexture(titleCanvas)
  titleTexture.minFilter = THREE.LinearFilter
  titleTexture.generateMipmaps = false

  // The title canvas sits at a fixed place: centered, its first text line
  // starting TOP_MARGIN below the top edge.
  const titleTop = OUTPUT_HEIGHT - TOP_MARGIN + TITLE_PAD
  const titleLeft = CENTER_X - TITLE_CANVAS_WIDTH / 2

  const uniforms: Uniforms = {
    // ColorManagement is off (render/renderer.ts), so this holds the hex value / 255
    uBackground: { value: new THREE.Color(DEFAULT_BACKGROUND) },
    uSlotCount: { value: 0 },
    uSlotRect: {
      value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()],
    },
    uSlot0: { value: null },
    uSlot1: { value: null },
    uSlot2: { value: null },
    uTitle: { value: titleTexture },
    uTitleRect: {
      value: new THREE.Vector4(
        titleLeft,
        titleTop - TITLE_CANVAS_HEIGHT,
        titleLeft + TITLE_CANVAS_WIDTH,
        titleTop,
      ),
    },
  }

  const material = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX_SHADER,
    fragmentShader,
    uniforms,
  })

  const slots: SlotTexture[] = []
  for (let i = 0; i < SLOTS; i++) slots.push(createSlotTexture())

  gpu = {
    ctx,
    quad: createFullscreenQuad(material),
    uniforms,
    slots,
    titleCanvas,
    titleTexture,
    titleKey: '',
    title: { lines: [], fontSize: DEFAULT_TITLE_SIZE },
    background: DEFAULT_BACKGROUND,
  }
}

// Redraws the title canvas, but only when the text or size changed.
function updateTitle(state: GpuState, text: string, fontSize: number): void {
  const key = fontSize + '|' + text
  if (key === state.titleKey) return
  state.titleKey = key

  const g = state.titleCanvas.getContext('2d')
  if (!g) return
  const measure = (t: string, size: number) => {
    g.font = titleFont(size)
    return g.measureText(t).width
  }
  const maxWidth = TITLE_CANVAS_WIDTH - 2 * TITLE_PAD
  state.title = fitTitle(text, fontSize, maxWidth, measure)
  drawTitle(state.titleCanvas, state.title, TITLE_PAD)
  state.titleTexture.needsUpdate = true
}

function render(frame: FrameData, values: ParamValues): void {
  if (!gpu) return
  const u = gpu.uniforms

  const background = colorParam(values, 'background', DEFAULT_BACKGROUND)
  if (background !== gpu.background) {
    u.uBackground.value.set(background) // parses the string, so only on change
    gpu.background = background
  }

  updateTitle(
    gpu,
    textParam(values, 'title', DEFAULT_TITLE),
    numberParam(values, 'titleSize', DEFAULT_TITLE_SIZE),
  )

  // Update every slot's texture and collect the ones that have a picture.
  // Empty slots are skipped, so the present windows close up.
  const sizes: Size[] = []
  const textures: THREE.Texture[] = []
  for (let i = 0; i < SLOTS; i++) {
    const slot = gpu.slots[i]
    const size = updateSlotTexture(slot, frame.plugins[i] ?? null)
    if (size && slot.texture) {
      sizes.push(size)
      textures.push(slot.texture)
    }
  }

  // The windows go between the title and the safe zone's bottom edge
  const lines = gpu.title.lines.length
  let top = OUTPUT_HEIGHT - TOP_MARGIN
  if (lines > 0) {
    top -= lines * gpu.title.fontSize * TITLE_LINE_HEIGHT + TITLE_GAP
  }
  const rects = layoutStack(sizes, {
    centerX: CENTER_X,
    width: COLUMN_MAX_WIDTH * numberParam(values, 'width', DEFAULT_WIDTH),
    top,
    bottom: SAFE_BOTTOM,
    gap: numberParam(values, 'gap', DEFAULT_GAP),
  })

  rects.forEach((r, i) => u.uSlotRect.value[i].set(r.x0, r.y0, r.x1, r.y1))
  u.uSlotCount.value = rects.length
  u.uSlot0.value = textures[0] ?? null
  u.uSlot1.value = textures[1] ?? null
  u.uSlot2.value = textures[2] ?? null

  gpu.quad.render(gpu.ctx.renderer)
}

// Safe to call more than once.
function dispose(): void {
  if (!gpu) return
  gpu.quad.dispose() // geometry + material
  gpu.titleTexture.dispose() // the quad doesn't own textures
  for (const slot of gpu.slots) disposeSlotTexture(slot)
  gpu = null
}

export const stack: Visualizer = {
  id: 'stack',
  name: 'Stack',
  params,
  pluginSlots: SLOTS,
  init,
  render,
  dispose,
}
