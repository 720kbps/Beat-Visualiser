// The WebGL renderer shared by the preview and the export.
//
// Resolution: the drawing buffer is ALWAYS exactly 1080×1920, whatever size
// the canvas is shown at. Preview and export must be pixel-identical
// (CLAUDE.md: "What you see is what you get"), so the shaders always run at
// output resolution and the browser only scales the finished image for
// display. The UI sets the canvas' CSS size; this file never touches it.
//
// Color convention (read this before writing a theme shader):
// Three.js is a pure pass-through here. Whatever a fragment shader writes to
// gl_FragColor is the final display value (sRGB-encoded, 0..1 = byte / 255)
// that lands on screen and in the exported MP4. No conversion anywhere:
// - ShaderMaterial only converts its output if the shader contains
//   `#include <colorspace_fragment>` (it calls linearToOutputTexel). Our shaders
//   don't include it. outputColorSpace is set to Linear anyway, so that chunk
//   (and the built-in materials) would also be a no-op if someone used them.
// - THREE.Color normally converts hex/CSS colors from sRGB to linear when you
//   create them, so `new THREE.Color('#38bdf8')` as a uniform would arrive in
//   the shader darker than the hex value. ColorManagement is turned off below,
//   so a Color uniform holds exactly the hex value / 255.
// - Textures (e.g. the recorded plugin video): leave `texture.colorSpace` at
//   its default (NoColorSpace). The shader then samples the raw sRGB values,
//   the same values the video shows. Setting it to SRGBColorSpace would make
//   the GPU decode to linear on sampling.
// Doing blending/glow math on sRGB values is not physically exact, but it's
// what the look is tuned against; a shader can still convert locally if needed.
import * as THREE from 'three'

export const OUTPUT_WIDTH = 1080
export const OUTPUT_HEIGHT = 1920

// Global Three.js switch (see the color notes above). Runs once, when this
// module is first imported, before any theme creates a THREE.Color.
THREE.ColorManagement.enabled = false

export type RenderContext = {
  renderer: THREE.WebGLRenderer
  canvas: HTMLCanvasElement
  width: number // always OUTPUT_WIDTH (drawing-buffer pixels)
  height: number // always OUTPUT_HEIGHT
}

export function createRenderContext(canvas: HTMLCanvasElement): RenderContext {
  // Three.js r163+ only uses WebGL 2 (Safari 15+, WebView2: fine).
  const renderer = new THREE.WebGLRenderer({
    canvas,
    // No MSAA: we draw one fullscreen quad, its edges are the canvas edges.
    // Shaders do their own anti-aliasing (smoothstep, fwidth).
    antialias: false,
    // false (the default): the browser may clear the drawing buffer after it
    // has shown a frame. Export reads the pixels (readPixels / VideoFrame)
    // right after render(), in the same JS task, before that can happen, so
    // it isn't needed. true costs an extra copy every frame.
    preserveDrawingBuffer: false,
  })
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace // = "no output conversion"

  // Pixel ratio 1, otherwise Three.js multiplies the size by devicePixelRatio
  // (2 on Retina) and the buffer would be 2160×3840.
  renderer.setPixelRatio(1)
  // false = only set canvas.width/height (the drawing buffer), not the CSS
  // style. The Svelte component decides how big it looks.
  renderer.setSize(OUTPUT_WIDTH, OUTPUT_HEIGHT, false)

  return { renderer, canvas, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT }
}

export function disposeRenderContext(ctx: RenderContext): void {
  // dispose() frees Three.js' GPU objects but keeps the WebGL context alive.
  ctx.renderer.dispose()
  // Release the context right away instead of waiting for garbage collection.
  // Browsers only allow a handful of live WebGL contexts (WebKit: 16), and
  // every remount of the preview (or Vite hot reload) creates a new one.
  ctx.renderer.forceContextLoss()
}

// Calls onFrame once per requestAnimationFrame until the returned stop() is called.
// rAF runs at the display refresh rate and pauses while the window is hidden.
// That's fine for the preview; export will not use this loop, it renders
// frame i at t = i / fps as fast as it can.
export function startRenderLoop(onFrame: () => void): () => void {
  let rafId = 0
  let running = true

  function tick() {
    if (!running) return
    onFrame()
    rafId = requestAnimationFrame(tick)
  }

  rafId = requestAnimationFrame(tick)

  return function stop() {
    running = false
    cancelAnimationFrame(rafId)
  }
}
