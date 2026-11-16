<script lang="ts">
  // Waveform + play/pause for one decoded beat, with the section that gets
  // recorded drawn on top. The section can be dragged (or moved with the
  // arrow keys); the parent snaps it to bars. The engine draws the waveform:
  // this component owns the <canvas>, the section box and the Play button.
  // The player comes from the parent (App), which shares it with the preview
  // so both follow the same playback position. The parent also disposes it.
  import type { DecodedAudio } from '../engine/audio/decode'
  import type { Player } from '../engine/audio/player'
  import { createWaveformView } from '../engine/render/waveform-view'

  let {
    audio,
    player,
    sectionStart,
    sectionLength,
    step,
    label,
    onmove,
    disabled = false,
  }: {
    audio: DecodedAudio
    player: Player
    sectionStart: number // seconds
    sectionLength: number // seconds
    step: number // seconds per arrow key press (one bar, or 1 s)
    label: string // shown inside the section, e.g. "bars 33–40"
    onmove: (start: number) => void // the parent snaps and clamps it
    disabled?: boolean // no moving (while recording or exporting)
  } = $props()

  // The section box, as shares of the canvas width (CSS only).
  let leftPercent = $derived((sectionStart / audio.duration) * 100)
  let widthPercent = $derived(
    Math.min(100 - leftPercent, (sectionLength / audio.duration) * 100),
  )

  // Set by bind:this once the <canvas> exists. Not $state: it never changes after mount.
  let canvas: HTMLCanvasElement

  // Only changes on play / pause / ended, so it's fine as Svelte state.
  // The playhead position is NOT here: the engine's frame loop reads it directly.
  let isPlaying = $state(false)

  // $effect runs after the component is in the page (so `canvas` is bound),
  // and re-runs whenever a $state or prop it reads changes, here `audio` and
  // `player`. Before each re-run, and when the component is removed, Svelte
  // calls the function we return. So a new beat = old view disposed, new one
  // created. (Stopping the old playback is the parent's job: it owns the player.)
  $effect(() => {
    const p = player
    p.onEnded(() => (isPlaying = false))
    const view = createWaveformView(canvas, audio.buffer, p.getTime, (s) =>
      p.seek(s),
    )
    isPlaying = p.isPlaying()

    return () => {
      view.dispose()
      p.onEnded(() => {}) // don't touch this component's state after it's gone
    }
  })

  // Play starts at the section when the playhead is outside it, so "Play"
  // previews what will be recorded.
  async function toggle() {
    const p = player
    if (!p.isPlaying()) {
      const t = p.getTime()
      if (t < sectionStart || t >= sectionStart + sectionLength) {
        p.seek(sectionStart)
      }
    }
    await p.toggle()
    // Read back from the player instead of flipping, in case play() bailed out.
    isPlaying = p.isPlaying()
  }

  // Dragging the section. Plain variable: only the pointer handlers use it.
  // x = where the pointer went down, start = the section start back then,
  // width = the waveform's width in CSS pixels (seconds per pixel).
  let drag: { x: number; start: number; width: number } | null = null
  let dragging = $state(false) // for the cursor style

  function onPointerDown(event: PointerEvent) {
    if (disabled) return
    const box = event.currentTarget as HTMLElement
    const width = box.parentElement?.getBoundingClientRect().width ?? 0
    if (width === 0) return
    drag = { x: event.clientX, start: sectionStart, width }
    // Keep getting move events even when the pointer leaves the box
    box.setPointerCapture(event.pointerId)
    dragging = true
    event.preventDefault()
  }

  function onPointerMove(event: PointerEvent) {
    if (!drag) return
    const seconds = ((event.clientX - drag.x) / drag.width) * audio.duration
    onmove(drag.start + seconds)
  }

  // Letting go (or a plain click on the section): play from its start next.
  function onPointerUp() {
    if (!drag) return
    drag = null
    dragging = false
    player.seek(sectionStart)
  }

  function onSectionKeydown(event: KeyboardEvent) {
    if (disabled) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      onmove(sectionStart + (event.key === 'ArrowLeft' ? -step : step))
    }
  }

  // Space bar toggles play/pause, except when focus is in a text field, or on
  // a button (Space already "clicks" a focused button, it would toggle twice).
  function onKeydown(event: KeyboardEvent) {
    if (event.code !== 'Space' || event.repeat) return
    const target = event.target
    if (
      target instanceof Element &&
      target.closest('input, textarea, select, button, [contenteditable]')
    ) {
      return
    }
    event.preventDefault() // don't scroll the page
    toggle()
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex flex-col gap-3">
  <div class="relative overflow-hidden rounded-lg">
    <!-- CSS sets the display size; the engine sets the pixel size (× devicePixelRatio). -->
    <canvas bind:this={canvas} class="block h-24 w-full cursor-pointer"
    ></canvas>
    <!--
      The section that gets recorded and exported, drawn by CSS on top of the
      canvas. Clicks outside it reach the canvas (seeking); the box itself is
      dragged. role="slider" so the arrow keys and screen readers work too.
    -->
    <div
      class={[
        'absolute inset-y-0 touch-none border-x-2 border-accent bg-accent/15 transition-colors duration-150 ease-out outline-none focus-visible:bg-accent/25',
        disabled
          ? 'cursor-default opacity-60'
          : dragging
            ? 'cursor-grabbing bg-accent/25'
            : 'cursor-grab hover:bg-accent/20',
      ]}
      style:left="{leftPercent}%"
      style:width="{widthPercent}%"
      role="slider"
      tabindex={disabled ? -1 : 0}
      aria-label="Section"
      aria-valuemin={0}
      aria-valuemax={Math.round(audio.duration)}
      aria-valuenow={Math.round(sectionStart)}
      aria-valuetext={label}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      onkeydown={onSectionKeydown}
    >
      <span
        class="pointer-events-none absolute bottom-1 left-1.5 font-mono text-xs whitespace-nowrap text-accent"
      >
        {label}
      </span>
    </div>
  </div>
  <div class="flex items-center gap-3">
    <button class="btn btn-secondary w-20" onclick={toggle}>
      {isPlaying ? 'Pause' : 'Play'}
    </button>
    <span class="text-xs text-muted">
      <span class="kbd">Space</span> plays the section, drag it to move it, click
      the waveform to seek
    </span>
  </div>
</div>
