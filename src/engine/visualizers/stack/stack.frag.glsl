// "Stack": a plain background, the recorded plugin windows stacked on top of
// each other (shown unchanged), and a title above them.
// All placement is computed in TypeScript (layout.ts); this shader only
// fills the rectangles it gets.
//
// Three.js adds `#version 300 es`, precision and some #defines in front of
// this, so GLSL 1 style works: `varying`, `gl_FragColor`, `texture2D`.
// gl_FragColor is the final display (sRGB) value, see renderer.ts.

uniform vec3 uBackground;

// Up to 3 windows, top to bottom. Rect = (x0, y0, x1, y1) in output pixels,
// origin bottom-left. Only the first uSlotCount entries are used.
uniform int uSlotCount;
uniform vec4 uSlotRect[3];
uniform sampler2D uSlot0;
uniform sampler2D uSlot1;
uniform sampler2D uSlot2;

// The title, drawn by a 2D canvas (white text on transparent).
uniform sampler2D uTitle;
uniform vec4 uTitleRect;

bool inside(vec2 px, vec4 rect) {
  return px.x >= rect.x && px.x < rect.z && px.y >= rect.y && px.y < rect.w;
}

// Position of px inside rect as a texture coordinate, 0..1. Textures are
// uploaded flipped (Three.js' default flipY), so v = 1 is the top of the
// picture, the same direction as GL's y.
vec2 rectUv(vec2 px, vec4 rect) {
  return (px - rect.xy) / (rect.zw - rect.xy);
}

// The windows are usually shown smaller than they were recorded (a 2600 px
// wide Retina capture in an ~800 px column). One bilinear sample per pixel
// would skip texels and make small plugin text shimmer, so average 4 samples
// spread over the pixel (a cheap box filter).
vec3 sampleWindow(sampler2D tex, vec2 px, vec4 rect) {
  vec2 uv = rectUv(px, rect);
  vec2 d = 0.25 / (rect.zw - rect.xy); // a quarter of an output pixel in uv
  vec3 sum = texture2D(tex, uv + vec2(-d.x, -d.y)).rgb
           + texture2D(tex, uv + vec2( d.x, -d.y)).rgb
           + texture2D(tex, uv + vec2(-d.x,  d.y)).rgb
           + texture2D(tex, uv + vec2( d.x,  d.y)).rgb;
  return sum * 0.25;
}

void main() {
  vec2 px = gl_FragCoord.xy; // pixel centers at .5, origin bottom-left
  vec3 color = uBackground;

  // Rects never overlap, so at most one of these is true
  if (uSlotCount > 0 && inside(px, uSlotRect[0])) {
    color = sampleWindow(uSlot0, px, uSlotRect[0]);
  } else if (uSlotCount > 1 && inside(px, uSlotRect[1])) {
    color = sampleWindow(uSlot1, px, uSlotRect[1]);
  } else if (uSlotCount > 2 && inside(px, uSlotRect[2])) {
    color = sampleWindow(uSlot2, px, uSlotRect[2]);
  }

  // Title over everything. The canvas is drawn 1:1 (one texel per pixel).
  if (inside(px, uTitleRect)) {
    vec4 title = texture2D(uTitle, rectUv(px, uTitleRect));
    color = mix(color, title.rgb, title.a);
  }

  gl_FragColor = vec4(color, 1.0);
}
