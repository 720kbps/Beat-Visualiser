<script lang="ts">
  // One-button flow: drop the beat, pick the plugin window, pick a length,
  // press "Play & record". FL plays from the song start while the app records
  // the window; the recording then shows in the preview, lined up with the beat.
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

  // Matches the Rust `Take` struct (take.rs).
  type Take = {
    path: string
    play_offset: number // video seconds at which FL started playing
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
  // `offset`: where beat time 0 is in the video (a take's play_offset).
  // Returns true if this clip is now shown.
  async function loadClip(path: string, offset = 0): Promise<boolean> {
    const request = ++clipRequest
    clipError = ''
    clipLoading = true
    try {
      // convertFileSrc turns the path into an asset:// URL that Tauri serves
      // from disk (allowed folder: assetProtocol.scope in tauri.conf.json).
      // It streams with HTTP range requests, so big files aren't read into
      // memory, and its CORS headers keep the video usable as a WebGL texture.
      const next = await loadPluginClip(convertFileSrc(path), offset)
      if (request !== clipRequest) {
        next.dispose() // a newer request or Clear came in meanwhile
        return false
      }
      clip?.dispose()
      clip = next
      clipPath = path
      return true
    } catch (e) {
      if (request === clipRequest) {
        clipError = e instanceof Error ? e.message : String(e)
      }
      return false
    } finally {
      if (request === clipRequest) clipLoading = false
    }
  }

  async function useLatestRecording() {
    clipError = ''
    try {
      const path = await invoke<string | null>('latest_recording')
      if (path) {
        await loadClip(path) // offset 0: we don't know when FL started
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

  // "take-1794617731.mov" from the full path (/ on macOS, \ on Windows).
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
  let windowsError = $state('')
  // The plugin window to record (its id from list_windows), null = none picked.
  let selectedWindowId = $state<number | null>(null)

  async function listWindows() {
    windowsError = ''
    try {
      // Tauri maps the camelCase key `titleFilter` to the Rust arg `title_filter`.
      windows = await invoke<WindowInfo[]>('list_windows', { titleFilter })
    } catch (e) {
      windows = []
      windowsError = String(e)
    }
    // Forget the selection if that window is gone (or now off screen).
    const still = windows.find((w) => w.id === selectedWindowId)
    if (!still || !still.on_screen) selectedWindowId = null
  }

  // Take length in seconds. The spec lengths; the take is capped to the beat.
  const LENGTHS = [15, 30, 60]
  let length = $state(15)
  // What we really record: the chosen length, but never longer than the beat.
  let takeSeconds = $derived(
    decoded
      ? Math.max(1, Math.min(length, Math.floor(decoded.duration)))
      : length,
  )

  let recording = $state(false)
  // Whole seconds since "Play & record" was pressed. Only a UI counter,
  // updated 4 times a second; not render-loop data.
  let recordingElapsed = $state(0)
  let takeStatus = $state('') // e.g. "Done — press Play to preview"
  let takeError = $state('')

  let canRecord = $derived(
    decoded !== null && selectedWindowId !== null && !recording,
  )

  // The one button: FL plays from the start while Rust records the window,
  // then the recording goes into the preview with its play offset.
  async function playAndRecord() {
    if (selectedWindowId === null) return
    // Don't play the beat in the app on top of FL.
    player?.pause()
    takeError = ''
    takeStatus = ''
    recording = true
    recordingElapsed = 0
    const seconds = takeSeconds
    const startedAt = performance.now()
    const timer = setInterval(() => {
      const elapsed = Math.floor((performance.now() - startedAt) / 1000)
      recordingElapsed = Math.min(elapsed, seconds)
    }, 250)

    try {
      const take = await invoke<Take>('record_take', {
        windowId: selectedWindowId,
        seconds,
      })
      if (await loadClip(take.path, take.play_offset)) {
        // Back to the start, so Play shows the take from its first beat.
        player?.seek(0)
        takeStatus = 'Done — press Play to preview'
      }
    } catch (e) {
      takeError = String(e)
    } finally {
      clearInterval(timer)
      recording = false
    }
  }

  // Debug: last FL command result, e.g. "Sent play" or the error from Rust.
  let flStatus = $state('')

  async function sendToFl(command: 'fl_play' | 'fl_stop', label: string) {
    try {
      await invoke(command)
      flStatus = `Sent ${label}`
    } catch (e) {
      flStatus = String(e)
    }
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
        <h2 class="mb-2 font-semibold">1. Beat</h2>
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
        <h2 class="mb-2 font-semibold">2. Plugin window</h2>
        <div class="mb-2 flex gap-2">
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
        {#if windowsError}
          <p class="mb-2 text-sm text-red-400">{windowsError}</p>
        {/if}
        <!-- One radio per window; the whole row is the label, so it's clickable. -->
        <ul class="space-y-1 font-mono text-sm">
          {#each windows as w (w.id)}
            <li>
              <label
                class={[
                  'flex cursor-pointer items-center gap-2 rounded px-2 py-1',
                  w.id === selectedWindowId
                    ? 'bg-sky-800 text-white'
                    : 'hover:bg-zinc-800',
                  !w.on_screen && 'cursor-not-allowed opacity-50',
                ]}
              >
                <input
                  type="radio"
                  name="plugin-window"
                  value={w.id}
                  bind:group={selectedWindowId}
                  disabled={!w.on_screen || recording}
                />
                <span class="truncate">
                  {w.app_name} | {w.title} | {w.width}×{w.height}
                </span>
                {#if !w.on_screen}
                  <span class="text-zinc-400">(off screen)</span>
                {/if}
                {#if w.is_fl}<span class="text-sky-300">FL</span>{/if}
              </label>
            </li>
          {/each}
        </ul>
      </section>

      <section class="mb-6">
        <h2 class="mb-2 font-semibold">3. Length</h2>
        <div class="flex items-center gap-2">
          {#each LENGTHS as seconds (seconds)}
            <button
              class={[
                'rounded px-3 py-1 disabled:opacity-50',
                seconds === length
                  ? 'bg-sky-600 text-white'
                  : 'bg-zinc-700 hover:bg-zinc-600',
              ]}
              onclick={() => (length = seconds)}
              disabled={recording}
            >
              {seconds} s
            </button>
          {/each}
          {#if decoded && takeSeconds < length}
            <span class="text-sm text-zinc-400">
              The beat is shorter: records {takeSeconds} s
            </span>
          {/if}
        </div>
      </section>

      <section class="mb-6">
        <button
          class="rounded-lg bg-red-700 px-6 py-3 text-lg font-bold hover:bg-red-600 disabled:opacity-50"
          onclick={playAndRecord}
          disabled={!canRecord}
        >
          Play & record
        </button>
        <p class="mt-2 text-sm text-zinc-400">
          FL Studio: open the same beat, Song mode, MIDI script "Beat
          Visualiser" enabled. After updating the script, click "Reload script"
          in FL's Script output window.
        </p>
        {#if !decoded || selectedWindowId === null}
          <p class="mt-1 text-sm text-zinc-500">
            Needs a beat and a selected plugin window.
          </p>
        {/if}
        {#if recording}
          <p class="mt-2 text-amber-400">
            Recording… {recordingElapsed} / {takeSeconds} s
          </p>
        {/if}
        {#if takeStatus}
          <p class="mt-2 text-green-400">{takeStatus}</p>
        {/if}
        {#if takeError}
          <p class="mt-2 text-red-400">{takeError}</p>
        {/if}
      </section>

      <section class="mb-6">
        <h2 class="mb-2 font-semibold">Plugin recording</h2>
        <div class="flex items-center gap-2">
          <button
            class="rounded bg-sky-700 px-3 py-1 hover:bg-sky-600 disabled:opacity-50"
            onclick={useLatestRecording}
            disabled={clipLoading || recording}
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
            {formatTime(clip.duration)} · FL started at {clip.offset.toFixed(3)} s
          </p>
        {/if}
        {#if clipError}
          <p class="mt-2 text-sm text-red-400">{clipError}</p>
        {/if}
      </section>

      <details class="mb-6 text-sm">
        <summary class="cursor-pointer text-zinc-400">Debug</summary>
        <div class="mt-2 flex items-center gap-2">
          <span>FL Studio:</span>
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
          <span class="text-zinc-400">{flStatus}</span>
        </div>
      </details>
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
