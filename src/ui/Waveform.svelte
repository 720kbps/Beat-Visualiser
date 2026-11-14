<script lang="ts">
  // Waveform + play/pause for one decoded beat. The engine does the work: this
  // component only owns the <canvas>, creates the player and the view, and
  // shows the Play/Pause button.
  import type { DecodedAudio } from '../engine/audio/decode'
  import { createPlayer, type Player } from '../engine/audio/player'
  import { createWaveformView } from '../engine/render/waveform-view'

  let { audio }: { audio: DecodedAudio } = $props()

  // Set by bind:this once the <canvas> exists. Not $state: it never changes after mount.
  let canvas: HTMLCanvasElement

  // Plain variable, not $state: the template never reads it.
  let player: Player | null = null

  // Only changes on play / pause / ended, so it's fine as Svelte state.
  // The playhead position is NOT here: the engine's frame loop reads it directly.
  let isPlaying = $state(false)

  // $effect runs after the component is in the page (so `canvas` is bound),
  // and re-runs whenever a $state or prop it reads changes, here `audio`.
  // Before each re-run, and when the component is removed, Svelte calls the
  // function we return. So a new beat = old player and view disposed (playback
  // stops), new ones created. onMount wouldn't re-run when `audio` changes.
  $effect(() => {
    const p = createPlayer(audio.buffer)
    p.onEnded(() => (isPlaying = false))
    const view = createWaveformView(canvas, audio.buffer, p.getTime, (s) =>
      p.seek(s),
    )
    player = p
    isPlaying = false

    return () => {
      view.dispose()
      p.dispose()
      player = null
    }
  })

  async function toggle() {
    if (!player) return
    await player.toggle()
    // Read back from the player instead of flipping, in case play() bailed out.
    isPlaying = player?.isPlaying() ?? false
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

<div class="flex flex-col gap-2">
  <!-- CSS sets the display size; the engine sets the pixel size (× devicePixelRatio). -->
  <canvas bind:this={canvas} class="block h-32 w-full cursor-pointer rounded"
  ></canvas>
  <div>
    <button
      class="w-20 rounded bg-sky-700 px-3 py-1 hover:bg-sky-600"
      onclick={toggle}
    >
      {isPlaying ? 'Pause' : 'Play'}
    </button>
    <span class="ml-2 text-sm text-zinc-400">Space to play/pause</span>
  </div>
</div>
