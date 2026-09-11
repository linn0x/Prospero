use base64::{Engine, engine::general_purpose::STANDARD};
use prosperod_rs::terminal::{TerminalSize, screen::Screen};

#[test]
fn bounded_scrollback_and_pending_controls_do_not_grow_with_stream_length() {
    let mut screen = Screen::new(TerminalSize { cols: 80, rows: 24 });
    for _ in 0..1000 {
        screen.process(b"line\r\nline\r\nline\r\n");
    }
    let snapshot = screen.snapshot(3000).unwrap();
    assert!(snapshot.data_b64.len() < 100_000);
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
        cols: 500,
        rows: 300,
    });
    assert!(screen.snapshot(2).is_err());
}
