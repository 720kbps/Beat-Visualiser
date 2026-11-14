<script lang="ts">
  // Phase 1 spike: play/stop FL, list open windows and record one. Throwaway UI.
  import { convertFileSrc, invoke } from '@tauri-apps/api/core'
  import DropZone from './DropZone.svelte'
  import Waveform from './Waveform.svelte'
  import Preview from './Preview.svelte'
  import ParamControls from './ParamControls.svelte'
  import type { BeatFile } from './beat-file'
  import { decodeAudio, type DecodedAudio } from '../engine/audio/decode'
  import { createPlayer, type Player } from '../engine/audio/player'
  import {
    createFrameSource,
    type FrameSource,
  } from '../engine/frame/frame-data'
  import { formatTime } from '../engine/render/waveform-helpers'
  import { getVisualizer, visualizers } from '../engine/visualizers'
  import { defaultParams } from '../engine/visualizers/params'
  import type { Visualizer } from '../engine/visualizers/types'
  import { loadPluginClip, type PluginClip } from '../engine/video/plugin-clip'

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

  // One player for the decoded beat, shared by the waveform (play/pause/seek)
  // and the preview (reads the time every frame), so both show the same
  // position. Created here and disposed here, nowhere else.
  // $state.raw: replaced as a whole, never changed field by field.
  let player = $state.raw<Player | null>(null)

  // Per-frame values (levels, peaks, progress) for the themes, computed once
  // from the decoded samples. Covers the whole beat for now; Phase 4 picks a section.
  let frameSource = $state.raw<FrameSource | null>(null)

  // Stops playback and drops the old beat's player and frame source.
  function clearPlayback() {
    player?.dispose()
    player = null
    frameSource = null
  }

  async function onBeatFile(file: BeatFile) {
    beat = file
    // A new beat stops the old one right away. Clearing `decoded` and `player`
    // also removes the old <Waveform>.
    clearPlayback()
    decoded = null
    decodeError = ''
    decoding = true
    try {
      const result = await decodeAudio(file.bytes)
      // Another file may have been dropped while this one was decoding: keep the newest.
      if (beat === file) {
        decoded = result
        player = createPlayer(result.buffer)
        // One pass over the samples (~50 ms per minute of audio), then lookups.
        frameSource = createFrameSource(result.buffer)
      }
    } catch (e) {
      if (beat === file) {
        decodeError = e instanceof Error ? e.message : String(e)
      }
    } finally {
      if (beat === file) decoding = false
    }
  }

  // The preview's playback clock. The player's time is seconds into the
  // buffer, and the frame source covers the whole buffer, so they line up.
  // Called by the preview's frame loop; reading `player` there is a plain read.
  function getPlaybackTime(): number {
    return player ? player.getTime() : 0
  }

  function isBeatPlaying(): boolean {
    return player ? player.isPlaying() : false
  }

  // The recorded plugin window shown on the device screen. $state.raw: it
  // holds a <video> element, which must not be wrapped in a proxy.
  let clip = $state.raw<PluginClip | null>(null)
  let clipPath = $state('') // file of `clip`, shown in the UI
  let clipLoading = $state(false)
  let clipError = $state('')
  // Counts load requests, so a slow load that finishes after a newer one
  // (or after Clear) is thrown away. Plain variable: never shown.
  let clipRequest = 0

  // Loads a recording by its file path and makes it the current clip.
  async function loadClip(path: string) {
    const request = ++clipRequest
    clipError = ''
    clipLoading = true
    try {
      // convertFileSrc turns the path into an asset:// URL that Tauri serves
      // from disk (allowed folder: assetProtocol.scope in tauri.conf.json).
      // It streams with HTTP range requests, so big files aren't read into
      // memory, and its CORS headers keep the video usable as a WebGL texture.
      const next = await loadPluginClip(convertFileSrc(path))
      if (request !== clipRequest) {
        next.dispose() // a newer request or Clear came in meanwhile
        return
      }
      clip?.dispose()
      clip = next
      clipPath = path
    } catch (e) {
      if (request === clipRequest) {
        clipError = e instanceof Error ? e.message : String(e)
      }
    } finally {
      if (request === clipRequest) clipLoading = false
    }
  }

  async function useLatestRecording() {
    clipError = ''
    try {
      const path = await invoke<string | null>('latest_recording')
      if (path) {
        await loadClip(path)
      } else {
        clipError = 'No recordings yet. Record a window first.'
      }
    } catch (e) {
      clipError = String(e)
    }
  }

  function clearClip() {
    clipRequest++ // cancels a load that's still running
    clip?.dispose()
    clip = null
    clipPath = ''
    clipError = ''
    clipLoading = false
  }

  // "spike-1794617731.mov" from the full path (/ on macOS, \ on Windows).
  function fileName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path
  }

  // The selected theme. $state.raw: a theme object holds GPU state and must
  // not be wrapped in a proxy. The first registered theme is the default.
  let theme = $state.raw<Visualizer>(visualizers[0])

  // The theme's control values. Plain $state (a deep proxy) so ParamControls
  // can change single fields; the preview reads them every frame.
  let params = $state(defaultParams(visualizers[0].params))

  // Switching themes resets the controls to the new theme's defaults.
  function selectTheme(id: string) {
    const v = getVisualizer(id)
    if (!v) return
    theme = v
    params = defaultParams(v.params)
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
    // Show the new recording on the device screen right away.
    if (savedPath) await loadClip(savedPath)
  }
</script>

<main class="min-h-screen bg-zinc-900 p-6 text-zinc-200">
  <h1 class="mb-4 text-2xl font-bold text-sky-400">Beat Visualiser</h1>

  <!--
    Two columns: controls on the left (takes the remaining width, minmax(0, 1fr)
    lets it shrink below its content so long window titles don't push the
    preview off screen), the preview on the right (as wide as it needs).
  -->
  <div class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-8">
    <div>
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
        {#if decoded && player}
          <div class="mt-3">
            <Waveform audio={decoded} {player} />
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

      <section class="mb-6">
        <h2 class="mb-2 font-semibold">Plugin recording</h2>
        <div class="flex items-center gap-2">
          <button
            class="rounded bg-sky-700 px-3 py-1 hover:bg-sky-600 disabled:opacity-50"
            onclick={useLatestRecording}
            disabled={clipLoading}
          >
            Use latest recording
          </button>
          <button
            class="rounded bg-zinc-700 px-3 py-1 hover:bg-zinc-600 disabled:opacity-50"
            onclick={clearClip}
            disabled={!clip && !clipLoading}
          >
            Clear
          </button>
        </div>
        {#if clipLoading}
          <p class="mt-2 text-sm text-zinc-400">Loading recording…</p>
        {/if}
        {#if clip}
          <p class="mt-2 text-sm text-zinc-300" title={clipPath}>
            {fileName(clipPath)} · {clip.width}×{clip.height} ·
            {formatTime(clip.duration)}
          </p>
        {/if}
        {#if clipError}
          <p class="mt-2 text-sm text-red-400">{clipError}</p>
        {/if}
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
    </div>

    <!-- sticky: the preview stays in view when the left column scrolls -->
    <section class="sticky top-6">
      <div class="mb-2 flex items-center gap-3">
        <h2 class="font-semibold">Preview</h2>
        <select
          class="rounded bg-zinc-800 px-2 py-1 text-sm"
          value={theme.id}
          onchange={(e) => selectTheme(e.currentTarget.value)}
        >
          {#each visualizers as v (v.id)}
            <option value={v.id}>{v.name}</option>
          {/each}
        </select>
      </div>
      <div class="flex items-start gap-4">
        <Preview
          visualizer={theme}
          {params}
          {frameSource}
          getTime={getPlaybackTime}
          isPlaying={isBeatPlaying}
          {clip}
        />
        {#if theme.params.length > 0}
          <div class="w-64">
            <ParamControls schema={theme.params} bind:values={params} />
          </div>
        {/if}
      </div>
    </section>
  </div>
</main>
