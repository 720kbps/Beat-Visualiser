// One plugin window slot as a texture. Same approach as lcd-sampler's plugin
// texture, kept as a copy here so the two themes don't depend on each other:
// - preview: the source is a playing <video> → THREE.VideoTexture
// - export: the source is a canvas the exporter draws each frame into
//   → THREE.CanvasTexture, uploaded every frame
// colorSpace stays at the default, so the shader gets the recording's own
// sRGB values (see render/renderer.ts).
import * as THREE from 'three'
import type { VideoFrameSource } from '../types'
import type { Size } from './layout'

export type SlotTexture = {
  source: VideoFrameSource | null // the video or canvas currently in `texture`
  texture: THREE.Texture | null
  uploadedTime: number // video.currentTime of the last uploaded frame
}

export function createSlotTexture(): SlotTexture {
  return { source: null, texture: null, uploadedTime: -1 }
}

// The picture size of a source in pixels, or null while it has no picture yet.
export function sourceSize(source: VideoFrameSource): Size | null {
  if (source instanceof HTMLVideoElement) {
    // HAVE_CURRENT_DATA: there is a decoded frame to show
    if (source.readyState < source.HAVE_CURRENT_DATA) return null
    if (source.videoWidth === 0 || source.videoHeight === 0) return null
    return { width: source.videoWidth, height: source.videoHeight }
  }
  if (source.width === 0 || source.height === 0) return null
  return { width: source.width, height: source.height }
}

// Keeps the slot in step with this frame's source: a new texture when the
// source changes, and a fresh upload when its picture changed.
// Returns the picture size, or null when there's nothing to draw.
export function updateSlotTexture(
  slot: SlotTexture,
  source: VideoFrameSource | null,
): Size | null {
  if (source !== slot.source) {
    slot.texture?.dispose()
    slot.texture = source ? createTexture(source) : null
    slot.source = source
    slot.uploadedTime = -1
  }

  if (!source || !slot.texture) return null
  const size = sourceSize(source)
  if (!size) return null

  if (source instanceof HTMLCanvasElement) {
    // Export: the exporter drew the right frame just before render()
    slot.texture.needsUpdate = true
  } else if (!source.seeking && source.currentTime !== slot.uploadedTime) {
    // Preview: VideoTexture already uploads every new frame while the video
    // plays. Also upload when the time changed since the last upload (a seek
    // while paused), but not during a seek: the new frame isn't decoded yet.
    slot.texture.needsUpdate = true
    slot.uploadedTime = source.currentTime
  }
  return size
}

// Frees the texture. The video/canvas itself belongs to the caller.
export function disposeSlotTexture(slot: SlotTexture): void {
  slot.texture?.dispose()
  slot.texture = null
  slot.source = null
}

// Linear filtering, no mipmaps (they'd be rebuilt on every frame).
function createTexture(source: VideoFrameSource): THREE.Texture {
  const texture =
    source instanceof HTMLVideoElement
      ? new THREE.VideoTexture(source)
      : new THREE.CanvasTexture(source)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  return texture
}
