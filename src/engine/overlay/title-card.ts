// The title card: beat name, BPM, key and producer tag, drawn over every
// theme in the same place (CLAUDE.md, user flow step 6, "Optional text").
//
// It's part of the one render path: renderFrame() (render-frame.ts) draws the
// theme, then this card on top, in the preview and in the export alike.
// Themes keep TITLE_AREA free of important content.
//
// How it draws: the text goes into a 2D canvas (the browser renders the
// font), which becomes a texture on a small quad covering TITLE_AREA,
// blended over the theme's picture. The canvas is only redrawn when the text
// changes, not every frame.
import * as THREE from 'three'
import {
  createFullscreenQuad,
  type FullscreenQuad,
} from '../render/fullscreen-quad'
import {
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  type RenderContext,
} from '../render/renderer'
import { fitTitle, TITLE_LINE_HEIGHT, TITLE_MAX_LINES } from './fit-title'

export type TitleText = {
  name: string // the beat's name, the big line
  bpm: string // e.g. "140"; a string so the field can be empty
  key: string // e.g. "F#m"
  tag: string // producer name, shown as "prod. <tag>"
}

export const EMPTY_TITLE: TitleText = { name: '', bpm: '', key: '', tag: '' }

// Output pixels, GL convention (origin bottom-left, y up), like the shaders.
// 140..372 px from the top: below TikTok's top tabs, inside the safe zone's
// width (x 60..900, clear of the right 12%).
export const TITLE_AREA = { x0: 60, y0: 1548, x1: 900, y1: 1780 }

const NAME_SIZE = 72 // largest; fitTitle shrinks long names
const META_SIZE = 38
const META_GAP = 12 // between the name and the meta line
const FONT = 'system-ui, -apple-system, sans-serif'

// "140 BPM · F#m · prod. kylo", leaving out empty parts. '' if all are empty.
export function metaLine(text: TitleText): string {
  const parts: string[] = []
  if (text.bpm.trim()) parts.push(`${text.bpm.trim()} BPM`)
  if (text.key.trim()) parts.push(text.key.trim())
  if (text.tag.trim()) parts.push(`prod. ${text.tag.trim()}`)
  return parts.join(' · ')
}

export type TitleCard = {
  render(text: TitleText): void // draws over whatever is in the canvas now
  dispose(): void
}

const VERTEX_SHADER = /* glsl */ `
uniform vec4 uRect;       // where the card goes, output pixels
uniform vec2 uResolution; // (1080, 1920)
varying vec2 vUv;

void main() {
  vUv = uv;
  // The plane's uv runs 0..1 across it; place it on uRect in clip space.
  vec2 px = mix(uRect.xy, uRect.zw, uv);
  gl_Position = vec4(px / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`

// The canvas has straight (not premultiplied) alpha; Three.js' normal
// blending (transparent: true) mixes it over the theme: rgb * a + below * (1 - a).
const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uCard;
varying vec2 vUv;

void main() {
  gl_FragColor = texture2D(uCard, vUv);
}
`

export function createTitleCard(ctx: RenderContext): TitleCard {
  const width = TITLE_AREA.x1 - TITLE_AREA.x0
  const height = TITLE_AREA.y1 - TITLE_AREA.y0
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearFilter // drawn 1:1, no mipmaps needed
  texture.generateMipmaps = false

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uRect: {
        value: new THREE.Vector4(
          TITLE_AREA.x0,
          TITLE_AREA.y0,
          TITLE_AREA.x1,
          TITLE_AREA.y1,
        ),
      },
      uResolution: { value: new THREE.Vector2(OUTPUT_WIDTH, OUTPUT_HEIGHT) },
      uCard: { value: texture },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const quad: FullscreenQuad = createFullscreenQuad(material)

  let drawnKey: string | null = null // the text currently in the canvas
  let empty = true // nothing to draw: skip the GPU work

  function redraw(text: TitleText) {
    const g = canvas.getContext('2d')
    if (!g) return
    g.clearRect(0, 0, width, height)

    const measure = (t: string, size: number) => {
      g.font = `600 ${size}px ${FONT}`
      return g.measureText(t).width
    }
    const pad = 24 // room for the shadow
    const name = fitTitle(text.name, NAME_SIZE, width - 2 * pad, measure)
    const meta = metaLine(text)
    empty = name.lines.length === 0 && meta === ''
    if (empty) return

    // The block (name lines + meta line) is centered vertically in the card.
    const nameHeight = name.lines.length * name.fontSize * TITLE_LINE_HEIGHT
    const metaHeight = meta ? META_SIZE * TITLE_LINE_HEIGHT : 0
    const gap = name.lines.length > 0 && meta ? META_GAP : 0
    let y = (height - (nameHeight + gap + metaHeight)) / 2

    g.fillStyle = '#ffffff'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    // A soft shadow so white text also reads on a light theme
    g.shadowColor = 'rgba(0, 0, 0, 0.5)'
    g.shadowBlur = 12
    g.shadowOffsetY = 3

    g.font = `600 ${name.fontSize}px ${FONT}`
    for (const line of name.lines.slice(0, TITLE_MAX_LINES)) {
      const lineHeight = name.fontSize * TITLE_LINE_HEIGHT
      g.fillText(line, width / 2, y + lineHeight / 2)
      y += lineHeight
    }
    y += gap
    if (meta) {
      g.globalAlpha = 0.85
      g.font = `500 ${META_SIZE}px ${FONT}`
      g.fillText(meta, width / 2, y + (META_SIZE * TITLE_LINE_HEIGHT) / 2)
      g.globalAlpha = 1
    }
  }

  return {
    render(text) {
      const key = [text.name, text.bpm, text.key, text.tag].join('\u0000')
      if (key !== drawnKey) {
        drawnKey = key
        redraw(text)
        texture.needsUpdate = true
      }
      if (empty) return
      // Draw on top of the theme's picture instead of clearing it first.
      const renderer = ctx.renderer
      const autoClear = renderer.autoClear
      renderer.autoClear = false
      quad.render(renderer)
      renderer.autoClear = autoClear
    },
    dispose() {
      quad.dispose()
      texture.dispose()
    },
  }
}
