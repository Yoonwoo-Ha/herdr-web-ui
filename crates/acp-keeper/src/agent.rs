//! Starting the agent and ending everything it starts. The agent leads its own process group, so
//! the keeper can end the group with it. On Linux it also dies with the keeper (`PR_SET_PDEATHSIG`,
//! even when the keeper is killed outright), and where the user's systemd is reachable it runs in a
//! transient scope named after ROOT: helpers that leave the group (a broker that calls `setsid`)
//! stay in the scope, which the keeper stops when it ends and, before starting the agent, when an
//! earlier keeper in the same ROOT died without stopping it.
//!
//! The agent's real TUI is started the same way, in the same scope, on the pane's terminal instead
//! of pipes: it becomes the terminal's foreground job, as a shell would make it, and the keeper takes
//! the terminal back when it exits.

use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::process::{Child, Command};

pub enum Io {
    /// The ACP agent: stdin and stdout are the keeper's pipes, stderr goes to a file.
    Pipes(std::fs::File),
    /// The real TUI: the pane's terminal, handed over as the foreground job when the pane has job control.
    Terminal { foreground: bool },
}

pub struct Agent {
    pub child: Child,
    pub pid: u32,
    pub scope: Option<String>,
    #[cfg(unix)]
    child_signal: tokio::signal::unix::Signal,
}

impl Agent {
    pub async fn spawn(command: &str, args: &[String], cwd: &str, io: Io, root: &Path) -> std::io::Result<Agent> {
        #[cfg(unix)]
        let child_signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child())?;
        let scope = scope_for(root).await;
        let mut cmd = match &scope {
            Some(unit) => {
                let mut cmd = Command::new("systemd-run");
                cmd.args(["--user", "--scope", "--quiet", "--collect", "--expand-environment=no", "--property=TimeoutStopSec=2"])
                    .arg(format!("--unit={unit}"))
                    .arg("--")
                    .arg(command);
                cmd
            }
            None => Command::new(command),
        };
        cmd.args(args).current_dir(cwd).kill_on_drop(true);
        let foreground = match io {
            Io::Pipes(stderr) => {
                cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(stderr);
                false
            }
            Io::Terminal { foreground } => foreground,
        };
        #[cfg(not(unix))]
        let _ = foreground;
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(unix)]
        {
            let keeper = std::process::id() as libc::pid_t;
            unsafe {
                cmd.pre_exec(move || {
                    #[cfg(target_os = "linux")]
                    {
                        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        if libc::getppid() != keeper {
                            return Err(std::io::Error::other("the keeper ended before the agent started"));
                        }
                    }
                    let _ = keeper;
                    if foreground {
                        hand_terminal(libc::getpid());
                    }
                    Ok(())
                });
            }
        }
        let child = cmd.spawn()?;
        let pid = child.id().unwrap_or(0);
        #[cfg(unix)]
        if foreground && pid > 0 {
            hand_terminal(pid as libc::pid_t);
        }
        Ok(Agent {
            child,
            pid,
            scope,
            #[cfg(unix)]
            child_signal,
        })
    }

    pub async fn wait(&mut self) -> std::io::Result<ExitStatus> {
        #[cfg(unix)]
        {
            // Keep the exited child unreaped until the group has been signalled. Reaping can
            // release its PID (and thus its group number) for reuse by an unrelated process.
            while !child_status(self.pid, libc::WEXITED)? {
                self.child_signal.recv().await;
            }
            self.signal_group(Signal::Kill);
        }
        self.child.wait().await
    }

    /// Ends the agent and everything it started: SIGTERM to its group, SIGKILL after `grace`.
    pub async fn stop(&mut self, grace: Duration) -> std::io::Result<ExitStatus> {
        self.signal_group(Signal::Term);
        let status = match tokio::time::timeout(grace, self.wait()).await {
            Ok(status) => status,
            Err(_) => {
                self.signal_group(Signal::Kill);
                let _ = self.child.start_kill();
                self.child.wait().await
            }
        };
        self.stop_remaining_scope().await;
        status
    }

    /// The scope can contain helpers that left the agent's process group.
    pub async fn stop_remaining_scope(&self) {
        if let Some(unit) = &self.scope {
            stop_scope(unit).await;
        }
    }

    #[cfg(unix)]
    fn signal_group(&self, signal: Signal) {
        let signal = match signal {
            Signal::Term => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        if self.child.id().is_some() && self.pid > 0 {
            unsafe { libc::kill(-(self.pid as libc::pid_t), signal) };
        }
    }

    #[cfg(not(unix))]
    fn signal_group(&self, _signal: Signal) {}
}

enum Signal {
    Term,
    Kill,
}

fn quiet(cmd: &mut Command) -> &mut Command {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true)
}

const SCOPE_COMMAND_TIMEOUT: Duration = Duration::from_secs(3);

#[cfg(target_os = "linux")]
async fn scope_for(root: &Path) -> Option<String> {
    let mut probe = Command::new("systemd-run");
    probe.args(["--user", "--scope", "--quiet", "--collect", "--expand-environment=no", "true"]);
    let usable = tokio::time::timeout(SCOPE_COMMAND_TIMEOUT, quiet(&mut probe).status())
        .await
        .is_ok_and(|status| status.is_ok_and(|s| s.success()));
    if !usable {
        return None;
    }
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    use std::os::unix::ffi::OsStrExt;
    let hash = root.as_os_str().as_bytes().iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3));
    let unit = format!("acp-keeper-{hash:016x}");
    stop_scope(&unit).await.then_some(unit)
}

#[cfg(not(target_os = "linux"))]
async fn scope_for(_root: &Path) -> Option<String> {
    None
}

async fn stop_scope(unit: &str) -> bool {
    let mut stop = Command::new("systemctl");
    stop.args(["--user", "stop"]).arg(format!("{unit}.scope"));
    if tokio::time::timeout(SCOPE_COMMAND_TIMEOUT, quiet(&mut stop).status()).await.is_err() {
        eprintln!("systemctl stop timed out for {unit}.scope; scope cleanup is unconfirmed");
        return false;
    }
    // A nonzero status is normal when a collected scope already went away.
    true
}

/// Whether the pane's terminal has job control with the keeper as its foreground job, so the real
/// TUI can be handed the terminal and the keeper can take it back.
#[cfg(unix)]
pub fn job_control() -> bool {
    unsafe { libc::isatty(0) == 1 && libc::tcgetpgrp(0) == libc::getpgrp() }
}

#[cfg(windows)]
pub fn job_control() -> bool {
    false
}

/// Makes `pgid` the terminal's foreground job, ignoring SIGTTOU around the call as shells do.
#[cfg(unix)]
fn hand_terminal(pgid: libc::pid_t) {
    unsafe {
        let old = libc::signal(libc::SIGTTOU, libc::SIG_IGN);
        libc::tcsetpgrp(0, pgid);
        libc::signal(libc::SIGTTOU, old);
    }
}

#[cfg(unix)]
fn child_status(pid: u32, status: libc::c_int) -> std::io::Result<bool> {
    loop {
        // SAFETY: waitid may write a siginfo_t to this aligned, writable buffer. Its zeroed PID
        // also represents no child status when WNOHANG returns successfully without an event.
        let ready = unsafe {
            let mut info = std::mem::zeroed::<libc::siginfo_t>();
            let result = libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, status | libc::WNOHANG | libc::WNOWAIT);
            (result == 0).then(|| info.si_pid() != 0)
        };
        if let Some(ready) = ready {
            return Ok(ready);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

/// Whether `pid` (a child of the keeper) is stopped, as a TUI is after Ctrl+Z; the stop is not consumed.
#[cfg(unix)]
pub fn stopped(pid: u32) -> bool {
    child_status(pid, libc::WSTOPPED).unwrap_or(false)
}

#[cfg(not(unix))]
pub fn stopped(_pid: u32) -> bool {
    false
}

/// Lets a stopped TUI go on: the pane has no shell to bring it back with `fg`.
#[cfg(unix)]
pub fn continue_job(pid: u32) {
    hand_terminal(pid as libc::pid_t);
    unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGCONT) };
}

#[cfg(windows)]
pub fn continue_job(_pid: u32) {}

/// Takes the terminal back after the real TUI. `raw` (the status line's raw mode) runs while the
/// keeper is still in the background, so a Ctrl+C typed as the TUI quits stays a key instead of
/// becoming SIGINT for the keeper.
#[cfg(unix)]
pub fn take_terminal(raw: impl FnOnce()) {
    unsafe {
        let old = libc::signal(libc::SIGTTOU, libc::SIG_IGN);
        raw();
        libc::tcsetpgrp(0, libc::getpgrp());
        libc::signal(libc::SIGTTOU, old);
    }
}

#[cfg(windows)]
pub fn take_terminal(raw: impl FnOnce()) {
    raw();
}
