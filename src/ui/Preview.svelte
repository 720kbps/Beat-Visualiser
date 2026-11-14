<script lang="ts">
  // The 9:16 preview. The engine renders at the full 1080×1920; this
  // component only owns the <canvas>, gives it a display size with CSS, and
  // starts/stops the engine: the render context, the frame loop, and the
  // current theme (visualizer).
  import { onMount } from 'svelte'
  import {
    createRenderContext,
    disposeRenderContext,
    OUTPUT_HEIGHT,
    OUTPUT_WIDTH,
    startRenderLoop,
    type RenderContext,
  } from '../engine/render/renderer'
  import { PEAK_COLUMNS, type FrameSource } from '../engine/frame/frame-data'
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
    clip,
  }: {
    visualizer: Visualizer
    params: ParamValues
    frameSource: FrameSource | null // null = no beat loaded
    getTime: () => number // playback position in seconds, read every frame
    isPlaying: () => boolean // is the beat playing? read every frame
    clip: PluginClip | null // the recorded plugin window, null = none
  } = $props()

  // What we draw while no beat is loaded: silence at time 0, flat waveform.
  const idleFrame: FrameData = {
    time: 0,
    progress: 0,
    peaks: new Float32Array(PEAK_COLUMNS * 2),
    rms: 0,
    bass: 0,
    beat: false,
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

  // Displayed size in CSS pixels. Only changes when the layout changes (window
  // resize), not per frame, so Svelte state is fine here.
  let shownWidth = $state(0)
  let scalePercent = $derived(Math.round((shownWidth / OUTPUT_WIDTH) * 100))

  // Dev aid: shade the TikTok overlay area on top of the canvas.
  let showSafeZone = $state(false)

  let error = $state('')

  // One frame: everything is read here, every frame, as plain values. Per-frame
  // data (time, levels, playhead) never goes into Svelte state.
  function drawFrame() {
    if (!active) return
    const time = getTime()
    const frame = frameSource ? frameSource.getFrame(time) : idleFrame
    // The plugin video follows the beat's clock (play/pause/seek), then the
    // theme draws whatever frame the video is on.
    if (clip) clip.sync(time, isPlaying())
    frame.plugin = clip ? clip.video : undefined
    active.render(frame, params)
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
    const stop = startRenderLoop(drawFrame)

    return () => {
      stop()
      observer.disconnect()
      // Free the theme's GPU objects before the context goes away. The effect
      // below also disposes it on removal; dispose() is safe to call twice.
      active?.dispose()
      active = null
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

<div class="flex flex-col items-center gap-2">
  <!--
    The canvas' pixel size (canvas.width/height) is always 1080×1920, set by
    the engine. These classes only set how big it is SHOWN: a fixed height and
    a 9:16 aspect ratio give the width. The browser scales the image down.
  -->
  <div class="relative overflow-hidden rounded">
    <canvas
      bind:this={canvas}
      class="block aspect-9/16 h-[min(75vh,960px)] bg-black"
    ></canvas>
    {#if showSafeZone}
      <!--
        CSS only, drawn by the browser on top of the canvas. It's not part of
        the rendered 1080×1920 image, so it never ends up in the export.
        Shaded: the bottom 20% and the right 12% (TikTok's caption and buttons).
      -->
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 h-[20%] bg-red-500/30"
      ></div>
      <div
        class="pointer-events-none absolute top-0 right-0 bottom-[20%] w-[12%] bg-red-500/30"
      ></div>
    {/if}
  </div>
  <div class="flex items-center gap-4 text-sm text-zinc-400">
    <span>{OUTPUT_WIDTH}×{OUTPUT_HEIGHT}, shown at {scalePercent}%</span>
    <label class="flex items-center gap-1">
      <input type="checkbox" bind:checked={showSafeZone} />
      Show safe zone
    </label>
  </div>
  {#if error}
    <p class="text-sm text-red-400">{error}</p>
  {/if}
</div>
