#![cfg(unix)]

use portable_pty::CommandBuilder;
use prosperod_rs::terminal::{Terminal, TerminalSize, spawn};

fn terminal() -> Terminal {
    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", "sleep 5"]);
    spawn(command, TerminalSize { cols: 80, rows: 24 }).expect("spawn PTY")
}

#[test]
fn inner_lease_claim_takeover_release_and_legacy_gate() {
    let terminal = terminal();
    let same_handle = terminal.clone();
    let epoch = terminal.epoch().to_owned();

    assert!(terminal.legacy_control_allowed().unwrap());
    assert!(terminal.acquire_controller("first", false).unwrap());
    assert_eq!(same_handle.controller().unwrap().as_deref(), Some("first"));
    assert!(!same_handle.legacy_control_allowed().unwrap());

    // An observer may not steal a free-form control lease.
    assert!(!same_handle.acquire_controller("second", false).unwrap());
    assert_eq!(terminal.controller().unwrap().as_deref(), Some("first"));

    // Explicit takeover revokes the first owner.  Its later release must not
    // accidentally clear the replacement lease.
    assert!(same_handle.acquire_controller("second", true).unwrap());
    assert!(!terminal.release_controller("first").unwrap());
    assert_eq!(terminal.controller().unwrap().as_deref(), Some("second"));
    assert!(!terminal.legacy_control_allowed().unwrap());

    assert!(terminal.release_controller("second").unwrap());
    assert!(same_handle.controller().unwrap().is_none());
    assert!(same_handle.legacy_control_allowed().unwrap());
    assert_eq!(terminal.epoch(), epoch);
    assert_eq!(same_handle.epoch(), epoch);

    terminal.stop();
}
