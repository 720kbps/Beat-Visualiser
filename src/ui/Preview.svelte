<script lang="ts">
  // The 9:16 preview. The engine renders at the full 1080×1920; this
  // component only owns the <canvas>, gives it a display size with CSS, and
  // starts/stops the engine: the render context, the frame loop, and the
  // current theme (visualizer).
  import { onMount } from 'svelte'
  import SafeZoneOverlay from './SafeZoneOverlay.svelte'
  import {
    createRenderContext,
    disposeRenderContext,
    OUTPUT_HEIGHT,
    OUTPUT_WIDTH,
    startRenderLoop,
    type RenderContext,
  } from '../engine/render/renderer'
  import { PEAK_COLUMNS, type FrameSource } from '../engine/frame/frame-data'
  import { renderFrame } from '../engine/render/render-frame'
  import {
    createTitleCard,
    type TitleCard,
    type TitleText,
  } from '../engine/overlay/title-card'
  import type { PluginClip } from '../engine/video/plugin-clip'
  import type {
    FrameData,
    ParamValues,
    Visualizer,
  } from '../engine/visualizers/types'

  let {
    visualizer,
    params,
    frameSource,
    getTime,
    isPlaying,
    clips,
    title,
  }: {
    visualizer: Visualizer
    params: ParamValues
    frameSource: FrameSource | null // null = no beat loaded
    getTime: () => number // playback position in seconds, read every frame
    isPlaying: () => boolean // is the beat playing? read every frame
    clips: PluginClip[] // the recorded plugin windows, one per slot (top first)
    title: TitleText // the title card's text, read every frame
  } = $props()

  // What we draw while no beat is loaded: silence at time 0, flat waveform.
  const idleFrame: FrameData = {
    time: 0,
    progress: 0,
    peaks: new Float32Array(PEAK_COLUMNS * 2),
    rms: 0,
    bass: 0,
    beat: false,
    plugins: [],
  }

  // Set by bind:this once the <canvas> exists. Not $state: it never changes.
  let canvas: HTMLCanvasElement

  // The render context, created once on mount. $state.raw so the effect below
  // re-runs when it appears; .raw so Svelte doesn't wrap the Three.js renderer
  // in a reactive proxy.
  let ctx = $state.raw<RenderContext | null>(null)

  // The theme the frame loop draws with: set once it's initialized, null while
  // switching. A plain variable, not $state: only the frame loop reads it.
  let active: Visualizer | null = null

  // The title card, drawn over every theme. Created with the context.
  // A plain variable: only the frame loop and withRenderer read it.
  let titleCard: TitleCard | null = null

  // Displayed size in CSS pixels. Only changes when the layout changes (window
  // resize), not per frame, so Svelte state is fine here.
  let shownWidth = $state(0)
  let scalePercent = $derived(Math.round((shownWidth / OUTPUT_WIDTH) * 100))

  // Stops the frame loop; null while it isn't running (no context, or
  // paused for an export). Plain variable: never shown.
  let stopLoop: (() => void) | null = null
  let destroyed = false

  // Lends the renderer and the current theme to `work` (the export) and
  // pauses the preview's own loop meanwhile, so the two never draw into the
  // canvas at the same time. The theme keeps its GPU state between the two:
  // each theme exists once (module-level state), so export must use this
  // instance, not a second one. The loop restarts when `work` is done, also
  // after an error. Called from App via bind:this.
  export async function withRenderer<T>(
    work: (
      ctx: RenderContext,
      visualizer: Visualizer,
      titleCard: TitleCard,
    ) => Promise<T>,
  ): Promise<T> {
    if (!ctx || !active || !titleCard) {
      throw new Error('The preview is not ready yet.')
    }
    stopLoop?.()
    stopLoop = null
    try {
      return await work(ctx, active, titleCard)
    } finally {
      if (!destroyed) stopLoop = startRenderLoop(drawFrame)
    }
  }

  // Dev aid: shade the TikTok overlay area on top of the canvas.
  let showSafeZone = $state(false)

  let error = $state('')

  // One frame: everything is read here, every frame, as plain values. Per-frame
  // data (time, levels, playhead) never goes into Svelte state.
  function drawFrame() {
    if (!active || !titleCard) return
    const time = getTime()
    const frame = frameSource ? frameSource.getFrame(time) : idleFrame
    // Each plugin video follows the beat's clock (play/pause/seek), then the
    // theme draws whatever frame each video is on. Every clip has its own
    // offset, so they line up with the beat (and each other) separately.
    const playing = isPlaying()
    for (const clip of clips) clip.sync(time, playing)
    frame.plugins = clips.map((clip) => clip.video)
    renderFrame(active, frame, params, titleCard, title)
  }

  // onMount: the context and the loop have no inputs, so they're set up once.
  // The function onMount's callback returns is called when the component is removed.
  onMount(() => {
    // Watch the canvas' displayed size for the "shown at X%" label.
    const observer = new ResizeObserver((entries) => {
      shownWidth = entries[0].contentRect.width
    })
    observer.observe(canvas)

    let context: RenderContext
    try {
      context = createRenderContext(canvas)
    } catch (e) {
      // e.g. WebGL 2 unavailable or the GPU refused to create a context
      error = e instanceof Error ? e.message : String(e)
      return () => observer.disconnect()
    }
    ctx = context
    titleCard = createTitleCard(context)
    stopLoop = startRenderLoop(drawFrame)

    return () => {
      destroyed = true
      stopLoop?.()
      stopLoop = null
      observer.disconnect()
      // Free the theme's GPU objects before the context goes away. The effect
      // below also disposes it on removal; dispose() is safe to call twice.
      active?.dispose()
      active = null
      titleCard?.dispose()
      titleCard = null
      disposeRenderContext(context)
    }
  })

  // (Re)initializes the theme: runs when the context appears and whenever the
  // `visualizer` prop changes. The cleanup disposes the previous theme first.
  $effect(() => {
    const context = ctx
    const v = visualizer
    if (!context) return
    v.init(context)
    active = v
    return () => {
      active = null
      v.dispose()
    }
  })
</script>

<div class="flex flex-col items-center gap-3">
  <!--
    The canvas' pixel size (canvas.width/height) is always 1080×1920, set by
    the engine. These classes only set how big it is SHOWN: the height fills
    the window below the top bar, and the 9:16 aspect ratio gives the width.
    The browser scales the image down.
  -->
  <div
    class="relative overflow-hidden rounded-[20px] border border-line bg-black"
  >
    <canvas
      bind:this={canvas}
      class="block aspect-9/16 h-[min(calc(100vh-136px),960px)] min-h-96"
    ></canvas>
    {#if showSafeZone}
      <!-- Mock TikTok/Reels UI over the canvas; never part of the export -->
      <SafeZoneOverlay />
    {/if}
  </div>
  <div class="flex items-center gap-4 text-xs text-muted">
    <span class="font-mono tabular-nums">
      {OUTPUT_WIDTH} × {OUTPUT_HEIGHT} · shown at {scalePercent}%
    </span>
    <label class="flex cursor-pointer items-center gap-2 hover:text-soft">
      <input type="checkbox" bind:checked={showSafeZone} />
      Safe zone
    </label>
  </div>
  {#if error}
    <p class="text-sm text-bad">{error}</p>
  {/if}
</div>
