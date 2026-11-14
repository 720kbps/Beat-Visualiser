// LCD Sampler theme: a brushed-metal sampler with two blue LCD screens.
//
// One fullscreen pass at 1080x1920. Everything is drawn analytically with
// signed distance functions (SDFs): d < 0 inside a shape, d > 0 outside, |d| in
// pixels. Shapes are layered back to front with mix(color, shapeColor, coverage).
//
// Three.js adds `#version 300 es`, precision and some #defines in front of this
// file, so GLSL 1 style works (`varying`, `gl_FragColor`, `texture2D`) and so do
// GLSL 3 features (`texelFetch`, const arrays). gl_FragColor is the final display
// (sRGB) value, no conversion afterwards (see render/renderer.ts).
//
// Cost per pixel: every element first checks a bounding box and returns early,
// so a pixel only pays for the one or two elements it's in. The most expensive
// pixels are in the waveform screen (9 texel fetches + a few SDFs). 2 M pixels
// per frame, no loops apart from that 9-tap waveform search, no textures besides
// the 1024x1 peaks texture.
//
// Preview note: the preview shows this image at ~31% without prefiltering, so
// lines and periodic detail are kept at >= 3-4 px (and scanlines at a 6 px
// period); thinner detail would shimmer or moire in the preview only.

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

// 1 when a recorded plugin video is available (not wired up yet, always 0).
uniform float uHasPlugin;

// Theme params (see index.ts)
uniform vec3 uScreenColor; // LCD tint
uniform float uGlow;       // 0..1
uniform float uScanlines;  // 0..1
uniform float uMetalTone;  // 0 = dark metal, 1 = light metal
uniform float uGrid;       // 1 = grid on, 0 = off

varying vec2 vUv; // 0..1, (0,0) = bottom-left

// ---------- Layout ----------
// Output pixels, origin at the BOTTOM-left, y up. Rects are vec4(x0, y0, x1, y1).
// TikTok safe zone: the screens stay inside x 60..900, y 420..1860 (out of the
// bottom 20% and the right 12%). The metal body and the decoration (knobs,
// pads, vents) may go anywhere.

const vec4 BODY = vec4(24.0, 52.0, 1056.0, 1896.0);
const float BODY_RADIUS = 56.0;

const vec4 MAIN_GLASS = vec4(72.0, 1290.0, 888.0, 1800.0); // 816 x 510 = 16:10
const vec4 WAVE_GLASS = vec4(72.0, 980.0, 888.0, 1216.0);  // 816 x 236
const float BEZEL = 22.0;        // dark plastic frame around each glass
const float BEZEL_RADIUS = 20.0;
const float GLASS_RADIUS = 10.0;

const vec4 METER_SLOT = vec4(60.0, 866.0, 790.0, 934.0);
const float METER_SEGMENTS = 24.0;
const vec2 BASS_LED = vec2(848.0, 900.0);

const float PAD_Y0 = 600.0;
const float PAD_Y1 = 810.0;
const float PAD_X0 = 72.0;  // left edge of the first pad
const float PAD_W = 180.0;
const float PAD_PITCH = 212.0; // width + gap

const float BUTTON_Y0 = 456.0;
const float BUTTON_Y1 = 540.0;
const float BUTTON_W = 144.0;
const float BUTTON_PITCH = 168.0;

const float KNOB_Y = 236.0;
const float KNOB_RADIUS = 66.0;
const vec2 GRILLE = vec2(790.0, 236.0);
const float GRILLE_RADIUS = 128.0;

const float SIDE_X = 983.0; // center of the right-hand column (vents, fader)

// Light comes from the top left (normalized direction towards the light).
const vec2 LIGHT = vec2(-0.41, 0.91);

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

// ---------- Background and metal ----------

vec3 background(vec2 px) {
  vec3 c = mix(vec3(0.03, 0.035, 0.045), vec3(0.07, 0.08, 0.1), vUv.y);
  return c;
}

// Brushed aluminium: streaks of noise stretched along x (long and thin), a soft
// vertical sheen band, and a gentle top-to-bottom gradient.
vec3 brushedMetal(vec2 px) {
  float streaks = 0.6 * valueNoise(vec2(px.x / 260.0, px.y / 3.0))
                + 0.4 * valueNoise(vec2(px.x / 70.0 + 31.0, px.y / 1.6));
  float base = mix(0.3, 0.74, uMetalTone);
  float v = base + (streaks - 0.5) * 0.07;
  v += (px.y / uResolution.y - 0.5) * 0.08;                 // lighter at the top
  v += 0.07 * exp(-pow((px.x - 330.0) / 230.0, 2.0));        // sheen band
  v -= 0.04 * exp(-pow((px.x - 820.0) / 160.0, 2.0));        // darker band
  return vec3(v) * vec3(0.97, 0.99, 1.03); // slightly cool
}

// Engraved line: a dark groove with a lit lower lip.
void groove(inout vec3 col, float distAcross, float along, float from, float to) {
  if (along < from || along > to) return;
  float dark = 1.0 - smoothstep(1.0, 2.0, abs(distAcross));
  float lip = 1.0 - smoothstep(0.8, 1.6, abs(distAcross + 2.6));
  col *= 1.0 - 0.45 * dark;
  col += 0.07 * lip;
}

// ---------- LCD screens ----------

// Dark backlight of an LCD, brighter in the middle.
vec3 lcdBase(vec2 local, vec2 size) {
  vec2 q = local / size - 0.5;
  float falloff = 1.0 - 0.9 * dot(q, q);
  return (uScreenColor * 0.17 + vec3(0.004, 0.008, 0.016)) * falloff;
}

// Scanlines, vignette and a faint glass reflection, applied on top of the content.
vec3 lcdFinish(vec3 c, vec2 local, vec2 size) {
  // Scanlines: a smooth (cosine) dip every SCANLINE_PERIOD px
  float dip = 0.5 - 0.5 * cos(6.2831853 * local.y / SCANLINE_PERIOD);
  c *= 1.0 - uScanlines * 0.5 * dip;

  // Vignette towards the corners
  vec2 q = local / size - 0.5;
  c *= 1.0 - 0.6 * pow(dot(q, q) * 2.0, 2.0);

  // Glass reflection: a soft diagonal sheen across the top-left
  float diag = (1.0 - local.x / size.x) * 0.45 + local.y / size.y;
  c += vec3(0.75, 0.85, 1.0) * 0.045 * smoothstep(0.75, 1.25, diag);
  return c;
}

// Main screen content. Later this shows the recorded plugin window; until then
// an idle dot-matrix pattern whose ripples pulse with the loudness.
vec3 mainScreenContent(vec2 local, vec2 size) {
  vec3 tint = uScreenColor;
  vec3 c = lcdBase(local, size);

  if (uHasPlugin > 0.5) {
    // TODO(plugin video): sample the recorded plugin window here, e.g.
    //   uniform sampler2D uPlugin;            (a THREE.VideoTexture)
    //   vec2 uv = local / size;               (fit/letterbox to the video aspect)
    //   vec3 video = texture2D(uPlugin, uv).rgb;
    //   c = mix(video, video * (0.6 + 0.6 * tint), 0.25); (light LCD tint)
    //   return c;
  }

  // Grid: 16 x 10 cells of 51 px
  if (uGrid > 0.5) {
    float minor = max(gridLine(local.x, 51.0, 3.0), gridLine(local.y, 51.0, 3.0));
    c += tint * 0.08 * minor;
  }

  // Dot matrix, one dot every 25.5 px (2 per grid cell). Each dot's brightness
  // is a ring ripple moving outward from the center, scaled by the loudness.
  const float pitch = 25.5;
  vec2 cell = floor(local / pitch);
  vec2 dotCenter = (cell + 0.5) * pitch;
  float dotMask = 1.0 - smoothstep(3.2, 4.8, length(local - dotCenter));
  float r = length(dotCenter - 0.5 * size);
  float ripple = 0.5 + 0.5 * cos(r * 0.028 - uTime * 4.0);
  float fade = 1.0 - 0.7 * smoothstep(0.0, 0.55 * size.x, r);
  float level = 0.07 + uRms * (0.12 + 0.75 * ripple) * fade;
  c += mix(tint, vec3(1.0), 0.25) * dotMask * level;

  // Viewfinder corners: "a window goes here"
  vec2 fromEdge = min(local, size - local) - 36.0; // distance inside the bracket frame
  float nearest = min(fromEdge.x, fromEdge.y);
  float bracket = step(0.0, nearest) * step(nearest, 4.0) * step(max(fromEdge.x, fromEdge.y), 56.0);
  c = mix(c, mix(tint, vec3(1.0), 0.35), bracket * 0.7);

  // Center crosshair
  vec2 m = abs(local - 0.5 * size);
  float cross = step(m.x, 2.0) * step(m.y, 22.0) + step(m.y, 2.0) * step(m.x, 22.0);
  c = mix(c, mix(tint, vec3(1.0), 0.35), min(cross, 1.0) * 0.5);
  return c;
}

// Offsets (in waveform columns) of the 9 taps around a pixel: dense near the
// pixel so the waveform itself is exact, sparser further out for the glow.
const int TAPS[9] = int[9](-8, -5, -3, -1, 0, 1, 3, 5, 8);

// Waveform screen content: grid, mirrored min/max waveform, playhead.
vec3 waveScreenContent(vec2 local, vec2 size) {
  vec3 tint = uScreenColor;
  vec3 bright = mix(tint, vec3(1.0), 0.55);
  float centerY = 0.5 * size.y;
  float playX = uProgress * size.x;
  bool played = local.x < playX;

  vec3 c = lcdBase(local, size);
  if (played) c += tint * 0.035;

  // Grid: minor lines every 34 px (from the center line out), major lines
  // every 136 px across and the center line.
  // TODO(Phase 4): put the vertical lines on the bars once beats are known.
  if (uGrid > 0.5) {
    vec2 g = vec2(local.x, local.y - centerY);
    float minor = max(gridLine(g.x, 34.0, 3.0), gridLine(g.y, 34.0, 3.0));
    float major = max(gridLine(g.x, 136.0, 3.0), 1.0 - smoothstep(1.0, 2.5, abs(g.y)));
    c += tint * (0.06 * minor + 0.12 * major);
  }

  // Waveform as a distance field: for each tap, the distance from this pixel
  // to that column's [min, max] bar; keep the smallest. Distance 0 = on the
  // waveform, > 0 gives the glow. The "core" is the same bar at 45% height.
  float pxPerColumn = size.x / uPeakColumns;
  float amplitude = 0.42 * size.y;
  int lastColumn = int(uPeakColumns) - 1;
  int column = int(floor(local.x / pxPerColumn));
  float y = local.y - centerY;
  float dWave = 1e5;
  float dCore = 1e5;
  for (int i = 0; i < 9; i++) {
    int tap = clamp(column + TAPS[i], 0, lastColumn);
    vec2 minMax = texelFetch(uPeaks, ivec2(tap, 0), 0).rg;
    float columnX = (float(tap) + 0.5) * pxPerColumn;
    float dx = max(abs(local.x - columnX) - 0.5 * pxPerColumn, 0.0);
    // At least 3 px tall, so silence still shows as a line
    float lo = min(minMax.r * amplitude, -1.5);
    float hi = max(minMax.g * amplitude, 1.5);
    float dy = max(max(lo - y, y - hi), 0.0);
    float dyCore = max(max(0.45 * lo - y, y - 0.45 * hi), 0.0);
    dWave = min(dWave, length(vec2(dx, dy)));
    dCore = min(dCore, length(vec2(dx, dyCore)));
  }

  float glowWidth = 3.0 + 12.0 * uGlow;
  c += tint * exp(-dWave / glowWidth) * uGlow * (played ? 0.55 : 0.22);
  vec3 waveColor = played ? mix(tint, vec3(1.0), 0.3) : tint * 0.55;
  vec3 coreColor = played ? mix(tint, vec3(1.0), 0.75) : tint * 0.8;
  c = mix(c, waveColor, fill(dWave - 0.5));
  c = mix(c, coreColor, fill(dCore - 0.5));

  // Playhead: a 4 px line with a glow, and a small triangle at the top and bottom
  vec3 headColor = vec3(0.88, 0.96, 1.0);
  float dHead = abs(local.x - playX);
  c += bright * exp(-dHead / (5.0 + 16.0 * uGlow)) * (0.12 + 0.4 * uGlow);
  c = mix(c, headColor, fill(dHead - 2.0));
  float triTop = (local.y - (size.y - 20.0)) * 0.65 - dHead;
  float triBottom = (20.0 - local.y) * 0.65 - dHead;
  c = mix(c, headColor, smoothstep(-0.8, 0.8, max(triTop, triBottom)));
  return c;
}

// A screen: dark bezel recessed into the metal, glass with an inner shadow, and
// the LCD content. isMain picks which content.
void drawScreen(inout vec3 col, vec2 px, vec4 glass, bool isMain) {
  vec4 bezelRect = glass + vec4(-BEZEL, -BEZEL, BEZEL, BEZEL);
  float dBezel = sdRoundRect(px, bezelRect, BEZEL_RADIUS);
  if (dBezel > 1.0) return;

  // Bezel: dark plastic, slightly lighter at the top, with lit/shadowed walls
  float t = (px.y - bezelRect.y) / (bezelRect.w - bezelRect.y);
  vec3 bezel = vec3(0.06, 0.065, 0.075) * (0.8 + 0.4 * t);
  bezel += 0.16 * insetShade(dBezel, roundRectNormal(px, bezelRect, BEZEL_RADIUS), 7.0);

  // Glass
  float dGlass = sdRoundRect(px, glass, GLASS_RADIUS);
  if (dGlass < 1.0) {
    vec2 local = px - glass.xy;
    vec2 size = glass.zw - glass.xy;
    vec3 lcd = isMain ? mainScreenContent(local, size) : waveScreenContent(local, size);
    lcd = lcdFinish(lcd, local, size);
    // Inner shadow from the bezel lip, mostly along the top edge
    vec2 n = roundRectNormal(px, glass, GLASS_RADIUS);
    float wall = 1.0 - smoothstep(0.0, 16.0, -dGlass);
    lcd *= 1.0 - 0.7 * wall * clamp(0.35 + dot(n, LIGHT), 0.0, 1.0);
    // Thin lit lip along the bottom edge
    lcd += 0.06 * (1.0 - smoothstep(0.0, 2.5, -dGlass)) * max(-dot(n, LIGHT), 0.0);
    bezel = mix(bezel, lcd, fill(dGlass));
  }

  col = mix(col, bezel, fill(dBezel));
}

// ---------- Hardware details ----------

// Level meter: a slot with LED segments (green, amber, red) lit by the loudness,
// and next to it a round LED that flashes with the bass.
void drawMeter(inout vec3 col, vec2 px) {
  float dSlot = sdRoundRect(px, METER_SLOT, 12.0);
  if (dSlot < 1.0) {
    vec3 slot = vec3(0.035, 0.04, 0.045);
    slot += 0.18 * insetShade(dSlot, roundRectNormal(px, METER_SLOT, 12.0), 6.0);

    float x0 = METER_SLOT.x + 16.0;
    float pitch = (METER_SLOT.z - 16.0 - x0) / METER_SEGMENTS;
    float i = clamp(floor((px.x - x0) / pitch), 0.0, METER_SEGMENTS - 1.0);
    vec2 segCenter = vec2(x0 + (i + 0.5) * pitch, 0.5 * (METER_SLOT.y + METER_SLOT.w));
    vec2 segHalf = vec2(0.5 * pitch - 4.0, 17.0);
    float dSeg = sdRoundRect(px, vec4(segCenter - segHalf, segCenter + segHalf), 3.0);

    float t = (i + 0.5) / METER_SEGMENTS;
    vec3 led = t < 0.66 ? LED_GREEN : (t < 0.86 ? LED_AMBER : LED_RED);
    // 0..1; the topmost lit segment fades in smoothly instead of popping
    float lit = clamp(uRms * METER_SEGMENTS - i, 0.0, 1.0);
    slot += led * exp(-max(dSeg, 0.0) / 5.0) * lit * 0.35; // halo
    vec3 seg = led * mix(0.12, 1.0, lit);
    seg += 0.12 * lit * (1.0 - smoothstep(0.0, 6.0, (segCenter.y + segHalf.y) - px.y)); // top shine
    slot = mix(slot, seg, fill(dSeg));
    col = mix(col, slot, fill(dSlot));
  }

  // Bass LED: chrome ring, red lens, glow spilling onto the metal
  vec2 p = px - BASS_LED;
  float r = length(p);
  if (r < 90.0) {
    float flash = smoothstep(0.3, 1.0, uBass);
    col += LED_RED * exp(-max(r - 18.0, 0.0) / 18.0) * flash * 0.6;
    vec3 ring = vec3(0.7) + 0.3 * bevelShade(r - 27.0, p / max(r, 1e-3), 8.0);
    col = mix(col, ring, fill(r - 27.0));
    vec3 lens = mix(LED_RED * 0.18, mix(LED_RED, vec3(1.0, 0.85, 0.75), 0.35 * flash), flash);
    lens += 0.25 * (1.0 - smoothstep(0.0, 6.0, length(p - vec2(-6.0, 7.0)))); // specular dot
    col = mix(col, lens, fill(r - 18.0));
  }
}

// A chunky square pad sitting in a well. glowAmount 0..1 lights it from inside.
void drawPad(inout vec3 col, vec2 px, vec4 rect, vec3 color, float glowAmount) {
  vec4 well = rect + vec4(-8.0, -8.0, 8.0, 8.0);
  float dWell = sdRoundRect(px, well, 26.0);
  if (dWell > 1.0) return;

  vec3 c = vec3(0.03);
  c += 0.12 * insetShade(dWell, roundRectNormal(px, well, 26.0), 5.0);
  // Pad's shadow on the well floor (light from the top left)
  float dShadow = sdRoundRect(px - vec2(4.0, -6.0), rect, 20.0);
  c *= 0.5 + 0.5 * smoothstep(-2.0, 8.0, dShadow);

  float dPad = sdRoundRect(px, rect, 20.0);
  float t = (px.y - rect.y) / (rect.w - rect.y);
  vec3 face = color * (0.78 + 0.3 * t);
  face *= 0.97 + 0.06 * valueNoise(px / 3.0); // rubber grain
  face += 0.2 * bevelShade(dPad, roundRectNormal(px, rect, 20.0), 18.0);
  face += color * glowAmount * 0.5;
  c = mix(c, face, fill(dPad));
  col = mix(col, c, fill(dWell));
}

// Transport button with a symbol. kind: 0 rewind, 1 fast forward, 2 stop, 3 play, 4 record.
void drawButton(inout vec3 col, vec2 px, vec4 rect, int kind) {
  vec4 well = rect + vec4(-6.0, -6.0, 6.0, 6.0);
  float dWell = sdRoundRect(px, well, 20.0);
  if (dWell > 1.0) return;

  vec3 c = vec3(0.03);
  c += 0.12 * insetShade(dWell, roundRectNormal(px, well, 20.0), 4.0);
  float dShadow = sdRoundRect(px - vec2(3.0, -5.0), rect, 15.0);
  c *= 0.5 + 0.5 * smoothstep(-2.0, 6.0, dShadow);

  float dButton = sdRoundRect(px, rect, 15.0);
  float t = (px.y - rect.y) / (rect.w - rect.y);
  vec3 face = vec3(0.16, 0.17, 0.19) * (0.8 + 0.35 * t);
  face += 0.2 * bevelShade(dButton, roundRectNormal(px, rect, 15.0), 12.0);

  // Symbol, centered on the button
  vec2 p = px - 0.5 * (rect.xy + rect.zw);
  float dSym = 1e5;
  vec3 symColor = vec3(0.78, 0.8, 0.82);
  if (kind == 0) {
    dSym = min(sdTriangle(vec2(p.y, -(p.x + 9.0)), 12.0), sdTriangle(vec2(p.y, -(p.x - 11.0)), 12.0));
  } else if (kind == 1) {
    dSym = min(sdTriangle(vec2(p.y, p.x + 11.0), 12.0), sdTriangle(vec2(p.y, p.x - 9.0), 12.0));
  } else if (kind == 2) {
    dSym = sdRoundRect(p, vec4(-12.0, -12.0, 12.0, 12.0), 2.0);
  } else if (kind == 3) {
    dSym = sdTriangle(vec2(p.y, p.x + 3.0), 14.0);
    symColor = LED_GREEN * 0.85;
  } else {
    dSym = length(p) - 13.0;
    symColor = LED_RED * 0.95;
  }
  face = mix(face, symColor, fill(dSym));

  c = mix(c, face, fill(dButton));
  col = mix(col, c, fill(dWell));
}

// Knob with a dark knurled skirt, a colored cap, an indicator line, and tick
// marks printed on the panel. angle: radians, 0 = pointing up, clockwise.
void drawKnob(inout vec3 col, vec2 px, vec2 center, float angle, vec3 color) {
  vec2 p = px - center;
  float r = length(p);
  if (r > 100.0) return;
  float a = atan(p.x, p.y); // 0 = up, clockwise positive

  // 11 ticks from -135 to +135 degrees
  if (r > 80.0 && r < 94.0) {
    float tickStep = 4.712389 / 10.0; // 270 degrees / 10 gaps
    float idx = clamp(floor((a + 2.356194) / tickStep + 0.5), 0.0, 10.0);
    float tickAngle = -2.356194 + idx * tickStep;
    float tick = 1.0 - smoothstep(1.2, 2.4, abs(a - tickAngle) * r);
    col = mix(col, vec3(0.1), tick * 0.85);
  }

  // Drop shadow on the panel
  float dShadow = length(p - vec2(7.0, -11.0)) - KNOB_RADIUS;
  col *= 1.0 - 0.5 * (1.0 - smoothstep(-6.0, 22.0, dShadow));

  vec2 n = p / max(r, 1e-3);
  // Skirt: dark plastic with ridges around the edge (~7 px apart)
  float ridge = 0.5 + 0.5 * cos(a * 60.0);
  vec3 skirt = vec3(0.07, 0.075, 0.08) + 0.04 * ridge;
  skirt += 0.22 * bevelShade(r - KNOB_RADIUS, n, 10.0);
  col = mix(col, skirt, fill(r - KNOB_RADIUS));

  // Cap: colored plastic with a conic sheen (lighter on the lit side)
  float capRadius = 50.0;
  float sheen = 0.5 + 0.5 * cos(2.0 * (a + 0.42));
  vec3 cap = color * (0.72 + 0.35 * sheen * sheen);
  cap += 0.18 * bevelShade(r - capRadius, n, 7.0);
  col = mix(col, cap, fill(r - capRadius));

  // Indicator line from r = 14 to 42
  vec2 dir = vec2(sin(angle), cos(angle));
  float along = clamp(dot(p, dir), 14.0, 42.0);
  float dLine = length(p - dir * along) - 3.0;
  col = mix(col, vec3(0.95), fill(dLine));
}

// Round speaker grille: a hex grid of holes inside a circle.
void drawGrille(inout vec3 col, vec2 px) {
  vec2 p = px - GRILLE;
  if (length(p) > GRILLE_RADIUS + 10.0) return;
  const float pitch = 22.0;
  const float rowStep = 19.05; // pitch * sqrt(3) / 2
  float row = floor(p.y / rowStep + 0.5);
  float offset = mod(row, 2.0) * 0.5 * pitch;
  float column = floor((p.x - offset) / pitch + 0.5);
  vec2 hole = vec2(column * pitch + offset, row * rowStep);
  if (length(hole) > GRILLE_RADIUS - 8.0) return;
  vec2 q = p - hole;
  float d = length(q) - 6.5;
  vec3 c = vec3(0.02) + 0.25 * insetShade(d, q / max(length(q), 1e-3), 3.0);
  col = mix(col, c, fill(d));
}

// Right-hand column: three vent slots, a power LED, and a vertical fader.
void drawSideColumn(inout vec3 col, vec2 px) {
  if (px.x < 925.0) return;

  // Vent slots
  for (int i = 0; i < 3; i++) {
    float x = SIDE_X + float(i - 1) * 27.0;
    float d = sdCapsuleV(px, x, 1030.0, 1720.0, 6.0);
    if (d < 1.0) {
      vec2 closest = vec2(x, clamp(px.y, 1030.0, 1720.0));
      vec2 n = normalize(px - closest + vec2(1e-3, 0.0));
      vec3 c = vec3(0.025) + 0.3 * insetShade(d, n, 4.0);
      col = mix(col, c, fill(d));
    }
  }

  // Power LED (always on)
  float dLed = length(px - vec2(SIDE_X, 1790.0));
  col += LED_GREEN * exp(-max(dLed - 8.0, 0.0) / 10.0) * 0.2;
  col = mix(col, vec3(0.65), fill(dLed - 13.0));
  col = mix(col, mix(LED_GREEN, vec3(1.0), 0.3), fill(dLed - 8.0));

  // Fader: track slot, tick marks, cap
  const float trackY0 = 480.0;
  const float trackY1 = 890.0;
  float dTrack = sdCapsuleV(px, SIDE_X, trackY0, trackY1, 6.0);
  float tick = gridLine(px.y - trackY0, 41.0, 3.0) * step(abs(px.x - (SIDE_X - 34.0)), 9.0)
             * step(trackY0 - 2.0, px.y) * step(px.y, trackY1 + 2.0);
  col = mix(col, vec3(0.12), tick * 0.8);
  if (dTrack < 1.0) {
    vec2 n = normalize(px - vec2(SIDE_X, clamp(px.y, trackY0, trackY1)) + vec2(1e-3, 0.0));
    col = mix(col, vec3(0.02) + 0.3 * insetShade(dTrack, n, 4.0), fill(dTrack));
  }
  vec4 cap = vec4(SIDE_X - 36.0, 742.0, SIDE_X + 36.0, 782.0);
  float dCapShadow = sdRoundRect(px - vec2(5.0, -8.0), cap, 8.0);
  col *= 1.0 - 0.45 * (1.0 - smoothstep(-3.0, 12.0, dCapShadow));
  float dCap = sdRoundRect(px, cap, 8.0);
  if (dCap < 1.0) {
    vec3 c = vec3(0.13, 0.135, 0.15);
    c += 0.25 * bevelShade(dCap, roundRectNormal(px, cap, 8.0), 9.0);
    c = mix(c, vec3(0.92), 1.0 - smoothstep(1.2, 2.4, abs(px.y - 762.0)));
    col = mix(col, c, fill(dCap));
  }
}

// Phillips screw head
void drawScrew(inout vec3 col, vec2 px, vec2 center, float angle) {
  vec2 p = px - center;
  float r = length(p);
  if (r > 28.0) return;
  col *= 1.0 - 0.35 * (1.0 - smoothstep(-2.0, 8.0, length(p - vec2(3.0, -4.0)) - 15.0));
  vec3 head = vec3(0.62) + 0.25 * dot(p / 15.0, LIGHT); // domed: lit side brighter
  head += 0.15 * bevelShade(r - 15.0, p / max(r, 1e-3), 4.0);
  // Cross slot, rotated
  vec2 q = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * p;
  q = abs(q);
  float dSlot = min(max(q.x - 2.0, q.y - 9.0), max(q.y - 2.0, q.x - 9.0));
  head = mix(head, vec3(0.18), fill(dSlot));
  col = mix(col, head, fill(r - 15.0));
}

// Everything on the face of the device, drawn onto the metal color.
vec3 deviceFace(vec2 px, vec3 metal) {
  vec3 col = metal;

  // Panel grooves: horizontal section dividers and the right column divider
  groove(col, px.y - 840.0, px.x, 44.0, 922.0);
  groove(col, px.y - 575.0, px.x, 44.0, 922.0);
  groove(col, px.y - 410.0, px.x, 44.0, 922.0);
  groove(col, px.x - 922.0, px.y, 410.0, 1850.0);

  // Upper area: the two screens (safe zone)
  if (px.y > 930.0 && px.x < 925.0) {
    drawScreen(col, px, MAIN_GLASS, true);
    drawScreen(col, px, WAVE_GLASS, false);
  }

  if (px.y > 850.0 && px.y < 950.0) drawMeter(col, px);

  // Pads: red, orange, yellow, teal. The red one lights up with the bass.
  if (px.y > 585.0 && px.y < 825.0 && px.x < 925.0) {
    int i = int(clamp(floor((px.x - PAD_X0 + 16.0) / PAD_PITCH), 0.0, 3.0));
    vec4 rect = vec4(PAD_X0 + float(i) * PAD_PITCH, PAD_Y0, PAD_X0 + float(i) * PAD_PITCH + PAD_W, PAD_Y1);
    vec3 color = i == 0 ? vec3(0.86, 0.25, 0.17)
               : i == 1 ? vec3(0.94, 0.52, 0.16)
               : i == 2 ? vec3(0.93, 0.76, 0.22)
               : vec3(0.2, 0.62, 0.6);
    drawPad(col, px, rect, color, i == 0 ? smoothstep(0.4, 1.0, uBass) : 0.0);
  }

  // Transport buttons
  if (px.y > 445.0 && px.y < 550.0 && px.x < 925.0) {
    int i = int(clamp(floor((px.x - PAD_X0 + 12.0) / BUTTON_PITCH), 0.0, 4.0));
    float x0 = PAD_X0 + float(i) * BUTTON_PITCH;
    drawButton(col, px, vec4(x0, BUTTON_Y0, x0 + BUTTON_W, BUTTON_Y1), i);
  }

  // Knobs and speaker grille (bottom 20%: decoration only)
  if (px.y < 400.0) {
    drawKnob(col, px, vec2(150.0, KNOB_Y), -1.4, vec3(0.86, 0.25, 0.17));
    drawKnob(col, px, vec2(330.0, KNOB_Y), 0.35, vec3(0.94, 0.62, 0.18));
    drawKnob(col, px, vec2(510.0, KNOB_Y), 1.6, vec3(0.2, 0.62, 0.6));
    drawGrille(col, px);
  }

  drawSideColumn(col, px);

  drawScrew(col, px, vec2(64.0, 92.0), 0.3);
  drawScrew(col, px, vec2(1016.0, 92.0), 1.1);
  drawScrew(col, px, vec2(64.0, 1856.0), 0.7);
  drawScrew(col, px, vec2(1016.0, 1856.0), 0.1);
  return col;
}

void main() {
  vec2 px = gl_FragCoord.xy; // pixel centers at .5, (0.5, 0.5) = bottom-left pixel

  vec3 col = background(px);

  // Soft drop shadow of the body (offset down and to the right)
  float dShadow = sdRoundRect(px - vec2(10.0, -22.0), BODY, BODY_RADIUS);
  col *= 1.0 - 0.75 * exp(-max(dShadow, 0.0) / 30.0);

  float dBody = sdRoundRect(px, BODY, BODY_RADIUS);
  if (dBody < 1.0) {
    vec3 metal = brushedMetal(px);
    // Rounded edge: lit along the top left, dark along the bottom right,
    // plus a thin bright highlight line right at the rim.
    vec2 n = roundRectNormal(px, BODY, BODY_RADIUS);
    metal += 0.22 * bevelShade(dBody, n, 18.0);
    metal += 0.18 * (1.0 - smoothstep(1.0, 3.0, -dBody)) * max(dot(n, LIGHT), 0.0);
    metal = deviceFace(px, metal);
    col = mix(col, metal, fill(dBody));
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
