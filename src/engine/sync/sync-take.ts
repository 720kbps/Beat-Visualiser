// Glue for the UI: reads a take's recorded sound and lines it up with the beat.
import { alignOffset, mixToMono, type AlignResult } from './align'
import { readRecordedAudio } from './recording-audio'

// How much of the recording is compared (alignOffset's analyzeSeconds).
const ANALYZE_SECONDS = 8

// `url`: the take (asset:// URL in the app). `beat`: the decoded beat;
// `sectionStart`: where in it the take starts (beat time 0).
// `coarseOffset`: the take's play_offset (0 if unknown). `searchSeconds`:
// how far the real offset may be from it.
// Returns null if the recording has no audio track. Throws if it can't be read.
export async function syncTakeToBeat(
  url: string,
  beat: AudioBuffer,
  sectionStart: number,
  coarseOffset: number,
  searchSeconds = 0.5,
): Promise<AlignResult | null> {
  // alignOffset compares video time max(0, coarse - search) onwards, for
  // ANALYZE_SECONDS. Read just that (plus a little), not the whole take.
  const readSeconds =
    Math.max(0, coarseOffset - searchSeconds) + ANALYZE_SECONDS + 0.1
  const recorded = await readRecordedAudio(url, readSeconds)
  if (!recorded) return null

  // The beat from the section start; the shifts can reach up to
  // 2 × searchSeconds past the analyzed part.
  const channels: Float32Array[] = []
  for (let c = 0; c < beat.numberOfChannels; c++) {
    channels.push(beat.getChannelData(c))
  }
  const first = Math.round(sectionStart * beat.sampleRate)
  const count = Math.round(
    (ANALYZE_SECONDS + 2 * searchSeconds + 0.1) * beat.sampleRate,
  )
  const beatMono = mixToMono(channels, first, count)

  return alignOffset(
    beatMono,
    beat.sampleRate,
    recorded.samples,
    recorded.sampleRate,
    coarseOffset,
    { searchSeconds, analyzeSeconds: ANALYZE_SECONDS },
  )
}
