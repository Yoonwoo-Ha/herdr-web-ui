#![cfg(target_os = "linux")]

mod common;

use std::io::{Read, Write};
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use common::*;
use serde_json::{json, Value};

/// The keeper on a pseudo-terminal of its own, as in a herdr-core pane: a session leader with the
/// pty as its controlling terminal, so it has job control and can hand the terminal to a real TUI.
struct Pane {
    child: Child,
    /// The pty's settings before the keeper started.
    initial: libc::termios,
    master: std::fs::File,
    screen: Arc<(Mutex<Vec<u8>>, Condvar)>,
}

impl Pane {
    fn start(root: &Root, resume: &Value, agent_args: &[&str]) -> Pane {
        Pane::on(root, resume, agent_args, true)
    }

    /// `controlling: false`: the pty is the keeper's stdio but not its controlling terminal, so it
    /// has no job control.
    fn on(root: &Root, resume: &Value, agent_args: &[&str], controlling: bool) -> Pane {
        let (mut master, mut slave) = (0, 0);
        let size = libc::winsize {
            ws_row: 30,
            ws_col: 160,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        assert_eq!(unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null(), &size) }, 0, "openpty");
        let slave = unsafe { OwnedFd::from_raw_fd(slave) };
        let mut initial = unsafe { std::mem::zeroed::<libc::termios>() };
        assert_eq!(unsafe { libc::tcgetattr(master, &mut initial) }, 0);
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_ovis-acp-keeper"));
        cmd.arg(&root.0)
            .arg("--resume")
            .arg(resume.to_string())
            .arg("--")
            .arg(fake_agent())
            .args(agent_args)
            .env("TERM", "xterm-256color")
            .stdin(Stdio::from(slave.try_clone().unwrap()))
            .stdout(Stdio::from(slave.try_clone().unwrap()))
            .stderr(Stdio::from(slave));
        unsafe {
            cmd.pre_exec(move || {
                if libc::setsid() < 0 || (controlling && libc::ioctl(0, libc::TIOCSCTTY, 0) < 0) {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = cmd.spawn().expect("keeper on a pty");
        let master = unsafe { std::fs::File::from_raw_fd(master) };
        let screen = Arc::new((Mutex::new(Vec::new()), Condvar::new()));
        let (mut reader, shared) = (master.try_clone().unwrap(), screen.clone());
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                shared.0.lock().unwrap().extend_from_slice(&buf[..n]);
                shared.1.notify_all();
            }
        });
        let pane = Pane { child, initial, master, screen };
        pane.shows("ACP로 실행 중", 0);
        pane
    }

    fn termios(&self) -> libc::termios {
        use std::os::fd::AsRawFd;
        let mut termios = unsafe { std::mem::zeroed::<libc::termios>() };
        assert_eq!(unsafe { libc::tcgetattr(self.master.as_raw_fd(), &mut termios) }, 0);
        termios
    }

    fn type_keys(&mut self, keys: &str) {
        self.master.write_all(keys.as_bytes()).expect("type into the pane");
    }

    /// Waits (bounded) until the pane has printed `text` since byte `from`; returns where it ends.
    fn shows(&self, text: &str, from: usize) -> usize {
        let deadline = Instant::now() + WAIT;
        let (lock, cv) = &*self.screen;
        let mut screen = lock.lock().unwrap();
        let text = text.as_bytes();
        loop {
            if let Some(at) = screen.get(from..).and_then(|s| s.windows(text.len()).position(|w| w == text)) {
                return from + at + text.len();
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(
                !left.is_zero(),
                "the pane never showed {:?}; it showed {:?}",
                String::from_utf8_lossy(text),
                String::from_utf8_lossy(screen.get(from..).unwrap_or(b""))
            );
            screen = cv.wait_timeout(screen, left).unwrap().0;
        }
    }
}

impl Drop for Pane {
    fn drop(&mut self) {
        let pid = self.child.id() as i32;
        unsafe { libc::kill(pid, libc::SIGTERM) };
        if !wait_gone(pid) {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        let _ = self.child.wait();
    }
}

fn mode(row: &Value, mode: &str, phase: &str) -> bool {
    method(row) == Some("_keeper/mode") && row["msg"]["params"]["mode"] == mode && row["msg"]["params"]["phase"] == phase
}

const COOKED: libc::tcflag_t = libc::ICANON | libc::ECHO | libc::ISIG;

#[test]
fn the_pane_shows_a_status_line_and_its_keys_never_answer_an_approval() {
    let root = Root::new("pane-keys");
    let mut pane = Pane::start(&root, &json!(["true"]), &[]);
    let mut client = Client::connect(&root);
    let session = client.session();
    client.send(&prompt(1, &session, "ask"));
    let ask = client.wait("the approval request", |r| r["dir"] == "from-agent" && method(r) == Some("session/request_permission"));
    pane.shows("승인 대기 1", 0);
    pane.type_keys("y1n\r\x1b[B\r\x1b[1;2S\x1bOS");
    let refused = client.wait("the F4 typed after the other keys", |r| matches!(method(r), Some("_keeper/switch_refused" | "_keeper/resolved")));
    assert_eq!(method(&refused), Some("_keeper/switch_refused"), "a key in the pane answered the approval");
    assert_eq!(refused["msg"]["params"]["reason"], "an approval is waiting");
    client.send(&json!({"jsonrpc": "2.0", "id": ask["msg"]["id"], "result": {"outcome": {"outcome": "selected", "optionId": "reject"}}}));
    let resolved = client.wait("the approval's answer", |r| method(r) == Some("_keeper/resolved"));
    assert_eq!(resolved["msg"]["params"]["by"], format!("client-{}", client.conn.unwrap()));
    client.wait("the agent's word", |r| chunk_text(r) == Some("answered reject"));
}

#[test]
fn without_job_control_the_pane_keeps_acp() {
    let root = Root::new("pane-nojob");
    let _pane = Pane::on(&root, &json!(["true"]), &[], false);
    let mut client = Client::connect(&root);
    client.session();
    client.send(&json!({"jsonrpc": "2.0", "id": 1, "method": "_keeper/open_terminal"}));
    let refused = client.answer(json!(1));
    assert_eq!(refused["msg"]["error"]["message"], "the pane has no terminal with job control");
}

#[test]
fn f4_hands_the_pane_to_the_real_tui_and_back_on_the_same_session() {
    let root = Root::new("pane-switch");
    let got = root.0.join("tui-got");
    let tui = json!(["sh", "-c", "printf 'REAL-TUI %s\\n' \"$1\"; IFS= read -r line; printf %s \"$line\" > \"$2\"", "sh", "{session}", got]);
    let mut pane = Pane::start(&root, &tui, &[]);
    let mut client = Client::connect(&root);
    let session = client.session();
    let seen = pane.shows("F4: 진짜 TUI로 열기", 0);

    client.send(&prompt(1, &session, "hold"));
    client.wait("the held prompt on its way", |r| r["dir"] == "to-agent" && method(r) == Some("session/prompt"));
    client.send(&json!({"jsonrpc": "2.0", "id": 2, "method": "_keeper/open_terminal"}));
    let refused = client.answer(json!(2));
    assert_eq!(refused["msg"]["error"]["message"], "a turn is running", "the switch went ahead during a turn");
    client.send(&prompt(3, &session, "release"));
    client.answer(json!(1));
    client.answer(json!(3));

    let both = format!("{}\n{}\n", json!({"jsonrpc": "2.0", "id": 4, "method": "_keeper/open_terminal"}), prompt(5, &session, "hold"));
    client.send_raw(both.as_bytes());
    assert_eq!(client.answer(json!(4))["msg"]["result"]["accepted"], true);
    assert!(client.answer(json!(5))["msg"]["error"].is_object(), "a prompt sent with an accepted switch reached the agent");
    client.wait("the real TUI in the pane", |r| mode(r, "terminal", "ready"));
    let seen = pane.shows(&format!("REAL-TUI {session}"), seen);
    client.send(&prompt(6, &session, "echo while the TUI has it"));
    assert!(client.answer(json!(6))["msg"]["error"].is_object(), "a prompt reached ACP while the real TUI had the conversation");

    pane.type_keys("typed in the tui\r");
    client.wait("ACP again", |r| mode(r, "acp", "start"));
    let load = client.wait("the same session loaded again", |r| r["dir"] == "to-agent" && method(r) == Some("session/load"));
    assert_eq!(load["msg"]["params"]["sessionId"], session.as_str());
    client.wait("ACP ready", |r| mode(r, "acp", "ready"));
    assert_eq!(std::fs::read_to_string(&got).expect("the TUI's input"), "typed in the tui", "the keys did not reach the real TUI");
    pane.shows("ACP로 실행 중", seen);

    client.send(&prompt(5, &session, "echo back"));
    let echo = client.wait("a turn after coming back", |r| chunk_text(r) == Some("echo bytes=9"));
    assert_eq!(echo["msg"]["params"]["sessionId"], session.as_str(), "the turn after coming back ran in another session");
}

#[test]
fn a_failed_return_is_reported_and_the_pane_gets_its_settings_back() {
    let root = Root::new("pane-fail");
    let refuse = root.0.join("refuse-load");
    let tui = json!(["sh", "-c", "stty raw -echo -isig; : > \"$1\"; exit 3", "sh", refuse]);
    let before = {
        let mut pane = Pane::start(&root, &tui, &["--refuse-load", refuse.to_str().unwrap()]);
        let before = pane.initial;
        let mut client = Client::connect(&root);
        client.session();
        pane.type_keys("\x1bOS");
        client.wait("the real TUI in the pane", |r| mode(r, "terminal", "ready"));
        let failed = client.wait("the failed return", |r| mode(r, "acp", "failed") || mode(r, "acp", "ready"));
        assert!(mode(&failed, "acp", "failed"), "the keeper reported a return it did not make");
        let archive = std::fs::read_to_string(root.0.join("archive.jsonl")).unwrap();
        let opened = archive
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|r| r["dir"] == "to-agent" && serde_json::from_str::<Value>(r["raw"].as_str().unwrap()).unwrap()["method"] == "session/new")
            .count();
        assert_eq!(opened, 1, "the keeper opened a new conversation in place of the TUI's");
        let seen = pane.shows("✖", 0);
        pane.type_keys("\x11");
        pane.child.wait().expect("the keeper ends on Ctrl+Q");
        let _ = seen;
        let after = pane.termios();
        (before.c_lflag & COOKED, after.c_lflag & COOKED)
    };
    assert_eq!(before.1, before.0, "the pane was left with the failed TUI's terminal settings");
}

#[test]
fn an_approval_from_the_ended_agent_cannot_be_answered() {
    let root = Root::new("pane-close");
    let tui = json!(["sh", "-c", "read line"]);
    let mut pane = Pane::start(&root, &tui, &["--ask-on-close"]);
    let mut client = Client::connect(&root);
    client.session();
    pane.type_keys("\x1bOS");
    let asked = client.wait("the ended agent's last request", |r| r["dir"] == "from-agent" && method(r) == Some("session/request_permission"));
    let expired = client.wait("its expiry", |r| method(r) == Some("_keeper/expired"));
    client.wait("the real TUI in the pane", |r| mode(r, "terminal", "ready"));
    assert_eq!(expired["msg"]["params"]["id"], asked["msg"]["id"]);
    client.send(&json!({"jsonrpc": "2.0", "id": asked["msg"]["id"], "result": {"outcome": {"outcome": "selected", "optionId": "allow"}}}));
    let late = client.wait("the answer's fate", |r| matches!(method(r), Some("_keeper/dropped" | "_keeper/resolved")));
    assert_eq!(method(&late), Some("_keeper/dropped"), "an answer was reported delivered to an agent that was gone");
    pane.type_keys("\r");
    client.wait("ACP again", |r| mode(r, "acp", "ready"));
}

#[test]
fn a_tui_stopped_with_ctrl_z_goes_on() {
    let root = Root::new("pane-stop");
    let got = root.0.join("tui-got");
    let tui = json!([
        "sh",
        "-c",
        "printf 'STOPPING\\n'; kill -STOP $$; printf 'GOING-ON\\n'; IFS= read -r line; printf %s \"$line\" > \"$1\"",
        "sh",
        got
    ]);
    let mut pane = Pane::start(&root, &tui, &[]);
    let mut client = Client::connect(&root);
    client.session();
    pane.type_keys("\x1bOS");
    client.wait("the stopped TUI going on", |r| method(r) == Some("_keeper/tui_continued"));
    pane.shows("GOING-ON", 0);
    pane.type_keys("after the stop\r");
    client.wait("ACP again", |r| mode(r, "acp", "ready"));
    assert_eq!(std::fs::read_to_string(&got).expect("the TUI's input"), "after the stop");
}

#[test]
fn an_agent_that_cannot_load_keeps_the_conversation_for_the_tui() {
    let root = Root::new("pane-noload");
    let mut pane = Pane::start(&root, &json!(["true"]), &["--no-load"]);
    let mut client = Client::connect(&root);
    let session = client.session();
    pane.type_keys("\x1bOS");
    let failed = client.wait("the failed return", |r| mode(r, "acp", "failed") || mode(r, "acp", "ready"));
    assert!(mode(&failed, "acp", "failed"), "the keeper reported a return it did not make");
    assert_eq!(failed["msg"]["params"]["reason"], "the agent cannot load a session");
    client.send(&json!({"jsonrpc": "2.0", "id": 1, "method": "_keeper/open_terminal"}));
    let again = client.answer(json!(1));
    assert_eq!(again["msg"]["result"]["argv"][0], "true", "the conversation can no longer be reopened in its TUI: {again}");
    let _ = session;
}
