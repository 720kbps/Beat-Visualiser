<script lang="ts">
  // One-time setup (CLAUDE.md, user flow step 0). A panel over the app with
  // the five things that must work before the first take:
  //   1. our script is in FL's Settings/Hardware folder (copied automatically)
  //   2. the virtual MIDI ports exist (created by the app at startup)
  //   3. the user picked them in FL's MIDI settings (manual, shown with a GIF)
  //   4. "Test connection": FL answers a ping
  //   5. macOS Screen Recording permission
  // App opens it on first launch, when something is missing, and from the
  // "Setup" button in the top bar.
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { open as openDialog } from '@tauri-apps/plugin-dialog'
  import type { SetupStatus } from './setup-status'
  import type { Connection } from './connection'

  let {
    connection,
    ontest,
    onclose,
  }: {
    connection: Connection // FL's answer to the last "Test connection"
    ontest: () => void
    onclose: () => void
  } = $props()

  let status = $state<SetupStatus | null>(null)
  let statusError = $state('') // setup_status itself failed
  let scriptError = $state('')
  let installing = $state(false)
  let justInstalled = $state(false)
  let permissionError = $state('')
  let permissionAsked = $state(false)
  let gifMissing = $state(false)

  async function refresh() {
    try {
      status = await invoke<SetupStatus>('setup_status')
      statusError = ''
    } catch (e) {
      statusError = String(e)
    }
  }

  // `picked`: a folder chosen by the user, or null for the found one.
  async function install(picked: string | null) {
    scriptError = ''
    installing = true
    try {
      await invoke('install_fl_script', { picked })
      justInstalled = true
      await refresh()
    } catch (e) {
      scriptError = String(e)
    } finally {
      installing = false
    }
  }

  async function chooseFolder() {
    const picked = await openDialog({
      directory: true,
      title: 'Choose the “FL Studio” folder (Documents/Image-Line/FL Studio)',
    })
    if (typeof picked === 'string') await install(picked)
  }

  async function requestPermission() {
    permissionError = ''
    try {
      const granted = await invoke<boolean>('request_screen_permission')
      permissionAsked = !granted
      await refresh()
    } catch (e) {
      permissionError = String(e)
    }
  }

  async function openPermissionSettings() {
    try {
      await invoke('open_screen_permission_settings')
    } catch (e) {
      permissionError = String(e)
    }
  }

  async function restartApp() {
    await invoke('restart_app')
  }

  // Load the status once when the panel opens. A found but missing or old
  // script is copied right away: no click needed.
  onMount(async () => {
    await refresh()
    const script = status?.script
    if (script?.hardware_folder && !script.up_to_date) await install(null)
  })

  // Status dot color: green once a step is done, neutral until then.
  function dot(done: boolean): string {
    return done ? 'bg-good' : 'bg-line-strong'
  }

  let scriptOk = $derived(status?.script.up_to_date ?? false)
  let midiOk = $derived(status !== null && status.midi_error === null)
  let permissionOk = $derived(status?.screen_permission ?? false)

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onclose()
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Dimmed backdrop; the panel scrolls on its own if the window is short -->
<div
  class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-6"
  role="presentation"
>
  <div
    class="flex w-full max-w-2xl flex-col gap-6 rounded-2xl border border-line bg-surface p-6"
    role="dialog"
    aria-modal="true"
    aria-labelledby="setup-title"
  >
    <header class="flex flex-col gap-1">
      <h2 id="setup-title" class="text-lg font-semibold">Connect FL Studio</h2>
      <p class="text-sm text-soft">
        A one-time setup, so the app can start FL and record your plugin
        windows.
      </p>
    </header>

    <ol class="flex flex-col gap-5">
      <!-- 1. Script -->
      <li class="flex gap-3">
        <span class={['mt-1.5 size-2 shrink-0 rounded-full', dot(scriptOk)]}
        ></span>
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <h3 class="text-sm font-medium">The Beat Visualiser script in FL</h3>
          {#if statusError}
            <p class="text-sm text-bad">{statusError}</p>
          {:else if !status}
            <p class="text-sm text-muted">Checking…</p>
          {:else if installing}
            <p class="text-sm text-muted">Copying the script…</p>
          {:else if scriptOk}
            <p class="text-sm text-soft">
              {justInstalled ? 'Copied into' : 'Installed in'}
              <span class="font-mono text-xs break-all"
                >{status.script.hardware_folder}</span
              >
            </p>
            {#if justInstalled}
              <p class="text-xs text-muted">
                If FL is already open, restart it so it finds the script. After
                an update, clicking “Reload script” in FL’s Script output window
                is enough.
              </p>
            {/if}
          {:else if !status.script.hardware_folder}
            <p class="text-sm text-soft">
              FL Studio’s data folder isn’t in the usual place
              (Documents/Image-Line/FL Studio). Choose it once, the app
              remembers it.
            </p>
            <div>
              <button class="btn btn-secondary" onclick={chooseFolder}>
                Choose folder
              </button>
            </div>
          {:else}
            <div>
              <button class="btn btn-secondary" onclick={() => install(null)}>
                Install script
              </button>
            </div>
          {/if}
          {#if scriptError}
            <p class="text-sm text-bad">{scriptError}</p>
            <div>
              <button class="btn btn-ghost" onclick={chooseFolder}>
                Choose folder
              </button>
            </div>
          {/if}
        </div>
      </li>

      <!-- 2. MIDI ports -->
      <li class="flex gap-3">
        <span class={['mt-1.5 size-2 shrink-0 rounded-full', dot(midiOk)]}
        ></span>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <h3 class="text-sm font-medium">The MIDI port</h3>
          {#if status?.midi_error}
            <p class="text-sm text-bad">{status.midi_error}</p>
          {:else if status}
            <p class="text-sm text-soft">
              “Beat Visualiser” is ready while this app is open.
            </p>
          {/if}
        </div>
      </li>

      <!-- 3. FL's MIDI settings (manual) -->
      <li class="flex gap-3">
        <span
          class={[
            'mt-1.5 size-2 shrink-0 rounded-full',
            dot(connection.state === 'ok'),
          ]}
        ></span>
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <h3 class="text-sm font-medium">Turn it on in FL’s MIDI settings</h3>
          <ol class="list-decimal space-y-1 pl-5 text-sm text-soft">
            <li>In FL, open Options › MIDI settings.</li>
            <li>
              Under Input, select “Beat Visualiser”, set Controller type to
              “Beat Visualiser”, click Enable and give it a port number, like
              10.
            </li>
            <li>
              Under Output, select “Beat Visualiser” and give it the same port
              number.
            </li>
          </ol>
          <p class="text-xs text-muted">
            Not in the list? Click “Rescan devices” in the same window.
          </p>
          <!--
            Recorded once from FL's MIDI settings and put in public/onboarding/.
            Hidden until the file exists.
          -->
          {#if !gifMissing}
            <img
              src="/onboarding/fl-midi-settings.gif"
              alt="Selecting the Beat Visualiser input and output in FL Studio’s MIDI settings"
              class="w-full rounded-lg border border-line"
              onerror={() => (gifMissing = true)}
            />
          {/if}
        </div>
      </li>

      <!-- 4. Test connection -->
      <li class="flex gap-3">
        <span
          class={[
            'mt-1.5 size-2 shrink-0 rounded-full',
            dot(connection.state === 'ok'),
          ]}
        ></span>
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <h3 class="text-sm font-medium">Test the connection</h3>
          <div class="flex flex-wrap items-center gap-3">
            <button
              class="btn btn-secondary"
              onclick={ontest}
              disabled={connection.state === 'checking'}
            >
              {connection.state === 'checking' ? 'Testing…' : 'Test connection'}
            </button>
            {#if connection.state === 'ok'}
              <span class="text-sm text-good">{connection.message}</span>
            {/if}
          </div>
          {#if connection.state === 'fail'}
            <p class="text-sm text-bad">{connection.message}</p>
          {/if}
        </div>
      </li>

      <!-- 5. Screen recording (macOS) -->
      {#if status?.platform === 'macos'}
        <li class="flex gap-3">
          <span
            class={['mt-1.5 size-2 shrink-0 rounded-full', dot(permissionOk)]}
          ></span>
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <h3 class="text-sm font-medium">Screen recording permission</h3>
            {#if permissionOk}
              <p class="text-sm text-soft">Allowed.</p>
            {:else}
              <p class="text-sm text-soft">
                macOS asks once before an app can record windows. The app only
                records the plugin windows you pick, and the recordings stay on
                this Mac.
              </p>
              <div class="flex flex-wrap gap-2">
                {#if !permissionAsked}
                  <button class="btn btn-secondary" onclick={requestPermission}>
                    Allow screen recording
                  </button>
                {:else}
                  <button
                    class="btn btn-secondary"
                    onclick={openPermissionSettings}
                  >
                    Open System Settings
                  </button>
                  <button class="btn btn-ghost" onclick={restartApp}>
                    Restart the app
                  </button>
                {/if}
              </div>
              {#if permissionAsked}
                <p class="text-xs text-muted">
                  Turn on Beat Visualiser under Screen & System Audio Recording,
                  then restart the app: macOS only applies it after a restart.
                  In development the permission belongs to the terminal or
                  editor that runs the app.
                </p>
              {/if}
            {/if}
            {#if permissionError}
              <p class="text-sm text-bad">{permissionError}</p>
            {/if}
          </div>
        </li>
      {/if}
    </ol>

    <footer
      class="flex items-center justify-end gap-2 border-t border-line pt-4"
    >
      <button class="btn btn-primary" onclick={onclose}>Done</button>
    </footer>
  </div>
</div>
