// ---------- Hardware ----------
//
// The controls and details below the display: level meter, bass LED, pads,
// transport buttons, knobs, speaker grille, the right-hand column, screws and
// the model badge. Each draw function checks its own bounding box first.

// Level meter: a slot under a smoked cover with LED segments (green, amber,
// red) lit by the loudness. Their light leaks onto the metal around the slot.
void drawMeter(inout vec3 col, vec2 px) {
  const float radius = 14.0;
  float dSlot = sdRoundRect(px, METER_SLOT, radius);
  if (dSlot > 30.0) return;

  float x0 = METER_SLOT.x + 16.0;
  float pitch = (METER_SLOT.z - 16.0 - x0) / METER_SEGMENTS;
  float i = clamp(floor((px.x - x0) / pitch), 0.0, METER_SEGMENTS - 1.0);
  float t = (i + 0.5) / METER_SEGMENTS;
  vec3 led = t < 0.66 ? LED_GREEN : (t < 0.86 ? LED_AMBER : LED_RED);
  // 0..1; the topmost lit segment fades in smoothly instead of popping
  float lit = clamp(uRms * METER_SEGMENTS - i, 0.0, 1.0);

  // Light leaking onto the metal around the slot. Uses a smooth version of
  // the lit/unlit split and the colors, so the leak has no hard steps.
  float tx = clamp((px.x - x0) / (pitch * METER_SEGMENTS), 0.0, 1.0);
  vec3 leakColor = mix(mix(LED_GREEN, LED_AMBER, smoothstep(0.6, 0.72, tx)), LED_RED, smoothstep(0.82, 0.9, tx));
  float leakLit = 1.0 - smoothstep(uRms - 0.04, uRms + 0.04, tx);
  col += leakColor * leakLit * 0.07 * exp(-max(dSlot, 0.0) / 8.0);
  vec2 n = roundRectNormal(px, METER_SLOT, radius);
  holeChamfer(col, dSlot, n, 6.0);
  if (dSlot > 1.0) return;

  vec3 slot = vec3(0.018, 0.02, 0.024);
  vec2 segCenter = vec2(x0 + (i + 0.5) * pitch, 0.5 * (METER_SLOT.y + METER_SLOT.w));
  vec2 segHalf = vec2(0.5 * pitch - 4.0, 13.0);
  float dSeg = sdRoundRect(px, vec4(segCenter - segHalf, segCenter + segHalf), 3.0);
  slot += led * exp(-max(dSeg, 0.0) / 5.0) * lit * 0.35; // halo
  vec3 seg = led * mix(0.1, 1.0, lit);
  seg += 0.15 * lit * (1.0 - smoothstep(0.0, 6.0, (segCenter.y + segHalf.y) - px.y)); // top shine
  slot = mix(slot, seg, fill(dSeg));

  // Smoked cover: inner shadow at the top, a soft reflection over the upper half
  float wall = 1.0 - smoothstep(0.0, 10.0, -dSlot);
  slot *= 1.0 - 0.6 * wall * clamp(0.3 + dot(n, LIGHT), 0.0, 1.0);
  float ty = (px.y - METER_SLOT.y) / (METER_SLOT.w - METER_SLOT.y);
  slot += vec3(0.05, 0.055, 0.06) * smoothstep(0.45, 0.9, ty) * (1.0 - wall);
  col = mix(col, slot, fill(dSlot));
}

// Bass LED: a chrome bezel with a domed red lens that flashes with the bass;
// its light spills onto the metal around it.
void drawBassLed(inout vec3 col, vec2 px) {
  vec2 p = px - BASS_LED;
  float r = length(p);
  if (r > 110.0) return;
  vec2 n = p / max(r, 1e-3);
  float flash = smoothstep(0.3, 1.0, uBass);

  col += LED_RED * exp(-max(r - 20.0, 0.0) / 22.0) * flash * 0.45;
  col *= softShadow(length(p - vec2(3.0, -5.0)) - 25.0, 8.0, 0.4);

  // Chrome bezel: a rounded ring, its lit side bright, plus a dark inner lip
  vec3 ring = vec3(0.55) + 0.4 * dot(n, LIGHT) * (1.0 - smoothstep(-25.0, -19.0, -r));
  ring += 0.2 * (1.0 - smoothstep(0.0, 3.0, 25.0 - r)) * max(dot(n, LIGHT), 0.0);
  col = mix(col, ring, fill(r - 25.0));
  col = mix(col, vec3(0.05), fill(r - 18.5));

  // Lens: dark red when off, bright red-orange with a hot center when on.
  // The dome is lighter towards the light and has a small specular highlight.
  vec3 off = LED_RED * 0.16 * (0.8 + 0.4 * dot(p / 17.0, LIGHT));
  vec3 on = mix(LED_RED, vec3(1.0, 0.8, 0.7), 0.6 * (1.0 - smoothstep(0.0, 14.0, r)));
  vec3 lens = mix(off, on, flash);
  lens += 0.45 * (1.0 - smoothstep(1.0, 5.0, length(p - vec2(-5.0, 7.0))));
  col = mix(col, lens, fill(r - 16.5));
}

// A chunky pad of translucent rubber sitting in a well. glowAmount 0..1 lights
// it from inside (an LED under the rubber).
// Shading: a pillow-shaped height profile lit by LIGHT3 (rounded edges, flat
// top), a broad weak sheen, and a cheap "subsurface" look: near the edges the
// light travels further through the rubber, so the color gets deeper there.
void drawPad(inout vec3 col, vec2 px, vec4 rect, vec3 color, float glowAmount) {
  vec4 well = rect + vec4(-9.0, -9.0, 9.0, 9.0);
  float wellRadius = PAD_RADIUS + 8.0;
  float dWell = sdRoundRect(px, well, wellRadius);
  if (dWell > 1.0) return;

  // Well floor: dark, upper wall in shadow, lower lip lit
  vec3 c = vec3(0.026, 0.028, 0.032);
  c += 0.1 * insetShade(dWell, roundRectNormal(px, well, wellRadius), 5.0);
  float dPad = sdRoundRect(px, rect, PAD_RADIUS);
  c += color * glowAmount * 0.6 * exp(-max(dPad, 0.0) / 5.0); // LED light around the pad
  // The pad's shadow on the floor, away from the light
  c *= softShadow(sdRoundRect(px - vec2(4.0, -7.0), rect, PAD_RADIUS), 8.0, 0.6);

  if (dPad < 1.0) {
    vec3 N = pillowNormal(dPad, roundRectNormal(px, rect, PAD_RADIUS), 26.0, 1.5);
    float diffuse = dot(N, LIGHT3) / LIGHT3.z; // 1 on the flat top
    float inside = clamp(-dPad / 26.0, 0.0, 1.0); // 0 at the edge, 1 on the top

    vec3 face = mix(color * color * 0.85, color, 0.3 + 0.7 * inside); // deeper at the edges
    face *= 0.5 + 0.5 * diffuse;
    float ty = (px.y - rect.y) / (rect.w - rect.y);
    face *= 0.88 + 0.18 * ty; // the top is a little closer to the light
    face += 0.12 * pow(max(dot(N, HALF3), 0.0), 16.0); // soft rubber sheen
    face *= 0.97 + 0.06 * valueNoise(px / 3.0); // grain (static)

    // Lit from inside: blend towards the fully saturated color (adding light
    // would wash it out to pastel), brightest in the middle, plus a hot core.
    vec3 litColor = color / max(max(color.r, color.g), color.b);
    vec3 lit = litColor * (0.7 + 0.35 * inside) * (0.85 + 0.15 * diffuse);
    face = mix(face, lit, glowAmount * 0.85);
    face += mix(litColor, vec3(1.0), 0.5) * glowAmount * 0.12 * inside * inside;
    c = mix(c, face, fill(dPad));
  }
  col = mix(col, c, fill(dWell));
}

// Transport button: dark glossy plastic with a backlit symbol and the big soft
// gloss reflection on its upper half that every early-2000s button had.
// kind: 0 rewind, 1 fast forward, 2 stop, 3 play, 4 record.
void drawButton(inout vec3 col, vec2 px, vec4 rect, int kind) {
  const float radius = 18.0;
  vec4 well = rect + vec4(-6.0, -6.0, 6.0, 6.0);
  float dWell = sdRoundRect(px, well, radius + 5.0);
  if (dWell > 1.0) return;

  vec3 c = vec3(0.026, 0.028, 0.032);
  c += 0.1 * insetShade(dWell, roundRectNormal(px, well, radius + 5.0), 4.0);
  c *= softShadow(sdRoundRect(px - vec2(3.0, -5.0), rect, radius), 6.0, 0.6);

  float dButton = sdRoundRect(px, rect, radius);
  if (dButton < 1.0) {
    vec3 N = pillowNormal(dButton, roundRectNormal(px, rect, radius), 14.0, 1.3);
    float diffuse = dot(N, LIGHT3) / LIGHT3.z;
    float ty = (px.y - rect.y) / (rect.w - rect.y);
    vec3 face = vec3(0.115, 0.12, 0.135) * (0.75 + 0.4 * ty) * (0.55 + 0.45 * diffuse);
    face += 0.3 * pow(max(dot(N, HALF3), 0.0), 40.0); // sharp highlight on the lit edge

    // Symbol, centered. Play and record are backlit and glow; the others are
    // printed light grey.
    vec2 p = px - 0.5 * (rect.xy + rect.zw);
    float dSym = 1e5;
    vec3 symColor = vec3(0.72, 0.74, 0.77);
    float glow = 0.0;
    if (kind == 0) {
      dSym = min(sdTriangle(vec2(p.y, -(p.x + 9.0)), 12.0), sdTriangle(vec2(p.y, -(p.x - 11.0)), 12.0));
    } else if (kind == 1) {
      dSym = min(sdTriangle(vec2(p.y, p.x + 11.0), 12.0), sdTriangle(vec2(p.y, p.x - 9.0), 12.0));
    } else if (kind == 2) {
      dSym = sdRoundRect(p, vec4(-11.0, -11.0, 11.0, 11.0), 2.0);
    } else if (kind == 3) {
      dSym = sdTriangle(vec2(p.y, p.x + 3.0), 14.0);
      symColor = mix(LED_GREEN, vec3(1.0), 0.2);
      glow = 1.0;
    } else {
      dSym = length(p) - 12.0;
      symColor = LED_RED;
      glow = 0.5;
    }
    face += symColor * glow * 0.3 * exp(-max(dSym, 0.0) / 7.0);
    face = mix(face, symColor, fill(dSym));

    // Gloss: the reflection of a bright window over the upper half, fading
    // out downwards, inset from the edges.
    vec4 glossRect = vec4(rect.x + 8.0, mix(rect.y, rect.w, 0.48), rect.z - 8.0, rect.w - 5.0);
    float dGloss = sdRoundRect(px, glossRect, radius - 6.0);
    float glossT = (px.y - glossRect.y) / (glossRect.w - glossRect.y);
    face += vec3(0.15, 0.16, 0.18) * smoothstep(0.0, 1.0, glossT) * (1.0 - smoothstep(-3.0, 1.0, dGloss));

    c = mix(c, face, fill(dButton));
  }
  col = mix(col, c, fill(dWell));
}

// Knob: a colored, knurled plastic skirt with a spun-aluminium cap and an
// engraved pointer, over a printed scale. angle: radians, 0 = up, clockwise.
// Cost: only pixels within 104 px of the center get past the first line.
void drawKnob(inout vec3 col, vec2 px, vec2 center, float angle, vec3 color) {
  vec2 p = px - center;
  float r = length(p);
  if (r > 104.0) return;
  float a = atan(p.x, p.y); // 0 = up, clockwise positive
  vec2 n = p / max(r, 1e-3);

  // Printed scale (light silkscreen): 11 ticks over 270 degrees, the two end
  // ticks longer.
  float tickStep = 4.712389 / 10.0; // 270 degrees / 10 gaps
  float idx = clamp(floor((a + 2.356194) / tickStep + 0.5), 0.0, 10.0);
  float tickAngle = -2.356194 + idx * tickStep;
  float tickEnd = (idx == 0.0 || idx == 10.0) ? 97.0 : 88.0;
  float tick = (1.0 - smoothstep(1.2, 2.2, abs(a - tickAngle) * r)) * step(78.0, r) * step(r, tickEnd);
  col = mix(col, vec3(0.7, 0.71, 0.73), tick * 0.8);

  // Shadows on the plate: a soft one away from the light, a tight contact one
  col *= softShadow(length(p - vec2(8.0, -12.0)) - KNOB_RADIUS, 22.0, 0.55);
  col *= softShadow(r - KNOB_RADIUS - 1.0, 5.0, 0.35);

  // Skirt: rounded at the top edge, with knurled ridges. The ridges are done by
  // tilting the normal sideways with a sine around the circumference
  // (56 ridges, ~7 px apart at the rim).
  vec3 N = pillowNormal(r - KNOB_RADIUS, n, 16.0, 1.2);
  vec2 tangent = vec2(n.y, -n.x);
  N = normalize(N + vec3(tangent * 0.4 * sin(a * 56.0), 0.0));
  vec3 skirt = color * (0.3 + 0.55 * dot(N, LIGHT3) / LIGHT3.z);
  skirt += 0.2 * pow(max(dot(N, HALF3), 0.0), 24.0);
  // The cap's shadow on the skirt
  const float capRadius = 46.0;
  skirt *= softShadow(length(p - vec2(2.0, -4.0)) - capRadius, 6.0, 0.55);
  col = mix(col, skirt, fill(r - KNOB_RADIUS));

  // Cap: spun aluminium. Concentric machining rings reflect the light as two
  // bright wedges along the light direction (anisotropic, like a CD), plus a
  // fainter pair across it. Fine rings: 1D noise along the radius.
  const float lightAngle = -0.423; // atan(LIGHT.x, LIGHT.y)
  float along = 0.5 + 0.5 * cos(2.0 * (a - lightAngle));
  float across = 0.5 - 0.5 * cos(2.0 * (a - lightAngle));
  vec3 cap = vec3(0.4 + 0.42 * pow(along, 5.0) + 0.1 * pow(across, 8.0));
  cap += 0.05 * (valueNoise(vec2(r * 0.8, 7.0)) - 0.5);
  // Small chamfer on the cap's edge: bright on the lit side, dark opposite
  float edge = 1.0 - smoothstep(0.0, 4.0, capRadius - r);
  cap += 0.25 * edge * dot(n, LIGHT);

  // Engraved pointer from r = 10 to 38: a dark groove with a lit lower lip
  vec2 dir = vec2(sin(angle), cos(angle));
  vec2 off = p - dir * clamp(dot(p, dir), 10.0, 38.0); // from the pointer's axis to p
  float dLine = length(off);
  cap = mix(cap, vec3(0.06), fill(dLine - 2.5));
  float lip = 1.0 - smoothstep(0.0, 1.5, abs(dLine - 3.5));
  cap += 0.15 * lip * max(-dot(off / max(dLine, 1e-3), LIGHT), 0.0);
  col = mix(col, cap, fill(r - capRadius));
}

// Round speaker grille: a shallow dish pressed into the plate with a hex grid
// of holes. Cost: the hole lookup is O(1) (nearest hex cell), no loop.
void drawGrille(inout vec3 col, vec2 px) {
  vec2 p = px - GRILLE;
  float r = length(p);
  const float dishRadius = GRILLE_RADIUS + 6.0;
  if (r > dishRadius + 10.0) return;
  vec2 n = p / max(r, 1e-3);

  holeChamfer(col, r - dishRadius, n, 8.0);
  if (r > dishRadius + 1.0) return;
  // Dish floor: a bit darker, inner shadow along the upper rim
  vec3 dish = col * 0.88;
  float wall = 1.0 - smoothstep(0.0, 14.0, dishRadius - r);
  dish *= 1.0 - 0.45 * wall * clamp(0.3 + dot(n, LIGHT), 0.0, 1.0);

  const float pitch = 22.0;
  const float rowStep = 19.05; // pitch * sqrt(3) / 2
  float row = floor(p.y / rowStep + 0.5);
  float offset = mod(row, 2.0) * 0.5 * pitch;
  float column = floor((p.x - offset) / pitch + 0.5);
  vec2 hole = vec2(column * pitch + offset, row * rowStep);
  if (length(hole) < GRILLE_RADIUS - 8.0) {
    vec2 q = p - hole;
    float d = length(q) - 6.5;
    // Hole: black cloth behind, the lower wall catches light
    vec3 c = vec3(0.012) + 0.2 * insetShade(d, q / max(length(q), 1e-3), 3.0);
    dish = mix(dish, max(c, 0.0), fill(d));
  }
  col = mix(col, dish, fill(r - dishRadius));
}

// Right-hand column (outside the safe zone, so decoration only): a power LED,
// three vent slots, and a vertical fader.
void drawSideColumn(inout vec3 col, vec2 px) {
  // Vent slots: dark inside, getting darker towards the bottom of the slot
  const float ventY0 = 1030.0;
  const float ventY1 = 1720.0;
  if (px.y > ventY0 - 24.0 && px.y < ventY1 + 24.0) {
    float i = clamp(floor((px.x - SIDE_X + 40.5) / 27.0), 0.0, 2.0); // nearest slot
    float x = SIDE_X + (i - 1.0) * 27.0;
    vec2 closest = vec2(x, clamp(px.y, ventY0, ventY1));
    float d = length(px - closest) - 6.0;
    col *= softShadow(d - 1.0, 4.0, 0.25); // a little ambient occlusion around the slot
    if (d < 1.0) {
      vec2 n = normalize(px - closest + vec2(1e-3, 0.0));
      vec3 c = vec3(0.02) + 0.3 * insetShade(d, n, 4.0);
      col = mix(col, max(c, 0.0), fill(d));
    }
  }

  // Power LED (always on): chrome ring, green lens, a little light on the metal
  vec2 pl = px - vec2(SIDE_X, 1800.0);
  float rl = length(pl);
  if (rl < 50.0) {
    col += LED_GREEN * exp(-max(rl - 8.0, 0.0) / 10.0) * 0.18 * (1.0 - smoothstep(30.0, 50.0, rl));
    vec3 ring = vec3(0.55) + 0.35 * dot(pl / max(rl, 1e-3), LIGHT);
    col = mix(col, ring, fill(rl - 13.0));
    vec3 lens = mix(LED_GREEN, vec3(1.0), 0.45 * (1.0 - smoothstep(0.0, 7.0, rl)));
    lens += 0.3 * (1.0 - smoothstep(0.5, 3.0, length(pl - vec2(-3.0, 4.0))));
    col = mix(col, lens, fill(rl - 8.5));
  }

  // Fader: printed tick marks, a slot, and a glossy cap with grip ridges
  const float trackY0 = 480.0;
  const float trackY1 = 890.0;
  if (px.y < trackY0 - 40.0 || px.y > trackY1 + 40.0) return;
  float tick = gridLine(px.y - trackY0, 41.0, 3.0) * step(abs(px.x - (SIDE_X - 36.0)), 9.0)
             * step(trackY0 - 2.0, px.y) * step(px.y, trackY1 + 2.0);
  col = mix(col, vec3(0.14), tick * 0.75);
  float dTrack = sdCapsuleV(px, SIDE_X, trackY0, trackY1, 6.0);
  if (dTrack < 1.0) {
    vec2 n = normalize(px - vec2(SIDE_X, clamp(px.y, trackY0, trackY1)) + vec2(1e-3, 0.0));
    col = mix(col, max(vec3(0.02) + 0.3 * insetShade(dTrack, n, 4.0), 0.0), fill(dTrack));
  }
  vec4 cap = vec4(SIDE_X - 34.0, 738.0, SIDE_X + 34.0, 786.0);
  col *= softShadow(sdRoundRect(px - vec2(5.0, -9.0), cap, 9.0), 12.0, 0.5);
  float dCap = sdRoundRect(px, cap, 9.0);
  if (dCap < 1.0) {
    vec3 N = pillowNormal(dCap, roundRectNormal(px, cap, 9.0), 10.0, 1.3);
    // Grip: three horizontal ridges, made by tilting the normal up/down
    float ridgeY = px.y - 762.0;
    N = normalize(N + vec3(0.0, 0.5 * sin(ridgeY * 0.52) * step(abs(ridgeY), 18.0), 0.0));
    vec3 c = vec3(0.1, 0.105, 0.115) * (0.5 + 0.5 * dot(N, LIGHT3) / LIGHT3.z);
    c += 0.3 * pow(max(dot(N, HALF3), 0.0), 30.0);
    // White index line across the middle
    c = mix(c, vec3(0.9), 1.0 - smoothstep(1.5, 2.5, abs(ridgeY)));
    col = mix(col, c, fill(dCap));
  }
}

// Phillips screw in a countersunk hole. angle rotates the slot.
void drawScrew(inout vec3 col, vec2 px, vec2 center, float angle) {
  vec2 p = px - center;
  float r = length(p);
  if (r > 24.0) return;
  vec2 n = p / max(r, 1e-3);
  holeChamfer(col, r - 13.0, n, 4.0); // countersink
  col *= softShadow(length(p - vec2(2.0, -3.0)) - 13.0, 4.0, 0.5);

  // Domed head: lit side brighter, a small specular spot towards the light
  vec3 head = vec3(0.58) + 0.3 * dot(p / 13.0, LIGHT);
  head += 0.25 * (1.0 - smoothstep(0.0, 5.0, length(p - 6.0 * LIGHT)));
  // Cross slot, rotated
  vec2 q = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * p;
  q = abs(q);
  float dSlot = min(max(q.x - 2.0, q.y - 8.0), max(q.y - 2.0, q.x - 8.0));
  head = mix(head, vec3(0.12), fill(dSlot));
  col = mix(col, head, fill(r - 13.0));
}

// Model badge: a small raised dark enamel plate with four slanted color stripes
// (the pad colors). Abstract on purpose, no name or logo.
const vec4 BADGE = vec4(104.0, 1856.0, 262.0, 1878.0);
void drawBadge(inout vec3 col, vec2 px) {
  float d = sdRoundRect(px, BADGE, 6.0);
  if (d > 14.0) return;
  col *= softShadow(sdRoundRect(px - vec2(2.0, -3.0), BADGE, 6.0), 5.0, 0.5);
  if (d > 1.0) return;
  vec3 plate = vec3(0.07, 0.075, 0.085);
  plate += 0.2 * bevelShade(d, roundRectNormal(px, BADGE, 6.0), 3.0);
  // Stripes: slanted coordinate, 14 px pitch, 9 px wide, at the right end
  float sx = px.x - (BADGE.z - 68.0) + 0.5 * (px.y - BADGE.y);
  float i = floor(sx / 14.0);
  if (i >= 0.0 && i < 4.0) {
    vec3 stripe = i == 0.0 ? PAD_RED : i == 1.0 ? PAD_ORANGE : i == 2.0 ? PAD_YELLOW : PAD_TEAL;
    float dStripe = abs(mod(sx, 14.0) - 4.5) - 4.5;
    float inner = sdRoundRect(px, BADGE + vec4(4.0, 4.0, -4.0, -4.0), 3.0);
    plate = mix(plate, stripe * 0.9, fill(max(dStripe, inner)));
  }
  // A thin engraved line on the left part
  float line = (1.0 - smoothstep(1.0, 2.0, abs(px.y - 0.5 * (BADGE.y + BADGE.w))))
             * step(BADGE.x + 12.0, px.x) * step(px.x, BADGE.z - 80.0);
  plate = mix(plate, vec3(0.32, 0.33, 0.35), line * 0.8);
  col = mix(col, plate, fill(d));
}
