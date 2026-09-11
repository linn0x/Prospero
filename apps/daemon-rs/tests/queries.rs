use prosperod_rs::database::Store;
use prosperod_rs::error::Error;
use prosperod_rs::protocol::*;
use rusqlite::{Connection, params};
use tempfile::TempDir;

fn create(store: &mut Store, title: &str, workspace: &str) -> SessionHead {
    store
        .create_session(CreateSession {
            agent: AgentKind::Claude,
            kind: SessionKind::Structured,
            title: title.into(),
            workspace: workspace.into(),
        })
        .unwrap()
}

#[test]
fn summaries_are_transactional_durable_and_include_only_active_attention() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    assert_eq!(
        store.session_summary(None).unwrap(),
        SessionSummary::default()
    );
    let a = create(&mut store, "First", "/first");
    create(&mut store, "Second", "/second");
    store
        .update_session(
            &a.id,
            UpdateSession {
                revision: 1,
                title: None,
                lifecycle: None,
                status: Some(SessionStatus::WaitingPermission),
            },
        )
        .unwrap();
    assert_eq!(
        store.session_summary(None).unwrap(),
        SessionSummary {
            total: 2,
            active: 2,
            archived: 0,
            attention: 1,
            latest_seq: 3
        }
    );
    assert_eq!(store.session_summary(Some("/first")).unwrap().attention, 1);
    store
        .update_session(
            &a.id,
            UpdateSession {
                revision: 2,
                title: None,
                lifecycle: Some(SessionLifecycle::Archived),
                status: None,
            },
        )
        .unwrap();
    let expected = SessionSummary {
        total: 2,
        active: 1,
        archived: 1,
        attention: 0,
        latest_seq: 4,
    };
    assert_eq!(store.session_summary(None).unwrap(), expected);
    let connection = Connection::open(directory.path().join("prospero.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_event BEFORE INSERT ON change_events BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    assert!(
        store
            .update_session(
                &a.id,
                UpdateSession {
                    revision: 3,
                    title: Some("Rollback".into()),
                    lifecycle: Some(SessionLifecycle::Active),
                    status: None
                }
            )
            .is_err()
    );
    assert_eq!(store.session_summary(None).unwrap(), expected);
    assert!(
        store
            .sessions(SessionQuery {
                text: Some("Rollback".into()),
                ..Default::default()
            })
            .unwrap()
            .items
            .is_empty()
    );
    assert!(
        store
            .create_session(CreateSession {
                agent: AgentKind::Shell,
                kind: SessionKind::Pty,
                title: "Failed".into(),
                workspace: "/failed".into()
            })
            .is_err()
    );
    assert_eq!(store.session_summary(Some("/failed")).unwrap().total, 0);
    drop(store);
    let reopened = Store::open(directory.path()).unwrap();
    assert_eq!(reopened.session_summary(None).unwrap(), expected);
    assert_eq!(
        reopened
            .workspaces(WorkspaceQuery::default())
            .unwrap()
            .items
            .len(),
        2
    );
}

#[test]
fn search_filters_are_literal_indexed_and_follow_renames() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let a = create(&mut store, "Unicode café 中文测试", "/alpha");
    let b = create(&mut store, "Unicode cafe search", "/beta");
    create(&mut store, "Other", "/alpha");
    let query = SessionQuery {
        text: Some("cafe".into()),
        workspace: Some("/alpha".into()),
        ..Default::default()
    };
    let page = store.sessions(query).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].id, a.id);
    assert_eq!(page.latest_seq, 3);
    for text in ["中", "中文", "UNIC", "café 中文", "\"Unicode\""] {
        let page = store
            .sessions(SessionQuery {
                text: Some(text.into()),
                workspace: Some("/alpha".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.items[0].id, a.id, "{text}");
    }
    let page = store
        .sessions(SessionQuery {
            text: Some("Unicode OR missing".into()),
            ..Default::default()
        })
        .unwrap();
    assert!(page.items.is_empty());
    store
        .update_session(
            &b.id,
            UpdateSession {
                revision: 1,
                title: Some("Renamed".into()),
                lifecycle: Some(SessionLifecycle::Archived),
                status: None,
            },
        )
        .unwrap();
    let page = store
        .sessions(SessionQuery {
            text: Some("Unicode".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page.total, 1);
    let page = store
        .sessions(SessionQuery {
            text: Some("ren".into()),
            lifecycle: Some(SessionLifecycle::Archived),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page.items[0].id, b.id);
    assert_eq!(page.total, 1);
    let connection = Connection::open(directory.path().join("prospero.sqlite")).unwrap();
    let plan: String = connection
        .query_row(
            "EXPLAIN QUERY PLAN SELECT rowid FROM session_search WHERE session_search MATCH ?",
            ["unicode*"],
            |row| row.get(3),
        )
        .unwrap();
    assert!(plan.contains("VIRTUAL TABLE INDEX"), "{plan}");
    let plan: String = connection.query_row("EXPLAIN QUERY PLAN SELECT payload FROM session_heads WHERE workspace=?1 AND lifecycle=?2 AND (created_at,id)<(?3,?4) ORDER BY created_at DESC,id DESC LIMIT 100", params!["/alpha", "active", 999, "id"], |row| row.get(3)).unwrap();
    assert!(
        plan.contains("SEARCH session_heads USING INDEX session_workspace_lifecycle_page"),
        "{plan}"
    );
}

#[test]
fn workspace_and_filtered_pages_are_bounded_and_cursors_bind_filters() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    for i in 0..5 {
        create(&mut store, &format!("Query {i}"), "/alpha");
    }
    create(&mut store, "Query", "/beta");
    let query = SessionQuery {
        limit: Some(2),
        workspace: Some("/alpha".into()),
        text: Some("Query".into()),
        ..Default::default()
    };
    let mut cursor = None;
    let mut ids = Vec::new();
    loop {
        let page = store
            .sessions(SessionQuery {
                cursor,
                ..query.clone()
            })
            .unwrap();
        assert_eq!(page.total, 5);
        assert!(page.items.len() <= 2);
        ids.extend(page.items.into_iter().map(|head| head.id));
        cursor = page.next_cursor;
        if !page.has_more {
            break;
        }
        for different in [
            SessionQuery {
                workspace: Some("/beta".into()),
                ..query.clone()
            },
            SessionQuery {
                text: Some("other".into()),
                ..query.clone()
            },
        ] {
            assert!(matches!(
                store.sessions(SessionQuery {
                    cursor: cursor.clone(),
                    ..different
                }),
                Err(Error::Invalid(_))
            ));
        }
    }
    assert_eq!(ids.len(), 5);
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        5
    );
    let page = store
        .workspaces(WorkspaceQuery {
            limit: Some(1),
            cursor: None,
        })
        .unwrap();
    assert_eq!(page.items[0].workspace, "/alpha");
    assert_eq!(page.items[0].summary.total, 5);
    assert!(page.has_more);
    let page = store
        .workspaces(WorkspaceQuery {
            limit: Some(1),
            cursor: page.next_cursor,
        })
        .unwrap();
    assert_eq!(page.items[0].workspace, "/beta");
    assert!(!page.has_more);
    assert_eq!(store.session_summary(Some("/absent")).unwrap().total, 0);
}

#[test]
fn lookup_preserves_requested_order_deduplicates_and_reports_missing() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let a = create(&mut store, "First", "/alpha");
    let b = create(&mut store, "Second", "/alpha");
    let result = store
        .lookup_sessions(SessionLookup {
            ids: vec![b.id.clone(), "missing".into(), a.id.clone(), b.id.clone()],
        })
        .unwrap();
    assert_eq!(
        result.items.iter().map(|item| &item.id).collect::<Vec<_>>(),
        vec![&b.id, &a.id]
    );
    assert_eq!(result.missing_ids, vec!["missing"]);
    assert_eq!(result.latest_seq, 2);
    for ids in [vec!["invalid/id".into()], vec![a.id; 101]] {
        assert!(matches!(
            store.lookup_sessions(SessionLookup { ids }),
            Err(Error::Invalid(_))
        ));
    }
    assert!(
        store
            .lookup_sessions(SessionLookup { ids: vec![] })
            .unwrap()
            .items
            .is_empty()
    );
    for text in ["*", "\n", &"x".repeat(257)] {
        assert!(matches!(
            store.sessions(SessionQuery {
                text: Some(text.into()),
                ..Default::default()
            }),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn common_search_walks_ordered_pages_without_returning_nonmatches() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let mut expected = Vec::new();
    for index in 0..100 {
        let matches = index % 5 != 0;
        let head = create(
            &mut store,
            if matches { "Common" } else { "Other" },
            "/synthetic",
        );
        if matches {
            expected.push(head);
        }
    }
    expected.sort_by(|a, b| (b.created_at, &b.id).cmp(&(a.created_at, &a.id)));
    for workspace in [None, Some("/synthetic".to_owned())] {
        let mut cursor = None;
        let mut items = Vec::new();
        loop {
            let page = store
                .sessions(SessionQuery {
                    cursor,
                    limit: Some(7),
                    text: Some("Common".into()),
                    workspace: workspace.clone(),
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(page.total, 80);
            items.extend(page.items);
            if !page.has_more {
                break;
            }
            cursor = page.next_cursor;
        }
        assert_eq!(items, expected);
    }
}

#[test]
fn workspace_pages_enforce_the_byte_budget_for_escaped_names() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    for index in 0..200 {
        create(
            &mut store,
            "Example",
            &format!("/{index:03}{}", "\"".repeat(3500)),
        );
    }
    let page = store
        .workspaces(WorkspaceQuery {
            limit: Some(200),
            cursor: None,
        })
        .unwrap();
    assert!(page.has_more);
    assert!(page.items.len() < 200);
    assert!(serde_json::to_vec(&page.items).unwrap().len() < MAX_PAGE_BYTES + 201);
    let next = store
        .workspaces(WorkspaceQuery {
            limit: Some(200),
            cursor: page.next_cursor,
        })
        .unwrap();
    assert!(!next.has_more);
    assert_eq!(page.items.len() + next.items.len(), 200);
}

#[test]
fn session_cursors_round_trip_long_escaped_workspace_filters() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let workspace = format!("/{}", "\"".repeat(3500));
    create(&mut store, "First", &workspace);
    create(&mut store, "Second", &workspace);
    let query = SessionQuery {
        limit: Some(1),
        workspace: Some(workspace),
        ..Default::default()
    };
    let first = store.sessions(query.clone()).unwrap();
    assert!(first.has_more);
    let second = store
        .sessions(SessionQuery {
            cursor: first.next_cursor,
            ..query
        })
        .unwrap();
    assert!(!second.has_more);
    assert_eq!(second.total, 2);
    assert_ne!(first.items[0].id, second.items[0].id);
}
