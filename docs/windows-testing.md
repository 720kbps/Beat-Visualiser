# Windows: first test session

Three steps of the Windows plan are written:

1. **List windows and record a Detached plugin window** to an H.264 `.mp4`.
2. **Control FL over MIDI** through two loopback ports: "Test connection" and "Play & record" (jump, play, stop).
3. **Record FL's sound** into the same `.mp4` (WASAPI process loopback), so audio sync works like on macOS.

All of it was written on a Mac and has **never run on Windows**. It compiles for Windows (`cargo clippy --tests --target x86_64-pc-windows-msvc`, no warnings), so the API calls are right, but nothing below has been seen working. Every spot that needs checking has a `TEST:` comment: search for `TEST:` in `src-tauri/src/`.

## Code

| File                                                              | What                                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [window_list_windows.rs](../src-tauri/src/window_list_windows.rs) | Lists top-level windows, real pixel size, FL detection                                   |
| [recorder_windows.rs](../src-tauri/src/recorder_windows.rs)       | Video (Windows.Graphics.Capture) + FL's audio (WASAPI) → `.mp4`, same methods as macOS   |
| [audio_clock.rs](../src-tauri/src/audio_clock.rs)                 | Keeps the audio in step with the video (fills gaps with silence). Tested on every system |
| [fl_midi.rs](../src-tauri/src/fl_midi.rs)                         | Windows: connects to the two loopback ports by name, reconnects when they appear later   |

## Set up the PC (once)

1. Install [Git](https://git-scm.com/), [Node.js LTS](https://nodejs.org/) and [Rust](https://rustup.rs/) (`rustup-init.exe`, default options).
2. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **Desktop development with C++** workload. Rust needs its linker.
3. WebView2 comes with Windows 11. On Windows 10, install the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) if `tauri dev` complains.
4. `git clone https://github.com/720kbps/Beat-Visualiser.git`, then `npm install` in the folder.

## 1. Automatic tests (no setup)

In PowerShell, from `src-tauri/`:

```powershell
cargo test
```

The first run compiles everything and takes a few minutes. These need nothing but a Windows desktop:

| Test                                                  | Checks                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `lists_windows_with_real_sizes`                       | Windows are listed, each with an id and a real size                     |
| `ids_lead_back_to_the_same_window`                    | A listed id finds the same window again (window handles fit in 32 bits) |
| `recognizes_fl_studio`                                | FL is detected by `FL64.exe`                                            |
| `a_window_that_doesnt_exist_is_refused`               | Recording a missing window gives the right message                      |
| `finding_fl_does_not_crash`                           | Walking the process list works (prints FL's process id if it's open)    |
| `a_missing_port_says_what_to_do`                      | A missing MIDI port says "create it in loopMIDI" instead of crashing    |
| everything else (MIDI encoding, audio clock, files …) | Shared code, same as on macOS                                           |

- [ ] All pass. For each one that fails, copy the whole failure text.

Also run the TypeScript tests from the repo root: `npm test` (same as on macOS).

## 2. Hardware tests (FL and loopMIDI)

Open FL Studio with a plugin window **Detached** (the plugin window's menu → Detached), and one docked for comparison. Install [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html) and add two ports, named exactly `Beat Visualiser` and `Beat Visualiser Reply`.

Start some playback in FL (a pattern on loop), then:

```powershell
$env:RECORD_TEST_TITLE = "Serum"   # any text from the plugin window's title
cargo test -- --ignored --nocapture
```

This runs two tests:

- `loopback_reply_port_reaches_the_listener`: both loopMIDI ports are found and a message gets through.
- `record_a_window_for_10_seconds`: records the plugin window for 10 s, with FL's sound, to `%TEMP%\beat-visualiser-test.mp4`. It prints the file path and `heard audio: true/false`.

- [ ] Both pass, and the recording test printed `heard audio: true`
- [ ] The Detached plugin window was in the printed list; the docked one wasn't

Open the `.mp4` in Films & TV / Media Player:

- [ ] It plays, at the window's real size, sharp, with the plugin moving
- [ ] Colors are right (not red and blue swapped). If swapped: `ColorFormat::Bgra8` in `recorder_windows.rs`
- [ ] No mouse cursor, no yellow border (on Windows 10 the border may stay; only Windows 11 can hide it)
- [ ] FL's sound is in it, in sync with the picture, and nothing else: play a YouTube video during the test; it must not be in the file
- [ ] About 10 s long. If the plugin was still at the end, the picture may stop early (Windows only sends a frame when something changes): note how much

## 3. The app with FL

```powershell
cd ..
npm run tauri dev
```

Setup:

- [ ] The FL script shows as installed (in `Documents\Image-Line\FL Studio\Settings\Hardware\BeatVisualiser`)
- [ ] The MIDI step is green. If you add the loopMIDI ports while the app is open, "Check again" finds them without a restart

In FL: Options › MIDI settings.

- Input: select `Beat Visualiser`, Controller type `Beat Visualiser`, Enable, port number 10.
- Output: select `Beat Visualiser Reply`, port number 10.
- Leave the `Beat Visualiser Reply` input switched off.

Then:

- [ ] "Test connection" says "FL Studio answered in … ms". If not, look in FL's View › Script output for errors
- [ ] "List windows" shows the same windows as the tests
- [ ] Drop the same beat FL has open, type the BPM, pick the Detached plugin window, press "Play & record": FL jumps to the section start, plays, stops at the end
- [ ] FL's Script output shows `jump to … ms`, `play`, `stop`
- [ ] The take shows in the preview and its sync line says "synced … ms (0.…)", not "using timing estimate"
- [ ] The plugin moves in time with the beat when you press Play
- [ ] Export MP4 works and the result plays with sound
- [ ] Switch the `Beat Visualiser Reply` input on in FL by mistake and press "Test connection": it still answers once, with no endless loop

## Write down

For anything that fails: the exact error text, Windows 10 or 11, and the display scale (Settings › Display). That's enough to fix it from the Mac.

## Checking from the Mac

The Windows code can be type-checked on macOS. Tauri's build step needs `llvm-rc` (from Homebrew's `llvm`) for the Windows app icon:

```sh
rustup target add x86_64-pc-windows-msvc
cd src-tauri
PATH="/opt/homebrew/opt/llvm/bin:$PATH" cargo clippy --tests --target x86_64-pc-windows-msvc
```

## After this works

- Fixes from these tests (e.g. repeating the last frame if videos end early).
- The setup GIF for Windows (loopMIDI + FL's MIDI settings).
- loopMIDI's license for a paid app, or Windows MIDI Services on Windows 11 instead (the app only looks for the two port names, so either works).
- A Windows installer (`npm run tauri build` on the PC) and code signing.
