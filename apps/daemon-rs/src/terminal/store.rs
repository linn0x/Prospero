use rusqlite::{OptionalExtension, params};

use super::*;
use crate::database::{Store, validate_id};
use crate::protocol::*;

impl Store {
    pub fn create_terminal(&mut self, input: CreateTerminal) -> Result<SessionHead> {
        let size = input.size.validate()?;
        self.create_session_with(
            CreateSession {
                agent: AgentKind::Shell,
                kind: SessionKind::Pty,
                title: input.title,
                workspace: input.workspace,
            },
            |tx, head| {
                tx.execute(
                    "INSERT INTO terminal_runs(session_id,cols,rows,active) VALUES(?1,?2,?3,1)",
                    params![head.id, size.cols, size.rows],
                )?;
                Ok(())
            },
        )
    }

    pub(crate) fn finish_terminal(&mut self, id: &str, archive: Archive) -> Result<SessionHead> {
        let head = self.session(id)?;
        self.update_session_with(id, UpdateSession { revision: head.revision, title: None, lifecycle: Some(SessionLifecycle::Archived), status: Some(if archive.exit_code == Some(0) { SessionStatus::Completed } else { SessionStatus::Failed }) }, |tx| {
            let changed = tx.execute("UPDATE terminal_runs SET active=0,floor_seq=?1,latest_seq=?2,exit_code=?3 WHERE session_id=?4 AND active=1", params![archive.floor, archive.seq, archive.exit_code, id])?;
            if changed != 1 { return Err(Error::Conflict); }
            for (offset, event) in archive.events.iter().enumerate() {
                tx.execute("INSERT INTO terminal_output(session_id,seq,payload) VALUES(?1,?2,?3)", params![id, archive.floor + offset as i64 + 1, serde_json::to_string(event)?])?;
            }
            Ok(())
        })
    }

    pub fn recover_terminals(&mut self) -> Result<usize> {
        let ids = self
            .connection
            .prepare(
                "SELECT session_id FROM terminal_runs WHERE active=1 ORDER BY session_id LIMIT 17",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if ids.len() > 16 {
            return Err(Error::Schema);
        }
        for id in &ids {
            self.finish_terminal(
                id,
                Archive {
                    floor: 0,
                    seq: 0,
                    events: Vec::new(),
                    exit_code: None,
                },
            )?;
        }
        Ok(ids.len())
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
        if after < 0 || after > latest {
            return Err(Error::Invalid("terminal cursor is ahead of output".into()));
        }
        let mut events = Vec::new();
        if after >= floor {
            let mut statement = self.connection.prepare("SELECT payload FROM terminal_output WHERE session_id=?1 AND seq>?2 ORDER BY seq LIMIT 64")?;
            let mut records = statement.query(params![id, after])?;
            let mut bytes = 0;
            while let Some(record) = records.next()? {
                let payload: String = record.get(0)?;
                if bytes + payload.len() > PAGE_BYTES {
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
            resync_required: after < floor,
            exited: true,
            exit_code: code,
        })
    }
}
