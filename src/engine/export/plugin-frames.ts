// Reads the recorded plugin window frame by frame, for the export.
//
// The preview uses a <video> element, which plays on its own clock. Export
// can't: it renders frames as fast as it can, and must show exactly the
// video frame belonging to each export frame. Seeking a <video> for every
// frame is slow (each seek decodes from the previous keyframe) and the
// browser may land on a neighbouring frame.
//
// So export decodes the file itself, in order: Mediabunny reads the .mov
// (demuxing: finding each compressed frame in the file) and feeds the frames
// to a WebCodecs VideoDecoder, which turns them into pictures (VideoSample,
// a wrapper around a WebCodecs VideoFrame). Every compressed frame is
// decoded at most once.
//
// Each picture is drawn into one canvas, which the theme uploads as a
// texture (an entry of frame.plugins). A VideoFrame holds GPU/decoder memory until it's
// closed, so every sample is closed right after drawing.
//
// The recording may have a variable frame rate (ScreenCaptureKit only sends a
// new frame when the window changes). That's fine: for each export time we get
// "the last frame that started at or before this time", like a player shows.
import {
  Input,
  MP4,
  QTFF,
  UrlSource,
  VideoSampleSink,
  type VideoSample,
} from 'mediabunny'

export type PluginFrameReader = {
  canvas: HTMLCanvasElement // holds the current frame; goes into frame.plugins
  width: number // video pixels
  height: number
  next(): Promise<void> // draws the frame for the next export time into `canvas`
  dispose(): Promise<void> // stops decoding, frees the decoder and the file
}

// A frame whose timestamp is a hair after the asked time (float noise:
// 0.0333334 vs 0.0333333) still counts as "at" that time.
const TIME_EPSILON = 0.0005

// `url`: the recording (asset:// URL in the app). `times`: video time in
// seconds for every export frame, in order (see timing.ts pluginVideoTime).
// Before the video's first frame the first frame is shown; after its end
// the last one (the decoder gives the last frame for any later time).
export async function openPluginFrames(
  url: string,
  times: number[],
): Promise<PluginFrameReader> {
  // UrlSource reads the file with HTTP range requests, so a big recording
  // isn't loaded into memory at once.
  const input = new Input({ source: new UrlSource(url), formats: [QTFF, MP4] })

  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('The recording has no video track.')

    // Asks VideoDecoder.isConfigSupported() for the track's codec (HEVC for
    // our recordings).
    if (!(await track.canDecode())) {
      const codec = (await track.getCodec()) ?? 'unknown codec'
      throw new Error(
        `This system can't decode the recording (${codec}) for export. Clear the recording to export without it.`,
      )
    }

    const width = await track.getDisplayWidth()
    const height = await track.getDisplayHeight()
    const firstTimestamp = await track.getFirstTimestamp()

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create a 2D canvas.')

    const wanted = times.map((t) => Math.max(t, firstTimestamp) + TIME_EPSILON)
    const sink = new VideoSampleSink(track)
    // One sample (or null) per entry of `wanted`, decoding ahead a little.
    const samples = sink.samplesAtTimestamps(wanted)

    async function next(): Promise<void> {
      const result = await samples.next()
      const sample: VideoSample | null = result.done ? null : result.value
      // null = no frame for this time; the canvas keeps the previous one.
      if (!sample) return
      try {
        sample.draw(context!, 0, 0, width, height)
      } finally {
        sample.close()
      }
    }

    async function dispose(): Promise<void> {
      // Ends the generator early: Mediabunny closes its decoder and any
      // frames it had decoded ahead.
      await samples.return(undefined)
      input.dispose()
    }

    return { canvas, width, height, next, dispose }
  } catch (err) {
    input.dispose()
    throw err
  }
}
