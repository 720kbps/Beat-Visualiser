// ---------- LCD screens ----------
//
// Both screens are the same (imaginary) LCD panel. The content is drawn first,
// then the effects go on top. One small function per effect:
//
//   lcdBacklight()    dark blue light behind the panel; black is never black
//   lcdRamp()         the panel's color for a brightness level 0..1:
//                     backlight -> screen color -> near white. The waveform
//                     uses it directly; the video goes through lcdTint().
//   lcdTint()         the plugin video as this LCD shows it (mostly the
//                     screen color, a bit of the plugin's own colors)
//   pluginGlow()      bright video content glows (8 taps); the waveform's glow
//                     is analytic, from its distance field
//   vignette()        darker towards the corners
//   lightLeak()       warm light leaking in at one corner, cool along one edge
//   scanlines()       the LCD pixel grid: dark rows and fainter columns
//   glassSheen()      a soft reflection on the glass
//   screenEdgeLight() the light a screen spills onto the gasket and acrylic
//
// Only the content and the glow change over time. Vignette, leak, pixel grid
// and sheen are static, so the video encoder pays for them once.

const float TAU = 6.2831853;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722); // Rec. 709 luma weights

// How much of the plugin's own colors survives the tint: 0 = pure monochrome
// LCD, 1 = untouched video. Enough to still tell a red knob from a green one.
const float COLOR_KEEP = 0.4;

// Vertical gaps of the LCD pixel grid (the horizontal ones are the scanlines).
const float PIXEL_PERIOD = 6.0; // px; >= 6 for the same reason as the scanlines

// Glow around bright video content: GLOW_TAPS samples on a disc of GLOW_RADIUS px.
const int GLOW_TAPS = 8;
const float GLOW_RADIUS = 14.0;

const vec3 LEAK_WARM = vec3(1.0, 0.8, 0.6); // warm white light leaking past the panel frame

float luma(vec3 c) {
  return dot(c, LUMA);
}

// "Screen" blend: adds light, but never past white, and less on what's already
// bright. That's how extra light (glow, leak) behaves on a real panel.
vec3 screenBlend(vec3 base, vec3 light) {
  return 1.0 - (1.0 - base) * (1.0 - clamp(light, 0.0, 1.0));
}

// Glow strength: the Glow param, pushed up to 35% more on the kick (uBass).
float glowAmount() {
  return uGlow * (1.0 + 0.35 * smoothstep(0.3, 1.0, uBass));
}

// The backlight at a point of a screen (local = px from its bottom-left).
vec3 lcdBacklight(vec2 local, vec2 size) {
  vec2 q = local / size - 0.5;
  float falloff = 1.0 - 0.9 * dot(q, q);
  return (uScreenColor * 0.17 + vec3(0.004, 0.008, 0.016)) * falloff;
}

// The panel's color for a brightness level: backlight -> screen color ->
// near white, two straight segments.
vec3 lcdRamp(float level, vec3 backlight) {
  vec3 highlight = mix(uScreenColor, vec3(1.0), 0.85);
  vec3 c = mix(backlight, uScreenColor, clamp(2.0 * level, 0.0, 1.0));
  return mix(c, highlight, clamp(2.0 * level - 1.0, 0.0, 1.0));
}

// A video color as this LCD shows it: its luminance through lcdRamp, mixed
// with the video's own colors (blacks lifted to the backlight). The gamma
// (pow 1.5) darkens the darks and mids a bit and keeps the brights, so a
// plugin's grey panels sit back and its text and lit controls stand out.
// Brightness order is kept, so text stays as readable as in the original.
vec3 lcdTint(vec3 video, vec3 backlight) {
  float y = pow(luma(video), 1.5);
  vec3 mono = lcdRamp(y, backlight);
  vec3 own = screenBlend(backlight, video);
  return mix(mono, own, COLOR_KEEP);
}

// Where the plugin video sits on the main screen. First uPluginCropTop video
// pixels are cut off the top (the window's title bar), then the rest is
// "contain" fitted: the biggest rect with its aspect that fits the screen,
// centered; the leftover stays dark backlight (letterbox bars).
// Returns the rect's size in output px (.xy) and its bottom-left corner (.zw).
vec4 pluginRect(vec2 size) {
  vec2 visible = vec2(uPluginSize.x, max(uPluginSize.y - uPluginCropTop, 1.0));
  float scale = min(size.x / visible.x, size.y / visible.y);
  vec2 fitted = visible * scale;
  return vec4(fitted, 0.5 * (size - fitted));
}

// The video color at uv (0..1 over the visible part of the video, (0,0) =
// bottom-left). uv is clamped, so samples past the edge repeat the edge.
vec3 samplePlugin(vec2 uv) {
  float visibleV = 1.0 - uPluginCropTop / uPluginSize.y; // the crop is at the top, v = 1
  uv = clamp(uv, 0.0, 1.0);
  return texture2D(uPlugin, vec2(uv.x, uv.y * visibleV)).rgb;
}

// 1 if uv is on the video, 0 if it's past its edge.
float onVideo(vec2 uv) {
  return step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
}

// The video at one output pixel. Recordings are 2-4x bigger than the screen
// and the texture has no mipmaps, so one bilinear sample would skip texels:
// thin text breaks up and crawls. 4 bilinear samples spread over the pixel
// act like a small box filter. pxToUv = the size of one output pixel in uv.
vec3 pluginPixel(vec2 uv, vec2 pxToUv) {
  vec2 o = 0.25 * pxToUv;
  return 0.25 * (samplePlugin(uv + vec2(-o.x, -o.y)) + samplePlugin(uv + vec2(o.x, -o.y))
               + samplePlugin(uv + vec2(-o.x, o.y)) + samplePlugin(uv + vec2(o.x, o.y)));
}

// How much bright video light reaches this pixel from around it: the
// average "brightness above a threshold" of GLOW_TAPS samples on a disc of
// GLOW_RADIUS px. The taps lie on a golden-angle (Vogel) spiral, each at a
// different distance, so the shifted copies of thin text blur together
// instead of showing as a ring of ghost copies. Taps past the video's edge
// count as dark, but the glow itself does spread into the letterbox bars.
float pluginGlow(vec2 uv, vec2 pxToUv) {
  float sum = 0.0;
  for (int i = 0; i < GLOW_TAPS; i++) {
    float r = GLOW_RADIUS * sqrt((float(i) + 0.5) / float(GLOW_TAPS));
    float a = 2.3999632 * float(i); // the golden angle, in radians
    vec2 tapUv = uv + r * vec2(cos(a), sin(a)) * pxToUv;
    sum += smoothstep(0.4, 0.9, luma(samplePlugin(tapUv))) * onVideo(tapUv);
  }
  return sum / float(GLOW_TAPS);
}

// Light leak: a warm glow from one corner (main screen: top right, waveform:
// bottom left, so the two don't line up) and cool, uneven "clouding" along one
// long edge, like the backlight of a cheap LCD. Static and smooth.
vec3 lightLeak(vec2 local, vec2 size, bool isMain) {
  vec2 corner = isMain ? size : vec2(0.0);
  vec2 d = (local - corner) / (vec2(0.4, 0.6) * size); // elliptical falloff
  vec3 warm = LEAK_WARM * 0.3 * exp(-dot(d, d));

  float fromEdge = isMain ? local.y : size.y - local.y; // main: bottom edge, wave: top edge
  float uneven = 0.6 + 0.4 * sin(local.x * 0.011 + (isMain ? 1.7 : 4.0));
  vec3 cool = mix(uScreenColor, vec3(1.0), 0.5) * 0.12 * exp(-fromEdge / 26.0) * uneven;
  return uLightLeak * (warm + cool);
}

// Vignette: the backlight gets weaker towards the corners.
vec3 vignette(vec3 c, vec2 local, vec2 size) {
  vec2 q = local / size - 0.5;
  return c * (1.0 - 0.45 * pow(dot(q, q) * 2.0, 2.0));
}

// LCD pixel grid: dark gaps between the rows (the scanlines, every
// SCANLINE_PERIOD px) and fainter ones between the columns. Smooth cosine
// dips, no hard lines. Bright pixels bleed a little into the gaps, so bright
// text stays solid. amount 0..1.
vec3 scanlines(vec3 c, vec2 local, float amount) {
  float rowGap = 0.5 - 0.5 * cos(TAU * local.y / SCANLINE_PERIOD);
  float columnGap = 0.5 - 0.5 * cos(TAU * local.x / PIXEL_PERIOD);
  float gap = 0.5 * rowGap + 0.15 * columnGap;
  return c * (1.0 - amount * gap * (1.0 - 0.4 * luma(c)));
}

// Glass reflection: a soft diagonal sheen across the top-left.
vec3 glassSheen(vec3 c, vec2 local, vec2 size) {
  float diag = (1.0 - local.x / size.x) * 0.45 + local.y / size.y;
  return c + vec3(0.75, 0.85, 1.0) * 0.045 * smoothstep(0.75, 1.25, diag);
}

// The effects on top of the content, in the order light passes through them:
// backlight unevenness and leaks, the pixel grid, then the glass. Both screens.
vec3 lcdFinish(vec3 c, vec2 local, vec2 size, bool isMain) {
  c = vignette(c, local, size);
  c = screenBlend(c, lightLeak(local, size, isMain)); // shows on dark content, hardly on bright
  c = scanlines(c, local, uScanlines);
  return glassSheen(c, local, size);
}

// Main screen content: the recorded plugin window, or (before there is one)
// an idle dot-matrix pattern whose ripples pulse with the loudness.
vec3 mainScreenContent(vec2 local, vec2 size) {
  vec3 tint = uScreenColor;
  vec3 c = lcdBacklight(local, size);

  if (uHasPlugin > 0.5) {
    vec4 rect = pluginRect(size);
    vec2 pxToUv = 1.0 / rect.xy;
    vec2 uv = (local - rect.zw) * pxToUv;
    vec3 shown = lcdTint(pluginPixel(uv, pxToUv), c);

    // 1 inside the video rect, 0 in the letterbox bars, with a 1 px soft edge.
    vec2 edge = abs(local - 0.5 * size) - 0.5 * rect.xy;
    float inside = 1.0 - smoothstep(-0.5, 0.5, max(edge.x, edge.y));
    c = mix(c, shown, inside);

    // Glow from the bright parts (text, lit knobs, meters), in the LCD's color
    vec3 glowColor = lcdRamp(0.8, c);
    return screenBlend(c, glowColor * pluginGlow(uv, pxToUv) * 0.5 * glowAmount());
  }

  // Grid: 16 x 10 cells of 51 px
  float minor = max(gridLine(local.x, 51.0, 3.0), gridLine(local.y, 51.0, 3.0));
  c += tint * 0.08 * minor;

  // Dot matrix, one dot every 25.5 px (2 per grid cell). Each dot's brightness
  // is a ring ripple moving outward from the center, scaled by the loudness.
  // Lit dots get a small halo, like bright video content.
  const float pitch = 25.5;
  vec2 cell = floor(local / pitch);
  vec2 dotCenter = (cell + 0.5) * pitch;
  float dDot = length(local - dotCenter) - 4.0;
  float dotMask = 1.0 - smoothstep(-0.8, 0.8, dDot);
  float halo = exp(-max(dDot, 0.0) / 4.0) * 0.45 * glowAmount();
  float r = length(dotCenter - 0.5 * size);
  float ripple = 0.5 + 0.5 * cos(r * 0.028 - uTime * 4.0);
  float fade = 1.0 - 0.7 * smoothstep(0.0, 0.55 * size.x, r);
  float level = 0.07 + uRms * (0.12 + 0.75 * ripple) * fade;
  c += lcdRamp(0.65, c) * (dotMask + (1.0 - dotMask) * halo) * level;

  // Viewfinder corners: "a window goes here"
  vec3 markColor = lcdRamp(0.7, c);
  vec2 fromEdge = min(local, size - local) - 36.0; // distance inside the bracket frame
  float nearest = min(fromEdge.x, fromEdge.y);
  float bracket = step(0.0, nearest) * step(nearest, 4.0) * step(max(fromEdge.x, fromEdge.y), 56.0);
  c = mix(c, markColor, bracket * 0.7);

  // Center crosshair
  vec2 m = abs(local - 0.5 * size);
  float cross = step(m.x, 2.0) * step(m.y, 22.0) + step(m.y, 2.0) * step(m.x, 22.0);
  c = mix(c, markColor, min(cross, 1.0) * 0.5);
  return c;
}

// Offsets (in waveform columns) of the 9 taps around a pixel: dense near the
// pixel so the waveform itself is exact, sparser further out for the glow.
const int TAPS[9] = int[9](-8, -5, -3, -1, 0, 1, 3, 5, 8);

// Waveform screen content: grid, mirrored min/max waveform, playhead.
// Played = bright levels, not yet played = dim levels of the same LCD ramp.
vec3 waveScreenContent(vec2 local, vec2 size) {
  vec3 tint = uScreenColor;
  float centerY = 0.5 * size.y;
  float playX = uProgress * size.x;
  bool played = local.x < playX;
  float glow = glowAmount();

  vec3 backlight = lcdBacklight(local, size);
  vec3 c = backlight;
  if (played) c += tint * 0.035;

  // Grid: minor lines every 34 px (from the center line out), major lines
  // every 136 px across and the center line.
  // TODO(Phase 4): put the vertical lines on the bars once beats are known.
  vec2 g = vec2(local.x, local.y - centerY);
  float minor = max(gridLine(g.x, 34.0, 3.0), gridLine(g.y, 34.0, 3.0));
  float major = max(gridLine(g.x, 136.0, 3.0), 1.0 - smoothstep(1.0, 2.5, abs(g.y)));
  c += tint * (0.06 * minor + 0.12 * major);

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
  c += tint * exp(-dWave / glowWidth) * glow * (played ? 0.55 : 0.22);
  vec3 waveColor = lcdRamp(played ? 0.68 : 0.28, backlight);
  vec3 coreColor = lcdRamp(played ? 0.94 : 0.4, backlight);
  c = mix(c, waveColor, fill(dWave - 0.5));
  c = mix(c, coreColor, fill(dCore - 0.5));

  // Playhead: a 4 px line with a glow, and a small triangle at the top and bottom
  vec3 headColor = mix(tint, vec3(1.0), 0.88);
  float dHead = abs(local.x - playX);
  c += lcdRamp(0.75, backlight) * exp(-dHead / (5.0 + 16.0 * uGlow)) * (0.12 + 0.4 * glow);
  c = mix(c, headColor, fill(dHead - 2.0));
  float triTop = (local.y - (size.y - 20.0)) * 0.65 - dHead;
  float triBottom = (20.0 - local.y) * 0.65 - dHead;
  c = mix(c, headColor, smoothstep(-0.8, 0.8, max(triTop, triBottom)));
  return c;
}

// The light a screen gives off at the point of its glass nearest to px,
// for the glow on the gasket and the acrylic around it. For the video it's
// the real content there (4 samples 12 px apart, so the light is soft), so a
// bright plugin edge lights up the acrylic next to it. Scaled by the glow.
// Cost: up to 4 video samples, only for pixels near a screen.
vec3 screenEdgeLight(vec2 px, vec4 glass, bool isMain) {
  vec2 size = glass.zw - glass.xy;
  vec2 local = clamp(px - glass.xy, vec2(16.0), size - 16.0); // just inside the glass
  vec3 backlight = lcdBacklight(local, size);
  vec3 light;
  if (isMain && uHasPlugin > 0.5) {
    vec4 rect = pluginRect(size);
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      vec2 offset = vec2(i == 0 || i == 2 ? -6.0 : 6.0, i < 2 ? -6.0 : 6.0);
      vec2 uv = (local + offset - rect.zw) / rect.xy;
      sum += onVideo(uv) > 0.5 ? lcdTint(samplePlugin(uv), backlight) : backlight;
    }
    light = 0.25 * sum;
  } else if (isMain) {
    light = backlight + uScreenColor * (0.04 + 0.12 * uRms); // the idle dots
  } else {
    // Brighter next to the played (bright) part of the waveform
    float played = 1.0 - smoothstep(-60.0, 60.0, local.x - uProgress * size.x);
    light = backlight + uScreenColor * (0.12 + 0.18 * played);
  }
  return light * (0.35 + 0.65 * glowAmount());
}

// A screen: dark bezel recessed into the metal, glass with an inner shadow, and
// the LCD content. isMain picks which content.
void drawScreen(inout vec3 col, vec2 px, vec4 glass, bool isMain) {
  vec4 bezelRect = glass + vec4(-BEZEL, -BEZEL, BEZEL, BEZEL);
  float dBezel = sdRoundRect(px, bezelRect, BEZEL_RADIUS);
  if (dBezel > 1.0) return;

  // Bezel: a matte black gasket the glass sits in, one step below the acrylic
  // display panel (drawDisplayPanel). Its upper wall is in shadow, the lower
  // one catches a little light, and the screen's light falls on it.
  vec3 bezel = vec3(0.014, 0.015, 0.019);
  bezel += 0.06 * insetShade(dBezel, roundRectNormal(px, bezelRect, BEZEL_RADIUS), 4.0);
  bezel = max(bezel, 0.0);
  float dGlass = sdRoundRect(px, glass, GLASS_RADIUS);
  if (dGlass > -1.0) {
    bezel += screenEdgeLight(px, glass, isMain) * 0.45 * exp(-max(dGlass, 0.0) / 4.0);
  }

  // Glass
  if (dGlass < 1.0) {
    vec2 local = px - glass.xy;
    vec2 size = glass.zw - glass.xy;
    vec3 lcd = isMain ? mainScreenContent(local, size) : waveScreenContent(local, size);
    lcd = lcdFinish(lcd, local, size, isMain);
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

// ---------- Display panel ----------
//
// The smoked-acrylic window that holds both screens, with the status strip
// printed/lit behind it between them.

// Status strip between the two screens, printed/lit behind the smoked acrylic:
// a green "playing" lamp, 16 position LEDs (one per 1/16 of the clip; with a
// 16-bar clip that's one per bar) and a 7-segment mm:ss timecode.
// Cost: only pixels within 26 px of STATUS_Y get here; at most 7 segment SDFs.
void drawStatusStrip(inout vec3 c, vec2 px) {
  vec3 tint = uScreenColor;
  vec3 lit = mix(tint, vec3(1.0), 0.45);
  float y = px.y - STATUS_Y;

  // Play lamp: a small green triangle with a glow
  float dPlay = sdTriangle(vec2(y, px.x - 92.0), 10.0); // pointing right
  c += LED_GREEN * 0.25 * exp(-max(dPlay, 0.0) / 6.0);
  c = mix(c, mix(LED_GREEN, vec3(1.0), 0.25), fill(dPlay));

  // Position LEDs: 16 small bars at a 34 px pitch from x = 130
  const float ledX0 = 130.0;
  const float ledPitch = 34.0;
  float i = floor((px.x - ledX0) / ledPitch);
  if (i >= 0.0 && i < 16.0) {
    vec2 center = vec2(ledX0 + (i + 0.5) * ledPitch, STATUS_Y);
    float dLed = sdRoundRect(px, vec4(center - vec2(11.0, 5.0), center + vec2(11.0, 5.0)), 3.0);
    float step16 = floor(uProgress * 16.0);
    // current step bright, passed steps half, future steps a faint ghost
    float level = i < step16 ? 0.4 : (i == step16 ? 1.0 : 0.07);
    c += tint * 0.22 * level * exp(-max(dLed, 0.0) / 5.0);
    c = mix(c, mix(tint * 0.5, lit, level) * level, fill(dLed));
  }

  // Timecode mm:ss, right-aligned with the screens. 4 digits on a 28 px pitch
  // with a 14 px gap for the colon in the middle.
  const float tcX0 = 762.0;
  float x = px.x - tcX0;
  if (x > -6.0 && x < 132.0) {
    float seconds = floor(uTime);
    float minutes = floor(seconds / 60.0);
    float s = mod(seconds, 60.0);
    float slot = x < 56.0 ? floor(x / 28.0) : floor((x - 14.0) / 28.0);
    slot = clamp(slot, 0.0, 3.0);
    float value = slot == 0.0 ? floor(minutes / 10.0)
                : slot == 1.0 ? mod(minutes, 10.0)
                : slot == 2.0 ? floor(s / 10.0)
                : mod(s, 10.0);
    float digitX = 14.0 + slot * 28.0 + (slot >= 2.0 ? 14.0 : 0.0);
    vec2 seg = sevenSegment(vec2(x - digitX, y), int(value));
    float dLit = seg.x - 2.5; // 5 px thick segments
    float dGhost = seg.y - 2.5;
    // Colon, blinking at 1 Hz
    vec2 cp = vec2(x - 63.0, abs(y) - 7.0);
    float dColon = length(cp - vec2(0.12 * y, 0.0)) - 2.8; // slanted like the digits
    dLit = min(dLit, mix(1e5, dColon, step(fract(uTime), 0.5)));
    c = mix(c, tint * 0.09, fill(dGhost));
    c += lit * 0.3 * exp(-max(dLit, 0.0) / 5.0);
    c = mix(c, lit, fill(dLit));
  }
}

// The smoked-acrylic display window: a chamfer cut into the metal, a glossy
// black panel with a soft reflection, the screens' light falling on it, a printed
// ruler under the waveform and the status strip. The screens are drawn on top
// of it by drawScreen().
void drawDisplayPanel(inout vec3 col, vec2 px) {
  float d = sdRoundRect(px, DISPLAY, DISPLAY_RADIUS);
  if (d > DISPLAY_CHAMFER + 1.0) return;
  vec2 n = roundRectNormal(px, DISPLAY, DISPLAY_RADIUS);
  holeChamfer(col, d, n, DISPLAY_CHAMFER);
  if (d > 1.0) return;

  // Glossy black acrylic. It reflects a big soft light from the upper left:
  // a brighter sheet over the top-left part with a soft diagonal edge.
  vec2 uv = (px - DISPLAY.xy) / (DISPLAY.zw - DISPLAY.xy);
  vec3 panel = vec3(0.018, 0.02, 0.026);
  float k = uv.y + 0.55 * (1.0 - uv.x) - 1.05;
  panel += vec3(0.05, 0.055, 0.065) * smoothstep(-0.03, 0.08, k);
  panel += vec3(0.018, 0.02, 0.025) * smoothstep(-0.9, 0.0, k); // the light's wide falloff

  // Light from both screens spilling into the acrylic around them, in the
  // color of the content next to it (screenEdgeLight). Past ~80 px it's < 1%,
  // so pixels further away skip the work.
  float dMain = sdRoundRect(px, MAIN_GLASS, GLASS_RADIUS);
  float dWave = sdRoundRect(px, WAVE_GLASS, GLASS_RADIUS);
  if (dMain < 80.0) panel += screenEdgeLight(px, MAIN_GLASS, true) * 0.2 * exp(-max(dMain, 0.0) / 18.0);
  if (dWave < 80.0) panel += screenEdgeLight(px, WAVE_GLASS, false) * 0.2 * exp(-max(dWave, 0.0) / 18.0);

  // Printed ruler under the waveform: a tick every 34 px (the waveform grid),
  // a long one every 136 px. Light grey silkscreen, 3 px wide.
  float rx = px.x - WAVE_GLASS.x;
  float rulerTop = WAVE_GLASS.y - BEZEL - 6.0;
  if (rx > -3.0 && rx < WAVE_GLASS.z - WAVE_GLASS.x + 3.0 && px.y < rulerTop) {
    float tickLength = gridLine(rx, 136.0, 3.0) > 0.0 ? 15.0 : 8.0;
    float tick = gridLine(rx, 34.0, 3.0) * step(rulerTop - tickLength, px.y);
    panel = mix(panel, vec3(0.45, 0.47, 0.5), tick * 0.75);
  }

  if (abs(px.y - STATUS_Y) < 26.0) drawStatusStrip(panel, px);

  // The panel sits below the metal: soft inner shadow along the upper edges
  float wall = 1.0 - smoothstep(0.0, 14.0, -d);
  panel *= 1.0 - 0.65 * wall * clamp(0.3 + dot(n, LIGHT), 0.0, 1.0);
  col = mix(col, panel, fill(d));
}
