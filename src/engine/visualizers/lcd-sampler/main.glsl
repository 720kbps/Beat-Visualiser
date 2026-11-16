// ---------- Main ----------

// Everything on the face of the device, drawn onto the metal color.
vec3 deviceFace(vec2 px, vec3 metal) {
  vec3 col = metal;

  // Seam where the silver face meets the dark lower plate, an engraved line
  // between pads and buttons, and one left of the side column
  groove(col, px.y - LOWER_PLATE_Y, px.x, BODY.x, BODY.z);
  groove(col, px.y - 571.0, px.x, 44.0, SIDE_DIVIDER_X - 12.0);
  groove(col, px.x - SIDE_DIVIDER_X, px.y, LOWER_PLATE_Y + 24.0, DISPLAY.w);

  // Display window with both screens (safe zone)
  if (px.y > DISPLAY.y - DISPLAY_CHAMFER - 2.0 && px.x < DISPLAY.z + DISPLAY_CHAMFER + 2.0) {
    drawDisplayPanel(col, px);
    drawScreen(col, px, MAIN_GLASS, true);
    drawScreen(col, px, WAVE_GLASS, false);
  }

  if (px.y > 818.0 && px.y < 936.0) drawMeter(col, px);

  // Pads: red, orange, yellow, teal. The red one lights up with the bass, and
  // its light spills onto the metal around its well.
  float padGlow = smoothstep(0.4, 1.0, uBass);
  if (px.y > 520.0 && px.y < 890.0 && px.x < 400.0) {
    vec4 well = vec4(PAD_X0 - 9.0, PAD_Y0 - 9.0, PAD_X0 + PAD_W + 9.0, PAD_Y1 + 9.0);
    float d = sdRoundRect(px, well, PAD_RADIUS + 8.0);
    col += PAD_RED * padGlow * 0.2 * exp(-max(d, 0.0) / 16.0) * (1.0 - smoothstep(40.0, 70.0, d));
  }
  if (px.y > 585.0 && px.y < 825.0 && px.x < 925.0) {
    int i = int(clamp(floor((px.x - PAD_X0 + 16.0) / PAD_PITCH), 0.0, 3.0));
    vec4 rect = vec4(PAD_X0 + float(i) * PAD_PITCH, PAD_Y0, PAD_X0 + float(i) * PAD_PITCH + PAD_W, PAD_Y1);
    vec3 color = i == 0 ? PAD_RED : i == 1 ? PAD_ORANGE : i == 2 ? PAD_YELLOW : PAD_TEAL;
    drawPad(col, px, rect, color, i == 0 ? padGlow : 0.0);
  }

  // Transport buttons
  if (px.y > 440.0 && px.y < 556.0 && px.x < 925.0) {
    int i = int(clamp(floor((px.x - PAD_X0 + 12.0) / BUTTON_PITCH), 0.0, 4.0));
    float x0 = PAD_X0 + float(i) * BUTTON_PITCH;
    drawButton(col, px, vec4(x0, BUTTON_Y0, x0 + BUTTON_W, BUTTON_Y1), i);
  }

  // After the meter and the pads: the bass LED's light falls on both
  if (px.y > 790.0 && px.y < 960.0 && px.x > 760.0) drawBassLed(col, px);

  // Knobs and speaker grille on the lower plate (bottom 20%: decoration only)
  if (px.y < LOWER_PLATE_Y - 4.0) {
    drawKnob(col, px, vec2(142.0, KNOB_Y), -1.4, PAD_RED);
    drawKnob(col, px, vec2(328.0, KNOB_Y), 0.35, PAD_ORANGE);
    drawKnob(col, px, vec2(514.0, KNOB_Y), 1.6, PAD_TEAL);
    drawGrille(col, px);
  }

  if (px.x > SIDE_DIVIDER_X) drawSideColumn(col, px);

  if (px.y > 1830.0) drawBadge(col, px);
  drawScrew(col, px, vec2(62.0, 84.0), 0.3);
  drawScrew(col, px, vec2(1018.0, 84.0), 1.1);
  drawScrew(col, px, vec2(62.0, 1864.0), 0.7);
  drawScrew(col, px, vec2(1018.0, 1864.0), 0.1);
  return col;
}

void main() {
  vec2 px = toDevice(gl_FragCoord.xy); // device pixels, see common.glsl (Layout)

  vec3 col = background(px);
  drawBodyShadow(col, px);

  float dBody = sdRoundRect(px, BODY, BODY_RADIUS);
  drawSideWall(col, px, dBody);

  if (dBody < 1.0) {
    vec3 face = deviceFace(px, faceMetal(px, dBody));
    col = mix(col, face, fill(dBody));
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
