# Windows: first test session

Step 1 of the Windows plan: **list windows and record a Detached plugin window to `.mp4`** (video only). The code was written on a Mac without ever running on Windows. It compiles for Windows (`cargo check --target x86_64-pc-windows-msvc`), so the API calls are right, but nothing below has been seen working yet.

Not part of this step, so these are expected to fail on Windows:

- Anything with FL control: the MIDI ports don't exist on Windows yet, so setup shows a MIDI error and "Play & record" stops with "No MIDI port".
- Audio in recordings, so audio sync falls back to the timing estimate.

## Code

| File                                                                                           | What                                                              |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [window_list_windows.rs](../src-tauri/src/window_list_windows.rs)                              | Lists top-level windows (EnumWindows), size, FL detection         |
| [recorder_windows.rs](../src-tauri/src/recorder_windows.rs)                                    | Windows.Graphics.Capture → H.264 `.mp4`, same methods as on macOS |
| [recorder.rs](../src-tauri/src/recorder.rs), [window_list.rs](../src-tauri/src/window_list.rs) | Pick the Windows files with `#[cfg(target_os = "windows")]`       |

Every spot that needs checking has a `TEST:` comment. Search for `TEST:` in `src-tauri/src/`.

## Set up the PC (once)

1. Install [Git](https://git-scm.com/), [Node.js LTS](https://nodejs.org/) and [Rust](https://rustup.rs/) (`rustup-init.exe`, default options).
2. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **Desktop development with C++** workload. Rust needs its linker.
3. WebView2 comes with Windows 11. On Windows 10, install the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) if `tauri dev` complains.
4. `git clone https://github.com/720kbps/Beat-Visualiser.git`, then `npm install` in the folder.

## Tests, in order

Run these in PowerShell from `src-tauri/`. Open FL Studio with a plugin window **Detached** (the plugin window's menu → Detached) and one docked, for comparison.

### 1. Window list

```powershell
cargo test list_windows -- --nocapture
```

- [ ] It prints windows with sizes, and the FL ones show `fl=true`
- [ ] The Detached plugin window is in the list; the docked one is not
- [ ] Sizes are real pixels: on a 150% display a window covering half of a 1920 px wide screen shows ~960, not ~640
- [ ] FL's process name (Task Manager → Details) is `FL64.exe`; otherwise fix `is_fl_studio`

### 2. Record 10 seconds (no FL control needed)

Play something in FL so the plugin moves, then:

```powershell
$env:RECORD_TEST_TITLE = "Serum"   # any text from the plugin window's title
cargo test record_a_window -- --ignored --nocapture
```

It prints the file path (`%TEMP%\beat-visualiser-test.mp4`). Open it in Films & TV / Media Player.

- [ ] The test passes and the file plays
- [ ] The video is the plugin window at its real size, sharp
- [ ] Colors are right (not red and blue swapped). If swapped: `ColorFormat::Bgra8` in `recorder_windows.rs`
- [ ] No mouse cursor, no yellow border around the window. On Windows 10 the border may stay (only Windows 11 can hide it)
- [ ] The video is about 10 s long. If the plugin was still at the end, it may be shorter (Windows only sends a frame when something changes): note how much shorter
- [ ] Repeat with the window minimized: it should fail with "That window is minimized"

### 3. The app

```powershell
cd ..
npm run tauri dev
```

- [ ] The app opens; setup shows the FL script as installed (in `Documents\Image-Line\FL Studio\Settings\Hardware\BeatVisualiser`) and a MIDI error (expected)
- [ ] "List windows" shows the same windows as test 1
- [ ] Preview with a recording: copy the test file to `%USERPROFILE%\Videos\Beat Visualiser\take-1-1.mp4`, drop a beat, click "Use latest". The plugin shows in the preview and moves when you press Play
- [ ] Export MP4 works and the result plays with sound (WebView2 encodes H.264 and AAC itself)

### Write down

For anything that fails: the exact error text, Windows 10 or 11, and the display scale (Settings → Display). That's enough to fix it from the Mac.

## Checking from the Mac

The Windows code can be type-checked on macOS. Tauri's build step needs `llvm-rc` (from Homebrew's `llvm`) for the Windows app icon:

```sh
rustup target add x86_64-pc-windows-msvc
cd src-tauri
PATH="/opt/homebrew/opt/llvm/bin:$PATH" cargo clippy --tests --target x86_64-pc-windows-msvc
```

## Next steps after this works

2. MIDI through two loopback ports (loopMIDI or Windows MIDI Services): app → FL, and FL → app for the ping. One port can't do both: FL would get its own ping answer and answer again, forever.
3. FL's audio in the recording (WASAPI process loopback), so audio sync works.
4. The whole flow with a beat, and setup steps for the loopback ports.
