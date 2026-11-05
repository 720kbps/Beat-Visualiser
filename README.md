# Beat Visualiser

A desktop app (macOS and Windows) that turns a beat into a TikTok-ready 9:16 video.

It controls FL Studio, **automatically records a plugin window while the beat plays**, and puts that recording into a retro hardware-style video together with the real waveform of the track. No screen recorder, no video editing.

> **Status:** early development. The repo is currently a Vite + Svelte + TypeScript scaffold. Nothing below is working yet; this README describes what is being built.

## How it works

1. **One-time setup.** The app installs a small FL Studio MIDI script. You select it once in FL's MIDI settings and press "Test connection".
2. **Drop your beat** (an exported WAV or MP3).
3. **The best section is picked for you:** the strongest 15, 30 or 60 seconds, cut on the bar. You can drag it.
4. **Pick a plugin window** from the list of open windows in FL.
5. **Record.** The app jumps FL to the section start, plays, records the window, and stops FL at the end.
6. **Pick a theme** and see a live preview: your recording on the device screen, with the waveform and a moving playhead.
7. **Add text** (optional): beat name, BPM, key, producer tag. BPM and key are filled in from the audio analysis.
8. **Export** a 1080×1920 MP4.

## The look

Fake hardware: a brushed metal device, blue LCD screens with grid lines and scanlines, chunky coloured buttons and knobs. Think early-2000s hardware sampler. All visuals are rendered with WebGL shaders, and all designs are original.

## Principles

- **Defaults over choices.** Every step has a good default. Drop a file, pick a window, press export.
- **Set up once, then one click.**
- **What you see is what you get.** The preview and the exported video are identical, frame for frame.
- **Musically correct.** Clips start on a downbeat, last a whole number of bars, and the plugin recording stays in sync with the audio.
- **Private by default.** Your audio and recordings never leave your computer. There is no backend.

## Output

| Property    | Value                                             |
| ----------- | ------------------------------------------------- |
| Resolution  | 1080 × 1920 (9:16)                                |
| Frame rate  | 30 fps (60 fps option)                            |
| Video       | H.264                                             |
| Audio       | AAC, taken from the beat file (never the recording) |
| Container   | MP4                                               |
| Lengths     | 15 / 30 / 60 s, always a whole number of bars     |

## Tech stack

| Part             | Choice                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| Desktop shell    | [Tauri](https://tauri.app/) (Rust)                                          |
| UI               | Svelte 5, TypeScript, Vite, Tailwind v4                                     |
| Rendering        | Three.js: one fullscreen quad with GLSL fragment shaders                    |
| Window capture   | ScreenCaptureKit (macOS), Windows.Graphics.Capture (Windows)                |
| FL Studio control | FL's built-in MIDI Controller Scripting (Python), driven over a virtual MIDI port |
| Audio analysis   | BPM, beats, loudness and onsets for picking the highlight                   |

The engine (audio, analysis, rendering, export) is plain TypeScript and never imports Svelte. The UI only calls into it. Themes are plugins: each one implements a single `Visualizer` interface and declares its own controls.

## Project structure (planned)

```
src/
  engine/          plain TypeScript, no Svelte
    audio/         decoding, waveform peaks
    analysis/      BPM, beats, highlight scoring
    render/        Three.js setup, shaders, frame loop
    export/        export pipeline
    visualizers/   one folder per theme
  ui/              Svelte components
src-tauri/         Rust: window capture, MIDI, file system, encoding
fl-script/         the FL Studio MIDI script installed into FL
```

## Development

Requirements: [Node.js](https://nodejs.org/) and, once Tauri is added, the [Rust toolchain](https://rustup.rs/).

```sh
npm install
npm run dev      # start the Vite dev server
npm run check    # type-check Svelte and TypeScript
npm run build    # production build
```

Tauri commands will be added here once `src-tauri/` exists.

## Roadmap

- [ ] **Phase 0, setup:** Tailwind, ESLint + Prettier, engine/UI folders, Tauri
- [ ] **Phase 1, spike:** list windows from Rust, record a plugin window on macOS and Windows, FL script for play/stop, trigger FL from the app
- [ ] **Phase 2, audio in:** drop zone, decoding, waveform with playhead
- [ ] **Phase 3, first theme:** LCD sampler theme with the recording as a video texture
- [ ] **Phase 4:** automatic highlight detection
- [ ] **Phase 5:** full record flow and audio sync
- [ ] **Phase 6:** MP4 export
- [ ] **Phase 7:** onboarding and polish
- [ ] **Phase 8:** signed releases and testing with producers
