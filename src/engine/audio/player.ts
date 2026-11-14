// Plays one decoded AudioBuffer: play, pause, seek, and "where are we now".
//
// The core Web Audio idea: an AudioBufferSourceNode is ONE-SHOT. You can call
// start() on it once, and after stop() (or reaching the end) it's dead. So
// "pause" really means "stop and remember where we were", and "play" means
// "make a new source node and start it from that offset". Source nodes are
// cheap; the samples live in the AudioBuffer, which every source shares.
//
// Web Audio also doesn't tell you the playback position of a source. We work
// it out from the context's clock, `ctx.currentTime`, which is the audio
// hardware clock in seconds and keeps running whether or not we play:
//
//   startedAt = ctx.currentTime - offset     (when we start at `offset`)
//   position  = ctx.currentTime - startedAt  (any time later)
//
// i.e. `startedAt` is the clock time at which second 0 of the song "would have"
// played. While paused there is no source, so the position is just `pausedAt`.
import { getAudioContext } from './context'

export type Player = {
  play(): Promise<void>
  pause(): void
  toggle(): Promise<void>
  seek(seconds: number): void
  getTime(): number // seconds into the buffer
  isPlaying(): boolean
  onEnded(callback: () => void): void // called when playback reaches the end by itself
  dispose(): void
}

export function createPlayer(buffer: AudioBuffer): Player {
  const ctx = getAudioContext()
  const duration = buffer.duration

  let source: AudioBufferSourceNode | null = null // the node playing right now
  let playing = false
  let startedAt = 0 // ctx.currentTime at which offset 0 would have played (see top)
  let pausedAt = 0 // position in seconds while not playing
  let endedCallback: (() => void) | null = null
  let disposed = false

  function clampTime(seconds: number): number {
    return Math.min(Math.max(seconds, 0), duration)
  }

  function getTime(): number {
    if (!playing) return pausedAt
    // The clock keeps running for a moment after the end, so clamp.
    return clampTime(ctx.currentTime - startedAt)
  }

  // Creates a fresh source node and starts it at `offset` seconds into the buffer.
  function startSource(offset: number) {
    const node = ctx.createBufferSource()
    node.buffer = buffer
    node.connect(ctx.destination) // destination = the speakers
    node.onended = () => {
      // Only reached at the real end: stopSource() removes this handler first,
      // because `onended` ALSO fires when we call stop() ourselves.
      node.disconnect()
      source = null
      playing = false
      pausedAt = 0 // next play starts from the beginning
      endedCallback?.()
    }
    node.start(0, offset) // 0 = start now
    source = node
    startedAt = ctx.currentTime - offset
    playing = true
  }

  // Stops the current source without it counting as "ended".
  function stopSource() {
    if (source === null) return
    source.onended = null
    source.stop()
    source.disconnect()
    source = null
    playing = false
  }

  async function play() {
    if (playing || disposed) return
    // Autoplay rule: the context starts "suspended" until resumed from a user
    // gesture. Call play() from a click or key handler.
    await ctx.resume()
    // While we waited, play() may have been called again, or the player disposed.
    if (playing || disposed) return
    // Pressing play at the very end starts over.
    const offset = pausedAt >= duration ? 0 : pausedAt
    startSource(offset)
  }

  function pause() {
    if (!playing) return
    pausedAt = getTime() // read before stopping, while `playing` is still true
    stopSource()
  }

  async function toggle() {
    if (playing) {
      pause()
    } else {
      await play()
    }
  }

  function seek(seconds: number) {
    const target = clampTime(seconds)
    if (playing) {
      // Can't move a running source: replace it with one at the new offset.
      stopSource()
      startSource(target)
    } else {
      pausedAt = target
    }
  }

  function dispose() {
    disposed = true
    stopSource()
    endedCallback = null
  }

  return {
    play,
    pause,
    toggle,
    seek,
    getTime,
    isPlaying: () => playing,
    onEnded: (callback) => {
      endedCallback = callback
    },
    dispose,
  }
}
