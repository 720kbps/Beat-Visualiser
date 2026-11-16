<script lang="ts">
  // Drop target for the beat file (WAV or MP3).
  //
  // Tauri's native window catches file drops itself (`dragDropEnabled` is on
  // by default), so the browser's HTML `drop` event never gets the files.
  // Instead Tauri sends its own drag events with real file paths. These are
  // window-wide, not per element: the whole window is the drop target and
  // this box is only the visual.
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { getCurrentWebview } from '@tauri-apps/api/webview'
  import type { BeatFile } from './beat-file'

  let {
    onfile,
    disabled = false,
    name = '',
    meta = '',
  }: {
    onfile: (file: BeatFile) => void
    disabled?: boolean // true = drops are ignored (e.g. while exporting)
    name?: string // the loaded beat's file name; '' = nothing loaded yet
    meta?: string // one line under the name, e.g. "3:12 · 44.1 kHz · stereo"
  } = $props()

  let hovering = $state(false) // a file is being dragged over the window
  let loading = $state(false)
  let error = $state('')

  function isSupported(path: string): boolean {
    const lower = path.toLowerCase()
    return lower.endsWith('.wav') || lower.endsWith('.mp3')
  }

  // Works for macOS ("/") and Windows ("\") paths.
  function fileName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path
  }

  async function loadFirstSupported(paths: string[]) {
    // Ignore drops while the previous file is still being read.
    if (loading || disabled) return

    // Several files dropped: take the first WAV/MP3.
    const path = paths.find(isSupported)
    if (!path) {
      error = 'Drop a WAV or MP3 file'
      return
    }

    error = ''
    loading = true
    try {
      // Rust sends the bytes as a binary response, so this is an ArrayBuffer.
      const bytes = await invoke<ArrayBuffer>('read_audio_file', { path })
      onfile({ path, name: fileName(path), bytes })
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  // onMount runs once when the component appears; the function it returns
  // runs when the component is removed. ($effect would also work, but it
  // re-runs whenever state it reads changes; onMount makes "once" explicit.)
  onMount(() => {
    // Subscribing is async: it resolves to an `unlisten` function.
    const unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
      const drag = event.payload
      if (drag.type === 'enter' || drag.type === 'over') {
        hovering = !disabled
      } else if (drag.type === 'leave') {
        hovering = false
      } else if (drag.type === 'drop') {
        hovering = false
        loadFirstSupported(drag.paths)
      }
    })

    // Cleanup. Waiting on the promise also covers the case where the
    // component is removed before the subscription has finished.
    return () => {
      unlistenPromise.then((unlisten) => unlisten())
    }
  })
</script>

<!--
  Two looks: an empty drop target before the first beat, then a file row
  (icon, name, meta). Both stay drop targets: the whole window catches drops.
-->
<div
  class={[
    'flex items-center gap-3 rounded-xl border border-dashed px-3 transition-colors duration-150 ease-out',
    name ? 'h-16' : 'h-28 justify-center',
    hovering ? 'border-accent/60 bg-accent-soft' : 'border-line-strong',
    disabled && 'opacity-40',
  ]}
>
  {#if name}
    <span
      class="grid size-9 shrink-0 place-items-center rounded-lg bg-raised text-soft"
      aria-hidden="true"
    >
      <!-- a music note, drawn as a line icon -->
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    </span>
    <div class="min-w-0 flex-1">
      <p class="truncate font-mono text-sm">{name}</p>
      <p class="truncate text-xs text-muted tabular-nums">{meta}</p>
    </div>
    <p class="shrink-0 text-xs text-muted">
      {loading ? 'Loading…' : 'Drop another file to replace'}
    </p>
  {:else}
    <div class="text-center">
      <p class="text-sm text-fg">
        {loading ? 'Loading…' : 'Drop your beat here'}
      </p>
      <p class="mt-1 text-xs text-muted">WAV or MP3, the file you exported</p>
    </div>
  {/if}
</div>

{#if error}
  <p class="mt-2 text-sm text-bad">{error}</p>
{/if}
