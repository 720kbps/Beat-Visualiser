# name=Beat Visualiser
#
# FL Studio MIDI Controller Script for the Beat Visualiser app.
#
# The app sends MIDI notes on a virtual MIDI port called "Beat Visualiser".
# This script turns those notes into transport commands:
#
#   note 60 (note-on, velocity > 0)  ->  play
#   note 61 (note-on, velocity > 0)  ->  stop
#
# Everything is on MIDI channel 1. See fl-script/README.md for the protocol
# and how to install the script.
#
# FL Studio runs this file with its own embedded Python. Only FL's modules
# (transport, midi, ...) and plain Python are available, no pip packages.

import midi
import transport

# Protocol constants (must match the app and fl-script/test_midi.py).
CHANNEL = 0  # MIDI channel 1. In the status byte, channels are counted from 0.
NOTE_PLAY = 60
NOTE_STOP = 61
# NOTE_PING = 62 is reserved for a future "Test connection" message.


def OnInit():
    # Called when FL loads the script (FL start, choosing the script in
    # MIDI settings, or "Reload script").
    print('Beat Visualiser script loaded')


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

    # Only note-ons on our channel do anything.
    if message_type != midi.MIDI_NOTEON or channel != CHANNEL:
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
        # TODO: in pattern mode this plays the pattern, not the song (Phase 5).
        if not transport.isPlaying():
            transport.start()
        print('Beat Visualiser: play')
    elif note == NOTE_STOP:
        transport.stop()
        print('Beat Visualiser: stop')
