// "Test pattern": a debug theme, not meant for real videos. Shows a grid, a
// bar at the playhead position and the TikTok safe zone, so the renderer,
// scaling and playback sync can be checked without a real theme. No params.
import * as THREE from 'three'
import {
  createFullscreenQuad,
  FULLSCREEN_VERTEX_SHADER,
  type FullscreenQuad,
} from '../../render/fullscreen-quad'
import type { RenderContext } from '../../render/renderer'
import type { FrameData, Visualizer } from '../types'
// `?raw` is a Vite feature: it imports the file's text as a string (types
// come from vite/client), so the shader lives in a real .glsl file with
// editor highlighting instead of a JS string.
import fragmentShader from './test-pattern.frag.glsl?raw'

type GpuState = {
  ctx: RenderContext
  quad: FullscreenQuad
  uniforms: {
    uProgress: { value: number }
    uResolution: { value: THREE.Vector2 }
  }
}

let gpu: GpuState | null = null

function init(ctx: RenderContext): void {
  if (gpu) dispose()
  // Uniforms are plain objects { value }. Three.js uploads `.value` to the
  // GPU on every render, so changing it is all it takes to animate.
  const uniforms = {
    uProgress: { value: 0 },
    uResolution: { value: new THREE.Vector2(ctx.width, ctx.height) },
  }
  const material = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX_SHADER,
    fragmentShader,
    uniforms,
  })
  gpu = { ctx, quad: createFullscreenQuad(material), uniforms }
}

function render(frame: FrameData): void {
  if (!gpu) return
  gpu.uniforms.uProgress.value = frame.progress
  gpu.quad.render(gpu.ctx.renderer)
}

function dispose(): void {
  if (!gpu) return
  gpu.quad.dispose() // also disposes the material
  gpu = null
}

export const testPattern: Visualizer = {
  id: 'test-pattern',
  name: 'Test pattern',
  params: [],
  init,
  render,
  dispose,
}
