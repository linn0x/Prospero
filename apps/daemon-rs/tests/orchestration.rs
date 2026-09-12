//! Stage 7 acceptance tests: indexed readiness, idempotent dispatch, gates,
//! collaboration messages and set-based crash recovery.

use prosperod_rs::database::Store;
use prosperod_rs::error::Error;
use prosperod_rs::orchestration::{
    ApplyTaskGraph, CreateGate, CreateRunGraph, DispatchState, GateStatus, GraphNodeInput,
    MarkMessages, MessageType, PostMessage, RunStatus, TaskStatus, can_transition, find_cycle,
};
use prosperod_rs::protocol::{
    AgentKind, CreateSession, SessionKind, SessionLifecycle, UpdateSession,
};
use rusqlite::params;
use std::collections::HashMap;
use tempfile::TempDir;

fn node(client_id: &str, deps: &[&str]) -> GraphNodeInput {
    GraphNodeInput {
        client_id: client_id.into(),
        title: format!("Task {client_id}"),
        spec: format!("do {client_id}"),
        skills: vec![],
        deps: deps.iter().map(|value| (*value).to_owned()).collect(),
        parent_id: None,
    }
}

fn chain(count: usize) -> Vec<GraphNodeInput> {
    (0..count)
        .map(|index| {
            if index == 0 {
                node(&format!("n{index}"), &[])
            } else {
                node(&format!("n{index}"), &[&format!("n{}", index - 1)])
            }
        })
        .collect()
}

fn make_run(
    store: &mut Store,
    op: &str,
    nodes: Vec<GraphNodeInput>,
) -> (String, HashMap<String, String>) {
    let result = store
        .create_run_graph(CreateRunGraph {
            objective: "prove the DAG".into(),
            nodes,
            coordinator_session_id: None,
            operation_id: op.into(),
        })
        .unwrap();
    (result.run.id, result.id_map)
}

fn ready(store: &mut Store, run_id: &str) -> Vec<String> {
    store.run_snapshot(run_id).unwrap().ready
}

fn raw(directory: &TempDir) -> rusqlite::Connection {
    let connection = rusqlite::Connection::open(directory.path().join("prospero.sqlite")).unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    connection
}

#[test]
fn readiness_is_derived_through_the_reverse_dep_index_without_stored_state() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (run_id, ids) = make_run(&mut store, "op-graph-chain", chain(4));

    // Only the root is ready; nothing was precomputed at write time.
    assert_eq!(ready(&mut store, &run_id), vec![ids["n0"].clone()]);

    // Settling one task reads only its dependents (orch_deps_dep) and flips
    // exactly the next task — no graph-wide rescan, no missed transition.
    let first = store
        .dispatch_task(&ids["n0"], "sess-root-0001", None, None)
        .unwrap();
    store
        .settle_dispatch(&first.dispatch.id, true, "done")
        .unwrap();
    assert_eq!(ready(&mut store, &run_id), vec![ids["n1"].clone()]);

    let second = store
        .dispatch_task(&ids["n1"], "sess-next-0002", None, None)
        .unwrap();
    store
        .settle_dispatch(&second.dispatch.id, true, "done")
        .unwrap();
    assert_eq!(ready(&mut store, &run_id), vec![ids["n2"].clone()]);

    // A cancelled dependency deliberately does NOT satisfy the edge: n4 can
    // never become ready through a cancelled n3/n2 chain.
    let extra = store
        .apply_task_graph(ApplyTaskGraph {
            run_id: run_id.clone(),
            base_revision: 1,
            nodes: vec![GraphNodeInput {
                client_id: "n4".into(),
                title: "Task n4".into(),
                spec: "do n4".into(),
                skills: vec![],
                // Edits reference existing tasks by their durable id.
                deps: vec![ids["n3"].clone()],
                parent_id: None,
            }],
            delete_task_ids: vec![],
            operation_id: Some("op-add-n4".into()),
        })
        .unwrap();
    assert_eq!(extra.run.graph_revision, 2);
    store
        .cancel_task(&ids["n2"], "premise disappeared")
        .unwrap();
    // n3 depended on n2 and is now unreachable; nothing is ready.
    assert!(ready(&mut store, &run_id).is_empty());
    let tasks = store.list_tasks(Some(&run_id)).unwrap();
    let n4 = tasks
        .iter()
        .find(|task| task.id == extra.id_map["n4"])
        .unwrap();
    // n4 is still pending — it was never wrongly dispatched nor cancelled.
    assert_eq!(n4.status, TaskStatus::Pending);
}

#[test]
fn wide_graph_makes_every_independent_root_ready_without_a_full_scan() {
    // 200 is the per-edit ceiling: a wide fan-out proves the indexed anti-join
    // returns every independent root together.
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let mut nodes: Vec<GraphNodeInput> = (0..199)
        .map(|index| node(&format!("leaf{index:03}"), &[]))
        .collect();
    nodes.push(GraphNodeInput {
        client_id: "join".into(),
        title: "Join".into(),
        spec: "wait for all leaves".into(),
        skills: vec![],
        deps: (0..199).map(|index| format!("leaf{index:03}")).collect(),
        parent_id: None,
    });
    let (run_id, ids) = make_run(&mut store, "op-graph-wide", nodes);

    let mut expected: Vec<String> = (0..199)
        .map(|index| ids[&format!("leaf{index:03}")].clone())
        .collect();
    expected.sort();
    let mut actual = ready(&mut store, &run_id);
    actual.sort();
    assert_eq!(actual, expected);

    // The join flips ready in a single derived query after the last leaf.
    for index in 0..199usize {
        let leaf_id = ids[&format!("leaf{index:03}")].clone();
        let outcome = store
            .dispatch_task(&leaf_id, &format!("sess-leaf-{index:03}xx"), None, None)
            .unwrap();
        store
            .settle_dispatch(&outcome.dispatch.id, true, "ok")
            .unwrap();
    }
    assert_eq!(ready(&mut store, &run_id), vec![ids["join"].clone()]);
}

#[test]
fn live_dispatch_is_unique_even_against_retries_and_raw_races() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (run_id, ids) = make_run(&mut store, "op-graph-dup", chain(2));

    let outcome = store
        .dispatch_task(&ids["n0"], "sess-dup-00001", Some("op-start-1"), None)
        .unwrap();
    assert_eq!(outcome.task.status, TaskStatus::Dispatched);
    assert_eq!(outcome.dispatch.state, DispatchState::Starting);

    // A second live dispatch is rejected at the write boundary.
    let duplicate = store.dispatch_task(&ids["n0"], "sess-dup-00002", None, None);
    assert!(matches!(duplicate, Err(Error::Invalid(_))));

    // The partial unique index is the hard guarantee even if a future code
    // path bypasses the boundary check.
    let connection = raw(&directory);
    let raw_result = connection.execute(
        "INSERT INTO orch_dispatches(id,run_id,task_id,session_id,state,started_at) \
         VALUES('disp-race-001',?1,?2,'sess-raw-00001','starting',0)",
        params![run_id, ids["n0"]],
    );
    assert!(raw_result.is_err());
    drop(connection);

    // Retrying the SAME operation id with the SAME payload replays the frozen
    // first dispatch instead of creating another.
    let replay = store
        .dispatch_task(&ids["n0"], "sess-dup-00001", Some("op-start-1"), None)
        .unwrap();
    assert_eq!(replay.dispatch.id, outcome.dispatch.id);
    assert_eq!(store.list_dispatches(Some(&run_id)).unwrap().len(), 1);

    // Same operation id, different payload is rejected, never a silent redo.
    let reused = store.dispatch_task(&ids["n0"], "sess-dup-00099", Some("op-start-1"), None);
    assert!(matches!(reused, Err(Error::Invalid(_))));
}

#[test]
fn dispatch_boundary_rechecks_readiness_and_state_machine() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (_run_id, ids) = make_run(&mut store, "op-graph-bound", chain(2));

    // n1 has an unmet dependency.
    assert!(matches!(
        store.dispatch_task(&ids["n1"], "sess-early-0001", None, None),
        Err(Error::Invalid(_))
    ));
    // A done task never dispatches again.
    let outcome = store
        .dispatch_task(&ids["n0"], "sess-done-00001", None, None)
        .unwrap();
    store
        .settle_dispatch(&outcome.dispatch.id, true, "done")
        .unwrap();
    assert!(matches!(
        store.dispatch_task(&ids["n0"], "sess-again-0001", None, None),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn task_and_dispatch_settle_atomically_and_failure_can_retry() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (run_id, ids) = make_run(&mut store, "op-graph-settle", chain(1));
    let outcome = store
        .dispatch_task(&ids["n0"], "sess-atom-00001", None, None)
        .unwrap();
    let settled = store
        .settle_dispatch(&outcome.dispatch.id, false, "boom")
        .unwrap();
    assert_eq!(settled.task.status, TaskStatus::Failed);
    assert_eq!(settled.task.result.as_deref(), Some("boom"));
    assert_eq!(settled.dispatch.state, DispatchState::Failed);

    // A settled dispatch cannot be settled twice.
    assert!(matches!(
        store.settle_dispatch(&outcome.dispatch.id, true, "late"),
        Err(Error::Invalid(_))
    ));

    // Failed → pending via retry clears the result and re-queues the task.
    let retried = store.retry_task(&ids["n0"]).unwrap();
    assert_eq!(retried.status, TaskStatus::Pending);
    assert_eq!(retried.result, None);
    assert_eq!(ready(&mut store, &run_id), vec![ids["n0"].clone()]);
}

#[test]
fn gates_park_tasks_and_resolve_with_or_without_live_worker() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (run_id, ids) = make_run(&mut store, "op-graph-gate", chain(2));

    // Gate on a queued task: blocked → out of the ready set → pending on
    // resolve so readiness and workers are re-evaluated.
    let gate = store
        .create_gate(
            &run_id,
            CreateGate {
                task_id: Some(ids["n0"].clone()),
                question: "proceed?".into(),
                options: vec!["yes".into(), "no".into()],
            },
        )
        .unwrap();
    assert_eq!(store.task(&ids["n0"]).unwrap().status, TaskStatus::Blocked);
    assert!(ready(&mut store, &run_id).is_empty());
    let resolved = store.resolve_gate(&gate.id, "yes").unwrap();
    assert_eq!(resolved.decision.as_deref(), Some("yes"));
    assert_eq!(store.task(&ids["n0"]).unwrap().status, TaskStatus::Pending);
    assert_eq!(ready(&mut store, &run_id), vec![ids["n0"].clone()]);

    // Idempotent re-resolve with the same decision; a different one is refused.
    store.resolve_gate(&gate.id, "yes").unwrap();
    assert!(matches!(
        store.resolve_gate(&gate.id, "no"),
        Err(Error::Invalid(_))
    ));

    // Gate on a dispatched task: resolve keeps it dispatched because its
    // worker is still live; the dispatch must not be duplicated.
    let outcome = store
        .dispatch_task(&ids["n0"], "sess-gate-0001", None, None)
        .unwrap();
    let gate2 = store
        .create_gate(
            &run_id,
            CreateGate {
                task_id: Some(ids["n0"].clone()),
                question: "still?".into(),
                options: vec![],
            },
        )
        .unwrap();
    assert_eq!(store.task(&ids["n0"]).unwrap().status, TaskStatus::Blocked);
    store.resolve_gate(&gate2.id, "yes").unwrap();
    assert_eq!(
        store.task(&ids["n0"]).unwrap().status,
        TaskStatus::Dispatched
    );
    let live: Vec<_> = store
        .list_dispatches(Some(&run_id))
        .unwrap()
        .into_iter()
        .filter(|dispatch| dispatch.state.active())
        .collect();
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].id, outcome.dispatch.id);
    store
        .settle_dispatch(&outcome.dispatch.id, true, "done")
        .unwrap();
}

#[test]
fn cancel_cascades_pending_gates_but_waits_for_live_workers() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (run_id, ids) = make_run(&mut store, "op-graph-cancel", chain(1));
    let gate = store
        .create_gate(
            &run_id,
            CreateGate {
                task_id: Some(ids["n0"].clone()),
                question: "q".into(),
                options: vec![],
            },
        )
        .unwrap();
    store.cancel_task(&ids["n0"], "never mind").unwrap();
    assert_eq!(
        store.task(&ids["n0"]).unwrap().status,
        TaskStatus::Cancelled
    );
    let gates = store.list_gates(Some(&run_id), None).unwrap();
    assert_eq!(gates[0].id, gate.id);
    assert_eq!(gates[0].status, GateStatus::Cancelled);
    assert!(gates[0].resolved_at.is_some());

    // A task with a live worker cannot be cancelled out from under it.
    let extra = store
        .apply_task_graph(ApplyTaskGraph {
            run_id: run_id.clone(),
            base_revision: 1,
            nodes: vec![node("m0", &[])],
            delete_task_ids: vec![],
            operation_id: None,
        })
        .unwrap();
    let m0 = extra.id_map["m0"].clone();
    let outcome = store
        .dispatch_task(&m0, "sess-cancel-001", None, None)
        .unwrap();
    assert!(matches!(
        store.cancel_task(&m0, "try"),
        Err(Error::Invalid(_))
    ));
    store
        .settle_dispatch(&outcome.dispatch.id, false, "x")
        .unwrap();
    // A failed task is not directly cancellable (legacy state machine); it
    // retries back to pending, at which point it can be cancelled.
    assert!(matches!(
        store.cancel_task(&m0, "now"),
        Err(Error::Invalid(_))
    ));
    store.retry_task(&m0).unwrap();
    store.cancel_task(&m0, "now").unwrap();
    assert_eq!(store.task(&m0).unwrap().status, TaskStatus::Cancelled);
}

#[test]
fn abandon_preserves_an_explicit_done_delivery() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (_run_id, ids) = make_run(&mut store, "op-graph-preserve", chain(1));
    let outcome = store
        .dispatch_task(&ids["n0"], "sess-preserve-01", None, None)
        .unwrap();

    // Simulate the crash window: the worker delivered done but the dispatch
    // settle was lost.
    let connection = raw(&directory);
    connection
        .execute(
            "UPDATE orch_tasks SET status='done',result='delivered' WHERE id=?1",
            params![ids["n0"]],
        )
        .unwrap();
    drop(connection);

    let settled = store
        .abandon_dispatch(&outcome.dispatch.id, "worker vanished", TaskStatus::Failed)
        .unwrap();
    assert_eq!(settled.task.status, TaskStatus::Done);
    assert_eq!(settled.task.result.as_deref(), Some("delivered"));
    assert_eq!(settled.dispatch.state, DispatchState::Succeeded);
    assert_eq!(settled.dispatch.outcome.as_deref(), Some("delivered"));
}

#[test]
fn recovery_abandons_orphans_promotes_live_starts_and_is_idempotent() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();

    let archived_session = store
        .create_session(CreateSession {
            agent: AgentKind::Shell,
            kind: SessionKind::Pty,
            title: "archived".into(),
            workspace: "/w".into(),
        })
        .unwrap();
    let live_session = store
        .create_session(CreateSession {
            agent: AgentKind::Shell,
            kind: SessionKind::Pty,
            title: "live".into(),
            workspace: "/w".into(),
        })
        .unwrap();

    // Run A: n0 settles on the live session; n1 is mid-flight on a session
    // that becomes archived before the daemon crashed.
    let (run_a, a) = make_run(&mut store, "op-graph-recover-a", chain(2));
    let d0 = store
        .dispatch_task(&a["n0"], &live_session.id, None, None)
        .unwrap();
    store.set_dispatch_running(&d0.dispatch.id).unwrap();
    store
        .settle_dispatch(&d0.dispatch.id, true, "done")
        .unwrap();
    let d1 = store
        .dispatch_task(&a["n1"], &archived_session.id, None, None)
        .unwrap();
    store.set_dispatch_running(&d1.dispatch.id).unwrap();

    // Run B: a dispatch references a session row that vanished entirely (the
    // column has no FK; a wiped sessions database is exactly the crash case).
    let (run_b, b) = make_run(&mut store, "op-graph-recover-b", chain(1));
    let d_missing = store
        .dispatch_task(&b["n0"], "sess-vanished-001", None, None)
        .unwrap();
    assert_eq!(d_missing.dispatch.state, DispatchState::Starting);

    // Run C: a still-'starting' dispatch whose session survived. It must be
    // promoted to running, not abandoned.
    let (run_c, c) = make_run(&mut store, "op-graph-recover-c", chain(1));
    let d_live_start = store
        .dispatch_task(&c["n0"], &live_session.id, None, None)
        .unwrap();

    // Crash fixtures: archive one session; delete the other's row outright.
    store
        .update_session(
            &archived_session.id,
            UpdateSession {
                revision: 1,
                title: None,
                lifecycle: Some(SessionLifecycle::Archived),
                status: None,
            },
        )
        .unwrap();
    let connection = raw(&directory);
    connection
        .execute("DELETE FROM session_heads WHERE id='sess-vanished-001'", [])
        .unwrap();
    drop(connection);

    // One set-based pass settles both orphans and resumes the live start.
    let report = store.recover_dispatches().unwrap();
    let mut settled: Vec<String> = report.settled.iter().map(|d| d.id.clone()).collect();
    settled.sort();
    let mut expected_settled = vec![d1.dispatch.id.clone(), d_missing.dispatch.id.clone()];
    expected_settled.sort();
    assert_eq!(settled, expected_settled);
    assert_eq!(report.resumed.len(), 1);
    assert_eq!(report.resumed[0].id, d_live_start.dispatch.id);
    assert_eq!(report.resumed[0].state, DispatchState::Running);

    assert_eq!(store.task(&a["n1"]).unwrap().status, TaskStatus::Failed);
    assert_eq!(store.task(&b["n0"]).unwrap().status, TaskStatus::Failed);
    assert_eq!(store.task(&c["n0"]).unwrap().status, TaskStatus::Dispatched);
    assert_eq!(
        store.dispatch(&d1.dispatch.id).unwrap().state,
        DispatchState::Abandoned
    );
    assert_eq!(
        store.dispatch(&d_missing.dispatch.id).unwrap().state,
        DispatchState::Abandoned
    );
    assert_eq!(store.task(&a["n0"]).unwrap().status, TaskStatus::Done);

    // Re-running the pass changes nothing: recovery is idempotent.
    let again = store.recover_dispatches().unwrap();
    assert!(again.settled.is_empty());
    assert!(again.resumed.is_empty());

    // And it survives a real process restart.
    drop(store);
    let mut reopened = Store::open(directory.path()).unwrap();
    let after_restart = reopened.recover_dispatches().unwrap();
    assert!(after_restart.settled.is_empty());
    assert!(after_restart.resumed.is_empty());
    assert_eq!(
        reopened.task(&c["n0"]).unwrap().status,
        TaskStatus::Dispatched
    );
    assert_eq!(
        reopened.dispatch(&d_live_start.dispatch.id).unwrap().state,
        DispatchState::Running
    );
    let _ = (run_a, run_b, run_c);
}

#[test]
fn run_lifecycle_enforces_settlement_then_completes() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (run_id, ids) = make_run(&mut store, "op-graph-life", chain(1));

    // Unfinished tasks block completion.
    assert!(matches!(
        store.complete_run(&run_id, false),
        Err(Error::Invalid(_))
    ));
    let outcome = store
        .dispatch_task(&ids["n0"], "sess-life-00001", None, None)
        .unwrap();
    // A live worker blocks both completion and abandonment.
    assert!(matches!(
        store.complete_run(&run_id, false),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store.abandon_run(&run_id, "give up"),
        Err(Error::Invalid(_))
    ));
    store
        .settle_dispatch(&outcome.dispatch.id, true, "done")
        .unwrap();
    let run = store.complete_run(&run_id, false).unwrap();
    assert_eq!(run.status, RunStatus::Completed);
    // Completion is idempotent.
    assert_eq!(
        store.complete_run(&run_id, false).unwrap().status,
        run.status
    );
}

#[test]
fn failed_tasks_block_completion_unless_explicitly_allowed() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (run_id, ids) = make_run(&mut store, "op-graph-allow", chain(1));
    let outcome = store
        .dispatch_task(&ids["n0"], "sess-allow-0001", None, None)
        .unwrap();
    store
        .settle_dispatch(&outcome.dispatch.id, false, "nope")
        .unwrap();
    assert!(matches!(
        store.complete_run(&run_id, false),
        Err(Error::Invalid(_))
    ));
    let run = store.complete_run(&run_id, true).unwrap();
    assert_eq!(run.status, RunStatus::Completed);
}

#[test]
fn abandoned_run_cancels_everything_pending() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (run_id, ids) = make_run(&mut store, "op-graph-abandon", chain(2));
    let gate = store
        .create_gate(
            &run_id,
            CreateGate {
                task_id: Some(ids["n0"].clone()),
                question: "q".into(),
                options: vec![],
            },
        )
        .unwrap();
    let run = store.abandon_run(&run_id, "objective moot").unwrap();
    assert_eq!(run.status, RunStatus::Abandoned);
    for id in ids.values() {
        assert_eq!(store.task(id).unwrap().status, TaskStatus::Cancelled);
    }
    assert_eq!(
        store.list_gates(Some(&run_id), None).unwrap()[0].status,
        GateStatus::Cancelled
    );
    // The cancelled gate cannot be resolved afterwards.
    assert!(matches!(
        store.resolve_gate(&gate.id, "yes"),
        Err(Error::Invalid(_))
    ));
    // Abandonment is idempotent.
    assert_eq!(
        store.abandon_run(&run_id, "again").unwrap().status,
        RunStatus::Abandoned
    );
}

#[test]
fn graph_edits_use_optimistic_concurrency_and_reject_cycles() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (run_id, ids) = make_run(&mut store, "op-graph-occ", chain(2));

    // Stale base revision is rejected.
    assert!(matches!(
        store.apply_task_graph(ApplyTaskGraph {
            run_id: run_id.clone(),
            base_revision: 7,
            nodes: vec![node("x", &[])],
            delete_task_ids: vec![],
            operation_id: None,
        }),
        Err(Error::Conflict)
    ));

    // Cycles from the LLM coordinator are rejected wholesale.
    assert!(matches!(
        store.apply_task_graph(ApplyTaskGraph {
            run_id: run_id.clone(),
            base_revision: 1,
            nodes: vec![node("n0", &["n1"])],
            delete_task_ids: vec![],
            operation_id: None,
        }),
        Err(Error::Invalid(_))
    ));
    // The rejected edit changed nothing.
    assert_eq!(store.run_snapshot(&run_id).unwrap().run.graph_revision, 1);

    // Apply is idempotent on its own operation id: replay returns the same map
    // and bumps the revision only once.
    let applied = store
        .apply_task_graph(ApplyTaskGraph {
            run_id: run_id.clone(),
            base_revision: 1,
            nodes: vec![node("a", &[]), node("b", &["a"])],
            delete_task_ids: vec![],
            operation_id: Some("op-apply-1".into()),
        })
        .unwrap();
    assert_eq!(applied.run.graph_revision, 2);
    let replayed = store
        .apply_task_graph(ApplyTaskGraph {
            run_id: run_id.clone(),
            base_revision: 1,
            nodes: vec![node("a", &[]), node("b", &["a"])],
            delete_task_ids: vec![],
            operation_id: Some("op-apply-1".into()),
        })
        .unwrap();
    assert_eq!(replayed.id_map, applied.id_map);
    assert_eq!(replayed.run.graph_revision, 2);

    // n0 is already done; only pending tasks may be deleted.
    let done = store
        .dispatch_task(&ids["n0"], "sess-occ-00001", None, None)
        .unwrap();
    store
        .settle_dispatch(&done.dispatch.id, true, "done")
        .unwrap();
    assert!(matches!(
        store.apply_task_graph(ApplyTaskGraph {
            run_id: run_id.clone(),
            base_revision: 2,
            nodes: vec![],
            delete_task_ids: vec![ids["n0"].clone()],
            operation_id: None,
        }),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn graph_create_is_idempotent_per_operation_id() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let request = || CreateRunGraph {
        objective: "exactly one run".into(),
        nodes: vec![node("x", &[])],
        coordinator_session_id: None,
        operation_id: "op-once".into(),
    };
    let first = store.create_run_graph(request()).unwrap();
    let second = store.create_run_graph(request()).unwrap();
    assert_eq!(second.run.id, first.run.id);
    assert_eq!(second.id_map, first.id_map);
    assert_eq!(store.list_runs().unwrap().len(), 1);

    // Same operation id with a different payload is rejected.
    let mut tampered = request();
    tampered.objective = "a different objective".into();
    assert!(matches!(
        store.create_run_graph(tampered),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn collaboration_messages_thread_unread_and_answered_state() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (run_id, _ids) = make_run(&mut store, "op-graph-msgs", chain(1));

    let message = store
        .post_message(PostMessage {
            run_id: run_id.clone(),
            from: "worker-a".into(),
            to: "coordinator".into(),
            kind: MessageType::Ask,
            subject: "which file?".into(),
            body: "target unclear".into(),
            thread_id: None,
            task_id: None,
        })
        .unwrap();
    let reply = store
        .post_message(PostMessage {
            run_id: run_id.clone(),
            from: "coordinator".into(),
            to: "worker-a".into(),
            kind: MessageType::Reply,
            subject: "re: which file?".into(),
            body: "src/main.rs".into(),
            thread_id: Some(message.id.clone()),
            task_id: None,
        })
        .unwrap();

    assert_eq!(
        store
            .unread_messages("worker-a", Some(&run_id))
            .unwrap()
            .len(),
        1
    );
    store
        .mark_messages_read(
            &MarkMessages {
                ids: vec![reply.id.clone()],
            }
            .ids,
        )
        .unwrap();
    assert!(
        store
            .unread_messages("worker-a", Some(&run_id))
            .unwrap()
            .is_empty()
    );
    let answered = store.mark_message_answered(&reply.id).unwrap();
    assert!(answered.answered_at.is_some());
    assert_eq!(store.list_messages(Some(&run_id)).unwrap().len(), 2);
}

#[test]
fn state_machine_and_cycle_finder_match_legacy_model() {
    use TaskStatus::*;
    assert!(can_transition(Pending, Dispatched));
    assert!(can_transition(Dispatched, Pending));
    assert!(!can_transition(Blocked, Dispatched)); // gate resolve uses force
    assert!(!can_transition(Done, Pending));
    assert!(!can_transition(Cancelled, Pending));
    assert!(can_transition(Failed, Pending));

    let mut acyclic: HashMap<String, Vec<String>> = HashMap::new();
    acyclic.insert("a".into(), vec!["b".into()]);
    acyclic.insert("b".into(), vec!["c".into()]);
    acyclic.insert("c".into(), vec![]);
    assert_eq!(find_cycle(&acyclic), None);

    let mut cyclic: HashMap<String, Vec<String>> = HashMap::new();
    cyclic.insert("a".into(), vec!["b".into()]);
    cyclic.insert("b".into(), vec!["c".into()]);
    cyclic.insert("c".into(), vec!["a".into()]);
    let cycle = find_cycle(&cyclic).expect("cycle detected");
    assert_eq!(cycle.first(), cycle.last());
    assert!(cycle.len() >= 4);
}

#[test]
fn schema_indexes_survive_reopen() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let connection = raw(&directory);
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 13);
    // Stage 7 reverse-edge indexes and Stage 8 worktree indexes all exist.
    let indexed: i64 = connection
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='index' AND name IN \
             ('orch_deps_dep','orch_dispatch_active','orch_worktrees_run','orch_worktrees_state','orch_worktrees_path')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(indexed, 5);
    // The v10 dispatch column and asset table are present and writable.
    connection
        .execute(
            "INSERT INTO orch_worktree_assets \
             (id,kind,run_id,task_id,dispatch_id,repo,path,branch,state,created_at,updated_at,run_deleted_at,last_inspection,cleanup,last_error) \
             VALUES('wt-probe','worker','run-absent',NULL,NULL,'/repo','/tree',NULL,'preserved',1,1,1,NULL,NULL,'detached')",
            [],
        )
        .unwrap();
    drop(connection);

    let (run_id, ids) = make_run(&mut store, "op-graph-v9", chain(1));
    drop(store);
    let mut reopened = Store::open(directory.path()).unwrap();
    let snapshot = reopened.run_snapshot(&run_id).unwrap();
    assert_eq!(snapshot.ready, vec![ids["n0"].clone()]);
}

#[test]
fn v8_database_is_migrated_forward_to_v13() {
    // Build a v8 database by initialising the pre-orchestration schema with the
    // legacy application id, then prove Store::open upgrades it in place.
    let directory = TempDir::new().unwrap();
    let database = directory.path().join("prospero.sqlite");
    {
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(include_str!("../src/schema.sql"))
            .unwrap();
        connection
            .pragma_update(None, "application_id", 0x50525253i64)
            .unwrap();
        connection.pragma_update(None, "user_version", 8).unwrap();
    }
    let mut store = Store::open(directory.path()).unwrap();
    let connection = raw(&directory);
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 13);
    // The migrated store serves orchestration writes.
    let (_run_id, _ids) = make_run(&mut store, "op-graph-migrated", chain(1));
}

#[test]
fn v9_database_is_migrated_forward_to_v13() {
    // A v9 database (Stage 7 current schema) gains the v10 worktree table and
    // dispatch column without losing rows.
    let directory = TempDir::new().unwrap();
    let database = directory.path().join("prospero.sqlite");
    {
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(include_str!("../src/schema.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../src/orchestration/schema.sql"))
            .unwrap();
        connection
            .pragma_update(None, "application_id", 0x50525253i64)
            .unwrap();
        connection.pragma_update(None, "user_version", 9).unwrap();
    }
    let mut store = Store::open(directory.path()).unwrap();
    let connection = raw(&directory);
    assert_eq!(
        connection
            .query_row::<i64, _, _>("PRAGMA user_version", [], |row| row.get(0))
            .unwrap(),
        13
    );
    drop(connection);
    let (run_id, ids) = make_run(&mut store, "op-graph-v9up", chain(1));
    let outcome = store
        .dispatch_task(&ids["n0"], "sess-v9up-0001", None, Some("/tmp/tree"))
        .unwrap();
    assert_eq!(outcome.dispatch.worktree_path.as_deref(), Some("/tmp/tree"));
    drop(store);
    let mut reopened = Store::open(directory.path()).unwrap();
    let snapshot = reopened.run_snapshot(&run_id).unwrap();
    assert_eq!(
        snapshot.dispatches.first().unwrap().worktree_path,
        Some("/tmp/tree".to_owned())
    );
}

#[test]
fn v10_database_is_migrated_forward_to_v13() {
    // A v10 database gains agent_runs.permission_mode with the default mode.
    let directory = TempDir::new().unwrap();
    let database = directory.path().join("prospero.sqlite");
    {
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(include_str!("../src/schema.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../src/orchestration/schema.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../src/orchestration/schema-v10.sql"))
            .unwrap();
        connection
            .pragma_update(None, "application_id", 0x50525253i64)
            .unwrap();
        connection.pragma_update(None, "user_version", 10).unwrap();
        connection
            .execute(
                "INSERT INTO session_heads \
                 (id,created_at,lifecycle,revision,payload) \
                 VALUES('sess-mode',1,'active',1,json('{\"workspace\":\"/w\",\"agent\":\"claude\",\"kind\":\"structured\",\"title\":\"A\",\"status\":\"idle\"}'))",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO agent_runs(session_id,agent,active,approval_policy,turn,native_id) \
                 VALUES('sess-mode','claude',1,'manual',0,NULL)",
                [],
            )
            .unwrap();
    }
    let store = Store::open(directory.path()).unwrap();
    let connection = raw(&directory);
    assert_eq!(
        connection
            .query_row::<i64, _, _>("PRAGMA user_version", [], |row| row.get(0))
            .unwrap(),
        13
    );
    let mode: String = connection
        .query_row(
            "SELECT permission_mode FROM agent_runs WHERE session_id='sess-mode'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(mode, "default");
    drop(connection);
    drop(store);
}

#[test]
fn v11_database_is_migrated_forward_to_v13() {
    // A v11 database gains the subagent registry table and the timeline
    // subagent_id column without losing the existing agent run.
    let directory = TempDir::new().unwrap();
    let database = directory.path().join("prospero.sqlite");
    {
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(include_str!("../src/schema.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../src/orchestration/schema.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../src/orchestration/schema-v10.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../src/agent/schema-v11.sql"))
            .unwrap();
        connection
            .pragma_update(None, "application_id", 0x50525253i64)
            .unwrap();
        connection.pragma_update(None, "user_version", 11).unwrap();
        connection
            .execute(
                "INSERT INTO session_heads \
                 (id,created_at,lifecycle,revision,payload) \
                 VALUES('sess-sub',1,'active',1,json('{\"workspace\":\"/w\",\"agent\":\"claude\",\"kind\":\"structured\",\"title\":\"A\",\"status\":\"idle\"}'))",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO agent_runs(session_id,agent,active,approval_policy,permission_mode,turn,native_id) \
                 VALUES('sess-sub','claude',1,'manual','plan',2,'native-x')",
                [],
            )
            .unwrap();
    }
    let store = Store::open(directory.path()).unwrap();
    let connection = raw(&directory);
    assert_eq!(
        connection
            .query_row::<i64, _, _>("PRAGMA user_version", [], |row| row.get(0))
            .unwrap(),
        13
    );
    // The run row and its v11 fields survived.
    let (mode, turn, native): (String, i64, Option<String>) = connection
        .query_row(
            "SELECT permission_mode,turn,native_id FROM agent_runs WHERE session_id='sess-sub'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(mode, "plan");
    assert_eq!(turn, 2);
    assert_eq!(native.as_deref(), Some("native-x"));
    // The new column and registry table are usable post-migration.
    connection
        .execute(
            "INSERT INTO content_heads(session_id,id,bytes) VALUES('sess-sub','card-toolu',0)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO timeline_records \
             (session_id,id,turn_id,position,revision,generation,body,preview,subagent_id) \
             VALUES('sess-sub','card-toolu','turn1',1,1,1,'{}','','toolu')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO agent_subagents \
             (session_id,subagent_id,name,status,can_message,summary,created_at,updated_at) \
             VALUES('sess-sub','toolu','Explore','running',1,'looking',3,4)",
            [],
        )
        .unwrap();
    let count: i64 = connection
        .query_row(
            "SELECT count(*) FROM agent_subagents WHERE session_id='sess-sub' AND status='running'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    drop(connection);
    drop(store);
}

#[test]
fn v12_database_is_migrated_forward_to_v13() {
    // A v12 database gains the busy-turn message-queue table without losing
    // the existing agent run.
    let directory = TempDir::new().unwrap();
    let database = directory.path().join("prospero.sqlite");
    {
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(include_str!("../src/schema.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../src/orchestration/schema.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../src/orchestration/schema-v10.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../src/agent/schema-v11.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../src/agent/schema-v12.sql"))
            .unwrap();
        connection
            .pragma_update(None, "application_id", 0x50525253i64)
            .unwrap();
        connection.pragma_update(None, "user_version", 12).unwrap();
        connection
            .execute(
                "INSERT INTO session_heads \
                 (id,created_at,lifecycle,revision,payload) \
                 VALUES('sess-q',1,'active',1,json('{\"workspace\":\"/w\",\"agent\":\"claude\",\"kind\":\"structured\",\"title\":\"A\",\"status\":\"idle\"}'))",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO agent_runs(session_id,agent,active,approval_policy,permission_mode,turn,native_id) \
                 VALUES('sess-q','claude',1,'manual','default',1,'native-q')",
                [],
            )
            .unwrap();
    }
    let store = Store::open(directory.path()).unwrap();
    let connection = raw(&directory);
    assert_eq!(
        connection
            .query_row::<i64, _, _>("PRAGMA user_version", [], |row| row.get(0))
            .unwrap(),
        13
    );
    // The existing run survived.
    let (turn, native): (i64, Option<String>) = connection
        .query_row(
            "SELECT turn,native_id FROM agent_runs WHERE session_id='sess-q'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(turn, 1);
    assert_eq!(native.as_deref(), Some("native-q"));
    // The queue table is usable and orders front inserts (guide) first.
    connection
        .execute(
            "INSERT INTO agent_message_queue(session_id,queue_id,position,kind,text,created_at) \
             VALUES('sess-q','q1',0,'queue','first',10)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO agent_message_queue(session_id,queue_id,position,kind,text,created_at) \
             VALUES('sess-q','q2',-1,'guide','guide-first',11)",
            [],
        )
        .unwrap();
    let first: String = connection
        .query_row(
            "SELECT queue_id FROM agent_message_queue WHERE session_id='sess-q' ORDER BY position ASC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(first, "q2");
    drop(connection);
    drop(store);
}

#[test]
fn orchestration_changes_share_the_transactional_event_log() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (run_id, ids) = make_run(&mut store, "op-graph-events", chain(1));
    let events = store.events("orchestration", 0, 100).unwrap();
    let kinds: Vec<&str> = events
        .items
        .iter()
        .map(|event| event.kind.as_str())
        .collect();
    assert!(kinds.contains(&"run.created"));
    assert!(kinds.contains(&"task.created"));

    let outcome = store
        .dispatch_task(&ids["n0"], "sess-event-0001", None, None)
        .unwrap();
    store
        .settle_dispatch(&outcome.dispatch.id, true, "done")
        .unwrap();
    let events = store
        .events("orchestration", events.latest_seq, 100)
        .unwrap();
    let kinds: Vec<&str> = events
        .items
        .iter()
        .map(|event| event.kind.as_str())
        .collect();
    assert!(kinds.contains(&"dispatch.updated"));
    let _ = run_id;
}

// ── Stage 8: run/task creation, run deletion, asset detach ──────────────────

#[test]
fn run_create_and_task_create_append_and_bump_revision() {
    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let run = store
        .create_run(prosperod_rs::orchestration::CreateRun {
            objective: "incremental build".into(),
            coordinator_session_id: None,
        })
        .unwrap();
    assert_eq!(run.status, RunStatus::Active);
    assert_eq!(run.graph_revision, 0);

    let first = store
        .create_task(prosperod_rs::orchestration::CreateTask {
            run_id: run.id.clone(),
            title: "first".into(),
            spec: "do first".into(),
            skills: vec![],
            deps: vec![],
            parent_id: None,
        })
        .unwrap();
    let second = store
        .create_task(prosperod_rs::orchestration::CreateTask {
            run_id: run.id.clone(),
            title: "second".into(),
            spec: "do second".into(),
            skills: vec![],
            deps: vec![first.id.clone()],
            parent_id: None,
        })
        .unwrap();
    // The new task blocks behind `first`; its creation is what bumped rev 2.
    assert_eq!(second.deps, vec![first.id.clone()]);
    let snapshot = store.run_snapshot(&run.id).unwrap();
    assert_eq!(snapshot.run.graph_revision, 2);
    assert_eq!(snapshot.ready, vec![first.id.clone()]);

    // Appended tasks only validate forward against the full candidate graph;
    // a dependency on a missing task is rejected like a bad graph edit.
    // (Cycles that re-enter existing nodes are only possible through
    // apply_task_graph, which the Stage 7 graph tests cover.)
    assert!(
        store
            .create_task(prosperod_rs::orchestration::CreateTask {
                run_id: run.id.clone(),
                title: "ghost dep".into(),
                spec: "ghost".into(),
                skills: vec![],
                deps: vec!["task-does-not-exist".into()],
                parent_id: None,
            })
            .is_err()
    );

    // Unknown run / unknown dep are rejected.
    assert!(
        store
            .create_task(prosperod_rs::orchestration::CreateTask {
                run_id: "run-missing".into(),
                title: "x".into(),
                spec: "x".into(),
                skills: vec![],
                deps: vec![],
                parent_id: None,
            })
            .is_err()
    );

    // Tasks cannot be appended to a settled run.
    store.abandon_run(&run.id, "done here").unwrap();
    assert!(
        store
            .create_task(prosperod_rs::orchestration::CreateTask {
                run_id: run.id.clone(),
                title: "late".into(),
                spec: "late".into(),
                skills: vec![],
                deps: vec![],
                parent_id: None,
            })
            .is_err()
    );
}

#[test]
fn deleting_a_run_detaches_worktree_assets_but_keeps_them_indexed() {
    use prosperod_rs::orchestration::{RegisterWorktree, WorktreeAssetKind, WorktreeAssetState};

    let directory = TempDir::new().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (run_id, ids) = make_run(&mut store, "op-delete-run", chain(1));
    let task_id = ids["n0"].clone();

    let asset = store
        .register_worktree_asset(RegisterWorktree {
            kind: WorktreeAssetKind::Worker,
            run_id: run_id.clone(),
            task_id: Some(task_id.clone()),
            repo: "/tmp/repo".into(),
            path: "/tmp/prospero-worker-tree".into(),
            branch: Some("prospero/branch".into()),
        })
        .unwrap();
    assert_eq!(asset.task_id.as_deref(), Some(task_id.as_str()));

    // While a dispatch is live, deletion is refused unless forced.
    let outcome = store
        .dispatch_task(&task_id, "sess-delete-0001", None, Some(&asset.path))
        .unwrap();
    assert_eq!(
        outcome.dispatch.worktree_path.as_deref(),
        Some(asset.path.as_str())
    );
    // While the dispatch is live, run deletion is refused without force.
    assert!(store.delete_run(&run_id, false).is_err());
    // The worker service links asset to dispatch in the same start boundary.
    let linked = store
        .link_worktree_dispatch(&asset.id, &outcome.dispatch.id)
        .unwrap();
    assert_eq!(
        linked.dispatch_id.as_deref(),
        Some(outcome.dispatch.id.as_str())
    );

    // Manual delivery settles the dispatch and preserves the linked asset.
    store
        .settle_dispatch(&outcome.dispatch.id, true, "delivered")
        .unwrap();
    let linked = store.worktree_asset(&asset.id).unwrap();
    assert_eq!(linked.state, WorktreeAssetState::Preserved);

    let result = store.delete_run(&run_id, false).unwrap();
    assert_eq!(result.deleted_task_count, 1);
    assert_eq!(result.preserved_worktree_asset_ids, vec![asset.id.clone()]);

    // The run and its rows are gone, but the disk resource stays indexed...
    assert!(store.run_snapshot(&run_id).is_err());
    let detached = store.worktree_asset(&asset.id).unwrap();
    assert_eq!(detached.state, WorktreeAssetState::Preserved);
    assert!(detached.run_deleted_at.is_some());
    assert_eq!(
        detached.last_error.as_deref(),
        Some("所属 Run 已删除；资产与恢复分支仍保留，需显式检查或清理")
    );
    // ...and remains visible in the asset list for later cleanup. run_id is
    // deliberately kept as provenance (no FK), so the detached asset is still
    // locable by its original run too.
    assert_eq!(store.list_worktree_assets(None).unwrap().len(), 1);
    assert_eq!(
        store.list_worktree_assets(Some(&run_id)).unwrap()[0].state,
        WorktreeAssetState::Preserved
    );
}
