// 2D canvas waveform with a moving playhead. Temporary: Phase 3 replaces this
// with the Three.js LCD theme.
//
// Two layers:
// - The waveform itself only changes when the canvas is resized, so it's drawn
//   once into a hidden canvas (a cache).
// - Every animation frame we copy that cache onto the visible canvas and draw
//   the playhead and time readout on top. Copying a ready image is much cheaper
//   than redrawing thousands of columns 60 times a second.
//
// The playhead position comes from `getTime()`, called inside the frame loop.
// It's a plain value read here, never stored in Svelte state (see CLAUDE.md).
import { peaksFromBuffer } from '../audio/peaks'
import { formatTime, timeToX, xToTime } from './waveform-helpers'

// Placeholder colors in the LCD spirit
const BACKGROUND = '#0a1424'
const CENTER_LINE = 'rgba(56, 189, 248, 0.25)'
const WAVE = '#38bdf8'
const PLAYED_DIM = 'rgba(0, 0, 0, 0.35)'
const PLAYHEAD = '#e0f2fe'
const TEXT = '#bae6fd'

export type WaveformView = {
  dispose(): void
}

export function createWaveformView(
  canvas: HTMLCanvasElement,
  buffer: AudioBuffer,
  getTime: () => number,
  onSeek?: (seconds: number) => void,
): WaveformView {
  const duration = buffer.duration
  const g = get2d(canvas)

  // Hidden canvas holding the drawn waveform. A regular <canvas> that is never
  // added to the page; it works everywhere and drawImage() accepts it directly.
  // (OffscreenCanvas would also work in current WebKit, but it only pays off
  // when drawing in a Web Worker, which we don't.)
  const cache = document.createElement('canvas')
  const cacheG = get2d(cache)

  // Size in CSS pixels, from the ResizeObserver. The canvas backing store
  // (canvas.width/height) is this times devicePixelRatio, so 1 canvas pixel =
  // 1 screen pixel and the drawing is sharp on Retina.
  let cssWidth = 0
  let cssHeight = 0
  let dpr = window.devicePixelRatio || 1
  let rafId = 0 // id of the next scheduled frame, needed to cancel it

  function resize() {
    dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(cssWidth * dpr))
    const height = Math.max(1, Math.round(cssHeight * dpr))
    // Setting width/height clears a canvas, even to the same value. Our frame
    // loop redraws everything anyway.
    canvas.width = width
    canvas.height = height
    cache.width = width
    cache.height = height
    drawWaveform(width, height)
  }

  // One column of peaks per device pixel, each drawn as a 1 px wide bar from min to max.
  function drawWaveform(width: number, height: number) {
    const peaks = peaksFromBuffer(buffer, width)
    const mid = height / 2
    const scale = mid * 0.9 // leave a little room at top and bottom

    cacheG.fillStyle = BACKGROUND
    cacheG.fillRect(0, 0, width, height)

    cacheG.fillStyle = CENTER_LINE
    cacheG.fillRect(0, Math.floor(mid), width, Math.max(1, Math.round(dpr)))

    cacheG.fillStyle = WAVE
    for (let x = 0; x < width; x++) {
      const min = peaks[x * 2]
      const max = peaks[x * 2 + 1]
      // Canvas y grows downwards, so the max sample is the top of the bar.
      const top = mid - max * scale
      const bottom = mid - min * scale
      // At least 1 px tall, so silence still shows as a thin line
      cacheG.fillRect(x, top, 1, Math.max(1, bottom - top))
    }
  }

  // Runs once per screen refresh (requestAnimationFrame), ~60 times a second.
  function frame() {
    // Moving the window to a screen with a different pixel density changes
    // devicePixelRatio without changing the CSS size, so the ResizeObserver
    // doesn't fire. Checking here is one comparison per frame.
    if ((window.devicePixelRatio || 1) !== dpr) resize()

    const width = canvas.width
    const height = canvas.height
    const time = getTime()
    const x = timeToX(time, duration, width)

    g.drawImage(cache, 0, 0)

    // Dim the part that has already played
    g.fillStyle = PLAYED_DIM
    g.fillRect(0, 0, x, height)

    // Playhead, 2 CSS pixels wide
    const lineWidth = 2 * dpr
    g.fillStyle = PLAYHEAD
    g.fillRect(x - lineWidth / 2, 0, lineWidth, height)

    // Time readout, top left. Sizes are in device pixels, hence `* dpr`.
    g.fillStyle = TEXT
    g.font = `${12 * dpr}px ui-monospace, monospace`
    g.textBaseline = 'top'
    g.fillText(
      `${formatTime(time)} / ${formatTime(duration)}`,
      6 * dpr,
      6 * dpr,
    )

    rafId = requestAnimationFrame(frame)
  }

  // ResizeObserver calls back when the element's size changes, and once right
  // after observe() starts, which gives us the initial size.
  // contentRect is in CSS pixels. (devicePixelContentBoxSize would give exact
  // device pixels, but WebKit, which Tauri uses on macOS, doesn't support it.)
  const observer = new ResizeObserver((entries) => {
    const rect = entries[0].contentRect
    cssWidth = rect.width
    cssHeight = rect.height
    resize()
  })
  observer.observe(canvas)

  // Click to seek. offsetX is in CSS pixels relative to the canvas.
  function onPointerDown(event: PointerEvent) {
    if (onSeek) onSeek(xToTime(event.offsetX, cssWidth, duration))
  }
  canvas.addEventListener('pointerdown', onPointerDown)

  rafId = requestAnimationFrame(frame)

  return {
    dispose() {
      cancelAnimationFrame(rafId)
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
    },
  }
}

function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = canvas.getContext('2d')
  if (g === null) throw new Error('Canvas 2D is not available.')
  return g
}
