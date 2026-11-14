// ---------- Background, metal and body ----------
//
// The backdrop, the brushed aluminium, and the body: its shadow, the side wall
// below the face and the polished chamfer around the face. The things on the
// face are drawn by deviceFace() in main.glsl.

// Dark backdrop behind the device (mostly hidden by it).
vec3 background(vec2 px) {
  return mix(vec3(0.02, 0.022, 0.028), vec3(0.055, 0.06, 0.075), vUv.y);
}

// Brushed aluminium. The brushing runs along x, so the noise is stretched ~100x
// along x: thin horizontal streaks. Brushed metal reflects a light as a broad
// band ACROSS the brushing direction (anisotropic highlight), and the streaks
// show most inside that band; that's what makes it read as brushed.
// All static (depends only on px), so the video encoder pays for it once.
vec3 brushedMetal(vec2 px) {
  float fine = valueNoise(vec2(px.x / 150.0, px.y / 1.7));
  float coarse = valueNoise(vec2(px.x / 420.0 + 17.0, px.y / 7.0));
  float streaks = 0.6 * fine + 0.4 * coarse - 0.5; // -0.5..0.5

  // Highlight bands: a wide one towards the light, a faint narrow one on the right
  float band = 0.10 * exp(-pow((px.x - 300.0) / 210.0, 2.0))
             + 0.035 * exp(-pow((px.x - 790.0) / 80.0, 2.0));

  float v = mix(0.3, 0.74, uMetalTone) + band;
  v *= 1.0 + streaks * (0.08 + 1.1 * band);   // streaks pop inside the highlight
  v += (px.y / uResolution.y - 0.5) * 0.07;   // lighter at the top
  v += 0.03 * (valueNoise(px / 300.0) - 0.5); // big soft unevenness of the sheet
  return vec3(v) * vec3(0.97, 0.99, 1.025);   // slightly cool
}

// The lower plate: the same brushing, anodized a dark graphite.
vec3 anodize(vec3 metal) {
  return metal * vec3(0.33, 0.34, 0.37) + vec3(0.012, 0.013, 0.017);
}

// Polished chamfer of a hole cut into the face (display window, meter slot):
// the cut slopes down into the hole, so its lower part faces up and catches the
// light, its upper part faces away and is dark. d = SDF of the hole, n = its
// outward normal. Applied where 0 < d < width.
void holeChamfer(inout vec3 col, float d, vec2 n, float width) {
  float facing = -dot(n, LIGHT); // +1 lit .. -1 shaded
  vec3 cut = col * (0.82 + 0.45 * facing) + 0.1 * max(facing, 0.0);
  col = mix(col, cut, fill(d - width));
}

// Engraved line: a dark groove with a lit lower lip.
void groove(inout vec3 col, float distAcross, float along, float from, float to) {
  if (along < from || along > to) return;
  float dark = 1.0 - smoothstep(1.0, 2.0, abs(distAcross));
  float lip = 1.0 - smoothstep(0.8, 1.6, abs(distAcross + 2.6));
  col *= 1.0 - 0.45 * dark;
  col += 0.07 * lip;
}

// Shadows on the backdrop: a wide soft one away from the light, and a tight
// contact shadow right under the body.
void drawBodyShadow(inout vec3 col, vec2 px) {
  col *= 1.0 - 0.6 * exp(-max(sdRoundRect(px - vec2(14.0, -34.0), BODY, BODY_RADIUS), 0.0) / 45.0);
  col *= 1.0 - 0.6 * exp(-max(sdRoundRect(px - vec2(2.0, -BODY_DEPTH - 3.0), BODY, BODY_RADIUS), 0.0) / 6.0);
}

// Side wall: the body's thickness, seen below the face (the face outline
// moved down by BODY_DEPTH). t = 0 at the face edge, 1 at the bottom.
// dBody = SDF of the face.
void drawSideWall(inout vec3 col, vec2 px, float dBody) {
  float dSide = sdRoundRect(px + vec2(0.0, BODY_DEPTH), BODY, BODY_RADIUS);
  if (dSide > 1.0 || dBody < -1.0) return;
  float t = clamp(max(dBody, 0.0) / max(dBody - dSide, 1e-3), 0.0, 1.0);
  vec3 side = vec3(mix(0.07, 0.16, uMetalTone)) * (1.2 - 0.7 * t);
  side += 0.1 * (1.0 - smoothstep(0.0, 0.25, t)); // light catching the top of the wall
  col = mix(col, side, fill(dSide));
}

// The bare face: silver brushed metal above LOWER_PLATE_Y, dark anodized
// below, and the polished chamfer (RIM px) around the edge: lit along the top
// left, dark along the bottom right, with a crisp line where it meets the face
// and a bright highlight right at the outer edge.
vec3 faceMetal(vec2 px, float dBody) {
  vec3 metal = brushedMetal(px);
  if (px.y < LOWER_PLATE_Y) {
    metal = anodize(metal);
    // The silver face overhangs the plate a little: soft shadow under the seam
    metal *= 1.0 - 0.35 * exp(-(LOWER_PLATE_Y - px.y) / 10.0);
  }

  vec2 n = roundRectNormal(px, BODY, BODY_RADIUS);
  float facing = dot(n, LIGHT);
  float onRim = 1.0 - smoothstep(RIM - 1.0, RIM + 1.0, -dBody);
  vec3 rim = metal * (0.85 + 0.55 * facing) + 0.1 * max(facing, 0.0);
  metal = mix(metal, rim, onRim);
  metal += 0.08 * facing * (1.0 - smoothstep(0.5, 2.0, abs(-dBody - RIM)));
  metal += 0.2 * max(facing, 0.0) * (1.0 - smoothstep(0.5, 2.5, -dBody));
  return metal;
}
