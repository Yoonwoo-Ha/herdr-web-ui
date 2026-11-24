#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

pub const WAIT: Duration = Duration::from_secs(30);

pub fn fake_agent() -> PathBuf {
    // the profile dir is the test binary's grandparent, or further up where cargo keeps its
    // intermediate files apart (`build.build-dir`); the examples are always in the profile dir
    let exe = std::env::current_exe().expect("test binary path");
    let name = format!("fake_agent{}", std::env::consts::EXE_SUFFIX);
    let found = exe.ancestors().skip(2).map(|dir| dir.join("examples").join(&name)).find(|path| path.exists());
    let Some(path) = found else {
        panic!(
            "examples/{name} is missing above {}: plain `cargo test` builds it (`--test keeper` alone does not; `cargo build --examples` first)",
            exe.display()
        );
    };
    path
}

/// A private keeper ROOT; the socket path inside it must stay under the 108-byte limit, so it
/// lives in the temp dir rather than the (possibly deep) target dir.
pub struct Root(pub PathBuf);

impl Root {
    pub fn new(name: &str) -> Root {
        let dir = std::env::temp_dir().join(format!("ak-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("root dir");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("root mode");
        Root(dir)
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub struct Keeper {
    pub child: Child,
    pub stderr: PathBuf,
}

pub fn spawn(root: &Path, agent_args: &[&str]) -> (Child, PathBuf) {
    static STARTS: AtomicU64 = AtomicU64::new(0);
    let stderr = root.with_extension(format!("stderr-{}", STARTS.fetch_add(1, Ordering::Relaxed)));
    let child = Command::new(env!("CARGO_BIN_EXE_ovis-acp-keeper"))
        .arg(root)
        .arg("--headless")
        .arg("--")
        .arg(fake_agent())
        .args(agent_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(&stderr).expect("stderr file"))
        .spawn()
        .expect("keeper starts");
    (child, stderr)
}

impl Keeper {
    pub fn start(root: &Root, agent_args: &[&str]) -> Keeper {
        let (mut child, stderr) = spawn(&root.0, agent_args);
        let stdout = child.stdout.take().expect("piped stdout");
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line == "KEEPER_READY" {
                    let _ = tx.send(());
                }
            }
        });
        let keeper = Keeper { child, stderr };
        if rx.recv_timeout(WAIT).is_err() {
            panic!("the keeper did not get ready: {}", std::fs::read_to_string(&keeper.stderr).unwrap_or_default());
        }
        keeper
    }

    pub fn pid(&self) -> i32 {
        self.child.id() as i32
    }

    pub fn signal(&self, signal: i32) {
        unsafe { libc::kill(self.pid(), signal) };
    }

    pub fn wait_exit(&mut self) -> ExitStatus {
        assert!(wait_gone(self.pid()), "the keeper did not end");
        self.child.wait().expect("keeper status")
    }
}

impl Drop for Keeper {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            self.signal(libc::SIGTERM);
            if !wait_gone(self.pid()) {
                self.signal(libc::SIGKILL);
            }
            let _ = self.child.wait();
        }
        let _ = std::fs::remove_file(&self.stderr);
    }
}

/// Waits (bounded by WAIT) for a process to end, on its pidfd. Where pidfd_open is refused (a
/// container whose seccomp profile predates it answers EPERM or ENOSYS), it says so and reads
/// /proc instead: a process that has exited and waits to be reaped (state Z) has ended too.
pub fn wait_gone(pid: i32) -> bool {
    let deadline = Instant::now() + WAIT;
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return true;
        }
        eprintln!("pidfd_open({pid}) refused ({error}): reading /proc/{pid}/stat instead");
        while Instant::now() < deadline {
            if ended(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        return false;
    }
    let mut poll = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
    let ready = loop {
        let left = deadline.saturating_duration_since(Instant::now()).as_millis() as i32;
        let ready = unsafe { libc::poll(&mut poll, 1, left) };
        let error = std::io::Error::last_os_error();
        if ready >= 0 || error.raw_os_error() != Some(libc::EINTR) {
            if ready < 0 {
                eprintln!("poll on the pidfd of {pid} failed: {error}");
            }
            break ready;
        }
    };
    unsafe { libc::close(fd) };
    ready == 1
}

/// Whether `pid` is gone or has exited and waits to be reaped.
fn ended(pid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        // the state follows the command's closing parenthesis
        Ok(stat) => stat.rsplit_once(") ").is_some_and(|(_, rest)| rest.starts_with('Z') || rest.starts_with('X')),
    }
}

/// Kills what a test started outside the keeper's reach, so a failing test leaves nothing behind.
pub struct Reap(pub Vec<i32>);

impl Drop for Reap {
    fn drop(&mut self) {
        for pid in &self.0 {
            unsafe { libc::kill(*pid, libc::SIGKILL) };
        }
    }
}

/// Whether this PC's user systemd can hold a transient scope (the keeper's way to end an agent's
/// helpers that leave its process group).
pub fn scope_available() -> bool {
    Command::new("systemd-run")
        .args(["--user", "--scope", "--quiet", "--collect", "true"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

pub fn process_json(root: &Root) -> Value {
    serde_json::from_str(&std::fs::read_to_string(root.0.join("process.json")).expect("process.json")).expect("process.json parses")
}

/// The `group PID` and `session PID` the fake agent's `helpers` command wrote.
pub fn helpers(root: &Root) -> (i32, i32) {
    let text = std::fs::read_to_string(root.0.join("helpers")).expect("helpers file");
    let pid = |name: &str| text.lines().find_map(|l| l.strip_prefix(&format!("{name} "))).and_then(|p| p.parse().ok()).expect("helper pid");
    (pid("group"), pid("session"))
}

pub struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    pub conn: Option<u64>,
}

impl Client {
    pub fn connect(root: &Root) -> Client {
        let mut writer = UnixStream::connect(root.0.join("acp.sock")).expect("connect to acp.sock");
        writer.write_all(b"{\"replay\":1}\n").expect("replay request");
        Client {
            reader: BufReader::new(writer.try_clone().expect("clone stream")),
            writer,
            conn: None,
        }
    }

    pub fn send(&mut self, msg: &Value) {
        self.send_raw(format!("{msg}\n").as_bytes());
    }

    pub fn send_raw(&mut self, bytes: &[u8]) {
        self.writer.write_all(bytes).expect("send to the keeper");
    }

    /// The next archive row whose `msg` (its parsed `raw`) matches, reading past the others.
    /// This client's number, from the watermark that follows the replayed rows.
    pub fn number(&mut self) -> u64 {
        self.read_until("the watermark", |_| false, true);
        self.conn.expect("a client number")
    }

    pub fn wait(&mut self, what: &str, matches: impl FnMut(&Value) -> bool) -> Value {
        self.read_until(what, matches, false).expect("a matching row")
    }

    fn read_until(&mut self, what: &str, mut matches: impl FnMut(&Value) -> bool, watermark: bool) -> Option<Value> {
        let deadline = Instant::now() + WAIT;
        let mut line = String::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "timed out waiting for {what}");
            self.reader.get_mut().set_read_timeout(Some(left)).expect("read timeout");
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("the keeper closed the stream while waiting for {what}"),
                Ok(_) => {}
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => panic!("timed out waiting for {what}"),
                Err(e) => panic!("reading while waiting for {what}: {e}"),
            }
            let mut row: Value = serde_json::from_str(&line).expect("a JSON row");
            if row.get("through").is_some() {
                self.conn = row.get("client").and_then(Value::as_u64);
                if watermark {
                    return None;
                }
                continue;
            }
            let msg: Value = row.get("raw").and_then(Value::as_str).and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or(Value::Null);
            row["msg"] = msg;
            if matches(&row) {
                return Some(row);
            }
        }
    }

    pub fn session(&mut self) -> String {
        let row = self.wait("the session", |r| method(r) == Some("_keeper/session"));
        row["msg"]["params"]["sessionId"].as_str().expect("session id").to_string()
    }

    pub fn turn_end(&mut self, what: &str) -> Value {
        self.wait(what, |r| r["dir"] == "from-agent" && r["msg"]["result"]["stopReason"].is_string())
    }

    pub fn answer(&mut self, id: Value) -> Value {
        loop {
            let row = self.wait(&format!("the answer to id {id}"), |r| r["dir"] == "to-client");
            if self.conn.is_some() && row["client"].as_u64() == self.conn && row["msg"]["id"] == id {
                return row;
            }
        }
    }
}

pub fn method(row: &Value) -> Option<&str> {
    row["msg"]["method"].as_str()
}

pub fn chunk_text(row: &Value) -> Option<&str> {
    if row["dir"] != "from-agent" {
        return None;
    }
    row["msg"]["params"]["update"]["content"]["text"].as_str()
}

pub fn prompt(id: u64, session: &str, text: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "session/prompt", "params": {"sessionId": session, "prompt": [{"type": "text", "text": text}]}})
}
