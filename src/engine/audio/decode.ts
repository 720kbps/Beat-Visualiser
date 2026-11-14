import { getAudioContext } from './context'

export type DecodedAudio = {
  buffer: AudioBuffer
  duration: number // seconds
  sampleRate: number // the AudioContext's rate, not necessarily the file's
  channels: number
}

// Turns the bytes of a WAV or MP3 file into an AudioBuffer (raw float samples,
// one Float32Array per channel, values roughly -1..1).
export async function decodeAudio(bytes: ArrayBuffer): Promise<DecodedAudio> {
  if (bytes.byteLength === 0) {
    throw new Error('The file is empty.')
  }

  // decodeAudioData "detaches" the ArrayBuffer it gets: afterwards that buffer
  // has length 0 and can't be read. The caller keeps the original bytes, so we
  // hand over a copy instead.
  const copy = bytes.slice(0)

  // decodeAudioData resamples to the AudioContext's sample rate (usually
  // 44.1 or 48 kHz, whatever the output device uses). A 44.1 kHz file can
  // come back at 48 kHz. That's fine for preview and analysis; the exported
  // video takes its audio from the original file, not from this buffer.
  let buffer: AudioBuffer
  try {
    buffer = await getAudioContext().decodeAudioData(copy)
  } catch (err) {
    throw new Error('Could not decode this file. Is it a valid WAV or MP3?', {
      cause: err,
    })
  }

  // A file can decode "successfully" but contain no samples.
  if (buffer.length === 0) {
    throw new Error('This file contains no audio.')
  }

  return {
    buffer,
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
  }
}
