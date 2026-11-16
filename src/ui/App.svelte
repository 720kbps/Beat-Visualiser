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
  import Step from './Step.svelte'
  import Segmented from './Segmented.svelte'
  import Setup from './Setup.svelte'
  import { onMount } from 'svelte'
  import { setupComplete, type SetupStatus } from './setup-status'
  import type { Connection } from './connection'
  import { EMPTY_TITLE, type TitleText } from '../engine/overlay/title-card'
  import {
    barNumber,
    barSeconds,
    parseBpm,
    sectionLength,
    snapStart,
  } from '../engine/analysis/bars'
  import { computeHighlightScore } from '../engine/analysis/features'
  import { pickSection } from '../engine/analysis/pick-section'
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
    // The title card starts with the beat's name; the user can change it.
    title.name = nameFromFile(file.name)
    // A new beat gets its own auto-picked section.
    movedStart = null
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

  // One line under the beat's name: "3:12 · 44.1 kHz · stereo · 8.4 MB".
  let beatMeta = $derived.by(() => {
    if (!beat) return ''
    const size = `${(beat.bytes.byteLength / (1024 * 1024)).toFixed(1)} MB`
    if (!decoded) return decoding ? `${size} · decoding…` : size
    const channels =
      decoded.channels === 1
        ? 'mono'
        : decoded.channels === 2
          ? 'stereo'
          : `${decoded.channels} ch`
    return `${formatTime(decoded.duration)} · ${decoded.sampleRate / 1000} kHz · ${channels} · ${size}`
  })

  // "night_drive_140.wav" -> "night drive 140"
  function nameFromFile(file: string): string {
    return file
      .replace(/\.[^.]+$/, '')
      .replace(/_+/g, ' ')
      .trim()
  }

  // The title card's text (beat name, BPM, key, producer tag), drawn over
  // every theme. Plain $state: the fields are bound to inputs one by one,
  // and the preview reads it every frame (a plain property read).
  let title = $state<TitleText>({ ...EMPTY_TITLE })

  // The preview's playback clock: seconds into the SECTION (the frame
  // source and the plugin clips count from the section start). The player
  // plays the whole beat, so outside the section the preview holds its
  // first or last frame.
  // Called by the preview's frame loop; reading `player` and the section
  // there is a plain read.
  function getPlaybackTime(): number {
    if (!player) return 0
    const t = player.getTime() - sectionStart
    return Math.min(Math.max(t, 0), takeSeconds)
  }

  // Playing, and inside the section (so the plugin videos only run there).
  function isBeatPlaying(): boolean {
    if (!player || !player.isPlaying()) return false
    const t = player.getTime() - sectionStart
    return t >= 0 && t < takeSeconds
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
        sectionStart,
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

  // Whole seconds as m:ss, e.g. 75 -> "1:15". For labels; formatTime (with
  // tenths) is for the waveform's running clock.
  function clockTime(seconds: number): string {
    const s = Math.floor(seconds)
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }

  // "1 plugin window" etc., shown on each theme card.
  function slotLabel(slots: number): string {
    if (slots === 0) return 'No plugin window'
    return slots === 1 ? '1 plugin window' : `${slots} plugin windows`
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
  // True after the first "List windows", so an empty list can say "no match".
  let windowsListed = $state(false)
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
    windowsListed = true
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

  // --- The section: which part of the beat is recorded and exported ---

  // The chosen length. The real one is a whole number of bars (below).
  const LENGTHS = [15, 30, 60]
  let length = $state(15)

  // The tempo the user typed; null = empty or not a tempo. With it, the
  // section is cut on bars (engine/analysis/bars.ts).
  let bpm = $derived(parseBpm(title.bpm))

  // What we really record: a whole number of bars (multiple of 4) with a
  // BPM, whole seconds without; never longer than the chosen length or the beat.
  let takeSeconds = $derived(
    decoded ? sectionLength(length, bpm, decoded.duration) : length,
  )

  // How "big" each moment of the beat is, once per beat (features.ts).
  // Recomputed only when `decoded` changes. ($derived values are never
  // wrapped in a proxy, so the big typed array stays as it is.)
  let highlight = $derived(
    decoded ? computeHighlightScore(decoded.buffer) : null,
  )

  // The strongest section (pick-section.ts): on a bar, away from intro/outro.
  let autoStart = $derived(
    decoded && highlight
      ? pickSection(highlight, decoded.duration, takeSeconds, bpm)
      : 0,
  )

  // Where the user dragged the section; null = use the auto-pick. Kept
  // unsnapped, so it re-snaps when the BPM or length changes.
  let movedStart = $state<number | null>(null)

  // The section start in seconds: the user's spot snapped to a bar, or the
  // auto-pick. The take, preview, sync and export all use it.
  let sectionStart = $derived(
    decoded && movedStart !== null
      ? snapStart(movedStart, takeSeconds, decoded.duration, bpm)
      : autoStart,
  )

  // "bars 33–40" with a BPM, otherwise the time range.
  let sectionLabel = $derived(
    bpm === null
      ? `${clockTime(sectionStart)} – ${clockTime(sectionStart + takeSeconds)}`
      : `bars ${barNumber(sectionStart, bpm)}–${barNumber(sectionStart + takeSeconds, bpm) - 1}`,
  )

  // Per-frame values (levels, peaks, progress) for the themes, for exactly
  // that section, so the preview's waveform and playhead match the export.
  // One pass over the samples (~50 ms per minute of audio), then lookups;
  // recomputed when the beat or the length changes.
  let frameSource = $derived<FrameSource | null>(
    decoded
      ? createFrameSource(
          decoded.buffer,
          sectionStart,
          sectionStart + takeSeconds,
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
        startSeconds: sectionStart,
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
        player?.seek(sectionStart)
        takeStatus = 'Recorded. Press Play to preview it'
      }
    } catch (e) {
      takeError = String(e)
      // FL didn't answer the ping before the take: show it in the top bar too.
      if (takeError.includes("didn't answer")) {
        connection = { state: 'fail', message: takeError }
      }
      // A picked window is gone or hidden: refresh the list, so the user
      // sees what's still there.
      if (/window/i.test(takeError)) listWindows()
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
      title: $state.snapshot(title),
      frameSource,
      audio: decoded.buffer,
      sectionStart,
      length: takeSeconds,
      fps: exportFps,
      plugins: shownRecordings.map((r) => ({
        url: convertFileSrc(r.path),
        offset: r.clip.offset,
      })),
    }

    try {
      const bytes = await preview.withRenderer((ctx, visualizer, titleCard) =>
        exportVideo(
          { ...options, ctx, visualizer, titleCard },
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

  // --- Setup and the FL connection ---

  let setupOpen = $state(false)
  let connection = $state<Connection>({ state: 'unknown', message: '' })

  // "Test connection": FL's script answers a ping over MIDI.
  async function testConnection() {
    connection = { state: 'checking', message: '' }
    try {
      const ms = await invoke<number>('fl_ping')
      connection = { state: 'ok', message: `FL Studio answered in ${ms} ms` }
    } catch (e) {
      connection = { state: 'fail', message: String(e) }
    }
  }

  // Remembered in this browser profile (the app's webview): setup was
  // finished once. Wrapped in try: storage can be unavailable.
  const SETUP_DONE_KEY = 'setup-done'
  function setupSeen(): boolean {
    try {
      return localStorage.getItem(SETUP_DONE_KEY) === '1'
    } catch {
      return false
    }
  }
  function closeSetup() {
    setupOpen = false
    try {
      localStorage.setItem(SETUP_DONE_KEY, '1')
    } catch {
      // not remembered; setup shows again next launch
    }
  }

  // On launch: copy a missing or outdated FL script right away (an app
  // update brings a new script), then open setup if this is the first run
  // or something is missing.
  onMount(async () => {
    try {
      let status = await invoke<SetupStatus>('setup_status')
      const script = status.script
      if (script.hardware_folder && !script.up_to_date) {
        await invoke('install_fl_script', { picked: null })
        status = await invoke<SetupStatus>('setup_status')
      }
      if (!setupSeen() || !setupComplete(status)) setupOpen = true
    } catch (e) {
      // Not inside the app (e.g. `npm run dev` in a browser): no setup.
      console.warn('Setup check failed:', e)
    }
  })

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

<div class="flex min-h-screen flex-col">
  <!-- Top bar: the app name, and what's happening right now. -->
  <header
    class="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-6"
  >
    <span class="text-base font-semibold">Beat Visualiser</span>
    <div class="ml-auto flex items-center gap-2">
      <!-- FL connection: click to test it again -->
      <button
        class="inline-flex h-7 items-center gap-2 rounded-lg border border-line px-3 text-xs text-soft transition-colors duration-150 ease-out hover:bg-raised hover:text-fg disabled:opacity-60"
        onclick={testConnection}
        disabled={connection.state === 'checking' || recording}
        title={connection.message || 'Test the connection to FL Studio'}
      >
        <span
          class={[
            'size-2 rounded-full',
            connection.state === 'ok'
              ? 'bg-good'
              : connection.state === 'fail'
                ? 'bg-bad'
                : 'bg-line-strong',
          ]}
        ></span>
        {connection.state === 'ok'
          ? 'FL Studio connected'
          : connection.state === 'fail'
            ? 'FL Studio not answering'
            : connection.state === 'checking'
              ? 'Testing…'
              : 'Test FL connection'}
      </button>
      <button
        class="btn btn-ghost h-7 text-xs"
        onclick={() => (setupOpen = true)}
      >
        Setup
      </button>
      {#if recording}
        <span
          class="inline-flex h-7 items-center gap-2 rounded-lg border border-line px-3 font-mono text-xs tabular-nums"
        >
          <span class="size-2 rounded-full bg-rec"></span>
          Recording {recordingElapsed} / {Math.round(takeSeconds)} s
        </span>
      {:else if exporting}
        <span
          class="inline-flex h-7 items-center rounded-lg border border-line px-3 font-mono text-xs text-soft tabular-nums"
        >
          Exporting {Math.round(exportProgress * 100)}%
        </span>
      {/if}
    </div>
  </header>

  <!--
    Two columns: the preview on the left (as wide as it needs), the steps on
    the right (minmax(0, 1fr) lets them shrink, so long window titles
    truncate instead of pushing the layout wider). Below lg they stack.
  -->
  <main
    class="mx-auto grid w-full max-w-[1440px] items-start gap-8 p-6 lg:grid-cols-[auto_minmax(0,1fr)]"
  >
    <!-- sticky: the preview stays in view while the steps scroll -->
    <aside class="justify-self-center lg:sticky lg:top-6">
      <Preview
        bind:this={preview}
        visualizer={theme}
        {params}
        {frameSource}
        getTime={getPlaybackTime}
        isPlaying={isBeatPlaying}
        clips={shownClips}
        {title}
      />
    </aside>

    <div class="flex min-w-0 flex-col gap-4">
      <Step n={1} title="Beat">
        <DropZone
          onfile={onBeatFile}
          disabled={exporting || recording}
          name={beat?.name ?? ''}
          meta={beatMeta}
        />
        {#if decodeError}
          <p class="text-sm text-bad">{decodeError}</p>
        {/if}
      </Step>

      <Step n={2} title="Section">
        {#snippet aside()}
          <span class="font-mono tabular-nums">
            {clockTime(sectionStart)} – {clockTime(sectionStart + takeSeconds)}
          </span>
        {/snippet}
        {#if decoded && player}
          <Waveform
            audio={decoded}
            {player}
            {sectionStart}
            sectionLength={takeSeconds}
            step={bpm === null ? 1 : barSeconds(bpm)}
            label={sectionLabel}
            onmove={(start) => (movedStart = start)}
            disabled={recording || exporting}
          />
        {:else}
          <div
            class="grid h-24 place-items-center rounded-lg bg-raised text-xs text-muted"
          >
            {decoding ? 'Decoding…' : 'The waveform shows up once a beat is in'}
          </div>
        {/if}
        <div class="flex flex-wrap items-center gap-3">
          <Segmented
            label="Length"
            options={LENGTHS}
            selected={length}
            format={(s) => `${s} s`}
            onselect={(s) => (length = s)}
            disabled={recording || exporting}
          />
          <label class="flex items-center gap-2">
            <span class="text-xs text-muted">BPM</span>
            <input
              class="field w-20 tabular-nums"
              inputmode="decimal"
              maxlength="6"
              placeholder="140"
              bind:value={title.bpm}
              disabled={recording || exporting}
            />
          </label>
          {#if movedStart !== null}
            <button
              class="btn btn-ghost"
              onclick={() => (movedStart = null)}
              disabled={recording || exporting}
            >
              Auto-pick again
            </button>
          {/if}
        </div>
        <p class="text-xs text-muted">
          {#if !decoded}
            The strongest part is picked for you once a beat is in.
          {:else if bpm === null}
            Type the BPM to cut the section on whole bars. Until then it’s {takeSeconds}
            s, not snapped.
          {:else}
            {Math.round(takeSeconds / barSeconds(bpm))} bars ({takeSeconds.toFixed(
              1,
            )} s) at
            {bpm} BPM, {movedStart === null
              ? 'auto-picked: the loudest, busiest part away from the intro and outro.'
              : 'moved by you, snapped to bars.'}
            Bar 1 is the start of the file, as FL exports it.
          {/if}
        </p>
      </Step>

      <Step n={3} title="Plugin windows" highlight>
        {#snippet aside()}
          <span class="tabular-nums">
            {usedWindowIds.length} of {pickerSlots} picked
          </span>
        {/snippet}

        <div class="flex gap-2">
          <input
            class="field flex-1"
            placeholder="Title contains, empty for all"
            aria-label="Window title contains"
            bind:value={titleFilter}
            onkeydown={(e) => e.key === 'Enter' && listWindows()}
          />
          <button
            class="btn btn-secondary"
            onclick={listWindows}
            disabled={recording || exporting}
          >
            List windows
          </button>
        </div>
        {#if windowsError}
          <p class="text-sm text-bad">{windowsError}</p>
        {/if}

        <!--
          One button per window row. Clicking picks it for the next slot (the
          circle shows the slot number, 1 = top) or unpicks it. Picked windows
          past the theme's slot count stay picked but greyed out: unused.
        -->
        {#if windows.length > 0}
          <ul
            class="divide-y divide-line overflow-hidden rounded-xl border border-line"
          >
            {#each windows as w (w.id)}
              {@const slot = slotOf(w.id)}
              {@const used = slot > 0 && slot <= pickerSlots}
              <li>
                <button
                  type="button"
                  class={[
                    'flex h-11 w-full items-center gap-3 px-3 text-left text-sm transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:text-muted',
                    used ? 'bg-raised' : 'hover:bg-raised/60',
                  ]}
                  onclick={() => toggleWindow(w.id)}
                  disabled={!w.on_screen || recording}
                >
                  <span
                    class={[
                      'grid size-5 shrink-0 place-items-center rounded-full font-mono text-xs',
                      used
                        ? 'bg-accent font-semibold text-accent-ink'
                        : 'border border-line-strong text-muted',
                    ]}
                  >
                    {slot > 0 ? slot : ''}
                  </span>
                  <span class="min-w-0 flex-1 truncate">
                    {w.title || 'Untitled'}
                    <span class="text-muted">· {w.app_name}</span>
                  </span>
                  <span
                    class="shrink-0 font-mono text-xs text-muted tabular-nums"
                  >
                    {#if !w.on_screen}
                      off screen
                    {:else if slot > pickerSlots}
                      not used by {theme.name}
                    {:else}
                      {w.width} × {w.height}
                    {/if}
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {:else if windowsListed && !windowsError}
          <p class="text-sm text-soft">
            No windows match. Open the plugin in FL, detach it, then list again.
          </p>
        {/if}
        <p class="text-xs text-muted">
          {pickerSlots > 1
            ? `Pick up to ${pickerSlots}, in order from top to bottom.`
            : 'Pick one.'}
          Plugin windows have to be detached in FL to show up here.
        </p>

        <div class="flex flex-col gap-3 border-t border-line pt-4">
          <div class="flex flex-wrap items-center gap-3">
            <button
              class="btn btn-secondary"
              onclick={playAndRecord}
              disabled={!canRecord}
            >
              <span class="size-2.5 rounded-full bg-rec"></span>
              Play & record
            </button>
            <span class="text-xs text-muted">
              {#if !decoded || usedWindowIds.length === 0}
                Needs a beat and at least one picked window
              {:else}
                Plays FL from {clockTime(sectionStart)}, records {takeSeconds.toFixed(
                  1,
                )} s, then stops
              {/if}
            </span>
          </div>
          {#if recording}
            <!-- scaleX instead of width: transforms don't re-run layout -->
            <div class="h-1 overflow-hidden rounded-full bg-raised">
              <div
                class="h-full origin-left bg-rec transition-transform duration-300 ease-out"
                style:transform="scaleX({recordingElapsed / takeSeconds})"
              ></div>
            </div>
          {/if}
          {#if takeStatus}
            <p class="text-sm text-good">{takeStatus}</p>
          {/if}
          {#if takeError}
            <p class="text-sm text-bad">{takeError}</p>
          {/if}
        </div>

        <div class="flex flex-col gap-2 border-t border-line pt-4">
          <div class="flex items-center gap-2">
            <h3 class="text-xs font-medium text-soft">Recordings</h3>
            <div class="ml-auto flex gap-1">
              <button
                class="btn btn-ghost"
                onclick={useLatestRecording}
                disabled={clipLoading || recording || exporting}
              >
                Use latest
              </button>
              <button
                class="btn btn-ghost"
                onclick={clearClip}
                disabled={(recordings.length === 0 && !clipLoading) ||
                  exporting}
              >
                Clear
              </button>
            </div>
          </div>
          {#if clipLoading}
            <p class="text-sm text-muted">Syncing to the beat and loading…</p>
          {/if}
          {#each recordings as r, i (i)}
            <div
              class="flex items-start gap-3 rounded-lg bg-raised px-3 py-2"
              title={r.path}
            >
              <span
                class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-line-strong font-mono text-xs text-soft"
              >
                {i + 1}
              </span>
              <div class="min-w-0 flex-1">
                <p class="truncate font-mono text-sm">{fileName(r.path)}</p>
                <p class="text-xs text-muted tabular-nums">
                  {r.clip.width} × {r.clip.height} · {formatTime(
                    r.clip.duration,
                  )} · FL started at {r.clip.offset.toFixed(3)} s
                  {#if i >= theme.pluginSlots}
                    · not shown by {theme.name}
                  {/if}
                </p>
                {#if r.syncStatus}
                  <p class="mt-1 flex items-center gap-2 text-xs text-soft">
                    <span
                      class={[
                        'size-1.5 shrink-0 rounded-full',
                        r.syncOk ? 'bg-good' : 'bg-warn',
                      ]}
                    ></span>
                    {r.syncStatus}
                  </p>
                {/if}
              </div>
            </div>
          {:else}
            {#if !clipLoading}
              <p class="text-sm text-muted">None yet</p>
            {/if}
          {/each}
          {#if clipError}
            <p class="text-sm text-bad">{clipError}</p>
          {/if}
        </div>

        <details class="text-xs text-muted">
          <summary class="cursor-pointer hover:text-soft"
            >FL Studio setup</summary
          >
          <p class="mt-2 leading-5">
            Open the same beat in FL and enable the "Beat Visualiser" MIDI
            script in FL's MIDI settings. The app switches FL to song mode
            itself. After updating the script, click "Reload script" in FL's
            Script output window.
          </p>
        </details>
      </Step>

      <Step n={4} title="Theme">
        <div
          class="grid grid-cols-3 gap-2"
          role="radiogroup"
          aria-label="Theme"
        >
          {#each visualizers as v (v.id)}
            <button
              type="button"
              role="radio"
              aria-checked={v.id === theme.id}
              class={[
                'flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors duration-150 ease-out disabled:opacity-40',
                v.id === theme.id
                  ? 'border-accent/50 bg-accent-soft'
                  : 'border-line hover:bg-raised',
              ]}
              onclick={() => selectTheme(v.id)}
              disabled={exporting}
            >
              <span class="text-sm font-medium">{v.name}</span>
              <span class="text-xs text-muted">{slotLabel(v.pluginSlots)}</span>
            </button>
          {/each}
        </div>
      </Step>

      <Step n={5} title="Text">
        {#snippet aside()}Shown at the top of the video, with the BPM from step
          2{/snippet}
        <div class="grid grid-cols-[3fr_1fr] gap-2">
          <label class="flex min-w-0 flex-col gap-1">
            <span class="text-xs text-muted">Beat name</span>
            <input class="field" maxlength="60" bind:value={title.name} />
          </label>
          <label class="flex min-w-0 flex-col gap-1">
            <span class="text-xs text-muted">Key</span>
            <input class="field" maxlength="8" bind:value={title.key} />
          </label>
          <label class="col-span-2 flex min-w-0 flex-col gap-1">
            <span class="text-xs text-muted">Producer tag</span>
            <input
              class="field"
              maxlength="30"
              placeholder="Shown as “prod. …”, leave empty to hide"
              bind:value={title.tag}
            />
          </label>
        </div>
      </Step>

      {#if theme.params.length > 0}
        <Step n={6} title="Look">
          {#snippet aside()}{theme.name}{/snippet}
          <ParamControls schema={theme.params} bind:values={params} />
        </Step>
      {/if}

      <Step title="Export">
        {#snippet aside()}
          <span class="font-mono">1080 × 1920 · H.264 + AAC</span>
        {/snippet}
        <p class="text-sm text-soft">
          {takeSeconds.toFixed(1)} s from {clockTime(sectionStart)}, with the
          beat file's audio{shownClips.length === 1
            ? ' and the plugin recording'
            : shownClips.length > 1
              ? ` and ${shownClips.length} plugin recordings`
              : ''}
        </p>
        <div class="flex flex-wrap items-center gap-3">
          <Segmented
            label="Frame rate"
            options={EXPORT_FPS_OPTIONS}
            selected={exportFps}
            format={(f) => `${f} fps`}
            onselect={(f) => (exportFps = f as ExportFps)}
            disabled={exporting}
          />
          <div class="ml-auto flex gap-2">
            <button
              class="btn btn-secondary"
              onclick={showInFolder}
              disabled={!exportedPath}
            >
              Show in folder
            </button>
            <button
              class="btn btn-primary h-10 px-5"
              onclick={startExport}
              disabled={!canExport}
            >
              Export MP4
            </button>
          </div>
        </div>
        {#if exporting}
          <div class="flex items-center gap-3">
            <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
              <div
                class="h-full origin-left bg-accent"
                style:transform="scaleX({exportProgress})"
              ></div>
            </div>
            <span class="font-mono text-xs text-muted tabular-nums">
              {Math.round(exportProgress * 100)}% · {exportElapsed} s
            </span>
            <button class="btn btn-ghost" onclick={cancelExport}>Cancel</button>
          </div>
        {/if}
        {#if exportedPath}
          <p class="truncate text-sm text-good" title={exportedPath}>
            Saved {fileName(exportedPath)}
          </p>
        {/if}
        {#if exportError}
          <p class="text-sm text-bad">{exportError}</p>
        {/if}
      </Step>

      <details class="px-1 text-xs text-muted">
        <summary class="cursor-pointer hover:text-soft">Debug</summary>
        <div class="mt-2 flex items-center gap-2">
          <span>FL Studio</span>
          <button
            class="btn btn-ghost"
            onclick={() => sendToFl('fl_play', 'play')}
          >
            Play
          </button>
          <button
            class="btn btn-ghost"
            onclick={() => sendToFl('fl_stop', 'stop')}
          >
            Stop
          </button>
          <span class="font-mono">{flStatus}</span>
        </div>
      </details>
    </div>
  </main>
</div>

{#if setupOpen}
  <Setup {connection} ontest={testConnection} onclose={closeSetup} />
{/if}
