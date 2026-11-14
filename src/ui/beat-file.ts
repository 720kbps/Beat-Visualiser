// A beat file the user dropped into the app. Plain TS (not a .svelte file)
// so engine-facing code can import the type too.
export type BeatFile = {
  path: string // absolute path on disk; export in Rust reads the audio from here
  name: string // file name only, e.g. "my beat.wav"
  bytes: ArrayBuffer // the whole file, for decoding in the webview
}
