// One shared AudioContext for the whole app.
//
// An AudioContext is the Web Audio "engine": it owns the audio output device,
// the sample rate and the clock. Browsers limit how many you can create, and
// nodes from one context can't be connected to another, so decoding and
// playback should all use this one.

let ctx: AudioContext | null = null

export function getAudioContext(): AudioContext {
  // Created lazily on the first call, not when this file is imported.
  if (ctx === null) {
    ctx = new AudioContext()
  }
  return ctx
}

// Autoplay rule: a context created outside a user gesture (click, key press)
// starts in the "suspended" state and makes no sound. Playback code must call
// `await getAudioContext().resume()` from inside a click handler before playing.
//
// Decoding does NOT need that: decodeAudioData works on a suspended context,
// because it only turns file bytes into samples and doesn't use the output
// device. So the drop handler can decode before the user ever presses play.
