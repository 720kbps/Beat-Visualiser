<!--
  A mock of the generic TikTok / Reels / Shorts interface, drawn over the
  preview so you can see what the app's buttons and caption will cover.
  CSS/SVG only, on top of the canvas: it's not part of the rendered
  1080×1920 image, so it never ends up in the export.

  The SVG uses the video's own pixel coordinates (viewBox 0 0 1080 1920) and
  is stretched over the canvas, so it scales with the preview. The shaded
  areas are the safe-zone rule from CLAUDE.md: bottom 20% (y > 1536) and
  right 12% (x > 950). Icons are generic shapes, no platform logos.
-->
<script lang="ts">
  // Right rail: icon centers. x is the middle of the right 12% strip.
  const RAIL_X = 1015
  const ICON = 84 // icon size in video pixels
  const ICON_SCALE = ICON / 24 // the paths below are drawn on a 24×24 grid

  // Filled 24×24 icons (heart, comment, bookmark, share).
  const railIcons = [
    {
      y: 1110,
      count: '8,214',
      d: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z',
    },
    { y: 1270, count: '312', d: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z' },
    {
      y: 1430,
      count: '1,045',
      d: 'm19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z',
    },
    {
      y: 1590,
      count: '96',
      d: 'M13 4l9 8-9 8v-4.5C7 15.5 4 17.5 2 21c.5-6.5 4-10.5 11-11.5Z',
    },
  ]
</script>

<svg
  class="pointer-events-none absolute inset-0 h-full w-full font-sans"
  viewBox="0 0 1080 1920"
  preserveAspectRatio="none"
  aria-hidden="true"
>
  <defs>
    <!-- Platforms put a soft shadow under their white UI so it reads on any video -->
    <filter id="ui-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-opacity="0.45" />
    </filter>
  </defs>

  <!-- The covered areas, lightly shaded -->
  <rect x="0" y="1536" width="1080" height="384" fill="black" opacity="0.3" />
  <rect x="950" y="0" width="130" height="1536" fill="black" opacity="0.3" />

  <g filter="url(#ui-shadow)" fill="white">
    <!-- Profile picture with a follow button -->
    <circle
      cx={RAIL_X}
      cy="1010"
      r="50"
      fill="#3a3f4c"
      stroke="white"
      stroke-width="4"
    />
    <circle cx={RAIL_X} cy="1062" r="18" fill="#ff4d5e" />
    <path
      d="M{RAIL_X - 9} 1062h18M{RAIL_X} 1053v18"
      stroke="white"
      stroke-width="4"
      stroke-linecap="round"
    />

    <!-- Like, comment, save, share, each with a count -->
    {#each railIcons as icon (icon.y)}
      <g
        transform="translate({RAIL_X - ICON / 2} {icon.y}) scale({ICON_SCALE})"
        opacity="0.95"
      >
        <path d={icon.d} />
      </g>
      <text
        x={RAIL_X}
        y={icon.y + ICON + 36}
        font-size="30"
        font-weight="600"
        text-anchor="middle"
      >
        {icon.count}
      </text>
    {/each}

    <!-- Spinning record of the sound (static here) -->
    <circle
      cx={RAIL_X}
      cy="1810"
      r="46"
      fill="#1d2028"
      stroke="#4a4f5a"
      stroke-width="12"
    />
    <circle cx={RAIL_X} cy="1810" r="16" fill="#8a8f9c" />

    <!-- Caption block, bottom left -->
    <text x="40" y="1690" font-size="44" font-weight="600">@yourname</text>
    <text x="40" y="1752" font-size="38" opacity="0.92">
      New beat out now · 140 BPM #typebeat
    </text>
    <g transform="translate(40 1790) scale(1.6)" opacity="0.92">
      <path
        d="M9 18V5l12-2v13"
        fill="none"
        stroke="white"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </g>
    <text x="96" y="1822" font-size="34" opacity="0.92">
      original sound - yourname
    </text>
  </g>

  <!-- Playback progress line along the bottom edge -->
  <rect x="0" y="1908" width="1080" height="6" fill="white" opacity="0.25" />
  <rect x="0" y="1908" width="380" height="6" fill="white" opacity="0.85" />

  <!-- Where text and the main screen belong -->
  <rect
    x="1"
    y="1"
    width="948"
    height="1534"
    fill="none"
    stroke="var(--color-accent)"
    stroke-opacity="0.6"
    stroke-width="3"
    stroke-dasharray="16 12"
  />
</svg>
