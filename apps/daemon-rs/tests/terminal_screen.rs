use base64::{Engine, engine::general_purpose::STANDARD};
use prosperod_rs::terminal::{TerminalSize, screen::Screen};

#[test]
fn bounded_scrollback_and_pending_controls_do_not_grow_with_stream_length() {
    let mut screen = Screen::new(TerminalSize { cols: 80, rows: 24 });
    for _ in 0..1000 {
        screen.process(b"line\r\nline\r\nline\r\n");
    }
    let snapshot = screen.snapshot(3000).unwrap();
    assert!(snapshot.data_b64.len() < 1_000_000);
    screen.process(b"\x1b]0;");
    screen.process(&vec![b'x'; 65536]);
    assert!(screen.snapshot(3001).is_err());
    screen.process(b"\x07\x1bcreset");
    assert!(
        String::from_utf8(
            STANDARD
                .decode(screen.snapshot(3002).unwrap().data_b64)
                .unwrap()
        )
        .unwrap()
        .contains("reset")
    );
}

#[test]
fn malformed_utf8_is_processed_and_oversized_screens_are_refused() {
    let mut screen = Screen::new(TerminalSize { cols: 80, rows: 24 });
    screen.process(&vec![0xff; 16384]);
    assert!(screen.snapshot(1).is_ok());
    screen.resize(TerminalSize {
        cols: 3000,
        rows: 1000,
    });
    assert!(screen.snapshot(2).is_err());
}

#[test]
fn legal_wide_resize_keeps_snapshot_content() {
    let mut screen = Screen::new(TerminalSize { cols: 80, rows: 24 });
    screen.process(b"before");
    screen.resize(TerminalSize {
        cols: 500,
        rows: 300,
    });
    screen.process(b"wide");
    let snapshot = screen.snapshot(2).unwrap();
    let restored = String::from_utf8(STANDARD.decode(snapshot.data_b64).unwrap()).unwrap();
    assert!(restored.contains("before"));
    assert!(restored.contains("wide"));
}

#[test]
fn snapshot_normalizes_truecolor_and_tab_controls_for_xterm() {
    let mut screen = Screen::new(TerminalSize { cols: 16, rows: 2 });
    screen.process(b"\x1b[38:2:10:20:30mred\x1b[0m\x1b[3g\x1b[5G\x1bH\x1b[1G");
    let ansi = String::from_utf8(
        STANDARD
            .decode(screen.snapshot(7).unwrap().data_b64)
            .unwrap(),
    )
    .unwrap();
    assert!(ansi.contains("\x1b[38;2;10;20;30m"), "{ansi:?}");
    assert!(!ansi.contains("38:2:10:20:30"), "{ansi:?}");
    assert!(ansi.contains("\x1bH"), "{ansi:?}");
    assert!(!ansi.contains('W'), "{ansi:?}");
}

#[test]
fn protected_cells_and_selective_erase_refuse_snapshot() {
    let mut protected = Screen::new(TerminalSize { cols: 16, rows: 2 });
    protected.process(b"\x1b[1\"qprotected");
    assert!(protected.snapshot(8).is_err());

    let mut selective = Screen::new(TerminalSize { cols: 16, rows: 2 });
    selective.process(b"text\x1b[?2K");
    assert!(selective.snapshot(9).is_err());
}
