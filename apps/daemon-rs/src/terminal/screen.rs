use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use unicode_width::UnicodeWidthChar;

use super::*;

const MAX_CELLS: usize = 2_048_000;
// Reserve a fixed history budget for the largest supported viewport:
// 500 cols * (2 * 300 rows + 3400 history lines) = 2,000,000 cells.
// This avoids the old width-dependent 10,000-line budget disabling snapshots
// around 204 columns while keeping the screen within MAX_CELLS.
const MAX_SCROLLBACK_LINES: usize = 3_400;
const MAX_PENDING: usize = 8192;
const MAX_SNAPSHOT: usize = 1024 * 1024;
const MAX_GLYPHS: usize = 32_768;
const MAX_GLYPH_BYTES: usize = 4 * 1024 * 1024;
const NARROW_PROXY: u32 = 0xf0000;
const WIDE_PROXY: u32 = 0x20000;
const PROXY_COUNT: u32 = 0xfffe;

#[derive(Clone, PartialEq, Eq, Hash)]
struct Glyph {
    text: Arc<str>,
    link: Option<Arc<str>>,
}

impl Glyph {
    fn bytes(&self) -> usize {
        self.text.len() + self.link.as_ref().map_or(0, |link| link.len())
    }
}

fn is_proxy(ch: char) -> bool {
    let value = u32::from(ch);
    (NARROW_PROXY..NARROW_PROXY + PROXY_COUNT).contains(&value)
        || (WIDE_PROXY..WIDE_PROXY + PROXY_COUNT).contains(&value)
}

pub fn width_tables() -> String {
    [0, 2].map(|width| {
        let mut ranges = Vec::<(u32, u32)>::new();
        for value in 0..=0x10ffff {
            if char::from_u32(value).is_some_and(|ch| ch.width().unwrap_or(0) == width) {
                if let Some(last) = ranges.last_mut().filter(|last| last.1 + 1 == value) { last.1 = value; }
                else { ranges.push((value, value)); }
            }
        }
        format!("export const TERMINAL_WIDTH_{width}: readonly (readonly [number, number])[] = {};\n", serde_json::to_string(&ranges).expect("Unicode ranges"))
    }).concat()
}

#[derive(Default, PartialEq)]
enum Escape {
    #[default]
    Ground,
    Start,
    Intermediate,
    Csi,
    String,
}

pub struct Screen {
    terminal: Option<avt::Vt>,
    size: TerminalSize,
    escape: Escape,
    pending: String,
    utf8: Vec<u8>,
    compatible: bool,
    modes: BTreeSet<u16>,
    keypad: bool,
    osc: bool,
    cursor_style: String,
    glyphs: HashMap<char, Glyph>,
    proxies: HashMap<Glyph, char>,
    glyph_bytes: usize,
    next_proxy: [u32; 2],
    link: Option<Arc<str>>,
    join_width: usize,
}

impl Screen {
    fn build_terminal(size: TerminalSize) -> Option<avt::Vt> {
        let cells = usize::from(size.cols) * usize::from(size.rows) * 2;
        (cells <= MAX_CELLS).then(|| {
            avt::Vt::builder()
                .size(size.cols.into(), size.rows.into())
                .scrollback_limit(MAX_SCROLLBACK_LINES)
                .build()
        })
    }

    pub fn new(size: TerminalSize) -> Self {
        Self {
            terminal: Self::build_terminal(size),
            size,
            escape: Escape::Ground,
            pending: String::new(),
            utf8: Vec::new(),
            compatible: true,
            modes: BTreeSet::new(),
            keypad: false,
            osc: false,
            cursor_style: String::new(),
            glyphs: HashMap::new(),
            proxies: HashMap::new(),
            glyph_bytes: 0,
            next_proxy: [0, 0],
            link: None,
            join_width: 0,
        }
    }

    pub fn resize(&mut self, size: TerminalSize) {
        self.size = size;
        let too_large = usize::from(size.cols) * usize::from(size.rows) * 2 > MAX_CELLS;
        if too_large {
            self.terminal = None;
        } else if let Some(terminal) = &mut self.terminal {
            terminal.resize(size.cols.into(), size.rows.into());
        } else {
            // A previous oversized resize is reversible. Recreate the parser
            // when the viewport is small enough again so snapshots recover.
            self.terminal = Self::build_terminal(size);
        }
    }

    pub fn cursor_position(&self) -> (usize, usize) {
        self.terminal
            .as_ref()
            .map(|terminal| {
                let cursor = terminal.cursor();
                (cursor.row, cursor.col)
            })
            .unwrap_or((0, 0))
    }

    pub fn visible_tail_text(&self, limit: usize) -> String {
        let Some(terminal) = &self.terminal else {
            return String::new();
        };
        terminal
            .view()
            .skip(usize::from(self.size.rows).saturating_sub(limit))
            .map(|line| {
                line.chars()
                    .map(|ch| {
                        self.glyphs
                            .get(&ch)
                            .map_or_else(|| ch.to_string(), |glyph| glyph.text.to_string())
                    })
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn process(&mut self, bytes: &[u8]) {
        let bytes = [std::mem::take(&mut self.utf8), bytes.to_vec()].concat();
        let mut offset = 0;
        while offset < bytes.len() {
            let remaining = &bytes[offset..];
            match std::str::from_utf8(remaining) {
                Ok(text) => {
                    for ch in text.chars() {
                        self.character(ch);
                    }
                    break;
                }
                Err(error) => {
                    let prefix = std::str::from_utf8(&remaining[..error.valid_up_to()])
                        .expect("valid UTF-8 prefix");
                    for ch in prefix.chars() {
                        self.character(ch);
                    }
                    if let Some(length) = error.error_len() {
                        self.character('\u{fffd}');
                        offset += error.valid_up_to() + length;
                    } else {
                        self.utf8
                            .extend_from_slice(&remaining[error.valid_up_to()..]);
                        break;
                    }
                }
            }
        }
        if let Some(terminal) = &mut self.terminal {
            terminal.feed_str("");
        }
    }

    fn character(&mut self, ch: char) {
        if self.escape == Escape::Ground {
            if ch == '\x1b' {
                self.pending.push(ch);
                self.escape = Escape::Start;
            } else {
                if ch.is_control() {
                    if ('\u{80}'..='\u{9f}').contains(&ch) {
                        self.compatible = false;
                    }
                    if ch != '\x7f' {
                        self.join_width = 0;
                    }
                    self.feed(ch);
                } else {
                    self.print(ch);
                }
            }
            return;
        }
        if self.pending.len() + ch.len_utf8() <= MAX_PENDING {
            self.pending.push(ch);
        } else {
            self.compatible = false;
        }
        if matches!(ch, '\x18' | '\x1a') {
            self.escape = Escape::Ground;
        } else {
            self.escape = match (&self.escape, ch) {
                (Escape::Start, '[') => Escape::Csi,
                (Escape::Start, ']') => {
                    self.osc = true;
                    Escape::String
                }
                (Escape::Start, 'P' | 'X' | '^' | '_') => {
                    self.osc = false;
                    Escape::String
                }
                (Escape::Start | Escape::Intermediate, '\x20'..='\x2f') => Escape::Intermediate,
                (Escape::Start | Escape::Intermediate, '\x30'..='\x7e') => Escape::Ground,
                (Escape::Csi, '\x40'..='\x7e') => Escape::Ground,
                (Escape::String, '\x07') if self.osc => Escape::Ground,
                (_, '\x1b') => Escape::Start,
                _ => return,
            };
        }
        if self.escape == Escape::Ground {
            let sequence = std::mem::take(&mut self.pending);
            if sequence.ends_with("\x1bc") {
                *self = Self::new(self.size);
                return;
            }
            self.join_width = 0;
            self.input_modes(&sequence);
            for ch in sequence.chars() {
                self.feed(ch);
            }
            if let Some(terminal) = &mut self.terminal {
                terminal.feed_str("");
            }
        }
    }

    fn feed(&mut self, ch: char) {
        if let Some(terminal) = &mut self.terminal {
            terminal.feed(ch);
            if matches!(ch, '\n' | '\x0b' | '\x0c') {
                terminal.feed_str("");
            }
        }
    }

    fn print(&mut self, ch: char) {
        let width = ch.width().unwrap_or(1);
        if width == 0 {
            let Some(terminal) = &self.terminal else {
                return;
            };
            if self.join_width > 0 && !terminal.last_print_succeeded() {
                self.compatible = false;
                return;
            }
            let cursor = terminal.cursor();
            if self.join_width == 0 || cursor.col < self.join_width {
                self.compatible = false;
                self.feed(ch);
                return;
            }
            let col = cursor.col - self.join_width;
            let cell = &terminal.line(cursor.row)[col];
            let mut glyph = self
                .glyphs
                .get(&cell.char())
                .cloned()
                .unwrap_or_else(|| Glyph {
                    text: Arc::from(cell.char().to_string()),
                    link: None,
                });
            glyph.text = Arc::from(format!("{}{ch}", glyph.text));
            if let Some(proxy) = self.proxy(glyph, self.join_width)
                && let Some(terminal) = &mut self.terminal
            {
                terminal.replace_character(col, cursor.row, proxy);
            }
            return;
        }
        if self.join_width == 0
            && let Some(terminal) = &mut self.terminal
        {
            terminal.begin_print();
        }
        self.join_width = width;
        if self.link.is_some() || is_proxy(ch) {
            let ch = self
                .terminal
                .as_ref()
                .map_or(ch, |terminal| terminal.translate_character(ch));
            let glyph = Glyph {
                text: Arc::from(ch.to_string()),
                link: self.link.clone(),
            };
            if let Some(proxy) = self.proxy(glyph, width) {
                self.feed(proxy);
            } else {
                self.feed(ch);
            }
        } else {
            self.feed(ch);
        }
    }

    fn proxy(&mut self, glyph: Glyph, width: usize) -> Option<char> {
        if let Some(proxy) = self.proxies.get(&glyph) {
            return Some(*proxy);
        }
        let bytes = glyph.bytes();
        if bytes > MAX_PENDING || !self.compatible {
            self.compatible = false;
            return None;
        }
        if self.glyphs.len() >= MAX_GLYPHS || self.glyph_bytes + bytes > MAX_GLYPH_BYTES {
            let used: HashSet<_> = self
                .terminal
                .as_ref()
                .into_iter()
                .flat_map(|terminal| terminal.all_cells())
                .map(|cell| cell.char())
                .collect();
            self.glyphs.retain(|proxy, _| used.contains(proxy));
            self.proxies.retain(|_, proxy| used.contains(proxy));
            self.glyph_bytes = self.glyphs.values().map(Glyph::bytes).sum();
        }
        if self.glyphs.len() >= MAX_GLYPHS || self.glyph_bytes + bytes > MAX_GLYPH_BYTES {
            self.compatible = false;
            return None;
        }
        let slot = usize::from(width == 2);
        let base = if slot == 1 { WIDE_PROXY } else { NARROW_PROXY };
        loop {
            let proxy = char::from_u32(base + self.next_proxy[slot]).expect("proxy scalar");
            self.next_proxy[slot] = (self.next_proxy[slot] + 1) % PROXY_COUNT;
            if !self.glyphs.contains_key(&proxy) {
                self.glyph_bytes += bytes;
                self.proxies.insert(glyph.clone(), proxy);
                self.glyphs.insert(proxy, glyph);
                return Some(proxy);
            }
        }
    }

    fn expand_dump(&self, source: &str, mut link: Option<Arc<str>>) -> Result<String> {
        let mut parser = avt::parser::Parser::new();
        let mut output = String::with_capacity(source.len().min(MAX_SNAPSHOT));
        for ch in source.chars() {
            if matches!(parser.feed(ch), Some(avt::parser::Function::Print(_))) {
                let glyph = self.glyphs.get(&ch);
                let next_link = glyph.and_then(|glyph| glyph.link.clone());
                if link != next_link {
                    output.push_str(next_link.as_deref().unwrap_or("\x1b]8;;\x1b\\"));
                    link = next_link;
                }
                if let Some(glyph) = glyph {
                    output.push_str(&glyph.text);
                } else {
                    output.push(ch);
                }
            } else {
                output.push(ch);
            }
            if output.len() > MAX_SNAPSHOT {
                return Err(Error::Invalid("terminal checkpoint exceeds limit".into()));
            }
        }
        if link != self.link {
            output.push_str(self.link.as_deref().unwrap_or("\x1b]8;;\x1b\\"));
        }
        Ok(output)
    }

    fn input_modes(&mut self, sequence: &str) {
        if sequence == "\x1b[!p" {
            self.link = None;
        }
        if let Some(value) = sequence.strip_prefix("\x1b]8;").and_then(|value| {
            value
                .strip_suffix('\x07')
                .or_else(|| value.strip_suffix("\x1b\\"))
        }) && let Some((_, uri)) = value.split_once(';')
        {
            self.link = (!uri.is_empty()).then(|| Arc::from(format!("\x1b]8;{value}\x1b\\")));
        }
        // avt retains protected cells, but its dump does not restore DECSCA or
        // selective erase semantics in xterm. Refuse a misleading checkpoint.
        if sequence.starts_with("\x1b[")
            && ((sequence.ends_with("\"q") && sequence[2..].contains('"'))
                || (sequence.starts_with("\x1b[?")
                    && (sequence.ends_with('J') || sequence.ends_with('K'))))
        {
            self.compatible = false;
        }
        if let Some(value) = sequence.strip_prefix("\x1b]") {
            let code = value.split(';').next().unwrap_or("");
            let color_query = value.starts_with("10;?") || value.starts_with("11;?");
            if !color_query && !["0", "1", "2", "7", "8", "52", "133", "633"].contains(&code) {
                self.compatible = false;
            }
        }
        let last = sequence.rsplit('\x1b').next().unwrap_or(sequence);
        if last.starts_with('[') && last.ends_with(" q") {
            self.cursor_style = format!("\x1b{last}");
        }
        let terminal_sequence = format!("\x1b{last}");
        let sequence = terminal_sequence.as_str();
        if sequence == "\x1b=" {
            self.keypad = true;
        }
        if sequence == "\x1b>" {
            self.keypad = false;
        }
        if let Some(sequence) = sequence.strip_prefix("\x1b[?") {
            let enabled = sequence.ends_with('h');
            if !enabled && !sequence.ends_with('l') {
                return;
            }
            for code in sequence[..sequence.len() - 1]
                .split(';')
                .filter_map(|value| value.parse::<u16>().ok())
            {
                if [
                    9, 12, 1000, 1002, 1003, 1004, 1005, 1006, 1007, 1015, 1034, 2004, 2026,
                ]
                .contains(&code)
                {
                    if enabled {
                        if [9, 1000, 1002, 1003].contains(&code) {
                            for mode in [9, 1000, 1002, 1003] {
                                self.modes.remove(&mode);
                            }
                        }
                        self.modes.insert(code);
                    } else {
                        self.modes.remove(&code);
                    }
                } else if ![1, 6, 7, 12, 25, 47, 1047, 1048, 1049, 2026, 2031].contains(&code) {
                    self.compatible = false;
                }
            }
        }
    }

    pub fn snapshot(&self, seq: i64) -> Result<TerminalSnapshot> {
        let terminal = self
            .terminal
            .as_ref()
            .filter(|_| self.compatible)
            .ok_or_else(|| Error::Invalid("terminal state cannot be checkpointed yet".into()))?;
        let cursor = terminal.cursor();
        if self.join_width > 0 && !terminal.last_print_succeeded() && cursor.col > 0 {
            let previous = &terminal.line(cursor.row)[cursor.col - 1];
            if previous.char() == ' ' && previous.width() == 1 {
                return Err(Error::Invalid(
                    "terminal state cannot be checkpointed yet".into(),
                ));
            }
        }
        let mut ansi = self.expand_dump(&normalize_xterm_dump(&terminal.dump()), None)?;
        for mode in &self.modes {
            ansi.push_str(&format!("\x1b[?{mode}h"));
        }
        if self.keypad {
            ansi.push_str("\x1b=");
        }
        ansi.push_str(&self.cursor_style);
        ansi.push_str(
            &self.expand_dump(&terminal.reprint_last(self.join_width), self.link.clone())?,
        );
        ansi.push_str(&self.pending);
        if ansi.len() + self.utf8.len() > MAX_SNAPSHOT {
            return Err(Error::Invalid("terminal checkpoint exceeds limit".into()));
        }
        let mut bytes = ansi.into_bytes();
        bytes.extend_from_slice(&self.utf8);
        Ok(TerminalSnapshot {
            seq,
            size: self.size,
            data_b64: STANDARD.encode(bytes),
        })
    }
}

/// avt emits colon truecolor without the optional colour-space field and CTC
/// tab controls. These dump forms are not replayed correctly by xterm.
/// Parse only complete CSI controls emitted by a dump; ordinary text is never
/// rewritten.
fn normalize_xterm_dump(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(b"\x1b[") {
            let start = index;
            index += 2;
            while index < bytes.len()
                && (bytes[index].is_ascii_digit() || bytes[index] == b';' || bytes[index] == b':')
            {
                index += 1;
            }
            if index < bytes.len() {
                let final_byte = bytes[index];
                let params = &source[start + 2..index];
                if !(0x40..=0x7e).contains(&final_byte) {
                    // Unknown intermediates/pending text are not a complete
                    // control we can normalize. Keep UTF-8 boundaries intact.
                    out.push_str(&source[start..index]);
                    continue;
                }
                index += 1;
                if final_byte == b'm' {
                    let fixed = params
                        .split(';')
                        .map(|part| {
                            let fields: Vec<_> = part.split(':').collect();
                            if fields.len() == 5
                                && matches!(fields[0], "38" | "48")
                                && fields[1] == "2"
                                && fields[2..].iter().all(|v| v.parse::<u8>().is_ok())
                            {
                                format!("{};2;{};{};{}", fields[0], fields[2], fields[3], fields[4])
                            } else {
                                part.to_owned()
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(";");
                    out.push_str("\x1b[");
                    out.push_str(&fixed);
                    out.push('m');
                    continue;
                }
                if final_byte == b'W' {
                    match params {
                        "0" | "" => out.push_str("\x1bH"),
                        "2" => out.push_str("\x1b[0g"),
                        "5" => out.push_str("\x1b[3g"),
                        _ => {
                            out.push_str(&source[start..index]);
                        }
                    }
                    continue;
                }
                out.push_str(&source[start..index]);
                continue;
            }
            out.push_str(&source[start..]);
            break;
        }
        let next = source[index..].chars().next().expect("valid UTF-8");
        out.push(next);
        index += next.len_utf8();
    }
    out
}

#[cfg(test)]
mod dump_tests {
    use super::*;

    #[test]
    fn glyph_storage_is_reclaimed_across_buffers_and_long_link_streams() {
        let mut screen = Screen::new(TerminalSize { cols: 24, rows: 8 });
        screen.process("e\u{0301} 👩‍💻 \u{f0000}\u{20000}\x1b[?1049h".as_bytes());
        for index in 0..70_000 {
            screen.process(
                format!("\r\x1b]8;id={index};https://example.com/{index}\x07x\x1b]8;;\x07")
                    .as_bytes(),
            );
            assert!(screen.glyphs.len() <= MAX_GLYPHS);
            assert!(screen.glyph_bytes <= MAX_GLYPH_BYTES);
        }
        screen.process(b"\x1b[?1049l");
        assert!(screen.snapshot(1).is_ok());
        assert!(
            screen
                .visible_tail_text(8)
                .contains("e\u{0301} 👩‍💻 \u{f0000}\u{20000}")
        );
    }

    #[test]
    fn failed_combining_proxy_does_not_advance_cursor() {
        let mut screen = Screen::new(TerminalSize { cols: 24, rows: 8 });
        screen.compatible = false;
        screen.process("e\u{0301}".as_bytes());
        assert_eq!(screen.terminal.as_ref().unwrap().cursor().col, 1);
    }

    #[test]
    fn combining_after_an_ignored_wide_glyph_never_invents_a_checkpoint() {
        let mut screen = Screen::new(TerminalSize { cols: 24, rows: 8 });
        screen.process(format!("\x1b[?7l{}\x1b[1;24H界", "a".repeat(24)).as_bytes());
        assert!(screen.snapshot(1).is_ok());
        screen.process("\u{0301}".as_bytes());
        assert_eq!(screen.cursor_position(), (0, 23));
        assert!(screen.snapshot(2).is_err());
    }

    #[test]
    fn ignored_wide_glyph_after_an_ambiguous_blank_keeps_raw_replay() {
        for before in [
            format!("\x1b[?7l{}中X\x1b[1;24H界", "a".repeat(22)),
            format!("\x1b[?7l{} 界", "a".repeat(22)),
        ] {
            let mut screen = Screen::new(TerminalSize { cols: 24, rows: 8 });
            screen.process(before.as_bytes());
            assert_eq!(screen.cursor_position(), (0, 23));
            assert!(screen.snapshot(1).is_err());
            screen.process(b"Z");
            assert!(screen.snapshot(2).is_ok());
        }
    }

    #[test]
    fn only_complete_dump_controls_are_rewritten() {
        assert_eq!(
            normalize_xterm_dump("x\x1b[38:2:10:20:30my"),
            "x\x1b[38;2;10;20;30my"
        );
        assert_eq!(
            normalize_xterm_dump("\x1b[2W\x1b[5W\x1b[0W"),
            "\x1b[0g\x1b[3g\x1bH"
        );
        assert_eq!(
            normalize_xterm_dump("text 38:2:10:20:30 and \x1b[9W"),
            "text 38:2:10:20:30 and \x1b[9W"
        );
    }
}
