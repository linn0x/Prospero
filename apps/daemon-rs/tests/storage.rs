use prosperod_rs::database::Store;
use prosperod_rs::error::Error;
use prosperod_rs::protocol::*;
use rusqlite::{Connection, params};
use tempfile::TempDir;

fn create(store: &mut Store) -> SessionHead {
    store
        .create_session(CreateSession {
            agent: AgentKind::Codex,
            title: "Example".into(),
            workspace: "/synthetic".into(),
        })
        .unwrap()
}

#[test]
fn session_and_event_commit_together_and_survive_reopen() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let head = create(&mut store);
    let events = store.events("sessions", 0, 100).unwrap();
    assert_eq!(events.latest_seq, 1);
    assert_eq!(events.items[0].entity_id, head.id);
    let updated = store
        .update_session(
            &head.id,
            UpdateSession {
                revision: 1,
                title: Some("Updated".into()),
                lifecycle: Some(SessionLifecycle::Archived),
                status: Some(SessionStatus::Completed),
            },
        )
        .unwrap();
    assert_eq!(updated.revision, 2);
    assert!(matches!(
        store.update_session(
            &head.id,
            UpdateSession {
                revision: 1,
                title: None,
                lifecycle: None,
                status: None
            }
        ),
        Err(Error::Conflict)
    ));
    assert_eq!(store.events("sessions", 0, 100).unwrap().latest_seq, 2);
    drop(store);
    let mut reopened = Store::open(directory.path()).unwrap();
    assert_eq!(reopened.session(&head.id).unwrap(), updated);
    assert_eq!(reopened.events("sessions", 1, 100).unwrap().items.len(), 1);
    assert_eq!(reopened.check().unwrap(), "ok");
}

#[test]
fn data_directory_has_one_writer() {
    let directory = TempDir::new().unwrap();
    let store = Store::open(directory.path()).unwrap();
    assert!(matches!(
        Store::open(directory.path()),
        Err(Error::AlreadyRunning)
    ));
    drop(store);
    assert!(Store::open(directory.path()).is_ok());
}

#[test]
fn keyset_pages_cover_archives_without_duplicates_and_use_index() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    store.seed_archives(1000).unwrap();
    let mut cursor = None;
    let mut ids = Vec::new();
    loop {
        let page = store
            .sessions(SessionQuery {
                cursor,
                limit: Some(73),
                lifecycle: Some(SessionLifecycle::Archived),
            })
            .unwrap();
        assert!(page.items.len() <= 73);
        ids.extend(page.items.into_iter().map(|head| head.id));
        cursor = page.next_cursor;
        if !page.has_more {
            break;
        }
        assert!(cursor.is_some());
    }
    assert_eq!(ids.len(), 1000);
    assert_eq!(ids[0], "session-000000999");
    assert_eq!(ids[999], "session-000000000");
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        ids.len()
    );
    let connection = Connection::open(directory.path().join("prospero.sqlite")).unwrap();
    let plan: String = connection.query_row("EXPLAIN QUERY PLAN SELECT payload FROM session_heads WHERE lifecycle=?1 AND (created_at,id)<(?2,?3) ORDER BY created_at DESC,id DESC LIMIT 101", params!["archived", 999, "session-000000998"], |r| r.get(3)).unwrap();
    assert!(
        plan.contains("SEARCH session_heads USING INDEX session_lifecycle_page"),
        "{plan}"
    );
    assert_eq!(store.events("sessions", 0, 100).unwrap().latest_seq, 0);
}

#[test]
fn cursors_cannot_change_filter_or_skip_validation() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    store.seed_archives(3).unwrap();
    let page = store
        .sessions(SessionQuery {
            limit: Some(1),
            lifecycle: Some(SessionLifecycle::Archived),
            cursor: None,
        })
        .unwrap();
    assert!(matches!(
        store.sessions(SessionQuery {
            limit: Some(1),
            cursor: page.next_cursor,
            lifecycle: None
        }),
        Err(Error::Invalid(_))
    ));
    for cursor in ["not-json".to_owned(), "x".repeat(513)] {
        assert!(matches!(
            store.sessions(SessionQuery {
                cursor: Some(cursor),
                ..Default::default()
            }),
            Err(Error::Invalid(_))
        ));
    }
    for limit in [0, 201] {
        assert!(
            store
                .sessions(SessionQuery {
                    limit: Some(limit),
                    ..Default::default()
                })
                .is_err()
        );
    }
}

#[test]
fn large_bodies_are_chunked_and_absent_from_session_metadata() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let head = create(&mut store);
    let chunk = vec![0xf0; CONTENT_CHUNK_BYTES];
    for index in 0..20 {
        assert_eq!(
            store
                .append_content(
                    &head.id,
                    "output",
                    index * CONTENT_CHUNK_BYTES as i64,
                    &chunk
                )
                .unwrap(),
            (index + 1) * CONTENT_CHUNK_BYTES as i64
        );
    }
    assert_eq!(
        store.content(&head.id, "output", 0).unwrap(),
        chunk.repeat(16)
    );
    assert_eq!(
        store
            .content(&head.id, "output", MAX_PAGE_BYTES as i64)
            .unwrap(),
        chunk.repeat(4)
    );
    assert!(matches!(
        store.append_content(&head.id, "output", 0, &chunk),
        Err(Error::Conflict)
    ));
    assert!(store.content(&head.id, "output", 1).is_err());
    assert!(
        store
            .append_content(&head.id, "output", -1, &chunk)
            .is_err()
    );
    assert!(
        store
            .append_content(&head.id, "output", 0, &vec![0; CONTENT_CHUNK_BYTES + 1])
            .is_err()
    );
    assert!(
        serde_json::to_vec(&store.sessions(SessionQuery::default()).unwrap())
            .unwrap()
            .len()
            < 1024
    );
    assert_eq!(store.events("sessions", 0, 100).unwrap().latest_seq, 1);
}

#[test]
fn failed_event_write_rolls_back_the_session_update() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let head = create(&mut store);
    let connection = Connection::open(directory.path().join("prospero.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_event BEFORE INSERT ON change_events BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    assert!(
        store
            .update_session(
                &head.id,
                UpdateSession {
                    revision: 1,
                    title: Some("Must rollback".into()),
                    lifecycle: None,
                    status: None
                }
            )
            .is_err()
    );
    assert_eq!(store.session(&head.id).unwrap(), head);
    assert_eq!(store.events("sessions", 0, 100).unwrap().latest_seq, 1);
}

#[test]
fn retention_gaps_require_resynchronization() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let head = create(&mut store);
    let connection = Connection::open(directory.path().join("prospero.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE stream_heads SET last_seq=?1 WHERE scope='sessions'",
            [EVENT_RETENTION],
        )
        .unwrap();
    store
        .update_session(
            &head.id,
            UpdateSession {
                revision: 1,
                title: None,
                lifecycle: None,
                status: None,
            },
        )
        .unwrap();
    let gap = store.events("sessions", 0, 100).unwrap();
    assert!(gap.resync_required);
    assert_eq!(gap.floor_seq, 1);
    assert!(gap.items.is_empty());
    assert!(store.events("sessions", gap.latest_seq + 1, 100).is_err());
    assert!(store.events("sessions", -1, 100).is_err());
}

#[test]
fn old_data_directories_and_unknown_schemas_are_not_modified() {
    let directory = TempDir::new().unwrap();
    std::fs::write(directory.path().join("orchestration.json"), "fixture").unwrap();
    assert!(Store::open(directory.path()).is_err());
    assert!(!directory.path().join("prospero.sqlite").exists());
    let other = TempDir::new().unwrap();
    let connection = Connection::open(other.path().join("prospero.sqlite")).unwrap();
    connection
        .execute_batch("CREATE TABLE unrelated(id TEXT);")
        .unwrap();
    assert!(matches!(Store::open(other.path()), Err(Error::Schema)));
    assert!(connection.prepare("SELECT * FROM unrelated").is_ok());
}

#[cfg(unix)]
#[test]
fn database_symlinks_are_rejected_and_files_are_private() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let directory = TempDir::new().unwrap();
    let target = directory.path().join("target");
    std::fs::write(&target, "preserve").unwrap();
    symlink(&target, directory.path().join("prospero.sqlite")).unwrap();
    assert!(Store::open(directory.path()).is_err());
    assert_eq!(std::fs::read_to_string(target).unwrap(), "preserve");
    let other = TempDir::new().unwrap();
    let _store = Store::open(other.path()).unwrap();
    assert_eq!(
        std::fs::metadata(other.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(other.path().join("prospero.sqlite"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}
