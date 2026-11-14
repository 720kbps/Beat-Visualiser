<script lang="ts">
  // Phase 1 spike: play/stop FL, list open windows and record one. Throwaway UI.
  import { invoke } from '@tauri-apps/api/core'
  import DropZone from './DropZone.svelte'
  import Waveform from './Waveform.svelte'
  import type { BeatFile } from './beat-file'
  import { decodeAudio, type DecodedAudio } from '../engine/audio/decode'
  import { formatTime } from '../engine/render/waveform-helpers'

  // Matches the Rust `WindowInfo` struct (fields stay snake_case).
  type WindowInfo = {
    id: number
    title: string
    app_name: string
    width: number // real pixels
    height: number
    on_screen: boolean
    is_fl: boolean
  }

  // The dropped beat. `$state.raw` instead of `$state`: plain `$state` wraps
  // plain objects in a deep reactive proxy. We never change fields of this
  // object, only replace it with a new one, so the proxy is pointless. With
  // `.raw`, the object (and its big ArrayBuffer) is stored as-is and only
  // reassigning `beat` triggers updates.
  let beat = $state.raw<BeatFile | null>(null)

  // The decoded samples of `beat`. `$state.raw` for the same reason: the
  // AudioBuffer is big and only ever replaced, never changed field by field.
  let decoded = $state.raw<DecodedAudio | null>(null)
  let decoding = $state(false)
  let decodeError = $state('')

  async function onBeatFile(file: BeatFile) {
    beat = file
    // Clearing this removes the old <Waveform>, and its cleanup stops the old playback.
    decoded = null
    decodeError = ''
    decoding = true
    try {
      const result = await decodeAudio(file.bytes)
      // Another file may have been dropped while this one was decoding: keep the newest.
      if (beat === file) decoded = result
    } catch (e) {
      if (beat === file) {
        decodeError = e instanceof Error ? e.message : String(e)
      }
    } finally {
      if (beat === file) decoding = false
    }
  }

  // Free-text substring match on the window title, so any plugin works.
  // Default: Ogun, FL Studio's built-in synth.
  let titleFilter = $state('Ogun')
  let windows = $state<WindowInfo[]>([])
  let error = $state('')
  let recording = $state(false)
  let savedPath = $state('')

  // Last FL command result, e.g. "Sent play" or the error from Rust.
  let flStatus = $state('')

  async function sendToFl(command: 'fl_play' | 'fl_stop', label: string) {
    try {
      await invoke(command)
      flStatus = `Sent ${label}`
    } catch (e) {
      flStatus = String(e)
    }
  }

  async function listWindows() {
    error = ''
    try {
      // Tauri maps the camelCase key `titleFilter` to the Rust arg `title_filter`.
      windows = await invoke<WindowInfo[]>('list_windows', { titleFilter })
    } catch (e) {
      windows = []
      error = String(e)
    }
  }

  async function recordWindow(windowId: number) {
    error = ''
    savedPath = ''
    recording = true
    try {
      // Rust returns the path of the saved .mov file.
      savedPath = await invoke<string>('record_window', {
        windowId,
        seconds: 10,
      })
    } catch (e) {
      error = String(e)
    } finally {
      recording = false
    }
  }
</script>

<main class="min-h-screen bg-zinc-900 p-6 text-zinc-200">
  <h1 class="mb-4 text-2xl font-bold text-sky-400">Beat Visualiser</h1>

  <section class="mb-6">
    <h2 class="mb-2 font-semibold">Beat</h2>
    <DropZone onfile={onBeatFile} />
    {#if beat}
      <p class="mt-2 text-sm text-zinc-300">
        {beat.name} · {(beat.bytes.byteLength / (1024 * 1024)).toFixed(1)} MB
        {#if decoded}
          · {formatTime(decoded.duration)} · {decoded.sampleRate / 1000} kHz ·
          {decoded.channels === 1 ? 'mono' : `${decoded.channels} ch`}
        {/if}
      </p>
    {/if}
    {#if decoding}
      <p class="mt-2 text-sm text-zinc-400">Decoding…</p>
    {/if}
    {#if decodeError}
      <p class="mt-2 text-red-400">{decodeError}</p>
    {/if}
    {#if decoded}
      <div class="mt-3">
        <Waveform audio={decoded} />
      </div>
    {/if}
  </section>

  <section class="mb-6">
    <h2 class="mb-2 font-semibold">FL Studio</h2>
    <div class="flex items-center gap-2">
      <button
        class="rounded bg-green-700 px-3 py-1 hover:bg-green-600"
        onclick={() => sendToFl('fl_play', 'play')}
      >
        Play
      </button>
      <button
        class="rounded bg-zinc-700 px-3 py-1 hover:bg-zinc-600"
        onclick={() => sendToFl('fl_stop', 'stop')}
      >
        Stop
      </button>
      <span class="text-sm text-zinc-400">{flStatus}</span>
    </div>
  </section>

  <div class="mb-4 flex gap-2">
    <input
      class="rounded bg-zinc-800 px-2 py-1"
      placeholder="Title contains (empty = all)"
      bind:value={titleFilter}
    />
    <button
      class="rounded bg-sky-600 px-3 py-1 hover:bg-sky-500 disabled:opacity-50"
      onclick={listWindows}
      disabled={recording}
    >
      List windows
    </button>
  </div>

  {#if recording}
    <p class="mb-4 text-amber-400">Recording…</p>
  {/if}

  {#if savedPath}
    <p class="mb-4 text-green-400">Saved: {savedPath}</p>
  {/if}

  {#if error}
    <p class="mb-4 text-red-400">{error}</p>
  {/if}

  <ul class="space-y-1 font-mono text-sm">
    {#each windows as w (w.id)}
      <li class={w.is_fl ? 'rounded bg-sky-900 px-2 py-1' : 'px-2 py-1'}>
        {w.app_name} | {w.title} | {w.width}x{w.height} | id {w.id}
        {#if !w.on_screen}(off screen){/if}
        {#if w.is_fl}<span class="text-sky-300">FL</span>{/if}
        <button
          class="ml-2 rounded bg-red-700 px-2 hover:bg-red-600 disabled:opacity-50"
          onclick={() => recordWindow(w.id)}
          disabled={recording}
        >
          Record 10 s
        </button>
      </li>
    {/each}
  </ul>
</main>
