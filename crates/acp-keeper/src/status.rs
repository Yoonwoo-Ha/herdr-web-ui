//! The pane's status line. People work with an ACP agent in Ovis (chat and cards); the pane only
//! says that the agent runs over ACP and offers F4, which hands the pane to the agent's real TUI on
//! the same conversation. Every other key is dropped, so nothing typed in the pane can answer an
//! approval or reach the agent.

use std::io::Write;

use crossterm::cursor::{Hide, MoveTo, Show};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::style::Print;
use crossterm::terminal::{self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::{execute, queue};
use unicode_width::UnicodeWidthChar;

use crate::model::Model;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Acp,
    /// Between the ACP agent and the real TUI, either way.
    Switching,
    Terminal,
}

#[derive(PartialEq, Debug)]
pub enum Key {
    OpenTui,
    Quit,
    Redraw,
}

pub fn key(event: &Event) -> Option<Key> {
    let key = match event {
        Event::Key(key) => key,
        Event::Resize(..) => return Some(Key::Redraw),
        _ => return None,
    };
    if key.kind == KeyEventKind::Release {
        return None;
    }
    match key.code {
        KeyCode::F(4) if key.modifiers.is_empty() => Some(Key::OpenTui),
        KeyCode::Char('q') if key.modifiers == KeyModifiers::CONTROL => Some(Key::Quit),
        _ => None,
    }
}

pub fn lines(model: &Model, mode: Mode) -> Vec<String> {
    let mut head = match mode {
        Mode::Acp => format!("ACP로 실행 중 · {}", model.agent),
        Mode::Switching => format!("진짜 TUI와 바꾸는 중 · {}", model.agent),
        Mode::Terminal => return vec![],
    };
    if let Some(models) = &model.models {
        head.push_str(&format!(" · 모델 {}", models.current_name()));
    }
    if let Some(modes) = &model.modes {
        head.push_str(&format!(" · 모드 {}", modes.current_name()));
    }
    if model.working {
        head.push_str(" · 일하는 중");
    }
    if !model.pending.is_empty() {
        head.push_str(&format!(" · 승인 대기 {} (Ovis에서 답하세요)", model.pending.len()));
    }
    let mut out = vec![head, format!("클라이언트 {} · F4: 진짜 TUI로 열기 · Ctrl+Q: 닫기", model.clients)];
    if let Some(gone) = &model.agent_gone {
        out.push(gone.clone());
    }
    if let Some(notice) = &model.notice {
        out.push(notice.clone());
    }
    out.into_iter().map(|line| clean(&line)).collect()
}

/// Control characters become visible symbols, so text from the agent or a client cannot move the
/// cursor or rewrite the pane.
fn clean(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { char::from_u32(0x2400 + (c as u32 & 0x1f)).unwrap_or('?') } else { c })
        .collect()
}

fn fit(line: &str, width: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in line.chars() {
        let w = UnicodeWidthChar::width(c).unwrap_or(0);
        if used + w > width {
            break;
        }
        used += w;
        out.push(c);
    }
    out
}

pub fn restore_terminal() {
    let _ = terminal::disable_raw_mode();
    let _ = execute!(std::io::stdout(), LeaveAlternateScreen, Show);
}

pub struct Status {
    drawn: Vec<String>,
    /// The terminal's settings when the keeper started: a real TUI that exits without restoring
    /// its own (raw mode left on) must not become what the pane is left with.
    #[cfg(unix)]
    original: Option<libc::termios>,
}

impl Status {
    pub fn enter() -> std::io::Result<Status> {
        let mut status = Status {
            drawn: vec![],
            #[cfg(unix)]
            original: unsafe {
                let mut termios = std::mem::zeroed::<libc::termios>();
                (libc::tcgetattr(0, &mut termios) == 0).then_some(termios)
            },
        };
        status.resume()?;
        Ok(status)
    }

    /// Takes the pane (again): the settings it started with, then raw keys, its own screen and no
    /// cursor; the next draw paints everything.
    pub fn resume(&mut self) -> std::io::Result<()> {
        #[cfg(unix)]
        if let Some(original) = &self.original {
            unsafe { libc::tcsetattr(0, libc::TCSANOW, original) };
        }
        terminal::enable_raw_mode()?;
        execute!(std::io::stdout(), EnterAlternateScreen, Hide)?;
        self.drawn.clear();
        Ok(())
    }

    /// Gives the pane up for the real TUI: the terminal as the keeper found it.
    pub fn suspend(&mut self) {
        restore_terminal();
    }

    pub fn draw(&mut self, lines: Vec<String>) {
        if lines == self.drawn {
            return;
        }
        let width = terminal::size().map(|(w, _)| w as usize).unwrap_or(80);
        let mut out = std::io::stdout();
        let _ = queue!(out, MoveTo(0, 0), Clear(ClearType::All));
        for (row, line) in lines.iter().enumerate() {
            let _ = queue!(out, MoveTo(0, row as u16), Print(fit(line, width)));
        }
        let _ = out.flush();
        self.drawn = lines;
    }

    pub fn redraw(&mut self) {
        self.drawn.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEvent;
    use serde_json::json;

    #[test]
    fn only_f4_and_ctrl_q_mean_anything() {
        let press = |code, modifiers| Event::Key(KeyEvent::new(code, modifiers));
        assert_eq!(key(&press(KeyCode::F(4), KeyModifiers::NONE)), Some(Key::OpenTui));
        assert_eq!(key(&press(KeyCode::Char('q'), KeyModifiers::CONTROL)), Some(Key::Quit));
        for code in [KeyCode::Char('y'), KeyCode::Char('n'), KeyCode::Char('1'), KeyCode::Enter, KeyCode::Esc, KeyCode::F(5)] {
            assert_eq!(key(&press(code, KeyModifiers::NONE)), None, "{code:?} did something");
        }
        assert_eq!(key(&press(KeyCode::Char('c'), KeyModifiers::CONTROL)), None);
        assert_eq!(key(&press(KeyCode::F(4), KeyModifiers::SHIFT)), None, "Shift+F4 opened the real TUI");
        assert_eq!(key(&press(KeyCode::Char('q'), KeyModifiers::CONTROL | KeyModifiers::ALT)), None);
    }

    #[test]
    fn the_status_says_how_it_runs_and_what_waits() {
        let mut model = Model::new("gjc".into());
        model.session_result(&json!({"models": {"currentModelId": "m2", "availableModels": [{"modelId": "m2", "name": "Two"}]}}));
        let ask = json!({"method": "session/request_permission", "params": {"options": []}});
        model.request("k".into(), json!("agent-1"), 3, ask.as_object().unwrap());
        model.note("line\u{1b}[2J");
        let lines = lines(&model, Mode::Acp);
        assert_eq!(lines[0], "ACP로 실행 중 · gjc · 모델 Two · 승인 대기 1 (Ovis에서 답하세요)");
        assert!(lines[1].contains("F4: 진짜 TUI로 열기"));
        assert!(!lines.concat().contains('\u{1b}'), "an escape reached the pane");
        assert!(super::lines(&model, Mode::Terminal).is_empty());
    }
}
