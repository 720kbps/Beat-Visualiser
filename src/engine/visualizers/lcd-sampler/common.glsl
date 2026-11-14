// LCD Sampler theme: a brushed-metal sampler with two blue LCD screens.
//
// The fragment shader is split into five files, glued together in this order
// by index.ts (each file only uses what the files before it define):
//   common.glsl    this file: inputs, layout, SDF / noise / shading helpers
//   metal.glsl     backdrop, brushed metal, the body and its chamfers
//   screens.glsl   the LCD effects, both screens, the acrylic display panel
//   hardware.glsl  meter, pads, buttons, knobs, grille, side column, screws
//   main.glsl      deviceFace() (places everything) and main()
//
// One fullscreen pass at 1080x1920. Everything is drawn analytically with
// signed distance functions (SDFs): d < 0 inside a shape, d > 0 outside, |d| in
// pixels. Shapes are layered back to front with mix(color, shapeColor, coverage).
//
// Three.js adds `#version 300 es`, precision and some #defines in front of the
// source, so GLSL 1 style works (`varying`, `gl_FragColor`, `texture2D`) and so
// do GLSL 3 features (`texelFetch`, const arrays). gl_FragColor is the final
// display (sRGB) value, no conversion afterwards (see render/renderer.ts).
//
// Textures: the waveform peaks (1024x1 float) and the recorded plugin video.
//
// Cost per pixel: every element first checks a bounding box and returns early,
// so a pixel only pays for the one or two elements it's in. 2 M pixels per
// frame. The most expensive pixels are on the main screen with a video:
// 12 video samples (4 for the pixel itself, 8 for the glow). Next is the
// waveform screen (9 texel fetches + a few SDFs) and the acrylic and gaskets
// near a screen (up to 4 video samples each for the light they get from it).
// Every body pixel pays for the brushed metal (3 value noises) and ~4
// rounded-rect SDFs (body, side wall, shadows).
//
// Preview note: the preview shows this image at ~31% without prefiltering, so
// lines and periodic detail are kept at >= 3-4 px (and the LCD pixel grid and
// scanlines at a 6 px period); thinner detail would shimmer or moire in the
// preview only.

// ---------- Inputs ----------

uniform vec2 uResolution;  // (1080, 1920)
uniform float uTime;       // seconds into the clip
uniform float uProgress;   // 0..1, playhead position
uniform float uRms;        // loudness 0..1
uniform float uBass;       // low-frequency energy 0..1

// Waveform of the whole clip: 1 row, one texel per column, R = min, G = max
// (-1..1). Float texture with NEAREST filtering, read with texelFetch.
uniform sampler2D uPeaks;
uniform float uPeakColumns; // width of uPeaks in texels (1024)

// The recorded plugin window (a THREE.VideoTexture, raw sRGB values, linear
// filtering, flipY so uv (0,0) = bottom-left of the video). Only valid when
// uHasPlugin is 1.
uniform sampler2D uPlugin;
uniform vec2 uPluginSize;  // video size in pixels, e.g. (1600, 1000)
uniform float uHasPlugin;  // 1 = show the video on the main screen
uniform float uPluginCropTop; // video pixels to cut off the top (title bar), 0 = none

// Theme params (see index.ts)
uniform vec3 uScreenColor; // LCD tint
uniform float uGlow;       // 0..1, glow around bright LCD content
uniform float uScanlines;  // 0..1, strength of the LCD pixel grid / scanlines
uniform float uLightLeak;  // 0..1, backlight leaking in at the screen edges
uniform float uMetalTone;  // 0.2 = dark metal, 1 = light metal

varying vec2 vUv; // 0..1, (0,0) = bottom-left

// ---------- Layout ----------
// Output pixels, origin at the BOTTOM-left, y up. Rects are vec4(x0, y0, x1, y1).
// TikTok safe zone: the screens stay inside x 60..900, y 420..1860 (out of the
// bottom 20% and the right 12%). The metal body and the decoration (knobs,
// pads, vents) may go anywhere.

// The device: an aluminium body with a polished chamfer (RIM) around the face
// and BODY_DEPTH px of side wall visible below it, so it reads as a thick object.
const vec4 BODY = vec4(18.0, 46.0, 1062.0, 1900.0);
const float BODY_RADIUS = 56.0;
const float BODY_DEPTH = 14.0;
const float RIM = 12.0;

// Below this line the face is a separate, dark anodized plate (knobs, speaker).
// It also keeps TikTok's white caption text readable.
const float LOWER_PLATE_Y = 410.0;

// The display window: one smoked-acrylic panel set into the metal with a
// chamfered edge. It holds both LCDs and, between them, a status strip.
const vec4 DISPLAY = vec4(52.0, 938.0, 908.0, 1832.0);
const float DISPLAY_RADIUS = 30.0;
const float DISPLAY_CHAMFER = 9.0;
const float STATUS_Y = 1253.0; // center line of the strip between the screens

const vec4 MAIN_GLASS = vec4(72.0, 1290.0, 888.0, 1800.0); // 816 x 510 = 16:10
const vec4 WAVE_GLASS = vec4(72.0, 980.0, 888.0, 1216.0);  // 816 x 236
const float BEZEL = 10.0;        // matte black gasket around each glass
const float BEZEL_RADIUS = 18.0;
const float GLASS_RADIUS = 10.0;

const vec4 METER_SLOT = vec4(60.0, 850.0, 790.0, 904.0);
const float METER_SEGMENTS = 24.0;
const vec2 BASS_LED = vec2(850.0, 877.0);

const float PAD_Y0 = 600.0;
const float PAD_Y1 = 810.0;
const float PAD_X0 = 72.0;  // left edge of the first pad
const float PAD_W = 180.0;
const float PAD_PITCH = 212.0; // width + gap
const float PAD_RADIUS = 24.0;
const vec3 PAD_RED = vec3(0.88, 0.24, 0.16);
const vec3 PAD_ORANGE = vec3(0.95, 0.5, 0.14);
const vec3 PAD_YELLOW = vec3(0.95, 0.76, 0.2);
const vec3 PAD_TEAL = vec3(0.16, 0.62, 0.6);

const float BUTTON_Y0 = 456.0;
const float BUTTON_Y1 = 540.0;
const float BUTTON_W = 144.0;
const float BUTTON_PITCH = 168.0;

const float KNOB_Y = 236.0;
const float KNOB_RADIUS = 66.0;
const vec2 GRILLE = vec2(790.0, 236.0);
const float GRILLE_RADIUS = 128.0;

const float SIDE_X = 985.0;         // center of the right-hand column (vents, fader)
const float SIDE_DIVIDER_X = 932.0; // engraved line left of that column

// Light comes from the top left (normalized direction towards the light).
const vec2 LIGHT = vec2(-0.41, 0.91);
// The same light in 3D for shapes with a height profile (pads, buttons):
// tilted ~47 degrees towards the viewer. z = out of the screen.
const vec3 LIGHT3 = vec3(-0.30, 0.665, 0.684);
// Half vector between LIGHT3 and the viewer (0, 0, 1), for specular highlights.
const vec3 HALF3 = vec3(-0.163, 0.362, 0.918);

const float SCANLINE_PERIOD = 6.0; // px; >= 6 so the ~31% preview doesn't moire

const vec3 LED_GREEN = vec3(0.35, 1.0, 0.45);
const vec3 LED_AMBER = vec3(1.0, 0.72, 0.18);
const vec3 LED_RED = vec3(1.0, 0.22, 0.14);

// ---------- Helpers ----------

// SDF of a rounded rectangle.
float sdRoundRect(vec2 p, vec4 rect, float r) {
  vec2 center = 0.5 * (rect.xy + rect.zw);
  vec2 halfSize = 0.5 * (rect.zw - rect.xy);
  vec2 q = abs(p - center) - halfSize + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Outward normal of a rounded rectangle at p (the gradient of sdRoundRect).
vec2 roundRectNormal(vec2 p, vec4 rect, float r) {
  vec2 center = 0.5 * (rect.xy + rect.zw);
  vec2 halfSize = 0.5 * (rect.zw - rect.xy);
  vec2 s = sign(p - center);
  vec2 q = abs(p - center) - halfSize + r;
  if (q.x > 0.0 && q.y > 0.0) return s * normalize(q); // on a corner arc
  return q.x > q.y ? vec2(s.x, 0.0) : vec2(0.0, s.y);
}

// SDF of a vertical capsule from (x, y0) to (x, y1) with radius r.
float sdCapsuleV(vec2 p, float x, float y0, float y1, float r) {
  vec2 closest = vec2(x, clamp(p.y, y0, y1));
  return length(p - closest) - r;
}

// SDF of an equilateral triangle pointing up, "radius" r (Inigo Quilez).
float sdTriangle(vec2 p, float r) {
  const float k = 1.7320508; // sqrt(3)
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

// Anti-aliased coverage of an SDF: 1 inside, 0 outside, ~1.5 px soft edge.
float fill(float d) {
  return 1.0 - smoothstep(-0.75, 0.75, d);
}

// Hash and value noise (Dave Hoskins' hash12). Static: only depends on position.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Shading of a raised edge (body, pads, buttons): bright where the edge faces
// the light, dark where it faces away. d = shape SDF (inside < 0), n = outward
// normal, width = how far in the bevel goes. Returns -1..1, 0 away from the edge.
float bevelShade(float d, vec2 n, float width) {
  float edge = 1.0 - smoothstep(0.0, width, -d);
  return dot(n, LIGHT) * edge;
}

// The opposite: the wall of a hole cut into the surface (screens, slots). The
// top wall is in shadow, the bottom wall catches the light.
float insetShade(float d, vec2 n, float width) {
  return -bevelShade(d, n, width);
}

// Distance from p to a grid line, for lines every `spacing` px through 0.
// Returns line coverage 0..1 for a line `width` px wide.
float gridLine(float coord, float spacing, float width) {
  float d = abs(mod(coord + 0.5 * spacing, spacing) - 0.5 * spacing);
  return 1.0 - smoothstep(0.5 * width - 0.75, 0.5 * width + 0.75, d);
}

// 3D surface normal of a raised shape with rounded ("pillow") edges, for real
// lighting instead of the flat bevelShade. d = shape SDF, n = outward 2D
// normal, edgeWidth = how far in the rounding goes, steepness = slope at the
// very edge (1 = 45 degrees). The top is flat: normal (0, 0, 1).
vec3 pillowNormal(float d, vec2 n, float edgeWidth, float steepness) {
  float t = clamp(-d / edgeWidth, 0.0, 1.0); // 0 at the edge, 1 where the top starts
  float slope = steepness * (1.0 - t) * (1.0 - t);
  return normalize(vec3(n * slope, 1.0));
}

// Soft drop shadow: 1 = unshadowed. dShifted = SDF of the casting shape moved
// by the shadow offset (away from the light), blur = softness in px.
float softShadow(float dShifted, float blur, float strength) {
  return 1.0 - strength * (1.0 - smoothstep(-0.3 * blur, blur, dShifted));
}

// Distance to the line segment a-b.
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * t);
}

// Seven-segment digit, 18 x 30 px between segment centers, slanted like an LED
// display. p = position relative to the digit's center. Returns
// (distance to the lit segments, distance to all segments) so unlit segments
// can be drawn as faint "ghosts". Segments are bits 0..6 = a..g:
//    aaa
//   f   b
//    ggg
//   e   c
//    ddd
const int SEGMENT_MASKS[10] = int[10](0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F);

vec2 sevenSegment(vec2 p, int digit) {
  p.x -= 0.12 * p.y; // slant
  const float w = 9.0;  // half width
  const float h = 15.0; // half height
  const float g = 3.0;  // gap at the joints
  int mask = SEGMENT_MASKS[digit];
  float dLit = 1e5;
  float dAll = 1e5;
  for (int i = 0; i < 7; i++) {
    vec2 a;
    vec2 b;
    if (i == 0) { a = vec2(-w + g, h); b = vec2(w - g, h); }        // a
    else if (i == 1) { a = vec2(w, h - g); b = vec2(w, g); }        // b
    else if (i == 2) { a = vec2(w, -g); b = vec2(w, -h + g); }      // c
    else if (i == 3) { a = vec2(-w + g, -h); b = vec2(w - g, -h); } // d
    else if (i == 4) { a = vec2(-w, -g); b = vec2(-w, -h + g); }    // e
    else if (i == 5) { a = vec2(-w, h - g); b = vec2(-w, g); }      // f
    else { a = vec2(-w + g, 0.0); b = vec2(w - g, 0.0); }           // g
    float d = sdSegment(p, a, b);
    dAll = min(dAll, d);
    if (((mask >> i) & 1) == 1) dLit = min(dLit, d);
  }
  return vec2(dLit, dAll);
}
