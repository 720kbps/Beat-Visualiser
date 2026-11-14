// Debug theme: a grid, a bar that follows the playhead, and the TikTok safe
// zone. Useful to check the renderer, sync and scaling without a real theme.
//
// Three.js adds `#version 300 es`, precision and some #defines in front of
// this, so GLSL 1 style works: `varying`, `gl_FragColor`, `texture2D`.
// gl_FragColor is the final display (sRGB) value, see renderer.ts.

uniform float uProgress;   // 0..1, playhead position
uniform vec2 uResolution;  // (1080, 1920)

varying vec2 vUv;          // 0..1, (0,0) = bottom-left

void main() {
  // Pixel coordinates. Origin is the BOTTOM-left corner (GL convention),
  // pixel centers are at .5: the bottom-left pixel is (0.5, 0.5).
  vec2 px = gl_FragCoord.xy;

  // Background gradient: dark blue at the bottom to lighter blue at the top,
  // a bit of magenta towards the right.
  vec3 color = mix(vec3(0.04, 0.08, 0.16), vec3(0.10, 0.32, 0.48), vUv.y);
  color += vec3(0.12, 0.0, 0.08) * vUv.x;

  // Grid: a 1-pixel line every 108 px (10 columns across the width).
  vec2 cell = mod(floor(px), 108.0);
  if (cell.x == 0.0 || cell.y == 0.0) {
    color = mix(color, vec3(0.55, 0.85, 1.0), 0.35);
  }

  // Moving bar: 24 px wide, at the playhead position.
  float barX = uProgress * uResolution.x;
  if (abs(px.x - barX) < 12.0) {
    color = mix(color, vec3(1.0, 0.75, 0.2), 0.8);
  }

  // TikTok UI overlays: keep text and the main screen out of the bottom 20%
  // and the right 12%. Shade that area with red diagonal stripes.
  bool overlayZone = px.y < 0.20 * uResolution.y || px.x > 0.88 * uResolution.x;
  if (overlayZone) {
    float stripe = step(mod(px.x + px.y, 32.0), 16.0);
    color = mix(color, vec3(0.9, 0.15, 0.15), 0.15 + 0.2 * stripe);
  }

  // 1-pixel white border on the outermost pixels. Note: the preview shows the
  // image at ~1/3 size, and the browser's downscale can make 1-px lines (this
  // border, the grid) faint or drop out. They're there in the 1080x1920 buffer.
  vec2 fromEdge = min(px, uResolution - px); // 0.5 for edge pixels
  if (min(fromEdge.x, fromEdge.y) < 1.0) {
    color = vec3(1.0);
  }

  gl_FragColor = vec4(color, 1.0);
}
