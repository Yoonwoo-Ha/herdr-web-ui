//! The numbered message file and the replay stream: every JSON-RPC line is appended to
//! ROOT/archive.jsonl as `{"seq","dir","ts","raw"}` (rows the keeper addresses to one client also
//! carry `"client"`); a client sends `{"replay":N}` and gets rows N.. from the file, a
//! `{"through":seq,"pid":pid,"client":conn}` watermark, then live rows.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::watch;

pub const MAX_LINE: usize = 64 << 20;
pub const PUSH: usize = 64 * 1024;

pub enum Framed {
    Line(Vec<u8>),
    /// A line longer than the limit, dropped up to its newline: its length, and the top-level
    /// `id` (with whether a `method` came with it) when one was found in it.
    Oversize {
        bytes: usize,
        id: Option<Value>,
        request: bool,
    },
}

pub struct Framer {
    buf: Vec<u8>,
    over: Option<(usize, IdScan)>,
    limit: usize,
}

impl Framer {
    pub fn new(limit: usize) -> Self {
        Framer { buf: Vec::new(), over: None, limit }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<Framed> {
        let mut out = Vec::new();
        let mut start = 0;
        while start < chunk.len() {
            let lf = memchr::memchr(b'\n', &chunk[start..]).map(|at| start + at);
            let piece = &chunk[start..lf.unwrap_or(chunk.len())];
            match &mut self.over {
                Some((bytes, scan)) => {
                    *bytes += piece.len();
                    scan.feed(piece);
                }
                None if self.buf.len() + piece.len() > self.limit => {
                    let mut scan = IdScan::default();
                    scan.feed(&self.buf);
                    scan.feed(piece);
                    self.over = Some((self.buf.len() + piece.len(), scan));
                    self.buf = Vec::new();
                }
                None => self.buf.extend_from_slice(piece),
            }
            let Some(lf) = lf else { break };
            match self.over.take() {
                Some((bytes, scan)) => out.push(Framed::Oversize {
                    bytes,
                    request: scan.method,
                    id: scan.id(),
                }),
                None => {
                    let mut line = std::mem::take(&mut self.buf);
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    out.push(Framed::Line(line));
                }
            }
            start = lf + 1;
        }
        out
    }
}

/// Finds the top-level `"id"` of a JSON object streamed through it in pieces, keeping only a few
/// bytes: the line it reads is too long to hold, and the id may come after a huge `params`. Member
/// names are compared after JSON unescaping (`"\u0069d"` is `id`); a name past KEY_BYTES is no
/// `id` or `method`, and an id past ID_BYTES is not kept (the note then carries no id).
#[derive(Default)]
struct IdScan {
    depth: u32,
    string: bool,
    escape: bool,
    expect_key: bool,
    key: Option<Vec<u8>>,
    after_key: Option<Vec<u8>>,
    value: Option<Vec<u8>>,
    found: Option<Vec<u8>>,
    method: bool,
}

const KEY_BYTES: usize = 64;
const ID_BYTES: usize = 64 << 10;

impl IdScan {
    fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            if self.value.as_ref().is_some_and(|value| value.len() > ID_BYTES) {
                self.value = None;
            }
            if self.key.as_ref().is_some_and(|key| key.len() > KEY_BYTES) {
                self.key = None;
            }
            if self.string {
                if let Some(key) = self.key.as_mut() {
                    key.push(b);
                }
                if let Some(value) = self.value.as_mut() {
                    value.push(b);
                }
                if self.escape {
                    self.escape = false;
                } else if b == b'\\' {
                    self.escape = true;
                } else if b == b'"' {
                    self.string = false;
                    if let Some(key) = self.key.take() {
                        let quoted = [&b"\""[..], &key].concat();
                        self.after_key = serde_json::from_slice::<String>(&quoted).ok().map(String::into_bytes);
                    }
                }
                continue;
            }
            match b {
                b'"' => {
                    self.string = true;
                    if self.depth == 1 && self.expect_key {
                        self.expect_key = false;
                        self.key = Some(Vec::new());
                    } else if let Some(value) = self.value.as_mut() {
                        value.push(b);
                    }
                }
                b':' if self.depth == 1 => match self.after_key.take().as_deref() {
                    Some(b"id") => self.value = Some(Vec::new()),
                    Some(b"method") => self.method = true,
                    _ => {}
                },
                b',' if self.depth == 1 => {
                    if let Some(value) = self.value.take() {
                        self.found = Some(value);
                    }
                    self.expect_key = true;
                }
                b'{' | b'[' => {
                    self.depth += 1;
                    if self.depth == 1 {
                        self.expect_key = b == b'{';
                    } else if let Some(value) = self.value.as_mut() {
                        value.push(b);
                    }
                }
                b'}' | b']' => {
                    if self.depth == 1 {
                        if let Some(value) = self.value.take() {
                            self.found = Some(value);
                        }
                    } else if let Some(value) = self.value.as_mut() {
                        value.push(b);
                    }
                    self.depth = self.depth.saturating_sub(1);
                }
                _ => {
                    if let Some(value) = self.value.as_mut() {
                        value.push(b);
                    }
                }
            }
        }
    }

    fn id(&self) -> Option<Value> {
        let value: Value = serde_json::from_slice(self.found.as_deref()?).ok()?;
        (value.is_string() || value.is_number()).then_some(value)
    }
}

/// A JSON-RPC 2.0 message object, parsed; anything else is None.
pub fn rpc(line: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    let Ok(Value::Object(msg)) = serde_json::from_str::<Value>(line) else { return None };
    if msg.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return None;
    }
    let id_ok = |id: Option<&Value>| matches!(id, Some(Value::Null | Value::String(_))) || id.and_then(Value::as_i64).is_some();
    let ok = if let Some(method) = msg.get("method") {
        method.as_str().is_some_and(|m| !m.is_empty())
            && (!msg.contains_key("id") || id_ok(msg.get("id")))
            && !msg.contains_key("result")
            && !msg.contains_key("error")
            && msg.get("params").is_none_or(|p| p.is_object() || p.is_array())
    } else if !id_ok(msg.get("id")) || msg.contains_key("params") {
        false
    } else {
        match (msg.get("result"), msg.get("error")) {
            (Some(_), None) => true,
            (None, Some(Value::Object(error))) => error.get("code").and_then(Value::as_i64).is_some() && error.get("message").is_some_and(Value::is_string),
            _ => false,
        }
    };
    ok.then_some(msg)
}

pub fn key_of(id: &Value) -> String {
    serde_json::to_string(id).unwrap_or_default()
}

pub fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// What an earlier keeper in the same ROOT left in the archive: the last session it opened, the
/// agent requests nobody answered (the agent that asked them is gone), and its last client number.
#[derive(Default)]
pub struct Previous {
    pub session: Option<String>,
    pub pending: Vec<(Value, u64)>,
    /// The highest client number a row was addressed to: this run's clients count on from it, so a
    /// client replaying across a restart never takes an earlier client's answer for its own.
    pub last_client: u64,
}

impl Previous {
    fn read(&mut self, unanswered: &mut HashMap<String, (Value, u64)>, row: &[u8]) {
        let Ok(row) = serde_json::from_slice::<Value>(row) else { return };
        if let Some(client) = row["client"].as_u64() {
            self.last_client = self.last_client.max(client);
        }
        let (Some(seq), Some(dir), Some(raw)) = (row["seq"].as_u64(), row["dir"].as_str(), row["raw"].as_str()) else {
            return;
        };
        if dir != "keeper" && dir != "from-agent" {
            return;
        }
        let Some(msg) = rpc(raw) else { return };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").unwrap_or(&Value::Null);
        match (dir, method) {
            ("from-agent", "") => {}
            ("from-agent", _) => {
                if let Some(id) = msg.get("id") {
                    unanswered.insert(key_of(id), (id.clone(), seq));
                }
            }
            (_, "_keeper/client") => self.last_client = self.last_client.max(params["client"].as_u64().unwrap_or(0)),
            (_, "_keeper/session") => self.session = params["sessionId"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
            (_, "_keeper/resolved" | "_keeper/auto_answered" | "_keeper/expired") => {
                unanswered.remove(&key_of(&params["id"]));
            }
            _ => {}
        }
    }
}

struct Log {
    file: File,
    offsets: Vec<u64>,
}

pub struct Archive {
    log: Mutex<Log>,
    error: OnceLock<std::io::Error>,
    pub end: watch::Sender<u64>,
    pub path: PathBuf,
    /// set as the keeper ends: every replay stream sends what is left, then ends
    closing: watch::Sender<bool>,
    /// how many replay streams still run
    streams: watch::Sender<usize>,
}

impl Archive {
    /// Opens ROOT's archive, numbering on from the rows an earlier keeper left; a last row cut
    /// short (a keeper killed mid-write) is dropped.
    pub fn open(path: PathBuf) -> std::io::Result<(Archive, Previous)> {
        let file = private(OpenOptions::new().read(true).append(true).create(true)).open(&path)?;
        let mut offsets = vec![0];
        let mut previous = Previous::default();
        let mut unanswered = HashMap::new();
        let mut reader = BufReader::new(&file);
        let mut row = Vec::new();
        let mut end = 0u64;
        loop {
            row.clear();
            let n = reader.read_until(b'\n', &mut row)?;
            if n == 0 || row.last() != Some(&b'\n') {
                break;
            }
            end += n as u64;
            offsets.push(end);
            previous.read(&mut unanswered, &row);
        }
        drop(reader);
        if file.metadata()?.len() != end {
            // Append-only handles cannot truncate on Windows.
            OpenOptions::new().write(true).open(&path)?.set_len(end)?;
        }
        previous.pending = unanswered.into_values().collect();
        previous.pending.sort_by_key(|(_, seq)| *seq);
        let (tx, _) = watch::channel(end);
        Ok((
            Archive {
                log: Mutex::new(Log { file, offsets }),
                error: OnceLock::new(),
                end: tx,
                path,
                closing: watch::Sender::new(false),
                streams: watch::Sender::new(0),
            },
            previous,
        ))
    }

    pub fn append(&self, dir: &str, raw: &str) -> Option<u64> {
        self.row(dir, None, raw)
    }

    /// A row meant for one client: the keeper's answer to that client's own request.
    pub fn append_for(&self, client: u64, raw: &str) {
        self.row("to-client", Some(client), raw);
    }

    pub fn error(&self) -> Option<&std::io::Error> {
        self.error.get()
    }

    fn row(&self, dir: &str, client: Option<u64>, raw: &str) -> Option<u64> {
        let ts = now_ms();
        let mut log = self.log.lock().expect("archive lock");
        if self.error().is_some() {
            return None;
        }
        let seq = log.offsets.len() as u64;
        let client = client.map(|c| format!(",\"client\":{c}")).unwrap_or_default();
        let row = format!(
            "{{\"seq\":{seq},\"dir\":\"{dir}\"{client},\"ts\":{ts},\"raw\":{}}}\n",
            serde_json::to_string(raw).expect("a string serializes")
        );
        if let Err(error) = log.file.write_all(row.as_bytes()) {
            // Do not publish or write past a partial row. The next open repairs the tail.
            self.error.get_or_init(|| error);
            return None;
        }
        let end = log.offsets.last().copied().unwrap_or(0) + row.len() as u64;
        log.offsets.push(end);
        drop(log);
        self.end.send_replace(end);
        Some(seq)
    }

    /// Where row `n` starts, the current end and the last sequence number, read together.
    pub fn replay_from(&self, n: u64) -> Option<(u64, u64, u64)> {
        let log = self.log.lock().expect("archive lock");
        let count = log.offsets.len() as u64;
        if n < 1 || n > count {
            return None;
        }
        Some((log.offsets[(n - 1) as usize], *log.offsets.last().expect("offsets start at 0"), count - 1))
    }
}

#[cfg(unix)]
fn read_at(file: &File, buf: &mut [u8], at: u64) -> std::io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buf, at)
}

#[cfg(windows)]
fn read_at(file: &File, buf: &mut [u8], at: u64) -> std::io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buf, at)
}

/// Counts a replay stream while it runs, however it ends (an aborted task included).
struct Stream<'a>(&'a Archive);

impl Drop for Stream<'_> {
    fn drop(&mut self) {
        self.0.streams.send_modify(|n| *n -= 1);
    }
}

impl Archive {
    /// As the keeper ends: lets every replay stream send the rows it has not sent yet, so a client
    /// gets the agent's last answer, and waits (bounded) for them to finish.
    pub async fn close(&self, within: std::time::Duration) {
        self.closing.send_replace(true);
        let mut streams = self.streams.subscribe();
        let _ = tokio::time::timeout(within, streams.wait_for(|n| *n == 0)).await;
    }
}

/// Sends rows from `cursor` up to `boundary`, the watermark, then every row appended later, until
/// the archive closes and the last row is sent.
pub async fn pump<W: AsyncWrite + Unpin>(archive: &Archive, mut out: W, mut cursor: u64, boundary: u64, through: u64, pid: u32, client: u64) -> std::io::Result<()> {
    archive.streams.send_modify(|n| *n += 1);
    let _stream = Stream(archive);
    let reader = File::open(&archive.path)?;
    let mut end_rx = archive.end.subscribe();
    let mut closing = archive.closing.subscribe();
    let mut marker = false;
    let mut bytes = vec![0u8; PUSH];
    loop {
        let limit = if marker { *end_rx.borrow_and_update() } else { boundary };
        if cursor < limit {
            let want = PUSH.min((limit - cursor) as usize);
            let count = read_at(&reader, &mut bytes[..want], cursor)?;
            if count == 0 {
                return Err(std::io::Error::other("archive truncated while replaying"));
            }
            cursor += count as u64;
            out.write_all(&bytes[..count]).await?;
        } else if !marker {
            marker = true;
            out.write_all(format!("{{\"through\":{through},\"pid\":{pid},\"client\":{client}}}\n").as_bytes()).await?;
        } else if *closing.borrow_and_update() {
            return Ok(());
        } else {
            tokio::select! {
                changed = end_rx.changed() => if changed.is_err() { return Ok(()) },
                _ = closing.changed() => {}
            }
        }
    }
}

fn private(options: &mut OpenOptions) -> &mut OpenOptions {
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(options, 0o600);
    options
}

pub fn append_file(path: &Path) -> std::io::Result<File> {
    private(OpenOptions::new().append(true).create(true)).open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(limit: usize, input: &[u8]) -> Vec<Framed> {
        let mut framer = Framer::new(limit);
        input.chunks(7).flat_map(|chunk| framer.push(chunk)).collect()
    }

    #[test]
    fn an_oversize_line_reports_its_id_wherever_it_sits() {
        let line = br#"{"jsonrpc":"2.0","method":"m","params":{"id":1,"text":"a\"},\"id\":9,"},"id":"x-7"}"#;
        let mut input = line.to_vec();
        input.extend_from_slice(b"\n{\"ok\":1}\n");
        let framed = frame(40, &input);
        assert!(matches!(&framed[0], Framed::Oversize { bytes, id: Some(id), request: true } if *bytes == line.len() && id == "x-7"));
        assert!(matches!(&framed[1], Framed::Line(l) if l == b"{\"ok\":1}"));

        let answer = br#"{"result":{"outcome":{}},"jsonrpc":"2.0","id":12}"#;
        assert!(matches!(&frame(10, &[&answer[..], b"\n"].concat())[0], Framed::Oversize { id: Some(id), request: false, .. } if id == 12));
        assert!(matches!(&frame(10, b"[1,2,3,4,5,6,7,8,9]\n")[0], Framed::Oversize { id: None, .. }));
    }

    #[test]
    fn an_oversize_line_finds_an_escaped_key_and_a_long_id() {
        let long = "i".repeat(5000);
        let line = format!(r#"{{"jsonrpc":"2.0","method":"m","params":{{"t":"{}"}},"\u0069d":"{long}"}}"#, "z".repeat(100));
        let framed = frame(40, format!("{line}\n").as_bytes());
        assert!(matches!(&framed[0], Framed::Oversize { id: Some(id), request: true, .. } if id == &serde_json::json!(long)));
    }

    #[test]
    fn reopening_numbers_on_and_drops_a_torn_row() {
        let dir = std::env::temp_dir().join(format!("ak-unit-{}-reopen", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("archive.jsonl");
        let (archive, _) = Archive::open(path.clone()).unwrap();
        archive.append("keeper", r#"{"jsonrpc":"2.0","method":"_keeper/session","params":{"sessionId":"s1"}}"#);
        archive.append("from-agent", r#"{"jsonrpc":"2.0","id":4,"method":"session/request_permission","params":{}}"#);
        archive.append("from-agent", r#"{"jsonrpc":"2.0","id":5,"method":"session/request_permission","params":{}}"#);
        archive.append("keeper", r#"{"jsonrpc":"2.0","method":"_keeper/resolved","params":{"id":4}}"#);
        drop(archive);
        let whole = std::fs::metadata(&path).unwrap().len();
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{\"seq\":5,\"dir\":\"from-ag").unwrap();

        let (archive, previous) = Archive::open(path.clone()).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), whole);
        assert_eq!(previous.session.as_deref(), Some("s1"));
        assert_eq!(previous.pending, vec![(serde_json::json!(5), 3)]);
        assert_eq!(archive.append("keeper", "{}"), Some(5));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
