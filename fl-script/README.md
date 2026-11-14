# FL Studio script

`BeatVisualiser/device_BeatVisualiser.py` is an FL Studio MIDI Controller Script. It lets the Beat Visualiser app start, stop and rewind FL's playback by sending MIDI notes on a virtual MIDI port.

For now it only does play, stop and rewind to the song start. Jumping to a section, tempo and song mode come in Phase 5.

## Protocol

| What         | Value                                                                       |
| ------------ | --------------------------------------------------------------------------- |
| Port name    | `Beat Visualiser` (virtual MIDI port created by the app or the test script) |
| MIDI channel | 1                                                                           |
| Note 60      | Play (note-on, velocity > 0). Does nothing if FL is already playing.        |
| Note 61      | Stop (note-on, velocity > 0)                                                |
| Note 62      | Reserved for a future "ping / test connection". Not implemented yet.        |
| Note 63      | Rewind to the song start (`transport.setSongPos(0.0)`)                      |

The sender sends a note-off right after each note-on. The script ignores note-offs and velocity-0 note-ons, and marks every message from this port as handled so nothing reaches FL's instruments or linked controls.

## Install (manual)

Copy the whole `BeatVisualiser` folder into FL's hardware scripts folder:

- macOS: `~/Documents/Image-Line/FL Studio/Settings/Hardware/`
- Windows: `Documents\Image-Line\FL Studio\Settings\Hardware\`

On macOS, from the repo root (re-run it after every edit to the script):

```sh
cp -R fl-script/BeatVisualiser ~/Documents/Image-Line/FL\ Studio/Settings/Hardware/
```

Use a real copy, not a symlink. FL may not follow symlinks.

## One-time FL setup

1. Start the app or `fl-script/test_midi.py` first. The `Beat Visualiser` port only exists while one of them is running.
2. In FL: **Options > MIDI settings**.
3. Under **Input**, find `Beat Visualiser`. If it isn't listed, click **Rescan devices** (or restart FL).
4. Select it, set **Controller type** to `Beat Visualiser`, and make sure it's **Enabled**.

## Seeing the script's output

**View > Script output**, then pick the Beat Visualiser tab. You should see `Beat Visualiser script loaded`, and a `play` / `stop` / `rewind` line for each command.

## After editing the script

Copy it again (command above), then click **Reload script** in the Script output window. Re-selecting the controller type in MIDI settings also reloads it. Until you reload, FL keeps running the old version (an old script ignores rewind, so "Play & record" would start wherever the playhead is).
