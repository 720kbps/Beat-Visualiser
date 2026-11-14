// Reads the sound a take recorded (the system audio track in the .mov), for
// syncing. Only used for analysis: the exported audio is always the beat file.
//
// Same way of opening the file as the export (plugin-frames.ts): Mediabunny
// reads the .mov with HTTP range requests and decodes the AAC audio with the
// browser's WebCodecs AudioDecoder.
import {
  AudioSampleSink,
  Input,
  MP4,
  QTFF,
  UrlSource,
  type AudioSample,
} from 'mediabunny'

export type RecordedAudio = {
  samples: Float32Array // mono; index 0 = video time 0
  sampleRate: number
}

// Returns the first `seconds` of the recording's sound, mixed to mono, or
// null if the file has no audio track (e.g. takes from before system audio
// was recorded). Throws if there is audio but it can't be decoded.
// A take shorter than `seconds` gives a shorter array (not padded).
//
// Timing: sample i is the sound at video time i / sampleRate. A take's audio
// track starts a little after video time 0 (an "empty edit" of ~10–25 ms in
// the file's edit list), and its first 2112 samples are AAC encoder lead-in
// that the edit list skips. Mediabunny applies the edit list: the decoded
// chunks carry their real video-time timestamps (the first one is about
// -0.03 s, i.e. lead-in, and is dropped below). Checked on a real take and
// on test files in Chrome and WKWebView.
export async function readRecordedAudio(
  url: string,
  seconds: number,
): Promise<RecordedAudio | null> {
  const input = new Input({ source: new UrlSource(url), formats: [QTFF, MP4] })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) return null

    if (!(await track.canDecode())) {
      const codec = (await track.getCodec()) ?? 'unknown codec'
      throw new Error(`This system can't decode the recorded audio (${codec}).`)
    }

    const sampleRate = await track.getSampleRate()
    const out = new Float32Array(Math.ceil(seconds * sampleRate))
    const sink = new AudioSampleSink(track)

    // Decoded samples arrive in chunks (typically 1024 frames for AAC), each
    // with its own timestamp in video time. Each chunk is written at the
    // position its timestamp says, so a gap in the file stays a gap.
    let end = 0 // one past the last sample written
    for await (const sample of sink.samples(0, seconds)) {
      try {
        end = Math.max(end, addToMono(out, sample, sampleRate))
      } finally {
        sample.close() // frees the decoder's memory right away
      }
    }
    return { samples: out.subarray(0, end), sampleRate }
  } finally {
    input.dispose()
  }
}

// Mixes one decoded chunk to mono and adds it into `out` at its timestamp.
// Samples before video time 0 or past the end of `out` are dropped.
// Returns the index after the chunk's last sample.
function addToMono(
  out: Float32Array,
  sample: AudioSample,
  sampleRate: number,
): number {
  const first = Math.round(sample.timestamp * sampleRate)
  const channel = new Float32Array(sample.numberOfFrames)
  const gain = 1 / sample.numberOfChannels
  for (let c = 0; c < sample.numberOfChannels; c++) {
    // 'f32-planar': one plane per channel, as 32-bit floats, whatever format
    // the decoder produced.
    sample.copyTo(channel, { planeIndex: c, format: 'f32-planar' })
    for (let i = 0; i < channel.length; i++) {
      const index = first + i
      if (index >= 0 && index < out.length) out[index] += channel[i] * gain
    }
  }
  return Math.min(Math.max(first + channel.length, 0), out.length)
}
