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

  let { onfile }: { onfile: (file: BeatFile) => void } = $props()

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
    if (loading) return

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
        hovering = true
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

<div
  class={[
    'flex h-40 items-center justify-center rounded-lg border-2 border-dashed transition-colors',
    hovering
      ? 'border-sky-400 bg-sky-950 text-sky-300'
      : 'border-zinc-600 bg-zinc-800 text-zinc-400',
  ]}
>
  {#if loading}
    <p>Loading…</p>
  {:else}
    <p>Drop your beat here — WAV or MP3</p>
  {/if}
</div>

{#if error}
  <p class="mt-2 text-red-400">{error}</p>
{/if}
