use prosperod_rs::database::Store;
use prosperod_rs::error::Error;
use prosperod_rs::protocol::*;
use rusqlite::Connection;
use tempfile::TempDir;

fn session(store: &mut Store) -> String {
    store
        .create_session(CreateSession {
            agent: AgentKind::Codex,
            kind: SessionKind::Structured,
            title: "Example".into(),
            workspace: "/synthetic".into(),
        })
        .unwrap()
        .id
}

fn write(id: &str, revision: i64, text: &str) -> TimelineWrite {
    TimelineWrite {
        id: id.into(),
        turn_id: "turn".into(),
        expected_revision: revision,
        body: TimelineBody::Message {
            role: MessageRole::Assistant,
            final_answer: true,
        },
        text: text.into(),
        replace: false,
    }
}

#[test]
fn records_and_body_commit_together_and_survive_reopen() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let id = session(&mut store);
    let first = store
        .write_timeline(&id, write("message", 0, "Hello"))
        .unwrap();
    let second = store
        .write_timeline(&id, write("message", 1, " world"))
        .unwrap();
    assert_eq!(first.position, second.position);
    assert_eq!(second.preview, "Hello world");
    assert_eq!(second.revision, 2);
    assert_eq!(second.generation, 1);
    assert!(matches!(
        store.write_timeline(&id, write("message", 1, "stale")),
        Err(Error::Conflict)
    ));
    let events = store.events(&format!("timeline:{id}"), 0, 100).unwrap();
    assert_eq!(events.latest_seq, 2);
    assert_eq!(events.items[1].data["revision"], 2);
    assert!(!serde_json::to_string(&events).unwrap().contains("Hello"));
    drop(store);
    let store = Store::open(directory.path()).unwrap();
    assert_eq!(store.timeline_record(&id, "message").unwrap(), second);
    assert_eq!(
        store
            .timeline_text(&id, "message", TimelineTextQuery::default())
            .unwrap()
            .text,
        "Hello world"
    );
}

#[test]
fn unicode_body_pages_are_lossless_and_small_appends_share_chunks() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let id = session(&mut store);
    let fragment = "中🦀\n".repeat(7000);
    for revision in 0..11 {
        store
            .write_timeline(&id, write("message", revision, &fragment))
            .unwrap();
    }
    let expected = fragment.repeat(11);
    let mut joined = String::new();
    let mut part = 0;
    loop {
        let page = store
            .timeline_text(
                &id,
                "message",
                TimelineTextQuery {
                    part: Some(part),
                    generation: Some(1),
                },
            )
            .unwrap();
        assert!(page.text.len() <= CONTENT_CHUNK_BYTES + 3);
        assert_eq!(page.previous_part, part.checked_sub(1));
        joined.push_str(&page.text);
        match page.next_part {
            Some(next) => part = next,
            None => break,
        }
    }
    assert_eq!(joined, expected);
    let page = store.timeline(&id, TimelineQuery::default()).unwrap();
    assert_eq!(page.items.len(), 1);
    assert!(page.items[0].truncated);
    assert!(page.items[0].preview.len() <= 4096);
    assert!(serde_json::to_vec(&page).unwrap().len() < 10000);
    let connection = Connection::open(directory.path().join("prospero.sqlite")).unwrap();
    let chunks: i64 = connection
        .query_row(
            "SELECT count(*) FROM content_chunks WHERE content_id='message'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(chunks, expected.len().div_ceil(CONTENT_CHUNK_BYTES) as i64);
    for revision in 0..100 {
        store
            .write_timeline(&id, write("tiny", revision, "🦀"))
            .unwrap();
    }
    let chunks: i64 = connection
        .query_row(
            "SELECT count(*) FROM content_chunks WHERE content_id='tiny'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(chunks, 1);
}

#[test]
fn replacement_invalidates_old_body_cursors_and_preserves_position() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let id = session(&mut store);
    store
        .write_timeline(&id, write("message", 0, &"x".repeat(CONTENT_CHUNK_BYTES)))
        .unwrap();
    store
        .write_timeline(&id, write("message", 1, "tail"))
        .unwrap();
    let mut replacement = write("message", 2, "New authoritative text");
    replacement.replace = true;
    let updated = store.write_timeline(&id, replacement).unwrap();
    assert_eq!(updated.position, 1);
    assert_eq!(updated.generation, 2);
    assert!(matches!(
        store.timeline_text(
            &id,
            "message",
            TimelineTextQuery {
                generation: Some(1),
                part: Some(1)
            }
        ),
        Err(Error::Conflict)
    ));
    let body = store
        .timeline_text(&id, "message", TimelineTextQuery::default())
        .unwrap();
    assert_eq!(body.text, "New authoritative text");
    assert!(body.next_part.is_none());
    assert!(
        store
            .timeline_text(
                &id,
                "message",
                TimelineTextQuery {
                    part: Some(u32::MAX),
                    generation: None
                }
            )
            .is_err()
    );
}

#[test]
fn event_failure_rolls_back_content_metadata_and_position() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let id = session(&mut store);
    let original = store
        .write_timeline(&id, write("message", 0, "Original"))
        .unwrap();
    let connection = Connection::open(directory.path().join("prospero.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_event BEFORE INSERT ON change_events BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    let mut update = write("message", 1, "Replaced");
    update.replace = true;
    assert!(store.write_timeline(&id, update).is_err());
    assert!(
        store
            .write_timeline(&id, write("another", 0, "new"))
            .is_err()
    );
    assert_eq!(store.timeline_record(&id, "message").unwrap(), original);
    assert_eq!(
        store
            .timeline_text(&id, "message", TimelineTextQuery::default())
            .unwrap()
            .text,
        "Original"
    );
    let page = store.timeline(&id, TimelineQuery::default()).unwrap();
    assert_eq!(page.latest_position, 1);
    assert_eq!(page.revision, 1);
    assert!(store.timeline_record(&id, "another").is_err());
}

#[test]
fn retained_history_is_pageable_after_change_events_expire() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let head = store.seed_conversation(2600).unwrap();
    let latest = store.timeline(&head.id, TimelineQuery::default()).unwrap();
    assert_eq!(latest.items.len(), 40);
    assert_eq!(latest.items[0].position, 10361);
    assert!(latest.newer.is_none());
    assert!(latest.older.is_some());
    assert!(
        store
            .events(&format!("timeline:{}", head.id), 0, 100)
            .unwrap()
            .resync_required
    );
    let oldest = store
        .timeline(
            &head.id,
            TimelineQuery {
                before: Some(5),
                after: None,
                limit: Some(40),
            },
        )
        .unwrap();
    assert_eq!(oldest.items.len(), 4);
    assert_eq!(oldest.items[0].position, 1);
    assert!(oldest.older.is_none());
    assert_eq!(oldest.newer, Some(4));
    let newer = store
        .timeline(
            &head.id,
            TimelineQuery {
                after: oldest.newer,
                before: None,
                limit: Some(4),
            },
        )
        .unwrap();
    assert_eq!(newer.items[0].position, 5);
    assert_eq!(newer.items[3].position, 8);
    assert!(
        store
            .timeline(
                &head.id,
                TimelineQuery {
                    before: Some(10),
                    after: Some(2),
                    limit: None
                }
            )
            .is_err()
    );
}

#[test]
fn lookups_and_writes_preserve_session_and_record_identity() {
    assert!(serde_json::from_value::<TimelineBody>(serde_json::json!({"kind":"message","role":"assistant","finalAnswer":true,"unexpected":"field"})).is_err());
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let a = session(&mut store);
    let b = session(&mut store);
    store
        .write_timeline(&a, write("message", 0, "Private to A"))
        .unwrap();
    assert!(
        store
            .timeline_lookup(&b, vec!["message".into()])
            .unwrap()
            .items
            .is_empty()
    );
    assert!(
        store
            .timeline_text(&b, "message", TimelineTextQuery::default())
            .is_err()
    );
    assert!(store.timeline_lookup("missing", vec![]).is_err());
    assert!(
        store
            .timeline_lookup(&a, vec!["message".into(); 41])
            .is_err()
    );
    let mut changed = write("message", 1, "Wrong role");
    changed.body = TimelineBody::Message {
        role: MessageRole::User,
        final_answer: false,
    };
    assert!(store.write_timeline(&a, changed).is_err());
    let mut changed = write("message", 1, "Wrong turn");
    changed.turn_id = "other".into();
    assert!(store.write_timeline(&a, changed).is_err());
    assert!(
        store
            .write_timeline(
                &a,
                write("oversized", 0, &"x".repeat(CONTENT_CHUNK_BYTES + 1))
            )
            .is_err()
    );
    assert_eq!(
        store
            .timeline_lookup(&a, vec!["message".into(), "message".into()])
            .unwrap()
            .items
            .len(),
        1
    );
}
