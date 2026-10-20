use rusqlite::{OptionalExtension, Transaction, params};

use super::*;
use crate::database::{Store, validate_id};
use crate::protocol::*;

impl Store {
    pub fn create_terminal(&mut self, input: CreateTerminal) -> Result<SessionHead> {
        self.create_terminal_with(input, None)
    }

    /// `account_id` marks a non-shell terminal (the managed-account login
    /// PTY) so account deletion can block while it is alive.
    pub(crate) fn create_terminal_with(
        &mut self,
        input: CreateTerminal,
        account_id: Option<String>,
    ) -> Result<SessionHead> {
        let size = validate_size(input.size)?;
        self.create_session_with_launch(
            CreateSession {
                agent: input.agent.unwrap_or(AgentKind::Shell),
                kind: SessionKind::Pty,
                title: input.title,
                workspace: input.workspace,
            },
            None,
            SessionLaunchOptions {
                account_id: input.account_id.or_else(|| account_id.clone()),
                model: input.model,
                effort: input.effort,
                approval_policy: input.approval_policy,
            },
            |tx, head| {
                tx.execute(
                    "INSERT INTO terminal_runs(session_id,cols,rows,active,account_id) VALUES(?1,?2,?3,1,?4)",
                    params![head.id, size.cols, size.rows, account_id],
                )?;
                Ok(())
            },
        )
    }

    pub(crate) fn finish_terminal(&mut self, id: &str, archive: Archive) -> Result<SessionHead> {
        let head = self.session(id)?;
        self.update_session_with(
            id,
            UpdateSession {
                revision: head.revision,
                title: None,
                lifecycle: Some(SessionLifecycle::Archived),
                status: Some(if archive.exit_code == Some(0) {
                    SessionStatus::Completed
                } else {
                    SessionStatus::Failed
                }),
            },
            |tx| {
                persist(tx, id, archive, false)?;
                Ok(())
            },
        )
    }

    pub(crate) fn checkpoint_terminal(&mut self, id: &str, archive: Archive) -> Result<()> {
        let tx = self.connection.transaction()?;
        persist(&tx, id, archive, true)?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn terminal_checkpoint_seq(&self, id: &str) -> Result<i64> {
        self.connection
            .query_row(
                "SELECT latest_seq FROM terminal_runs WHERE session_id=? AND active=1",
                [id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(Error::Conflict)
    }

    pub fn active_terminal_ids(&mut self) -> Result<Vec<String>> {
        let ids: Vec<String> = self
            .connection
            .prepare(
                "SELECT session_id FROM terminal_runs WHERE active=1 ORDER BY session_id LIMIT 17",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if ids.len() > 16 {
            return Err(Error::Schema);
        }
        Ok(ids)
    }
    /// Manual Agent PTYs are intentionally separate from orchestration worker
    /// reclamation. Runtime prompt detection performs the final safety check.
    pub(crate) fn manual_terminal_reclaim_candidates(
        &self,
        before: i64,
        limit: usize,
    ) -> Result<Vec<String>> {
        let mut statement = self.connection.prepare(
            "SELECT h.id FROM session_heads h \
             JOIN terminal_runs t ON t.session_id=h.id \
             WHERE h.lifecycle='active' AND t.active=1 \
               AND json_extract(h.payload,'$.kind')='pty' \
               AND json_extract(h.payload,'$.status')='running' \
               AND json_extract(h.payload,'$.agent') IN ('codex','claude') \
               AND json_extract(h.payload,'$.updatedAt')<?1 \
               AND NOT EXISTS(SELECT 1 FROM orch_worker_starts w WHERE w.session_id=h.id) \
             ORDER BY json_extract(h.payload,'$.updatedAt'),h.id LIMIT ?2",
        )?;
        Ok(statement
            .query_map(rusqlite::params![before, limit.min(16) as i64], |row| {
                row.get(0)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }
    pub fn recover_terminals(&mut self) -> Result<usize> {
        self.recover_terminals_except(&[])
    }
    pub fn recover_terminals_except(&mut self, retained: &[String]) -> Result<usize> {
        let ids: Vec<_> = self
            .active_terminal_ids()?
            .into_iter()
            .filter(|id| !retained.contains(id))
            .collect();
        for id in &ids {
            self.fail_terminal(id)?;
        }
        Ok(ids.len())
    }

    pub fn fail_terminal(&mut self, id: &str) -> Result<()> {
        let head = self.session(id)?;
        self.update_session_with(
            id,
            UpdateSession {
                revision: head.revision,
                title: None,
                lifecycle: Some(SessionLifecycle::Archived),
                status: Some(SessionStatus::Failed),
            },
            |tx| {
                tx.execute(
                    "UPDATE terminal_runs SET active=0,exit_code=NULL WHERE session_id=?",
                    [id],
                )?;
                Ok(())
            },
        )?;
        Ok(())
    }

    pub fn terminal_output(&self, id: &str, query: TerminalQuery) -> Result<TerminalPage> {
        validate_id(id)?;
        if query.wait_ms.unwrap_or(0) > 5000 {
            return Err(Error::Invalid("terminal wait exceeds limit".into()));
        }
        let (cols, rows, active, floor, latest, code): (u16, u16, bool, i64, i64, Option<u32>) = self.connection.query_row("SELECT cols,rows,active,floor_seq,latest_seq,exit_code FROM terminal_runs WHERE session_id=?", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))).optional()?.ok_or(Error::NotFound)?;
        if active {
            return Err(Error::Busy);
        }
        let after = query.after_seq.unwrap_or(0);
        if after < 0 {
            return Err(Error::Invalid("terminal cursor is ahead of output".into()));
        }
        let mut events = Vec::new();
        if after >= floor && after <= latest {
            let mut statement = self.connection.prepare("SELECT payload FROM terminal_output WHERE session_id=?1 AND seq>?2 ORDER BY seq LIMIT 64")?;
            let mut records = statement.query(params![id, after])?;
            let mut bytes = 0;
            while let Some(record) = records.next()? {
                let payload: String = record.get(0)?;
                if !events.is_empty() && bytes + payload.len() > PAGE_BYTES {
                    break;
                }
                bytes += payload.len();
                events.push(serde_json::from_str(&payload)?);
            }
        }
        Ok(TerminalPage {
            initial_size: TerminalSize { cols, rows },
            base_seq: after,
            next_seq: after + events.len() as i64,
            latest_seq: latest,
            floor_seq: floor,
            events,
            resync_required: after < floor || after > latest,
            exited: true,
            exit_code: code,
        })
    }

    pub fn terminal_snapshot(&self, id: &str) -> Result<Option<TerminalSnapshot>> {
        validate_id(id)?;
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT snapshot FROM terminal_runs WHERE session_id=?",
                [id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        Ok(value
            .map(|value| serde_json::from_str(&value))
            .transpose()?)
    }
}

fn persist(tx: &Transaction<'_>, id: &str, archive: Archive, active: bool) -> Result<()> {
    let (previous, previous_floor, previous_snapshot): (i64, i64, Option<String>) = tx
        .query_row(
            "SELECT latest_seq,floor_seq,snapshot FROM terminal_runs WHERE session_id=? AND active=1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or(Error::Conflict)?;
    if archive.seq < previous
        || archive.latest_seq != 0 && archive.latest_seq < archive.seq
        || !active && archive.latest_seq > archive.seq
        || archive.floor < 0
        || archive.floor < previous_floor && archive.start > archive.floor
        || archive.start < archive.floor
        || archive.start > previous.max(archive.floor)
        || archive.start + archive.events.len() as i64 != archive.seq
    {
        return Err(Error::Conflict);
    }
    if archive
        .snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot.seq < archive.floor || snapshot.seq > archive.seq)
    {
        return Err(Error::Conflict);
    }
    let snapshot = archive.snapshot.or(previous_snapshot
        .map(|value| serde_json::from_str::<TerminalSnapshot>(&value))
        .transpose()?
        .filter(|snapshot| snapshot.seq >= archive.floor && snapshot.seq <= archive.seq));
    tx.execute("UPDATE terminal_runs SET active=?1,floor_seq=?2,latest_seq=?3,exit_code=?4,snapshot=?5 WHERE session_id=?6", params![active, archive.floor, archive.seq, archive.exit_code, snapshot.map(|snapshot| serde_json::to_string(&snapshot)).transpose()?, id])?;
    tx.execute(
        "DELETE FROM terminal_output WHERE session_id=?1 AND seq<=?2",
        params![id, archive.floor],
    )?;
    let mut insert =
        tx.prepare_cached("INSERT INTO terminal_output(session_id,seq,payload) VALUES(?1,?2,?3)")?;
    for (offset, event) in archive.events.iter().enumerate() {
        let seq = archive.start + offset as i64 + 1;
        if seq > previous {
            insert.execute(params![id, seq, serde_json::to_string(event)?])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive(floor: i64, seq: i64) -> Archive {
        Archive {
            floor,
            start: floor,
            seq,
            latest_seq: seq,
            events: (floor..seq)
                .map(|_| TerminalEvent::Output {
                    data_b64: STANDARD.encode("x"),
                })
                .collect(),
            snapshot: None,
            exit_code: None,
        }
    }

    #[test]
    fn paged_checkpoints_keep_the_recovery_base_and_archive_every_event() {
        let directory = tempfile::TempDir::new().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let head = store
            .create_terminal(CreateTerminal {
                title: "Paged recovery".into(),
                workspace: "/synthetic".into(),
                size: TerminalSize { cols: 80, rows: 24 },
                agent: None,
                command: None,
                account_id: None,
                model: None,
                effort: None,
                approval_policy: None,
            })
            .unwrap();
        let mut first = archive(0, 400);
        first.snapshot = Some(TerminalSnapshot {
            seq: 400,
            size: TerminalSize { cols: 80, rows: 24 },
            data_b64: STANDARD.encode("base"),
        });
        store.checkpoint_terminal(&head.id, first).unwrap();
        let mut seq = 400;
        while seq < 900 {
            let next = (seq + 64).min(900);
            let mut page = archive(seq, next);
            page.floor = 0;
            page.latest_seq = 900;
            if next < 900 {
                assert!(store.finish_terminal(&head.id, page.clone()).is_err());
                store.checkpoint_terminal(&head.id, page).unwrap();
            } else {
                page.exit_code = Some(0);
                store.finish_terminal(&head.id, page).unwrap();
            }
            seq = next;
        }
        assert_eq!(store.terminal_snapshot(&head.id).unwrap().unwrap().seq, 400);
        let mut cursor = 0;
        while cursor < 900 {
            let page = store
                .terminal_output(
                    &head.id,
                    TerminalQuery {
                        after_seq: Some(cursor),
                        wait_ms: None,
                    },
                )
                .unwrap();
            assert_eq!(page.floor_seq, 0);
            assert!(!page.resync_required);
            assert!(page.exited);
            assert_eq!(page.exit_code, Some(0));
            assert!(page.next_seq > cursor);
            assert!(page.events.len() <= 64);
            cursor = page.next_seq;
        }
        assert_eq!(cursor, 900);
    }

    #[test]
    fn checkpoint_rejects_missing_events_and_future_snapshots() {
        let directory = tempfile::TempDir::new().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let head = store
            .create_terminal(CreateTerminal {
                title: "Recovery validation".into(),
                workspace: "/synthetic".into(),
                size: TerminalSize { cols: 80, rows: 24 },
                agent: None,
                command: None,
                account_id: None,
                model: None,
                effort: None,
                approval_policy: None,
            })
            .unwrap();
        store
            .checkpoint_terminal(&head.id, archive(0, 400))
            .unwrap();
        let mut gap = archive(401, 402);
        gap.floor = 0;
        assert!(store.checkpoint_terminal(&head.id, gap).is_err());
        let mut future = archive(400, 401);
        future.floor = 0;
        future.snapshot = Some(TerminalSnapshot {
            seq: 402,
            size: TerminalSize { cols: 80, rows: 24 },
            data_b64: STANDARD.encode("future"),
        });
        assert!(store.checkpoint_terminal(&head.id, future).is_err());
        assert_eq!(store.terminal_checkpoint_seq(&head.id).unwrap(), 400);
    }

    #[test]
    fn checkpoints_insert_only_new_events_and_recovery_preserves_the_retained_window() {
        let directory = tempfile::TempDir::new().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let head = store
            .create_terminal(CreateTerminal {
                title: "Checkpoint".into(),
                workspace: "/synthetic".into(),
                size: TerminalSize { cols: 80, rows: 24 },
                agent: None,
                command: None,
                account_id: None,
                model: None,
                effort: None,
                approval_policy: None,
            })
            .unwrap();
        store.connection.execute_batch("CREATE TABLE inserted(seq INTEGER); CREATE TRIGGER record_insert AFTER INSERT ON terminal_output BEGIN INSERT INTO inserted VALUES(NEW.seq); END;").unwrap();
        store
            .checkpoint_terminal(&head.id, archive(0, 400))
            .unwrap();
        store
            .checkpoint_terminal(&head.id, archive(88, 600))
            .unwrap();
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM inserted", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            600
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM terminal_output", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            512
        );
        assert!(store.checkpoint_terminal(&head.id, archive(0, 1)).is_err());
        assert_eq!(store.events("sessions", 0, 100).unwrap().latest_seq, 1);
        drop(store);
        let mut store = Store::open(directory.path()).unwrap();
        assert_eq!(store.recover_terminals().unwrap(), 1);
        assert_eq!(store.recover_terminals().unwrap(), 0);
        let page = store
            .terminal_output(
                &head.id,
                TerminalQuery {
                    after_seq: Some(88),
                    wait_ms: None,
                },
            )
            .unwrap();
        assert_eq!(page.floor_seq, 88);
        assert_eq!(page.latest_seq, 600);
        assert_eq!(page.events.len(), 64);
        assert!(page.exited);
        assert_eq!(page.exit_code, None);
        assert!(
            store
                .terminal_output(
                    &head.id,
                    TerminalQuery {
                        after_seq: Some(601),
                        wait_ms: None
                    }
                )
                .unwrap()
                .resync_required
        );
    }

    #[test]
    fn failed_checkpoint_rolls_back_watermark_pruning_and_new_events() {
        let directory = tempfile::TempDir::new().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let head = store
            .create_terminal(CreateTerminal {
                title: "Rollback".into(),
                workspace: "/synthetic".into(),
                size: TerminalSize { cols: 80, rows: 24 },
                agent: None,
                command: None,
                account_id: None,
                model: None,
                effort: None,
                approval_policy: None,
            })
            .unwrap();
        store.checkpoint_terminal(&head.id, archive(0, 2)).unwrap();
        store.connection.execute_batch("CREATE TRIGGER reject_output BEFORE INSERT ON terminal_output BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(store.checkpoint_terminal(&head.id, archive(1, 3)).is_err());
        let values: (i64, i64) = store
            .connection
            .query_row(
                "SELECT floor_seq,latest_seq FROM terminal_runs WHERE session_id=?",
                [&head.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(values, (0, 2));
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM terminal_output", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        store
            .connection
            .execute_batch("DROP TRIGGER reject_output")
            .unwrap();
        store.finish_terminal(&head.id, archive(1, 3)).unwrap();
        let page = store
            .terminal_output(
                &head.id,
                TerminalQuery {
                    after_seq: Some(1),
                    wait_ms: None,
                },
            )
            .unwrap();
        assert_eq!(page.events.len(), 2);
        assert_eq!(page.latest_seq, 3);
    }
}
