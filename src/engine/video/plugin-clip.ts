// The recorded plugin window as a <video> element the themes draw as a texture.
//
// The video is always muted: the final audio is the beat file, never the
// recorded sound (CLAUDE.md, Output spec). The element is never added to the
// page; Three.js reads its current frame straight into a texture.
//
// Loading: pass a URL the webview may read. In the app that's
// convertFileSrc(path), an asset:// URL served by Tauri (see App.svelte). For
// WebGL the video must be "CORS-clean": a cross-origin video without CORS
// makes the texture upload throw a SecurityError ("tainted"). The asset
// protocol is a different origin from the page, so we request it with
// crossOrigin = 'anonymous'; Tauri answers every asset response with
// `Access-Control-Allow-Origin: <the window's origin>`, which passes the check.
//
// Alignment: a take starts recording a moment before FL starts playing, so
// the beat's second 0 is at `offset` seconds in the video (the take's
// play_offset). sync() shows video time = beat time + offset.

export type PluginClip = {
  video: HTMLVideoElement
  duration: number // seconds
  width: number // video pixels
  height: number
  offset: number // video seconds at beat time 0, see the top of the file
  // Keeps the video in step with the beat. Call once per preview frame.
  sync(time: number, playing: boolean): void
  dispose(): void // stops the video and frees its decoder
}

// While playing: start catching up when the video drifts more than 1.5 frames
// (of a 60 fps recording) from the beat, and keep going until it's within half
// a frame. Two limits so the speed doesn't flip back and forth every frame.
const START_CATCH_UP = 1.5 / 60
const STOP_CATCH_UP = 0.5 / 60
// While paused, the video is moved when it's further than this from the beat.
const PAUSED_TOLERANCE = 0.5 / 60
// Above this the video jumps (seek); below it, it catches up by playing a bit faster or slower.
const SEEK_THRESHOLD = 0.5
const CATCH_UP_RATE = 0.1 // ±10% speed while catching up

// `offset`: the take's play_offset. 0 for a recording without one (the video
// then simply starts with the beat).
export function loadPluginClip(url: string, offset = 0): Promise<PluginClip> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true // no fullscreen takeover (matters on iOS-style WebKit)
  video.loop = false // past the end we hold the last frame
  video.preload = 'auto'
  video.crossOrigin = 'anonymous' // must be set before src, see the top of the file

  return new Promise((resolve, reject) => {
    function cleanup() {
      video.removeEventListener('loadeddata', onLoaded)
      video.removeEventListener('error', onError)
    }

    // loadeddata: the first frame is decoded, so the texture has something to show.
    function onLoaded() {
      cleanup()
      const duration = video.duration
      if (!Number.isFinite(duration) || duration <= 0) {
        unload(video)
        reject(new Error('The recording has no length (empty or broken file).'))
        return
      }
      resolve(createClip(video, duration, offset))
    }

    function onError() {
      cleanup()
      const message = describeError(video.error)
      unload(video)
      reject(new Error(message))
    }

    video.addEventListener('loadeddata', onLoaded)
    video.addEventListener('error', onError)
    video.src = url
  })
}

function createClip(
  video: HTMLVideoElement,
  duration: number,
  offset: number,
): PluginClip {
  // Preview only. Export will set currentTime for every frame and wait for it.
  //
  // The clip time is the beat time plus the offset. Before the video starts
  // we show its first frame, after its end we hold the last frame: the
  // recording covers one section, it doesn't repeat.
  //
  // While playing we let the video run on its own clock and only correct it
  // when it drifts. Seeking every frame would stutter: each seek makes the
  // decoder go back to the previous keyframe and decode forward. A seek also
  // takes time, during which the beat keeps going, so after a seek the video
  // is already a little behind; correcting that with another seek would loop
  // forever. So small drifts are fixed by playing slightly faster or slower,
  // and only big jumps (user seek) use a seek.
  function sync(time: number, playing: boolean) {
    const wanted = time + offset
    const target = Math.min(Math.max(wanted, 0), duration)
    // Not while a seek is still running: currentTime is the seek target then.
    if (video.seeking) return

    // Outside the recording (before its start or after its end) the video
    // stands still on its first or last frame, even while the beat plays.
    const outside = wanted <= 0 || wanted >= duration
    if (!playing || outside) {
      if (!video.paused) video.pause()
      if (video.playbackRate !== 1) video.playbackRate = 1
      // Show the frame at the beat's position (also after a seek of the beat
      // while paused), clamped to the first/last frame. Half a frame of
      // slack, because a browser may
      // report the time of the frame it landed on rather than the exact
      // value we asked for; without it we'd seek again every frame.
      if (Math.abs(video.currentTime - target) > PAUSED_TOLERANCE) {
        video.currentTime = target
      }
      return
    }

    // drift > 0: the video is ahead of the beat. `ended` also seeks: play()
    // on an ended video would restart it from 0.
    const drift = video.currentTime - target
    if (Math.abs(drift) > SEEK_THRESHOLD || video.ended) {
      video.currentTime = target
    }

    const catchingUp = video.playbackRate !== 1
    const limit = catchingUp ? STOP_CATCH_UP : START_CATCH_UP
    let rate = 1
    if (drift > limit) rate = 1 - CATCH_UP_RATE // ahead: slow down
    if (drift < -limit) rate = 1 + CATCH_UP_RATE // behind: speed up
    // Only set it on change: some browsers restart internal timing on every set.
    if (video.playbackRate !== rate) video.playbackRate = rate

    if (video.paused) {
      // play() returns a promise that rejects if it's interrupted (e.g. by
      // pause() a moment later). That's harmless here, so ignore it.
      video.play().catch(() => {})
    }
  }

  return {
    video,
    duration,
    width: video.videoWidth,
    height: video.videoHeight,
    offset,
    sync,
    dispose: () => unload(video),
  }
}

// Stops the video and releases the file and decoder. Removing the src alone
// isn't enough; load() makes the element drop the old media.
function unload(video: HTMLVideoElement) {
  video.pause()
  video.removeAttribute('src')
  video.load()
}

function describeError(error: MediaError | null): string {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_NETWORK:
      return 'Could not read the recording file.'
    case MediaError.MEDIA_ERR_DECODE:
      return 'The recording is damaged or uses a codec this computer cannot decode.'
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'Cannot open the recording: file not found, not allowed, or format not supported.'
    default:
      return `Could not load the recording${error?.message ? `: ${error.message}` : '.'}`
  }
}
