<script lang="ts">
  // Waveform + play/pause for one decoded beat. The engine does the work: this
  // component only owns the <canvas>, creates the view, and shows the
  // Play/Pause button. The player comes from the parent (App), which shares it
  // with the preview so both follow the same playback position. The parent
  // also disposes it.
  import type { DecodedAudio } from '../engine/audio/decode'
  import type { Player } from '../engine/audio/player'
  import { createWaveformView } from '../engine/render/waveform-view'

  let { audio, player }: { audio: DecodedAudio; player: Player } = $props()

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

  async function toggle() {
    const p = player
    await p.toggle()
    // Read back from the player instead of flipping, in case play() bailed out.
    isPlaying = p.isPlaying()
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
