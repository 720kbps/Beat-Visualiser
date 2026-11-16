# FL Studio script

`BeatVisualiser/device_BeatVisualiser.py` is an FL Studio MIDI Controller Script. It lets the Beat Visualiser app start, stop, rewind and position FL's playback by sending MIDI messages on a virtual MIDI port, and answers the app's "Test connection" ping.

It does play, stop, rewind, jump to a position and ping, and makes sure FL is in song mode for play, rewind and jump.

## Protocol

| What          | Value                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ports         | macOS: `Beat Visualiser` both ways, virtual ports the app creates. Windows: loopback ports the user creates, `Beat Visualiser` (app → FL) and `Beat Visualiser Reply` (FL → app)            |
| MIDI channel  | 1                                                                                                                                                                                           |
| Note 60       | Play (note-on, velocity > 0). Switches to song mode first if needed. Does nothing if FL is already playing.                                                                                 |
| Note 61       | Stop (note-on, velocity > 0)                                                                                                                                                                |
| Note 62       | Ping. The script answers with note-on 65 on FL's linked MIDI output; the app waits up to 1.5 s for it. 65, not 62: an answer that loops back into FL is then never mistaken for a new ping. |
| Note 63       | Switch to song mode if FL is in pattern mode, then rewind to the song start (`transport.setSongPos(0.0)`)                                                                                   |
| CC 20, 21, 22 | The next jump's position in milliseconds, 7 bits each: bits 0–6, 7–13, 14–20 (up to ~35 min). Only stored.                                                                                  |
| Note 64       | Song mode if needed, then jump to the stored position (`transport.setSongPos(ms, midi.SONGLENGTH_MS)`)                                                                                      |

Song mode: `transport.setLoopMode()` toggles between pattern and song, so the script only calls it when `transport.getLoopMode()` returns 0 (pattern). It switches before rewinding, because FL keeps separate positions for pattern and song mode. The app sends stop, the position, jump, play for each take, so a take always plays the song from the section start, even if FL was left in pattern mode. FL's song position in ms equals the time in the beat file because the beat was exported from the song start.

The sender sends a note-off right after each note-on. The script ignores note-offs and velocity-0 note-ons, and marks every message from this port as handled so nothing reaches FL's instruments or linked controls.

The ping answer only arrives if FL's **output** `Beat Visualiser` has the same port number as the script's input: that's how FL links a script to an output. The app pings before every take, so a take fails early with a clear message instead of recording a silent FL.

## Install

The app does it: on every launch it copies the script (compiled into the app) into FL's hardware scripts folder if it's missing or different, and the setup screen asks for FL's data folder if it isn't in the default place:

- macOS: `~/Documents/Image-Line/FL Studio/Settings/Hardware/BeatVisualiser/`
- Windows: `Documents\Image-Line\FL Studio\Settings\Hardware\BeatVisualiser\`

The script is embedded at build time (`include_str!` in `src-tauri/src/fl_script.rs`), so after editing it, restart `npm run tauri dev` to rebuild and reinstall it. To copy it by hand instead (e.g. with only `test_midi.py`), from the repo root:

```sh
cp -R fl-script/BeatVisualiser ~/Documents/Image-Line/FL\ Studio/Settings/Hardware/
```

Use a real copy, not a symlink. FL may not follow symlinks.

## One-time FL setup

The app's setup screen walks through this and checks it with "Test connection".

1. Start the app first. The `Beat Visualiser` ports only exist while it runs (`test_midi.py` creates only the input side, so no ping answer there).
2. In FL: **Options > MIDI settings**.
3. Under **Input**, find `Beat Visualiser`. If it isn't listed, click **Rescan devices** (or restart FL).
4. Select it, set **Controller type** to `Beat Visualiser`, make sure it's **Enabled**, and give it a **port number** (e.g. 10).
5. Under **Output**, select `Beat Visualiser` and give it the **same port number**.

## Seeing the script's output

**View > Script output**, then pick the Beat Visualiser tab. You should see `Beat Visualiser script loaded` (followed by a hint if no output is linked), and a `play` / `stop` / `rewind` / `jump to … ms` / `ping` line for each command, plus `switched to song mode` when the script had to leave pattern mode.

## After editing the script

Restart `npm run tauri dev` (or copy it by hand), then click **Reload script** in the Script output window. Re-selecting the controller type in MIDI settings also reloads it. Until you reload, FL keeps running the old version (an old script may ignore jump or ping, so "Play & record" could start wherever the playhead is, or play only the pattern).
