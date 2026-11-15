<script lang="ts">
  // One-button flow: drop the beat, pick the plugin windows, pick a length,
  // press "Play & record". FL plays from the song start while the app records
  // the windows; the recordings then show in the preview, lined up with the beat.
  // "Export MP4" then renders that section into a 1080×1920 video.
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
  import { syncTakeToBeat } from '../engine/sync/sync-take'
  import { exportVideo, isAbortError } from '../engine/export/export-video'
  import { EXPORT_FPS_OPTIONS, type ExportFps } from '../engine/export/timing'

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

  // Matches the Rust `Take` / `TakeClip` structs (take.rs). One clip per
  // recorded window, in the same order as the windowIds we sent.
  type TakeClip = {
    window_id: number
    path: string
    play_offset: number // video seconds at which we sent "play" to FL
    has_audio: boolean // the clip recorded audible sound (needed for audio sync)
  }
  type Take = { clips: TakeClip[] }

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

  // Stops playback and drops the old beat's player.
  function clearPlayback() {
    player?.dispose()
    player = null
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
  // buffer; the frame source's clip starts at second 0 of the buffer
  // (SECTION_START), so they line up.
  // Called by the preview's frame loop; reading `player` there is a plain read.
  function getPlaybackTime(): number {
    return player ? player.getTime() : 0
  }

  function isBeatPlaying(): boolean {
    return player ? player.isPlaying() : false
  }

  // One loaded plugin recording: the clip plus what the UI shows about it.
  type Recording = {
    clip: PluginClip
    path: string // the file, shown in the UI and read again by the export
    syncStatus: string // one line about its audio sync, '' = not synced
    syncOk: boolean // true: the offset comes from the audio
  }

  // The recorded plugin windows, one per slot: recordings[0] is slot 1 (top).
  // $state.raw: each holds a <video> element, which must not be wrapped in a
  // proxy. Only ever replaced as a whole array.
  let recordings = $state.raw<Recording[]>([])
  let clipLoading = $state(false)
  let clipError = $state('')
  // Counts load requests, so a slow load that finishes after a newer one
  // (or after Clear) is thrown away. Plain variable: never shown.
  let clipRequest = 0

  // A file to load into one slot. `offset`: where beat time 0 is in the
  // video (a take clip's play_offset). With `sync`, that offset is first
  // refined from the recorded sound.
  type ClipToLoad = {
    path: string
    offset: number
    sync: SyncRequest | null
  }

  type SyncRequest = {
    searchSeconds: number // how far FL's real start may be from the estimate
    hasAudio: boolean // false: the take is silent, don't even try
  }

  // Finds when FL really started, from the take's recorded sound (see
  // engine/sync/align.ts). Falls back to `estimate` (the play_offset) when
  // that's not possible. Returns the offset and the status line to show.
  async function syncOffset(
    path: string,
    estimate: number,
    request: SyncRequest,
  ): Promise<{ offset: number; ok: boolean; message: string }> {
    const fallback = `using timing estimate (${estimate.toFixed(3)} s)`
    if (!decoded) {
      return {
        offset: estimate,
        ok: false,
        message: `no beat loaded — ${fallback}`,
      }
    }
    if (!request.hasAudio) {
      return {
        offset: estimate,
        ok: false,
        message: `no sound in the recording — ${fallback}`,
      }
    }
    try {
      const result = await syncTakeToBeat(
        convertFileSrc(path),
        decoded.buffer,
        SECTION_START,
        estimate,
        request.searchSeconds,
      )
      if (!result) {
        return {
          offset: estimate,
          ok: false,
          message: `no audio track in the recording — ${fallback}`,
        }
      }
      if (!result.ok) {
        return {
          offset: estimate,
          ok: false,
          message: `audio sync failed (confidence ${result.confidence.toFixed(2)}) — ${fallback}`,
        }
      }
      const ms = Math.round(result.correction * 1000)
      return {
        offset: result.offset,
        ok: true,
        message: `synced ${ms >= 0 ? '+' : ''}${ms} ms (${result.confidence.toFixed(2)})`,
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      return {
        offset: estimate,
        ok: false,
        message: `audio sync failed: ${reason} — ${fallback}`,
      }
    }
  }

  // Loads recordings into the slots, in order (items[0] = slot 1), and
  // replaces the current ones. Syncs and loads one after the other: simple,
  // and the audio sync reads a few MB per clip, so it's quick anyway.
  // If one fails, none are shown. Returns true if the new ones are shown.
  async function loadRecordings(items: ClipToLoad[]): Promise<boolean> {
    const request = ++clipRequest
    clipError = ''
    clipLoading = true
    const loaded: Recording[] = []
    try {
      for (const item of items) {
        const synced = item.sync
          ? await syncOffset(item.path, item.offset, item.sync)
          : null
        // convertFileSrc turns the path into an asset:// URL that Tauri serves
        // from disk (allowed folder: assetProtocol.scope in tauri.conf.json).
        // It streams with HTTP range requests, so big files aren't read into
        // memory, and its CORS headers keep the video usable as a WebGL texture.
        const clip = await loadPluginClip(
          convertFileSrc(item.path),
          synced ? synced.offset : item.offset,
        )
        loaded.push({
          clip,
          path: item.path,
          syncStatus: synced ? synced.message : '',
          syncOk: synced ? synced.ok : false,
        })
        if (request !== clipRequest) break // a newer request or Clear came in
      }
      if (request !== clipRequest) {
        for (const r of loaded) r.clip.dispose()
        return false
      }
      for (const r of recordings) r.clip.dispose()
      recordings = loaded
      return true
    } catch (e) {
      for (const r of loaded) r.clip.dispose()
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
        // Only into slot 1, to keep it simple. We don't know when FL started
        // (estimate 0), so the audio sync searches wider: ±2 s.
        await loadRecordings([
          { path, offset: 0, sync: { searchSeconds: 2, hasAudio: true } },
        ])
      } else {
        clipError = 'No recordings yet. Record a window first.'
      }
    } catch (e) {
      clipError = String(e)
    }
  }

  function clearClip() {
    clipRequest++ // cancels a load that's still running
    for (const r of recordings) r.clip.dispose()
    recordings = []
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

  // The recordings the current theme shows: the first pluginSlots of them.
  // A theme with fewer slots just ignores the rest (they stay loaded, so
  // switching back shows them again).
  let shownRecordings = $derived(recordings.slice(0, theme.pluginSlots))
  let shownClips = $derived(shownRecordings.map((r) => r.clip))

  // Free-text substring match on the window title, so any plugin works.
  // Default: Ogun, FL Studio's built-in synth.
  let titleFilter = $state('Ogun')
  let windows = $state<WindowInfo[]>([])
  let windowsError = $state('')
  // The plugin windows to record, in slot order: [0] is slot 1 (top).
  // Ids from list_windows.
  let selectedWindowIds = $state<number[]>([])

  // How many windows the picker allows: the theme's slots, but at least one,
  // so a theme without a plugin screen can still record a take.
  let pickerSlots = $derived(Math.max(1, theme.pluginSlots))
  // What "Play & record" really records. The selection is kept when the
  // theme changes to fewer slots; only the first ones are used.
  let usedWindowIds = $derived(selectedWindowIds.slice(0, pickerSlots))

  // Click on a window row: picked -> unpick it (the ones after it move up a
  // slot); not picked -> give it the next slot. When all slots are taken, it
  // replaces the last one (so with one slot it works like a radio button).
  function toggleWindow(id: number) {
    if (selectedWindowIds.includes(id)) {
      selectedWindowIds = selectedWindowIds.filter((x) => x !== id)
    } else {
      const kept = selectedWindowIds.slice(0, pickerSlots - 1)
      selectedWindowIds = [...kept, id]
    }
  }

  // Slot number (1 = top) of a window, or 0 if it isn't picked.
  function slotOf(id: number): number {
    return selectedWindowIds.indexOf(id) + 1
  }

  async function listWindows() {
    windowsError = ''
    try {
      // Tauri maps the camelCase key `titleFilter` to the Rust arg `title_filter`.
      windows = await invoke<WindowInfo[]>('list_windows', { titleFilter })
    } catch (e) {
      windows = []
      windowsError = String(e)
    }
    // Forget picked windows that are gone (or now off screen).
    selectedWindowIds = selectedWindowIds.filter((id) =>
      windows.some((w) => w.id === id && w.on_screen),
    )
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

  // The clip that is recorded, previewed and exported: from the beat's start,
  // takeSeconds long. Phase 4 (highlight detection) will move the start.
  const SECTION_START = 0

  // Per-frame values (levels, peaks, progress) for the themes, for exactly
  // that section, so the preview's waveform and playhead match the export.
  // One pass over the samples (~50 ms per minute of audio), then lookups;
  // recomputed when the beat or the length changes.
  let frameSource = $derived<FrameSource | null>(
    decoded
      ? createFrameSource(
          decoded.buffer,
          SECTION_START,
          SECTION_START + takeSeconds,
        )
      : null,
  )

  let recording = $state(false)
  let exporting = $state(false) // true while "Export MP4" runs (step 4)
  // Whole seconds since "Play & record" was pressed. Only a UI counter,
  // updated 4 times a second; not render-loop data.
  let recordingElapsed = $state(0)
  let takeStatus = $state('') // e.g. "Done — press Play to preview"
  let takeError = $state('')

  let canRecord = $derived(
    decoded !== null && usedWindowIds.length > 0 && !recording && !exporting,
  )

  // The one button: FL plays from the start while Rust records the windows,
  // then each recording goes into its slot in the preview, with its own
  // play offset.
  async function playAndRecord() {
    if (usedWindowIds.length === 0) return
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
      // In slot order; take.clips comes back in the same order.
      const take = await invoke<Take>('record_take', {
        windowIds: usedWindowIds,
        seconds,
      })
      // FL starts a little after we send play; the audio sync finds the
      // exact moment, within ±0.5 s of each clip's play_offset.
      const items = take.clips.map((c) => ({
        path: c.path,
        offset: c.play_offset,
        sync: { searchSeconds: 0.5, hasAudio: c.has_audio },
      }))
      if (await loadRecordings(items)) {
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

  // --- Export ---

  // The preview component, for withRenderer(). Set by bind:this.
  let preview = $state.raw<ReturnType<typeof Preview>>()

  let exportFps = $state<ExportFps>(30)
  // UI values, updated at most ~10×/s (not per frame).
  let exportProgress = $state(0) // 0..1
  let exportElapsed = $state(0) // whole seconds
  let exportError = $state('')
  let exportedPath = $state('') // the saved MP4, '' = none yet
  // Aborts the running export (Cancel). Plain variable: never shown.
  let exportAbort: AbortController | null = null

  let canExport = $derived(
    decoded !== null && frameSource !== null && !recording && !exporting,
  )

  async function startExport() {
    if (!decoded || !frameSource || !preview) return
    player?.pause() // the preview loop stops anyway; don't play audio meanwhile

    exporting = true
    exportProgress = 0
    exportElapsed = 0
    exportError = ''
    exportedPath = ''
    const abort = new AbortController()
    exportAbort = abort
    const startedAt = performance.now()
    const timer = setInterval(() => {
      exportElapsed = Math.floor((performance.now() - startedAt) / 1000)
    }, 250)

    // Copies taken now, so changes during the export can't affect it.
    const options = {
      // $state.snapshot: a plain object instead of the reactive proxy
      params: $state.snapshot(params),
      frameSource,
      audio: decoded.buffer,
      sectionStart: SECTION_START,
      length: takeSeconds,
      fps: exportFps,
      plugins: shownRecordings.map((r) => ({
        url: convertFileSrc(r.path),
        offset: r.clip.offset,
      })),
    }

    try {
      const bytes = await preview.withRenderer((ctx, visualizer) =>
        exportVideo(
          { ...options, ctx, visualizer },
          (p) => (exportProgress = p),
          abort.signal,
        ),
      )
      // A Uint8Array as the whole argument: Tauri sends it as the raw
      // request body (binary), not as JSON. Rust writes it to disk.
      exportedPath = await invoke<string>('save_export', bytes)
    } catch (e) {
      if (!isAbortError(e)) {
        exportError = e instanceof Error ? e.message : String(e)
      }
    } finally {
      clearInterval(timer)
      exportAbort = null
      exporting = false
    }
  }

  function cancelExport() {
    exportAbort?.abort()
  }

  async function showInFolder() {
    try {
      await invoke('show_in_folder', { path: exportedPath })
    } catch (e) {
      exportError = String(e)
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
        <DropZone onfile={onBeatFile} disabled={exporting || recording} />
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
        <h2 class="mb-2 font-semibold">
          2. Plugin windows (pick up to {pickerSlots}, in order top → bottom)
        </h2>
        <div class="mb-2 flex gap-2">
          <input
            class="rounded bg-zinc-800 px-2 py-1"
            placeholder="Title contains (empty = all)"
            bind:value={titleFilter}
          />
          <button
            class="rounded bg-sky-600 px-3 py-1 hover:bg-sky-500 disabled:opacity-50"
            onclick={listWindows}
            disabled={recording || exporting}
          >
            List windows
          </button>
        </div>
        {#if windowsError}
          <p class="mb-2 text-sm text-red-400">{windowsError}</p>
        {/if}
        <!--
          One button per window row. Clicking picks it for the next slot (the
          badge shows the slot number, 1 = top) or unpicks it. Picked windows
          past the theme's slot count stay picked but greyed out: unused.
        -->
        <ul class="space-y-1 font-mono text-sm">
          {#each windows as w (w.id)}
            {@const slot = slotOf(w.id)}
            <li>
              <button
                type="button"
                class={[
                  'flex w-full items-center gap-2 rounded px-2 py-1 text-left disabled:cursor-not-allowed disabled:opacity-50',
                  slot > 0 && slot <= pickerSlots
                    ? 'bg-sky-800 text-white'
                    : 'hover:bg-zinc-800',
                  slot > pickerSlots && 'bg-zinc-800 text-zinc-400',
                ]}
                onclick={() => toggleWindow(w.id)}
                disabled={!w.on_screen || recording}
              >
                <span
                  class={[
                    'w-5 shrink-0 rounded text-center',
                    slot > 0 ? 'bg-sky-500 text-white' : 'bg-zinc-700',
                  ]}
                >
                  {slot > 0 ? slot : ''}
                </span>
                <span class="truncate">
                  {w.app_name} | {w.title} | {w.width}×{w.height}
                </span>
                {#if !w.on_screen}
                  <span class="text-zinc-400">(off screen)</span>
                {/if}
                {#if slot > pickerSlots}
                  <span class="shrink-0">(not used by this theme)</span>
                {/if}
                {#if w.is_fl}<span class="text-sky-300">FL</span>{/if}
              </button>
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
              disabled={recording || exporting}
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
        {#if !decoded || usedWindowIds.length === 0}
          <p class="mt-1 text-sm text-zinc-500">
            Needs a beat and at least one picked plugin window.
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
            disabled={clipLoading || recording || exporting}
          >
            Use latest recording
          </button>
          <button
            class="rounded bg-zinc-700 px-3 py-1 hover:bg-zinc-600 disabled:opacity-50"
            onclick={clearClip}
            disabled={(recordings.length === 0 && !clipLoading) || exporting}
          >
            Clear
          </button>
        </div>
        {#if clipLoading}
          <p class="mt-2 text-sm text-zinc-400">
            Syncing to audio and loading the recording…
          </p>
        {/if}
        {#each recordings as r, i (i)}
          <p class="mt-2 text-sm text-zinc-300" title={r.path}>
            Window {i + 1}: {fileName(r.path)} ·
            {r.clip.width}×{r.clip.height} · {formatTime(r.clip.duration)} · FL started
            at {r.clip.offset.toFixed(3)} s
            {#if i >= theme.pluginSlots}
              <span class="text-zinc-500">(not shown by this theme)</span>
            {/if}
          </p>
          {#if r.syncStatus}
            <p
              class={[
                'mt-1 text-sm',
                r.syncOk ? 'text-green-400' : 'text-amber-400',
              ]}
            >
              Window {i + 1}: {r.syncStatus}
            </p>
          {/if}
        {/each}
        {#if clipError}
          <p class="mt-2 text-sm text-red-400">{clipError}</p>
        {/if}
      </section>

      <section class="mb-6">
        <h2 class="mb-2 font-semibold">4. Export</h2>
        <div class="flex items-center gap-2">
          {#each EXPORT_FPS_OPTIONS as fps (fps)}
            <button
              class={[
                'rounded px-3 py-1 disabled:opacity-50',
                fps === exportFps
                  ? 'bg-sky-600 text-white'
                  : 'bg-zinc-700 hover:bg-zinc-600',
              ]}
              onclick={() => (exportFps = fps)}
              disabled={exporting}
            >
              {fps} fps
            </button>
          {/each}
          <button
            class="rounded-lg bg-sky-600 px-6 py-2 font-bold hover:bg-sky-500 disabled:opacity-50"
            onclick={startExport}
            disabled={!canExport}
          >
            Export MP4
          </button>
        </div>
        <p class="mt-2 text-sm text-zinc-400">
          {formatTime(takeSeconds)} from the start of the beat, 1080×1920 H.264 +
          AAC from the beat file{shownClips.length === 1
            ? ', with the plugin recording'
            : shownClips.length > 1
              ? `, with ${shownClips.length} plugin recordings`
              : ''}.
        </p>
        {#if exporting}
          <div class="mt-2 flex items-center gap-3">
            <progress class="h-2 w-64" max="1" value={exportProgress}
            ></progress>
            <span class="text-sm text-zinc-300">
              {Math.round(exportProgress * 100)}% · {exportElapsed} s
            </span>
            <button
              class="rounded bg-zinc-700 px-3 py-1 text-sm hover:bg-zinc-600"
              onclick={cancelExport}
            >
              Cancel
            </button>
          </div>
        {/if}
        {#if exportedPath}
          <div class="mt-2 flex items-center gap-3">
            <span class="text-green-400" title={exportedPath}>
              Saved: {fileName(exportedPath)}
            </span>
            <button
              class="rounded bg-zinc-700 px-3 py-1 text-sm hover:bg-zinc-600"
              onclick={showInFolder}
            >
              Show in folder
            </button>
          </div>
        {/if}
        {#if exportError}
          <p class="mt-2 text-sm text-red-400">{exportError}</p>
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
          class="rounded bg-zinc-800 px-2 py-1 text-sm disabled:opacity-50"
          disabled={exporting}
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
          bind:this={preview}
          visualizer={theme}
          {params}
          {frameSource}
          getTime={getPlaybackTime}
          isPlaying={isBeatPlaying}
          clips={shownClips}
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
