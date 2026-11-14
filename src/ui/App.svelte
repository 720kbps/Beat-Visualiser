<script lang="ts">
  // Phase 1 spike: list open windows and record one. Throwaway UI.
  import { invoke } from '@tauri-apps/api/core'

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

  // Free-text substring match on the window title, so any plugin works.
  // Default: Ogun, FL Studio's built-in synth.
  let titleFilter = $state('Ogun')
  let windows = $state<WindowInfo[]>([])
  let error = $state('')
  let recording = $state(false)
  let savedPath = $state('')

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
