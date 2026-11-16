// Matches the Rust `SetupStatus` / `ScriptStatus` structs (lib.rs,
// fl_script.rs). Field names stay snake_case.
export type SetupStatus = {
  script: {
    hardware_folder: string | null // FL's Settings/Hardware, null = not found
    installed: boolean
    up_to_date: boolean
  }
  midi_error: string | null // why the MIDI ports are missing, null = fine
  screen_permission: boolean
  platform: 'macos' | 'windows'
}

// True if setup has nothing left that the app can check by itself.
// (FL's MIDI settings can only be checked with "Test connection".)
export function setupComplete(status: SetupStatus): boolean {
  return (
    status.script.up_to_date &&
    status.midi_error === null &&
    status.screen_permission
  )
}
