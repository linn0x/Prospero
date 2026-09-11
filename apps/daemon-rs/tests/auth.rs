use prosperod_rs::auth::Token;
use tempfile::TempDir;

#[test]
fn local_token_persists_and_connection_file_contains_matching_metadata() {
    let directory = TempDir::new().unwrap();
    let token = Token::load(directory.path()).unwrap();
    let secret = std::fs::read_to_string(directory.path().join("local.token")).unwrap();
    assert!(token.accepts(&format!("Bearer {secret}")));
    assert!(!token.accepts(&format!("Basic {secret}")));
    assert!(!token.accepts("Bearer invalid"));
    assert!(
        Token::load(directory.path())
            .unwrap()
            .accepts(&format!("Bearer {secret}"))
    );
    token
        .publish(directory.path(), "http://127.0.0.1:12345")
        .unwrap();
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.path().join("connection.json")).unwrap())
            .unwrap();
    assert_eq!(value["pid"], std::process::id());
    assert_eq!(value["token"], secret);
}

#[cfg(unix)]
#[test]
fn token_symlinks_and_public_permissions_are_rejected() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let directory = TempDir::new().unwrap();
    let target = directory.path().join("original");
    std::fs::write(&target, "a".repeat(64)).unwrap();
    symlink(&target, directory.path().join("local.token")).unwrap();
    assert!(Token::load(directory.path()).is_err());
    std::fs::remove_file(directory.path().join("local.token")).unwrap();
    Token::load(directory.path()).unwrap();
    assert_eq!(
        std::fs::metadata(directory.path().join("local.token"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    std::fs::set_permissions(
        directory.path().join("local.token"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(Token::load(directory.path()).is_err());
}
