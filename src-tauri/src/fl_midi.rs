// Talks to FL Studio over MIDI. The app creates a virtual MIDI port that FL
// sees as an input device; our FL script (fl-script/) reacts to the notes.
//
// Protocol (shared with fl-script/, don't change one side only):
//   channel 1, note-on then note-off
//   note 60 = play, note 61 = stop, note 62 = ping, note 63 = rewind to the
//   song start, note 64 = jump to the position sent just before it as three
//   control changes (CC 20/21/22 = bits 0-6/7-13/14-20 of the position in ms,
//   because a MIDI data byte only holds 7 bits)
//
// The other direction: the app also creates a virtual MIDI input with the
// same name, which FL sees as an output device. The script answers a ping
// by sending note 62 back on it. That's how "Test connection" knows FL is
// really listening. FL only sends to that output when, in its MIDI settings,
// the output has the same port number as the script's input.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use midir::{MidiInputConnection, MidiOutputConnection};

// FL remembers its MIDI settings by port name, so keep this exact name.
pub const PORT_NAME: &str = "Beat Visualiser";

// MIDI status bytes for channel 1 (the low 4 bits are the channel, 0 = ch 1).
const NOTE_ON: u8 = 0x90;
const NOTE_OFF: u8 = 0x80;

const NOTE_PLAY: u8 = 60;
const NOTE_STOP: u8 = 61;
const NOTE_PING: u8 = 62;
const NOTE_REWIND: u8 = 63;
const NOTE_JUMP: u8 = 64;
const CONTROL_CHANGE: u8 = 0xB0;
const CC_POSITION: u8 = 20; // 20, 21, 22: low, middle, high 7 bits

/// The latest position a jump can reach: 21 bits of milliseconds, ~35 minutes.
pub const MAX_JUMP_MS: u32 = (1 << 21) - 1;

// How long "Test connection" waits for FL's answer. FL answers within a few
// ms when it's set up; the rest is slack for a busy FL (loading a project).
const PING_TIMEOUT: Duration = Duration::from_millis(1500);

// Shown when FL doesn't answer a ping. Covers every reason we can't tell
// apart from here.
pub const NO_ANSWER: &str = "FL Studio didn't answer. Check that FL is open, and that in \
    Options > MIDI settings both the \"Beat Visualiser\" input (controller type \"Beat \
    Visualiser\") and the \"Beat Visualiser\" output are enabled with the same port number.";

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
    send: impl FnOnce(&mut MidiOutputConnection) -> Result<(), String>,
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

pub fn send_ping(conn: &mut MidiOutputConnection) -> Result<(), String> {
    send_note(conn, NOTE_PING)
}

pub fn send_play(conn: &mut MidiOutputConnection) -> Result<(), String> {
    send_note(conn, NOTE_PLAY)
}

pub fn send_stop(conn: &mut MidiOutputConnection) -> Result<(), String> {
    send_note(conn, NOTE_STOP)
}

// Moves FL's playhead to the start of the song (doesn't start playing).
// Kept for the protocol and its test; takes use send_jump.
#[allow(dead_code)]
pub fn send_rewind(conn: &mut MidiOutputConnection) -> Result<(), String> {
    send_note(conn, NOTE_REWIND)
}

/// Moves FL's playhead to `ms` milliseconds into the song (doesn't start
/// playing). The script also switches FL to song mode.
pub fn send_jump(conn: &mut MidiOutputConnection, ms: u32) -> Result<(), String> {
    if ms > MAX_JUMP_MS {
        return Err(format!(
            "Can't jump to {ms} ms, the latest is {MAX_JUMP_MS} ms."
        ));
    }
    for (i, part) in position_parts(ms).iter().enumerate() {
        conn.send(&[CONTROL_CHANGE, CC_POSITION + i as u8, *part])
            .map_err(|e| format!("Could not send the song position: {e}"))?;
    }
    send_note(conn, NOTE_JUMP)
}

// ms split into three 7-bit parts, lowest first.
fn position_parts(ms: u32) -> [u8; 3] {
    [
        (ms & 0x7F) as u8,
        ((ms >> 7) & 0x7F) as u8,
        ((ms >> 14) & 0x7F) as u8,
    ]
}

// Listens for FL's answers on a virtual MIDI input, kept in managed state
// next to FlPort for the whole app run (FL only sees the port while it
// exists). The callback runs on midir's own thread and only stores WHEN the
// last ping answer arrived; ping() reads that.
pub struct FlListener {
    // Keeps the port alive; never read. Mutex: managed state must be Sync.
    _connection: Mutex<Option<MidiInputConnection<()>>>,
    startup_error: Option<String>,
    last_pong: Arc<Mutex<Option<Instant>>>,
}

impl FlListener {
    /// Ok if the input port was created at startup, otherwise the reason.
    pub fn check(&self) -> Result<(), String> {
        match &self.startup_error {
            None => Ok(()),
            Some(e) => Err(format!("No MIDI input: {e}")),
        }
    }
}

// FL's answer to a ping: note-on 62 with a velocity above 0, any channel.
// Only the macOS listener uses it so far.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_pong(message: &[u8]) -> bool {
    message.len() >= 3 && message[0] & 0xF0 == NOTE_ON && message[1] == NOTE_PING && message[2] > 0
}

#[cfg(target_os = "macos")]
pub fn create_listener(name: &str) -> FlListener {
    use midir::os::unix::VirtualInput;

    let last_pong = Arc::new(Mutex::new(None));
    // The callback gets its own handle to the same Mutex (Arc = shared ownership).
    let pong_writer = Arc::clone(&last_pong);
    let result = midir::MidiInput::new(name)
        .map_err(|e| format!("Could not start MIDI input: {e}"))
        .and_then(|input| {
            input
                .create_virtual(
                    name,
                    move |_time, message, _| {
                        if is_pong(message)
                            && let Ok(mut last) = pong_writer.lock()
                        {
                            *last = Some(Instant::now());
                        }
                    },
                    (),
                )
                .map_err(|e| format!("Could not create the virtual MIDI input \"{name}\": {e}"))
        });
    match result {
        Ok(connection) => FlListener {
            _connection: Mutex::new(Some(connection)),
            startup_error: None,
            last_pong,
        },
        Err(e) => FlListener {
            _connection: Mutex::new(None),
            startup_error: Some(e),
            last_pong,
        },
    }
}

#[cfg(not(target_os = "macos"))]
pub fn create_listener(name: &str) -> FlListener {
    FlListener {
        _connection: Mutex::new(None),
        startup_error: Some(format!(
            "Can't create the MIDI input \"{name}\": virtual MIDI ports only work on macOS so far."
        )),
        last_pong: Arc::new(Mutex::new(None)),
    }
}

/// Sends a ping and waits for FL's answer. Ok(round trip time) if FL
/// answered, otherwise an error that says what to check. Blocks for up to
/// PING_TIMEOUT, so call it from a background thread.
pub fn ping(port: &FlPort, listener: &FlListener) -> Result<Duration, String> {
    listener.check()?;
    let sent = Instant::now();
    send_to_fl(port, send_ping)?;
    let deadline = sent + PING_TIMEOUT;
    loop {
        let last = *listener
            .last_pong
            .lock()
            .map_err(|_| "MIDI input is unusable after an earlier crash.".to_string())?;
        // Only an answer that arrived after THIS ping counts.
        if let Some(at) = last
            && at >= sent
        {
            return Ok(at - sent);
        }
        if Instant::now() >= deadline {
            return Err(NO_ANSWER.to_string());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
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

    // Plays FL's part: connects to our virtual input and answers the ping.
    #[test]
    fn ping_gets_an_answer_through_the_virtual_input() {
        let name = format!("Beat Visualiser Ping Test {}", std::process::id());
        let port = FlPort(Mutex::new(create_port(&name)));
        let listener = create_listener(&name);
        listener.check().unwrap();

        // "FL": an output connected to our virtual input, answering right away.
        let output = midir::MidiOutput::new("Fake FL").unwrap();
        let target = output
            .ports()
            .into_iter()
            .find(|p| output.port_name(p).ok().as_deref() == Some(name.as_str()))
            .expect("virtual input not found in the MIDI output list");
        let mut fake_fl = output.connect(&target, "fake fl").unwrap();
        let answer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            fake_fl.send(&[0x90, 62, 127]).unwrap();
        });

        let round_trip = ping(&port, &listener).expect("no answer");
        answer.join().unwrap();
        assert!(round_trip < PING_TIMEOUT);
    }

    #[test]
    fn positions_split_into_7_bit_parts() {
        assert_eq!(position_parts(0), [0, 0, 0]);
        assert_eq!(position_parts(127), [127, 0, 0]);
        assert_eq!(position_parts(128), [0, 1, 0]);
        // 83 s = 83000 ms = 5 * 16384 + 8 * 128 + 56
        assert_eq!(position_parts(83_000), [56, 8, 5]);
        let [a, b, c] = position_parts(MAX_JUMP_MS);
        assert_eq!((a, b, c), (127, 127, 127));
    }

    #[test]
    fn pong_is_note_on_62() {
        assert!(is_pong(&[0x90, 62, 127]));
        assert!(is_pong(&[0x93, 62, 1])); // any channel
        assert!(!is_pong(&[0x90, 62, 0])); // velocity 0 = note-off
        assert!(!is_pong(&[0x80, 62, 64]));
        assert!(!is_pong(&[0x90, 60, 127]));
    }
}
