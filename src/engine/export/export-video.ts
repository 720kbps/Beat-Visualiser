// Renders the clip frame by frame and encodes it into an MP4 in memory.
//
// How the pieces fit (CLAUDE.md, Export):
//   theme.render(frame i)            the SAME call the preview makes, into the same canvas
//   -> VideoFrame of the canvas      a snapshot of the pixels, plus a timestamp
//   -> VideoEncoder (H.264)          WebCodecs, the system's hardware encoder
//   -> MP4 muxer                     Mediabunny writes the packets into an MP4 file
// and the beat's audio section goes AudioEncoder (AAC) -> the same muxer.
//
// Mediabunny wraps the WebCodecs encoders for us (CanvasSource and
// AudioSampleSource). It also carries workarounds for known WebKit encoder
// bugs (e.g. WebKit's AAC encoder reporting a broken codec description),
// which is why we don't drive VideoEncoder/AudioEncoder by hand.
//
// WebCodecs concepts, as they appear below:
// - VideoFrame: one picture plus its timestamp. Made from the canvas right
//   after render(), in the same JS task. The canvas has
//   preserveDrawingBuffer: false, so after the browser shows it, its pixels
//   may be gone; snapshotting immediately avoids that.
// - Timestamps: WebCodecs counts in microseconds; Mediabunny takes seconds
//   and converts. Frame i has timestamp i / fps (timing.ts), never a clock.
// - Keyframes: a frame that can be decoded on its own. The others only store
//   the difference to earlier frames. One every 2 s keeps seeking quick.
// - Backpressure: encode() only queues a frame; the encoder works in the
//   background. If we queued all 1800 frames of a 60 s video at once, each
//   1080×1920 frame (8 MB) would wait in memory. So add() returns a promise
//   that resolves once the encoder's queue is short again; we await it.
// - Flush: at the end the encoder still holds frames it hasn't output.
//   output.finalize() flushes (waits until every queued frame is encoded),
//   then writes the MP4's index.
import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
} from 'mediabunny'
import type { FrameSource } from '../frame/frame-data'
import type { RenderContext } from '../render/renderer'
import type { ParamValues, Visualizer } from '../visualizers/types'
import { applyFades, sliceSection } from './audio-section'
import { openPluginFrames, type PluginFrameReader } from './plugin-frames'
import {
  AAC_SAMPLE_RATES,
  audioQuality,
  checkExportSupport,
  videoBitrate,
} from './support'
import {
  createProgressThrottle,
  frameCount,
  frameTime,
  pluginVideoTime,
} from './timing'

export type ExportOptions = {
  ctx: RenderContext // the preview's renderer; the caller pauses the preview loop
  visualizer: Visualizer // already init()ed on ctx
  params: ParamValues // a snapshot: not changed while exporting
  // Per-frame values for exactly the exported section:
  // getFrame(t) with t = seconds into the clip (0..length).
  frameSource: FrameSource
  audio: AudioBuffer // the decoded beat (the whole file)
  sectionStart: number // seconds into the beat where the clip starts
  length: number // seconds
  fps: number // 30 or 60
  // The recorded plugin window, or null to export without it.
  // url: readable by fetch (asset:// in the app); offset: the take's play_offset.
  plugin: { url: string; offset: number } | null
}

// Called with 0..1, at most ~10 times a second.
export type ProgressCallback = (progress: number) => void

const KEYFRAME_INTERVAL_SECONDS = 2
const AUDIO_CHUNK_SECONDS = 1 // audio is added in pieces, alongside the video
// Give the browser a moment this often, so it can repaint (progress bar, the
// preview showing the export) and handle clicks (Cancel).
const YIELD_EVERY_MS = 50

// Returns the finished MP4 file. Throws an AbortError (DOMException) if
// `signal` aborts; nothing is kept in that case.
export async function exportVideo(
  options: ExportOptions,
  onProgress: ProgressCallback,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const { ctx, visualizer, params, frameSource, fps } = options
  const audio = options.audio
  const channels = Math.min(audio.numberOfChannels, 2)

  await checkExportSupport(fps, audio.sampleRate, channels)
  throwIfAborted(signal)

  const totalFrames = frameCount(options.length, fps)
  if (totalFrames === 0)
    throw new Error('Nothing to export: the clip is empty.')
  const progress = createProgressThrottle(onProgress)

  const audioChunks = prepareAudio(
    audio,
    options.sectionStart,
    totalFrames / fps,
  )

  // The whole file in memory: 12 Mbit/s ≈ 90 MB per minute at 30 fps. Fine
  // for clips of at most 60 s.
  const target = new BufferTarget()
  const output = new Output({
    // fastStart 'in-memory': the MP4's index goes at the front of the file,
    // so players and uploads can start before reading the whole file.
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  })

  // Captures ctx.canvas into a VideoFrame on every add().
  const video = new CanvasSource(ctx.canvas, {
    codec: 'avc', // H.264; Mediabunny picks the exact profile/level string
    quality: new Quality({ bitrate: videoBitrate(fps) }),
    keyFrameInterval: KEYFRAME_INTERVAL_SECONDS,
    latencyMode: 'quality', // never drop frames to keep up
  })
  output.addVideoTrack(video, { frameRate: fps })

  const sound = new AudioSampleSource({
    codec: 'aac',
    quality: audioQuality(),
    // AAC is only used at 44.1/48 kHz; anything else is resampled to 48 kHz.
    transform: AAC_SAMPLE_RATES.includes(audio.sampleRate)
      ? undefined
      : { sampleRate: 48000 },
  })
  output.addAudioTrack(sound)

  let plugin: PluginFrameReader | null = null
  try {
    if (options.plugin) {
      const { url, offset } = options.plugin
      const times: number[] = []
      for (let i = 0; i < totalFrames; i++) {
        times.push(pluginVideoTime(i, fps, options.sectionStart, offset))
      }
      plugin = await openPluginFrames(url, times)
    }

    await output.start()

    let audioIndex = 0
    let lastYield = performance.now()

    for (let i = 0; i < totalFrames; i++) {
      throwIfAborted(signal)
      const t = frameTime(i, fps)

      // Audio first, up to the end of this frame. Muxers want the tracks
      // added side by side (interleaved), not one whole track after the other.
      while (
        audioIndex < audioChunks.length &&
        audioChunks[audioIndex].timestamp < t + 1 / fps
      ) {
        await sound.add(audioChunks[audioIndex])
        audioChunks[audioIndex].close()
        audioIndex++
      }

      // The plugin picture for this frame, drawn into plugin.canvas.
      if (plugin) await plugin.next()

      const frame = frameSource.getFrame(t)
      frame.plugin = plugin ? plugin.canvas : undefined
      visualizer.render(frame, params)
      // No await between render() and add(): add() snapshots the canvas
      // synchronously, then we wait for the encoder (backpressure).
      await video.add(t, 1 / fps)

      progress((i + 1) / totalFrames)

      if (performance.now() - lastYield > YIELD_EVERY_MS) {
        await yieldToBrowser()
        lastYield = performance.now()
      }
    }

    // Any audio left (rounding): add it so both tracks end together.
    for (; audioIndex < audioChunks.length; audioIndex++) {
      await sound.add(audioChunks[audioIndex])
      audioChunks[audioIndex].close()
    }

    throwIfAborted(signal)
    await output.finalize() // flush the encoders, write the index
  } catch (err) {
    // Cancel or error: stop the encoders and throw away the partial file.
    for (const chunk of audioChunks) chunk.close() // safe to call twice
    await output.cancel().catch(() => {})
    throw err
  } finally {
    await plugin?.dispose().catch(() => {})
  }

  const buffer = target.buffer
  if (!buffer) throw new Error('The encoder produced no file.')
  return new Uint8Array(buffer)
}

// The beat's section, faded, as 1 s AudioSamples ("planar" float data:
// all of channel 0, then all of channel 1).
function prepareAudio(
  audio: AudioBuffer,
  sectionStart: number,
  seconds: number,
): AudioSample[] {
  const rate = audio.sampleRate
  const source: Float32Array[] = []
  for (let c = 0; c < audio.numberOfChannels; c++) {
    source.push(audio.getChannelData(c))
  }
  const section = sliceSection(source, rate, sectionStart, seconds)
  applyFades(section, rate)

  const total = section[0].length
  const chunkLength = Math.round(AUDIO_CHUNK_SECONDS * rate)
  const chunks: AudioSample[] = []
  for (let start = 0; start < total; start += chunkLength) {
    const n = Math.min(chunkLength, total - start)
    const data = new Float32Array(n * section.length)
    section.forEach((channel, c) => {
      data.set(channel.subarray(start, start + n), c * n)
    })
    chunks.push(
      new AudioSample({
        data,
        format: 'f32-planar',
        numberOfChannels: section.length,
        sampleRate: rate,
        timestamp: start / rate,
      }),
    )
  }
  return chunks
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

// A macrotask (setTimeout), not just a resolved promise: only then can the
// browser repaint and run click handlers in between.
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
