# name=Beat Visualiser
#
# FL Studio MIDI Controller Script for the Beat Visualiser app.
#
# The app sends MIDI notes on a virtual MIDI port called "Beat Visualiser".
# This script turns those notes into transport commands:
#
#   note 60 (note-on, velocity > 0)  ->  play
#   note 61 (note-on, velocity > 0)  ->  stop
#   note 62 (note-on, velocity > 0)  ->  ping: answer with note 65 back
#   note 63 (note-on, velocity > 0)  ->  rewind to the song start
#   CC 20/21/22                      ->  store a song position in ms, 7 bits
#                                        each (low, middle, high)
#   note 64 (note-on, velocity > 0)  ->  jump to that stored position
#
# The ping answer goes out on FL's MIDI output that has the same port number
# as this script's input. The app listens there ("Test connection"). The
# answer is a different note than the ping, so if that output ever loops back
# into this script (a loopback port on Windows), it can't trigger another
# answer.
#
# Play, rewind and jump first switch FL to song mode if it is in pattern mode,
# so a take always plays the song, never just the selected pattern.
#
# Everything is on MIDI channel 1. See fl-script/README.md for the protocol
# and how to install the script.
#
# FL Studio runs this file with its own embedded Python. Only FL's modules
# (transport, midi, ...) and plain Python are available, no pip packages.

import device
import midi
import transport

# Protocol constants (must match the app and fl-script/test_midi.py).
CHANNEL = 0  # MIDI channel 1. In the status byte, channels are counted from 0.
NOTE_PLAY = 60
NOTE_STOP = 61
NOTE_PING = 62
NOTE_PONG = 65  # sent back, never received
NOTE_REWIND = 63
NOTE_JUMP = 64
CC_POSITION = 20  # 20, 21, 22: the low, middle and high 7 bits of the position

# The position for the next jump, as the three 7-bit parts that came in.
position_parts = [0, 0, 0]

# Values returned by transport.getLoopMode().
LOOP_MODE_PATTERN = 0
LOOP_MODE_SONG = 1


def OnInit():
    # Called when FL loads the script (FL start, choosing the script in
    # MIDI settings, or "Reload script").
    print('Beat Visualiser script loaded')
    # isAssigned(): an output port with the same port number exists.
    # Without it the app's "Test connection" never gets an answer.
    if not device.isAssigned():
        print('Beat Visualiser: no MIDI output linked. In MIDI settings, give the '
              '"Beat Visualiser" output the same port number as the input.')


def answer_ping():
    # One MIDI message packed into an int: status | data1 << 8 | data2 << 16.
    # Note-on, channel 1, note 65, velocity 127.
    device.midiOutMsg(midi.MIDI_NOTEON + CHANNEL + (NOTE_PONG << 8) + (127 << 16))


def ensure_song_mode():
    # transport.setLoopMode() takes no argument: it toggles between pattern
    # and song. So only call it when FL is in pattern mode, otherwise we
    # would switch song mode off again.
    if transport.getLoopMode() == LOOP_MODE_PATTERN:
        transport.setLoopMode()
        print('Beat Visualiser: switched to song mode')


def OnMidiMsg(event):
    # Called for every MIDI message that arrives on this script's input port.

    # Mark everything from this port as handled, whatever it is.
    # This port only exists to control FL from the app. If we let a message
    # through, FL processes it normally: a note would play the selected
    # channel's instrument, a CC could move a linked knob. So nothing leaks.
    event.handled = True

    # The status byte holds the message type in the upper 4 bits and the
    # channel in the lower 4 bits. For example 0x90 = note-on, channel 1.
    message_type = event.status & 0xF0
    channel = event.status & 0x0F

    if channel != CHANNEL:
        return

    # A jump's position arrives first, as three control changes.
    if message_type == midi.MIDI_CONTROLCHANGE:
        part = event.data1 - CC_POSITION
        if 0 <= part < 3:
            position_parts[part] = event.data2
        return

    # Everything else is a note-on.
    if message_type != midi.MIDI_NOTEON:
        return

    # A note-on with velocity 0 means note-off in MIDI. Ignore it.
    # (Real note-offs are 0x80 and were already skipped above.)
    note = event.data1
    velocity = event.data2
    if velocity == 0:
        return

    if note == NOTE_PLAY:
        # transport.start() is play/pause: it toggles. Calling it while FL
        # is already playing would pause, so only call it when stopped.
        if not transport.isPlaying():
            # Safety net: the app sends rewind before play, which already
            # switches to song mode. Only done while stopped, so we never
            # change the mode in the middle of playback.
            ensure_song_mode()
            transport.start()
        print('Beat Visualiser: play')
    elif note == NOTE_STOP:
        transport.stop()
        print('Beat Visualiser: stop')
    elif note == NOTE_PING:
        answer_ping()
        print('Beat Visualiser: ping')
    elif note == NOTE_REWIND:
        # Switch to song mode first. FL keeps a separate position for
        # pattern and song mode, so setSongPos must run after the switch,
        # or it would rewind the pattern instead of the song.
        ensure_song_mode()
        # Without a mode argument, setSongPos takes a fraction of the song
        # length (0.0 = start, 1.0 = end) and needs a float, hence 0.0.
        transport.setSongPos(0.0)
        print('Beat Visualiser: rewind')
    elif note == NOTE_JUMP:
        ms = position_parts[0] + (position_parts[1] << 7) + (position_parts[2] << 14)
        # Same order as rewind: song mode first, then the position.
        ensure_song_mode()
        # With a mode argument, setSongPos takes the position in that unit.
        transport.setSongPos(ms, midi.SONGLENGTH_MS)
        print('Beat Visualiser: jump to ' + str(ms) + ' ms')
