use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;
use prospero_protocol_rs::TerminalSize;

pub struct TerminalModel {
    terminal: Term<VoidListener>,
    parser: Processor,
    size: TerminalSize,
}

impl std::fmt::Debug for TerminalModel {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TerminalModel")
            .field("size", &self.size)
            .finish()
    }
}

impl TerminalModel {
    pub fn new(size: TerminalSize) -> Self {
        let size = valid_size(size);
        let viewport = Viewport::new(size);
        Self {
            terminal: Term::new(Config::default(), &viewport, VoidListener),
            parser: Processor::new(),
            size,
        }
    }

    pub fn reset(&mut self, size: TerminalSize, bytes: &[u8]) {
        *self = Self::new(size);
        self.feed(bytes);
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.terminal, bytes);
    }

    pub fn resize(&mut self, size: TerminalSize) {
        let size = valid_size(size);
        self.terminal.resize(Viewport::new(size));
        self.size = size;
    }

    pub fn size(&self) -> TerminalSize {
        self.size
    }

    pub fn visible_text(&self) -> String {
        let content = self.terminal.renderable_content();
        let mut output = String::new();
        let mut current_line = None;
        let mut line = String::new();
        for indexed in content.display_iter {
            if current_line.is_some_and(|value| value != indexed.point.line) {
                trim_line(&mut line);
                output.push_str(&line);
                output.push('\n');
                line.clear();
            }
            current_line = Some(indexed.point.line);
            if indexed.cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            line.push(indexed.cell.c);
            if let Some(zero_width) = indexed.cell.zerowidth() {
                line.extend(zero_width);
            }
        }
        trim_line(&mut line);
        output.push_str(&line);
        output.trim_end_matches('\n').to_owned()
    }
}

fn valid_size(size: TerminalSize) -> TerminalSize {
    if size.is_valid() {
        size
    } else {
        TerminalSize {
            cols: 120,
            rows: 40,
        }
    }
}

fn trim_line(line: &mut String) {
    let length = line.trim_end_matches(' ').len();
    line.truncate(length);
}

#[derive(Clone, Copy)]
struct Viewport {
    columns: usize,
    lines: usize,
}

impl Viewport {
    fn new(size: TerminalSize) -> Self {
        Self {
            columns: usize::from(size.cols),
            lines: usize::from(size.rows),
        }
    }
}

impl Dimensions for Viewport {
    fn total_lines(&self) -> usize {
        self.lines
    }

    fn screen_lines(&self) -> usize {
        self.lines
    }

    fn columns(&self) -> usize {
        self.columns
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_ansi_unicode_and_incremental_output() {
        let mut terminal = TerminalModel::new(TerminalSize { cols: 20, rows: 5 });
        terminal.feed(b"first\r\n\x1b[31mred\x1b[0m ");
        terminal.feed("中文\r\n".as_bytes());
        let rendered = terminal.visible_text();
        assert!(rendered.contains("first"));
        assert!(rendered.contains("red 中文"), "{rendered:?}");
    }

    #[test]
    fn reset_and_resize_replace_the_visible_state() {
        let mut terminal = TerminalModel::new(TerminalSize { cols: 20, rows: 5 });
        terminal.feed(b"old");
        terminal.reset(TerminalSize { cols: 40, rows: 8 }, b"new");
        assert_eq!(terminal.size(), TerminalSize { cols: 40, rows: 8 });
        assert!(!terminal.visible_text().contains("old"));
        assert!(terminal.visible_text().contains("new"));
    }
}
