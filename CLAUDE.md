# Beat Visualiser

Project context for Claude Code. Read this before working on anything in this repo.

## Working with Bogdan (read first)

- **Bogdan is learning this stack** (Svelte, Tauri, Rust, Web Audio). By default, **explain and guide; don't write large amounts of code for him.** Give the steps, the reasoning, and small snippets when needed. Only take over and implement fully when he explicitly says so ("you can take over", "implement it").
- When something errors, explain what went wrong and why before (or instead of) fixing it.
- Be direct. No praise. Point out what is wrong or risky straight away.
- He prefers simple, direct solutions over clever or complex ones. Plain, mid-level code: no language showcases, no unnecessary abstractions.
- He has a graphics programming background (shaders, rendering) and is comfortable with GLSL and backend-style thinking. Frontend and Rust are newer to him.
- Don't run lots of commands or scaffold things on his behalf unless asked.

## The product

A **desktop app (macOS + Windows)** that turns a beat into a TikTok-ready 9:16 video.

**Main selling point:** it controls FL Studio and **automatically records a plugin window** (for example Serum) while the beat plays, then puts that recording into a retro hardware-style video together with the real waveform of the track.

Visual style: skeuomorphic fake hardware. Brushed metal device, blue LCD screens with grid lines and scanlines, chunky colored buttons and knobs, the real waveform drawn on the screens, a moving playhead. Think early-2000s hardware sampler / Winamp-era aesthetic.

- **Target user:** beat producers who post snippets on TikTok, Reels and Shorts, working in FL Studio.
- **Core promise:** one click records your plugin and gives you a correctly cut video. No screen recorder, no editing skills.
- **Differentiator vs competitors** (Specterr, Renderforest, VEED, Kapwing, Rotor): automatic plugin capture synced to the beat, automatic best-section selection cut on the bar, and a specific strong aesthetic.
- **Possible future business.** Keep that in mind for architecture and licensing, but the MVP is about validating that producers want it.

## Design principles

Every feature has to pass these:

1. **Defaults over choices.** Every step has a good default. The user drops a file, picks a window, presses export.
2. **Set up once, then one click.** Manual setup happens one time in onboarding and is verified before the user leaves it.
3. **What you see is what you get.** Preview and exported video are identical, frame for frame.
4. **One strong look per theme.** A theme is a finished aesthetic with at most ~5 controls, not a pile of effect sliders.
5. **Musically correct.** Clips start on a downbeat, last a whole number of bars, and the plugin recording stays in sync with the audio.
6. **Private by default.** Audio and recordings never leave the user's computer. No backend in the MVP.

## User flow

0. **One-time setup:** the app installs its FL Studio script, the user selects it once in FL's MIDI settings, a "Test connection" button confirms FL responds.
1. **Drop the beat** (exported WAV/MP3). Used for analysis and as the final audio.
2. **Auto-selected section:** strongest 15/30/60 s part, snapped to bars. Draggable.
3. **Pick the plugin window:** user opens the plugin in FL; the app lists open plugin windows by title; user picks one. Docked (non-detached) windows are greyed out with a hint to detach them.
4. **Record:** app jumps FL to the section start, plays, records the window, stops FL at the end.
5. **Pick a theme:** live preview with the recording on the device screen, plus waveform and playhead.
6. **Optional text:** beat name, BPM, key, producer tag (BPM and key pre-filled from analysis).
7. **Export:** 1080×1920 MP4 with progress bar, then "Show in folder".

## Output spec

| Property   | Value                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------- |
| Resolution | 1080 × 1920 (9:16)                                                                            |
| Frame rate | 30 fps default, 60 fps option                                                                 |
| Video      | H.264                                                                                         |
| Audio      | AAC, 44.1 or 48 kHz, 192 to 320 kbps, **always from the beat file**, never the recorded audio |
| Container  | MP4                                                                                           |
| Lengths    | 15 / 30 / 60 s, always a whole number of bars                                                 |
| Safe zone  | Keep text and the main screen out of the bottom ~20% and right ~12% (TikTok UI overlays)      |

## Architecture decisions (already made, don't relitigate without a reason)

| Decision                                                                     | Why                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tauri desktop app** (not a website, not Electron)                          | Automatic window capture and FL control need native access. Tauri is far smaller than Electron.                                                             |
| **Svelte 5 + TypeScript + Vite** for the UI                                  | The UI is small; little boilerplate; no virtual DOM fighting the render loop. Not React, not SvelteKit (yet).                                               |
| **Tailwind v4** for the control panel only                                   | Visuals are in WebGL, so CSS framework barely matters. v4 uses `@tailwindcss/vite` and `@import "tailwindcss"`, no `tailwind.config.js`.                    |
| **Framework-free engine**                                                    | Audio, analysis, rendering, export are plain TS that never import Svelte (enforce with ESLint). The UI only calls into the engine.                          |
| **Themes as plugins**                                                        | Each visual style implements one `Visualizer` interface and declares its own params; the UI builds controls from them. Adding a theme never touches the UI. |
| **One render path** for preview and export                                   | Same `render(frame, params)` call. `FrameData` is computed from time, not the live audio clock, so export is deterministic.                                 |
| **Three.js, one fullscreen quad + fragment shaders**                         | LCD tint, glow, scanlines, light leak in GLSL. No React Three Fiber.                                                                                        |
| **Native window capture**, not OBS                                           | ScreenCaptureKit (macOS), Windows.Graphics.Capture (Windows). Users install nothing extra. Rust crates like `scap` / `windows-capture`.                     |
| **FL Studio controlled via its built-in MIDI Controller Scripting (Python)** | Not Flapi (overkill, needs Python on user's machine), not simulated keypresses (needs focus, no timing).                                                    |
| **No MCP layer**                                                             | MCP is for AI tool calls; nothing here needs an AI in the loop.                                                                                             |
| **No backend in the MVP**                                                    | Zero cost per user, private. Accounts/payments/posting come later and only after validation.                                                                |

### Planned folder structure

```
src/
  engine/          plain TypeScript, never imports Svelte
    audio/         decode, waveform peaks
    analysis/      BPM, beats, highlight scoring
    render/        Three.js setup, shaders, frame loop
    export/        export pipeline
    visualizers/   one folder per theme (plugin)
  ui/              Svelte components
src-tauri/         Rust: window capture, MIDI, file system, ffmpeg
fl-script/         the FL Studio MIDI script that gets installed into FL
```

### Visualizer interface (starting point)

```ts
interface Visualizer {
  id: string
  name: string
  params: ParamSchema // sliders, colors, toggles it exposes
  init(ctx: RenderContext): void
  render(frame: FrameData, params: ParamValues): void
  dispose(): void
}

interface FrameData {
  time: number // seconds into the clip
  progress: number // 0..1, drives the playhead
  peaks: Float32Array // precomputed waveform of the clip
  rms: number // current loudness
  bass: number // current low-frequency energy
  beat: boolean // true on a beat frame
  plugin?: VideoFrameSource // the recorded plugin clip at this time
}
```

### Render loop rule

Per-frame values (playhead, levels) live in plain variables inside the engine, driven by `requestAnimationFrame`. **Never put per-frame values in Svelte state.** Svelte state is only for settings the user changes.

## FL Studio control

- A small Python script in FL's `Settings/Hardware/BeatVisualiser/device_BeatVisualiser.py` (first line `# name=Beat Visualiser`).
- The app sends MIDI notes over a **virtual MIDI port**; the script's `OnMidiMsg(event)` handles them:
  - play → `transport.start()`, stop → `transport.stop()`
  - jump → `transport.setSongPos(...)` (check the docs for the mode argument: fraction / ms / bars). Make sure FL is in song mode, not pattern mode.
  - Optionally read BPM with `mixer.getCurrentTempo()`.
- Ignore note-off / velocity 0; set `event.handled = True`.
- The script reports song position back over MIDI as a timing anchor (requires FL's output port set to the same port number).
- Rust side sends MIDI with the `midir` crate.
- For testing without the app: send notes from a MIDI utility or Python `mido`.

**Automatic vs onboarding:**

| Step                                                                                                               | Automatic?                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copy the script into FL's `Settings/Hardware` folder (default `Documents/Image-Line/FL Studio/Settings/Hardware/`) | Yes; ask for the folder only if the user moved FL's data folder                                                                                                                                           |
| Virtual MIDI port                                                                                                  | macOS: yes, app creates it via CoreMIDI (midir supports virtual ports). Windows: loopback port via Windows MIDI Services (Windows 11), possibly a one-time manual step; loopMIDI fallback (check license) |
| Select port + script in FL's MIDI settings                                                                         | **No.** FL stores this in its own settings; don't write to them. One-time onboarding step with a GIF                                                                                                      |
| Verify connection                                                                                                  | Yes, "Test connection" button                                                                                                                                                                             |
| macOS screen recording permission                                                                                  | One-time system prompt, explained in onboarding                                                                                                                                                           |
| Open the plugin window                                                                                             | User, per video. Plugin may need to be "Detached" in FL                                                                                                                                                   |

## Window capture

- Find plugin windows by title (e.g. contains "Serum"), user picks from a list.
- **macOS (ScreenCaptureKit / `SCStreamConfiguration`):** set `width`/`height` to the window's real pixel size (Retina = 2× points; `captureResolution = .best` on macOS 14+), `minimumFrameInterval` = 1/60, BGRA pixel format, `showsCursor = false`, `capturesAudio` + `excludesCurrentProcessAudio` for the sync audio.
- **Windows (Windows.Graphics.Capture):** resolution = the window's actual pixel size; `B8G8R8A8` frame pool; `IsCursorCaptureEnabled = false`; `IsBorderRequired = false` on Windows 11. **Frames only arrive when content changes**, so repeat the last frame to keep a steady timeline.
- Capture at 60 fps even when exporting at 30 (finer sync timing).
- Store the recording as a **high-quality intermediate** (ProRes 422 on macOS, high-bitrate H.264/HEVC on Windows), not raw frames (30 s raw ≈ 13 GB) and not low bitrate (it gets compressed again at export). Delete after export.
- Window size is the quality ceiling. Onboarding tip: set the plugin's GUI scale to 150% for sharper videos.
- The recorded clip is loaded in the webview as a video texture (Tauri asset protocol / `convertFileSrc`).

## Sync

1. The app knows when it sent "play"; the script reports the song position back. That's the coarse anchor.
2. Record system audio together with the window.
3. **Cross-correlate** the recorded audio with the beat file to find the exact offset (fine-tuning).
4. Final video uses the beat file's audio only.

Target: recording lines up with the beat to within one frame. A custom VST/CLAP plugin (JUCE) for sample-exact sync is a _later_ option, only if this isn't good enough.

## Highlight detection

Features per ~50 ms frame, each normalized 0..1:

- RMS energy (drops, hooks)
- Bass energy below ~150 Hz (kick and 808; separates a real drop from a loud empty breakdown)
- Onset density / spectral flux (busy vs static sections)
- Novelty (self-similarity, Foote) as a bonus for section boundaries, phase 2

```
score(t) = 0.5 * rms(t) + 0.3 * bass(t) + 0.2 * onsets(t)

for each candidate window of the chosen length:
    skip windows in the first and last ~10% (intro, outro, producer tag)
    value = mean(score over window) (+ bonus near a novelty peak)
pick the best window
snap start to the nearest downbeat
round length to a multiple of 4 or 8 bars
```

**Bar snapping matters more than the exact scoring.** Libraries: Essentia.js (WASM: BPM, beats, loudness, onsets), Meyda (lighter features). Prototype and tune weights in Python with librosa on 20 to 30 of Bogdan's beats before porting to TS.

## Export

- Frame loop uses the same render call as the preview; compute `FrameData` at `t = i / fps`.
- H.264 + AAC MP4 with the beat file's audio (short ~50 ms fades on the cut).
- **Open decision:** WebCodecs encoding inside the webview vs sending frames to native ffmpeg in Rust. Sending 1080×1920 frames over Tauri IPC may be too slow. Benchmark both before committing.
- Progress bar, cancel button, "Show in folder".

## Build plan and current status

Phases (the full checklist lives in Bogdan's "Beat Visualizer Build Plan" page):

- **Phase 0, Setup:** Vite + Svelte + TS, Tailwind, ESLint + Prettier, engine/ui folders, Rust toolchain, add Tauri, push to GitHub.
- **Phase 1, Spike (DO FIRST):** list windows from Rust; record 10 s of a Serum window on macOS and Windows (test docked vs Detached on Windows); write the FL MIDI script (play/stop); trigger play from the Tauri app via a virtual MIDI port. _Done when one button starts FL and records the Serum window on both OSes._
- **Phase 2, Audio in:** drop zone, decode, peaks, waveform with playhead.
- **Phase 3, First theme:** Three.js quad at 1080×1920, Visualizer interface, LCD sampler theme, recorded clip as video texture, shader effects, original device frame (no brands, no AI images).
- **Phase 4, Highlight detection.**
- **Phase 5, Record flow and sync:** setSongPos + song mode, record exact section length, position report, system audio, cross-correlation, window picker UI.
- **Phase 6, Export:** benchmark frame transfer, encode, progress/cancel, test uploads to TikTok/Instagram.
- **Phase 7, Onboarding and polish:** auto-install script, MIDI port, FL settings GIF, Test connection, macOS permission, title overlay, error states, test multiple FL versions and Windows 10/11.
- **Phase 8, Ship and validate:** code signing (Apple notarization, Windows signing), Tauri bundler + auto-updater, post 10+ videos, test with 5 to 10 producers.
- **Later (only after validation):** more themes (paper, generative), multiple plugin windows, other DAWs, VST sync plugin, accounts/presets/payments, direct posting.

**Current repo state (as of 2026-11-15):**

The full workflow works on **macOS** for one beat: drop beat → pick 1–3 FL windows → "Play & record" (FL plays from the section start in song mode while the windows record) → preview synced by audio cross-correlation → export MP4.

**Windows (the OS):** written blind, behind `#[cfg(target_os = "windows")]`, type-checked for `x86_64-pc-windows-msvc`, never run; `docs/windows-testing.md` is the test checklist (`TEST:` comments in the code).

- Step 1: window list + recording to H.264 `.mp4` (`window_list_windows.rs`, `recorder_windows.rs`).
- Step 2: MIDI through two user-created loopback ports, "Beat Visualiser" (app → FL) and "Beat Visualiser Reply" (FL → app), connected by name and reconnected when they appear (`fl_midi.rs`); setup has Windows steps. The pong is note 65 (not 62) so a looped-back answer can't trigger another.
- Step 3: FL's audio in the `.mp4` via WASAPI process loopback (`wasapi` crate, FL's process even for bridged plugins), kept in step with the video by `audio_clock.rs` (silence fills gaps).
- Tests: `cargo test` on Windows runs automatic Windows tests (window list, id round trip, missing window/port messages); `cargo test -- --ignored` runs the FL + loopMIDI ones.
- Left: fixes from the first test session, Windows setup GIF, loopMIDI license (or Windows MIDI Services), installer + signing.

- **Phases:**
  - Phases 0–3 are done on macOS.
  - Phase 5 is mostly done: song mode, jumping to the section start, recording exactly the section length, system audio, cross-correlation, and the window picker. Not done: the script reporting position back, and greying out docked windows.
  - Phase 6 is done except the ffmpeg benchmark, which was decided against (WebCodecs, about 55 fps measured) and the TikTok/Instagram upload test.
  - Phase 4 is done without BPM detection (Bogdan decided: the user types BPM and key; Essentia.js was dropped, it's AGPL) and without the librosa prototype (deferred). `engine/analysis/`: RMS + bass + spectral flux score per 50 ms, window search with 10% intro/outro skip, bar snapping from the typed BPM (bar 1 at 0 s), lengths a multiple of 4 bars. The section is draggable on the waveform.
- **Rust (`src-tauri/src/`):**
  - `window_list.rs`, `recorder.rs` (ScreenCaptureKit SCRecordingOutput, HEVC .mov with FL's audio, macOS 15+)
  - `take.rs` (`record_take(window_ids, seconds)` → per-clip `play_offset`, `has_audio`)
  - `fl_midi.rs` (virtual ports "Beat Visualiser", out and in; notes 60 play, 61 stop, 62 ping (the script answers with note 65 on FL's linked output), 63 rewind, 64 jump to the ms position sent as CC 20/21/22; rewind and jump ensure song mode). Every take pings first, then jumps to the section start.
  - `fl_script.rs` (the FL script is compiled in and copied into FL's `Settings/Hardware` on launch), `permission.rs` (Screen Recording status/request)
  - `audio_file.rs`, `recordings.rs`, `export_file.rs`
  - Files live in `~/Movies/Beat Visualiser/`.
- **FL script:** `fl-script/BeatVisualiser/`, installed by the app on launch. After changing it, restart `tauri dev`, then click "Reload script" in FL.
- **Engine (`src/engine/`):**
  - `audio/`: decode, peaks, player
  - `frame/`: deterministic FrameData, rms/bass per 10 ms
  - `render/`: Three.js, fixed 1080×1920, shaders write display sRGB
  - `visualizers/`: `lcd-sampler` (GLSL split into 5 files, device drawn at 80% to leave the title area free), `stack` (up to 3 windows), `test-pattern`; themes declare `pluginSlots`; params support number/color/toggle/text, max 5
  - `overlay/`: the title card (name, BPM, key, producer tag), drawn over every theme by `render/render-frame.ts` in preview and export
  - `video/`: preview clip sync
  - `sync/`: cross-correlation
  - `export/`: WebCodecs + Mediabunny 1.65.0 (MPL-2.0); AAC needs Safari 26's WebKit
- **UI:** `src/ui/App.svelte` is a numbered step flow styled after the build-plan mockup (tokens in `src/app.css`). `Setup.svelte` is the onboarding (script install, MIDI port, FL settings steps, Test connection, Screen Recording permission); it opens on first launch or when something is missing. The top bar shows the FL connection.
  - Phase 7: done except the onboarding GIF (not recorded; `public/onboarding/fl-midi-settings.gif`), Windows (loopback MIDI port) and testing on several FL versions / Windows 10 and 11.
- **Tooling:** ESLint (with the engine-must-not-import-Svelte rule), Prettier (no semicolons, single quotes), and vitest (`npm test`).
- **Repo:** GitHub `github.com/720kbps/Beat-Visualiser`. Recent commits are local and not pushed.
- **Known gaps:**
  - Windows build untested (needs MSVC Build Tools + WebView2, and a loopback MIDI port).
  - FL title bars are visible in recordings (the LCD shader has an unused `uPluginCropTop`).
  - A whole export is held in memory.
  - Each theme instance is single-use, so preview and export share it.

## Risks to keep in mind

| Risk                                                                                  | Response                                                               |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| FL plugin windows on Windows may be child windows of FL's main window → capture fails | Require "Detached"; prove it in the Phase 1 spike before anything else |
| No built-in virtual MIDI on Windows 10                                                | Windows 11 first; loopMIDI fallback after checking its license         |
| Recording drifts out of sync                                                          | Script timing anchor + cross-correlation                               |
| FL updates change scripting behaviour                                                 | Keep the script to a few commands; test on FL updates                  |
| Code signing cost/effort                                                              | Budget for it before the first public release                          |
| Plugin names/logos (Serum) in marketing                                               | Market as "works with any plugin window"                               |
| Theme assets resembling real hardware brands                                          | Original designs or procedural shaders only                            |

## Open questions

- 30 fps enough, or does the playhead need 60?
- First theme: LCD sampler or hand-drawn paper?
- Free forever, or a free tier with limits?
- Can the app create the Windows loopback MIDI port itself through the Windows MIDI Services SDK?
- Support Windows 10 at all, or Windows 11 only?

## Later: direct posting constraints (for reference)

- TikTok Content Posting API: unaudited clients can only post private (SELF_ONLY) videos, max 5 users per 24 h, until audit passes. No promotional watermarks on API-posted content. Needs a backend for OAuth.
- Instagram: Professional accounts only, Meta app review, media must be on a public URL or resumable upload.
- YouTube Shorts: Data API upload quota needs an increase at scale.
