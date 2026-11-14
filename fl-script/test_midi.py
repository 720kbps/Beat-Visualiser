"""
Test the Beat Visualiser FL Studio script without the Tauri app.

This script pretends to be the app: it creates a MIDI output port called
"Beat Visualiser" and sends the same PLAY / STOP notes the app will send.

Protocol (must match the FL script and the Rust app):
    MIDI channel 1 (channel=0 in mido)
    PLAY = note_on 60, velocity 127, then note_off 60
    STOP = note_on 61, velocity 127, then note_off 61

Setup (once, from the repo root):
    python3 -m venv fl-script/.venv
    fl-script/.venv/bin/pip install -r fl-script/requirements.txt

Run (from the repo root):
    fl-script/.venv/bin/python fl-script/test_midi.py            # interactive: p / s / q
    fl-script/.venv/bin/python fl-script/test_midi.py --demo     # play 5 s, then stop
    fl-script/.venv/bin/python fl-script/test_midi.py --self-test  # check without FL
    fl-script/.venv/bin/python fl-script/test_midi.py --port "loopMIDI Port"  # use an existing port

FL Studio side:
    - Start this script first (interactive mode keeps the port open), then in FL
      open Options > MIDI settings. In the Input list, select "Beat Visualiser",
      enable it and set Controller type to "Beat Visualiser".
    - If FL was already open when the port was created, it may not show up until
      you click "Rescan devices" (or restart FL).
    - The port only exists while this script runs. When it exits, the port is
      gone and FL loses the connection.

Notes:
    - Virtual ports work on macOS (CoreMIDI). Windows can't create them from
      mido; there you need a loopback port (loopMIDI, or Windows MIDI Services on
      Windows 11) and pass its name with --port.
    - Don't run this at the same time as the Beat Visualiser app: both create a
      port with the same name and FL can't tell them apart.
"""

import argparse
import sys
import time

import mido

PORT_NAME = 'Beat Visualiser'
CHANNEL = 0  # mido counts channels from 0, so this is MIDI channel 1
NOTE_PLAY = 60
NOTE_STOP = 61


def send_note(port, note):
    """Send a short note: note_on with full velocity, then note_off."""
    on = mido.Message('note_on', channel=CHANNEL, note=note, velocity=127)
    off = mido.Message('note_off', channel=CHANNEL, note=note, velocity=0)
    port.send(on)
    print('  sent:', on)
    time.sleep(0.05)  # tiny gap so the two messages don't arrive as one
    port.send(off)
    print('  sent:', off)


def open_port(port_name):
    """Open an existing port by name, or create the virtual port."""
    if port_name:
        print('Using existing output port:', port_name)
        print('Available outputs:', mido.get_output_names())
        return mido.open_output(port_name)

    if sys.platform == 'win32':
        print('Windows cannot create virtual MIDI ports from mido.')
        print('Create a loopback port (for example with loopMIDI), then run:')
        print('  python test_midi.py --port "<port name>"')
        print('Available outputs:', mido.get_output_names())
        sys.exit(1)

    print('Creating virtual output port:', PORT_NAME)
    return mido.open_output(PORT_NAME, virtual=True)


def interactive(port):
    """Read commands from the keyboard until the user quits."""
    print()
    print('The port stays open while this runs. Commands (then Enter):')
    print('  p = play    s = stop    q = quit')
    while True:
        try:
            command = input('> ').strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if command == 'p':
            print('PLAY')
            send_note(port, NOTE_PLAY)
        elif command == 's':
            print('STOP')
            send_note(port, NOTE_STOP)
        elif command == 'q':
            break
        elif command != '':
            print('Unknown command. Use p, s or q.')


def demo(port):
    """Play for 5 seconds, then stop."""
    print('Waiting 2 s so FL can pick up the port...')
    time.sleep(2)
    print('PLAY')
    send_note(port, NOTE_PLAY)
    time.sleep(5)
    print('STOP')
    send_note(port, NOTE_STOP)


def self_test():
    """Check the protocol without FL: open our own virtual port as an input
    and make sure the PLAY and STOP notes arrive as expected."""
    if sys.platform == 'win32':
        print('Self-test needs virtual ports, which only work on macOS.')
        sys.exit(1)

    out_port = mido.open_output(PORT_NAME, virtual=True)
    time.sleep(0.5)  # give CoreMIDI a moment to register the new port

    input_names = mido.get_input_names()
    print('Inputs visible:', input_names)
    # rtmidi may add a client prefix or number to the name, so match loosely.
    matches = [name for name in input_names if PORT_NAME in name]
    if not matches:
        print('FAIL: port', repr(PORT_NAME), 'not visible as an input')
        out_port.close()
        sys.exit(1)

    in_port = mido.open_input(matches[0])
    print('Opened input:', matches[0])

    send_note(out_port, NOTE_PLAY)
    send_note(out_port, NOTE_STOP)
    time.sleep(0.3)  # let the messages arrive

    received = list(in_port.iter_pending())
    in_port.close()
    out_port.close()

    print('Received:')
    for msg in received:
        print('  ', msg)

    expected = [
        ('note_on', NOTE_PLAY, 127),
        ('note_off', NOTE_PLAY, 0),
        ('note_on', NOTE_STOP, 127),
        ('note_off', NOTE_STOP, 0),
    ]
    actual = [(m.type, m.note, m.velocity) for m in received if m.channel == CHANNEL]
    if actual == expected:
        print('PASS: all 4 messages arrived on channel 1 with the right notes')
    else:
        print('FAIL: expected', expected)
        print('      got     ', actual)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description='Send PLAY/STOP notes to the FL script.')
    parser.add_argument('--port', help='use an existing output port instead of a virtual one')
    parser.add_argument('--demo', action='store_true', help='play for 5 s, then stop and exit')
    parser.add_argument('--self-test', action='store_true', help='check the messages without FL')
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return

    port = open_port(args.port)
    try:
        if args.demo:
            demo(port)
        else:
            interactive(port)
    finally:
        port.close()
        print('Port closed.')


if __name__ == '__main__':
    main()
