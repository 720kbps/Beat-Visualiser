// A 2×2 plane covering all of clip space (-1..1 in x and y), so a
// ShaderMaterial on it runs its fragment shader once per output pixel.
// This is the classic "fullscreen quad" from GLSL work, wrapped in the objects
// Three.js wants: renderer.render() always takes a scene and a camera.
//
// Why a plain THREE.Camera: its projection and view matrices are identity, and
// the mesh sits at the origin, so `projectionMatrix * modelViewMatrix` is the
// identity too. The plane's vertices (-1..1) therefore land exactly on the
// screen corners, whether the vertex shader is FULLSCREEN_VERTEX_SHADER below
// or Three.js' default ShaderMaterial vertex shader. No ortho camera setup.
import * as THREE from 'three'

// Use this as `vertexShader` in theme materials. `position` and `uv` are
// attributes Three.js adds to every ShaderMaterial automatically.
// vUv: (0,0) bottom-left, (1,1) top-right, same orientation as gl_FragCoord.
export const FULLSCREEN_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export type FullscreenQuad = {
  scene: THREE.Scene
  camera: THREE.Camera
  mesh: THREE.Mesh
  render(renderer: THREE.WebGLRenderer): void
  dispose(): void
}

export function createFullscreenQuad(
  material: THREE.ShaderMaterial,
): FullscreenQuad {
  const geometry = new THREE.PlaneGeometry(2, 2)
  const mesh = new THREE.Mesh(geometry, material)
  // Three.js skips meshes it thinks are outside the camera's view (using the
  // camera matrices and the geometry's bounding sphere). Our vertex shader
  // ignores those matrices, so turn the check off: always draw.
  mesh.frustumCulled = false

  const scene = new THREE.Scene()
  scene.add(mesh)
  const camera = new THREE.Camera()

  return {
    scene,
    camera,
    mesh,
    render(renderer) {
      renderer.render(scene, camera)
    },
    // Frees the plane and the material's compiled shader program. Textures in
    // the material's uniforms are NOT disposed: whoever created them owns them.
    // Calling material.dispose() again elsewhere is harmless.
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
