// Talks to FL Studio over MIDI. The app creates a virtual MIDI port that FL
// sees as an input device; our FL script (fl-script/) reacts to the notes.
//
// Protocol (shared with fl-script/, don't change one side only):
//   channel 1, note-on then note-off
//   note 60 = play, note 61 = stop, note 62 = reserved (ping, later)

use midir::MidiOutputConnection;

// FL remembers its MIDI settings by port name, so keep this exact name.
pub const PORT_NAME: &str = "Beat Visualiser";

// MIDI status bytes for channel 1 (the low 4 bits are the channel, 0 = ch 1).
const NOTE_ON: u8 = 0x90;
const NOTE_OFF: u8 = 0x80;

const NOTE_PLAY: u8 = 60;
const NOTE_STOP: u8 = 61;

// Creates a virtual MIDI output port called `name`. The port exists only
// as long as the returned connection is alive; dropping it removes the port.
#[cfg(target_os = "macos")]
pub fn create_port(name: &str) -> Result<MidiOutputConnection, String> {
    // Brings the `create_virtual` method into scope. midir only has it on
    // macOS/Linux (CoreMIDI and ALSA support virtual ports, Windows doesn't).
    use midir::os::unix::VirtualOutput;

    let output = midir::MidiOutput::new(name).map_err(|e| format!("Could not start MIDI: {e}"))?;
    output
        .create_virtual(name)
        .map_err(|e| format!("Could not create the virtual MIDI port \"{name}\": {e}"))
}

// Windows has no virtual ports in midir. Later we'll connect to a loopback
// port instead (Windows MIDI Services on Windows 11, or loopMIDI).
#[cfg(not(target_os = "macos"))]
pub fn create_port(name: &str) -> Result<MidiOutputConnection, String> {
    Err(format!(
        "Can't create the MIDI port \"{name}\": virtual MIDI ports only work on macOS so far. \
         Windows will need a loopback port (Windows MIDI Services or loopMIDI)."
    ))
}

pub fn send_play(conn: &mut MidiOutputConnection) -> Result<(), String> {
    send_note(conn, NOTE_PLAY)
}

pub fn send_stop(conn: &mut MidiOutputConnection) -> Result<(), String> {
    send_note(conn, NOTE_STOP)
}

// A short "key press": note-on with full velocity, then note-off.
// The FL script only acts on the note-on and ignores the note-off.
fn send_note(conn: &mut MidiOutputConnection, note: u8) -> Result<(), String> {
    conn.send(&[NOTE_ON, note, 127])
        .map_err(|e| format!("Could not send MIDI note-on {note}: {e}"))?;
    conn.send(&[NOTE_OFF, note, 0])
        .map_err(|e| format!("Could not send MIDI note-off {note}: {e}"))
}

// Round trip test without FL: create the port, listen to it with a MIDI
// input in the same process, send play + stop, check the 4 messages arrive.
// Uses its own port name so it never triggers a running FL (or clashes with
// the Python test script, which creates a "Beat Visualiser" port too).
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn play_and_stop_arrive_on_the_virtual_port() {
        let test_port = format!("Beat Visualiser Test {}", std::process::id());
        let mut conn = create_port(&test_port).unwrap();

        // Find our virtual port among the MIDI inputs.
        let input = midir::MidiInput::new("Beat Visualiser Test Input").unwrap();
        let port = input
            .ports()
            .into_iter()
            .find(|p| input.port_name(p).ok().as_deref() == Some(test_port.as_str()))
            .expect("virtual port not found in the MIDI input list");

        // midir calls this closure on its own thread for every message,
        // so we pass each message back through a channel.
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let _listener = input
            .connect(
                &port,
                "listener",
                move |_time, msg, _| {
                    tx.send(msg.to_vec()).ok();
                },
                (),
            )
            .unwrap();

        send_play(&mut conn).unwrap();
        send_stop(&mut conn).unwrap();

        let mut received = Vec::new();
        for _ in 0..4 {
            received.push(rx.recv_timeout(Duration::from_secs(2)).unwrap());
        }
        assert_eq!(
            received,
            vec![
                vec![0x90, 60, 127],
                vec![0x80, 60, 0],
                vec![0x90, 61, 127],
                vec![0x80, 61, 0],
            ]
        );
    }
}
