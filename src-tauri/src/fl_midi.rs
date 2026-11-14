// Talks to FL Studio over MIDI. The app creates a virtual MIDI port that FL
// sees as an input device; our FL script (fl-script/) reacts to the notes.
//
// Protocol (shared with fl-script/, don't change one side only):
//   channel 1, note-on then note-off
//   note 60 = play, note 61 = stop, note 62 = reserved (ping, later),
//   note 63 = rewind to the song start

use std::sync::Mutex;

use midir::MidiOutputConnection;

// FL remembers its MIDI settings by port name, so keep this exact name.
pub const PORT_NAME: &str = "Beat Visualiser";

// MIDI status bytes for channel 1 (the low 4 bits are the channel, 0 = ch 1).
const NOTE_ON: u8 = 0x90;
const NOTE_OFF: u8 = 0x80;

const NOTE_PLAY: u8 = 60;
const NOTE_STOP: u8 = 61;
const NOTE_REWIND: u8 = 63;

// The MIDI connection to FL, kept in Tauri "managed state" (see lib.rs).
//
// `app.manage(value)` hands one value to Tauri, which keeps it alive until
// the app quits. Any command can then ask for it by adding a
// `tauri::State<'_, FlPort>` argument; Tauri fills it in (you don't pass it
// from JavaScript). State is looked up by type, hence the small wrapper type.
//
// - Mutex: commands can run on different threads, and sending MIDI needs
//   `&mut`, so only one command may use the connection at a time.
// - Result: holds the error text if creating the port failed at startup,
//   so the commands can show the reason instead of a vague message.
pub struct FlPort(pub Mutex<Result<MidiOutputConnection, String>>);

/// Sends one FL command (e.g. `send_play`) through the shared port.
/// Holds the lock only for the send itself, a few microseconds.
pub fn send_to_fl(
    port: &FlPort,
    send: fn(&mut MidiOutputConnection) -> Result<(), String>,
) -> Result<(), String> {
    // lock() only fails if another thread panicked while holding the lock.
    let mut guard = port
        .0
        .lock()
        .map_err(|_| "MIDI port is unusable after an earlier crash.".to_string())?;
    match guard.as_mut() {
        Ok(conn) => send(conn),
        Err(startup_error) => Err(format!("No MIDI port: {startup_error}")),
    }
}

/// Ok if the port was created at startup, otherwise the reason it wasn't.
/// Lets a take fail early, before FL or the capture is touched.
pub fn check_port(port: &FlPort) -> Result<(), String> {
    let guard = port
        .0
        .lock()
        .map_err(|_| "MIDI port is unusable after an earlier crash.".to_string())?;
    match guard.as_ref() {
        Ok(_) => Ok(()),
        Err(startup_error) => Err(format!("No MIDI port: {startup_error}")),
    }
}

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

// Moves FL's playhead to the start of the song (doesn't start playing).
pub fn send_rewind(conn: &mut MidiOutputConnection) -> Result<(), String> {
    send_note(conn, NOTE_REWIND)
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
// input in the same process, send play + stop + rewind, check the 6
// messages arrive.
// Uses its own port name so it never triggers a running FL (or clashes with
// the Python test script, which creates a "Beat Visualiser" port too).
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn play_stop_and_rewind_arrive_on_the_virtual_port() {
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
        send_rewind(&mut conn).unwrap();

        let mut received = Vec::new();
        for _ in 0..6 {
            received.push(rx.recv_timeout(Duration::from_secs(2)).unwrap());
        }
        assert_eq!(
            received,
            vec![
                vec![0x90, 60, 127],
                vec![0x80, 60, 0],
                vec![0x90, 61, 127],
                vec![0x80, 61, 0],
                vec![0x90, 63, 127],
                vec![0x80, 63, 0],
            ]
        );
    }
}
