use rusqlite::{OptionalExtension, params};

use super::*;
use crate::database::Store;
use crate::error::{Error, Result};
use crate::protocol::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalPolicy {
    Manual,
    Auto,
}

impl ApprovalPolicy {
    fn label(self) -> &'static str {
        match self {
            ApprovalPolicy::Manual => "manual",
            ApprovalPolicy::Auto => "auto",
        }
    }
}

/// Claude collaboration mode persisted per session; applied as the headless
/// CLI's `--permission-mode` on each turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    Default,
    Plan,
}

impl PermissionMode {
    pub(crate) fn label(self) -> &'static str {
        match self {
            PermissionMode::Default => "default",
            PermissionMode::Plan => "plan",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AgentRun {
    pub agent: AgentKind,
    pub active: bool,
    pub policy: ApprovalPolicy,
    pub mode: PermissionMode,
    pub turn: i64,
    pub native_id: Option<String>,
}

impl Store {
    pub fn create_agent_session(
        &mut self,
        input: CreateAgentSession,
        policy: ApprovalPolicy,
    ) -> Result<SessionHead> {
        self.create_session_with(
            CreateSession {
                agent: AgentKind::Claude,
                kind: SessionKind::Structured,
                title: input.title,
                workspace: input.workspace,
            },
            |tx, head| {
                tx.execute(
                    "INSERT INTO agent_runs(session_id,agent,active,approval_policy,turn,native_id) VALUES(?1,'claude',1,?2,0,NULL)",
                    params![head.id, policy.label()],
                )?;
                Ok(())
            },
        )
    }

    pub(crate) fn agent_run(&self, id: &str) -> Result<AgentRun> {
        crate::database::validate_id(id)?;
        let row: (String, bool, String, String, i64, Option<String>) = self
            .connection
            .query_row(
                "SELECT agent,active,approval_policy,permission_mode,turn,native_id FROM agent_runs WHERE session_id=?",
                [id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        let policy = match row.2.as_str() {
            "manual" => ApprovalPolicy::Manual,
            "auto" => ApprovalPolicy::Auto,
            _ => return Err(Error::Schema),
        };
        let mode = match row.3.as_str() {
            "default" => PermissionMode::Default,
            "plan" => PermissionMode::Plan,
            _ => return Err(Error::Schema),
        };
        let agent = match row.0.as_str() {
            "claude" => AgentKind::Claude,
            _ => return Err(Error::Schema),
        };
        Ok(AgentRun {
            agent,
            active: row.1,
            policy,
            mode,
            turn: row.4,
            native_id: row.5,
        })
    }

    /// Persist the selected collaboration mode. Allowed only while the
    /// session is active; the running turn keeps its mode until the next send.
    pub(crate) fn set_agent_mode(&mut self, id: &str, mode: PermissionMode) -> Result<()> {
        crate::database::validate_id(id)?;
        let run = self.agent_run(id)?;
        if !run.active {
            return Err(Error::Conflict);
        }
        self.connection.execute(
            "UPDATE agent_runs SET permission_mode=?1 WHERE session_id=?2",
            params![mode.label(), id],
        )?;
        Ok(())
    }

    pub(crate) fn begin_agent_turn(&mut self, id: &str) -> Result<(i64, Option<String>)> {
        let run = self.agent_run(id)?;
        if !run.active {
            return Err(Error::Conflict);
        }
        if run.agent != AgentKind::Claude {
            return Err(Error::Schema);
        }
        let turn = run.turn + 1;
        self.connection.execute(
            "UPDATE agent_runs SET turn=?1 WHERE session_id=?2",
            params![turn, id],
        )?;
        Ok((turn, run.native_id))
    }

    pub(crate) fn set_agent_native_id(
        &mut self,
        id: &str,
        turn: i64,
        native_id: &str,
    ) -> Result<()> {
        crate::database::validate_id(native_id)?;
        let updated = self.connection.execute(
            "UPDATE agent_runs SET native_id=?1 WHERE session_id=?2 AND turn>=?3",
            params![native_id, id, turn],
        )?;
        if updated != 1 {
            return Err(Error::Conflict);
        }
        Ok(())
    }

    /// Mark a permission-request timeline record as resolved. Returns
    /// NotFound when no unresolved permission record exists.
    pub(crate) fn resolve_agent_permission(
        &mut self,
        session_id: &str,
        record_id: &str,
    ) -> Result<()> {
        self.resolve_agent_request_record(session_id, record_id, "permission_request")
    }

    /// Mark a question timeline record as resolved.
    pub(crate) fn resolve_agent_question(
        &mut self,
        session_id: &str,
        record_id: &str,
    ) -> Result<()> {
        self.resolve_agent_request_record(session_id, record_id, "question")
    }

    fn resolve_agent_request_record(
        &mut self,
        session_id: &str,
        record_id: &str,
        kind: &str,
    ) -> Result<()> {
        crate::database::validate_id(session_id)?;
        crate::database::validate_id(record_id)?;
        let transaction = self.connection.transaction()?;
        let updated = transaction.execute(
            "UPDATE timeline_records SET revision=revision+1, \
             body=json_set(body,'$.resolved',json('true')) \
             WHERE session_id=?1 AND id=?2 AND json_extract(body,'$.kind')=?3 \
             AND coalesce(json_extract(body,'$.resolved'),0)=0",
            params![session_id, record_id, kind],
        )?;
        if updated != 1 {
            return Err(Error::NotFound);
        }
        Self::append_event(
            &transaction,
            &format!("timeline:{session_id}"),
            "timeline.updated",
            record_id,
            serde_json::json!({"resolved": true}),
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Resolve every still-pending permission or question record in a
    /// session (used by interrupt and crash recovery; the CLI answers are
    /// denies or dropped callbacks).
    pub(crate) fn resolve_all_agent_requests(&mut self, session_id: &str) -> Result<usize> {
        crate::database::validate_id(session_id)?;
        let transaction = self.connection.transaction()?;
        let mut resolved = Vec::new();
        {
            let mut statement = transaction.prepare(
                "SELECT id FROM timeline_records WHERE session_id=?1 \
                 AND json_extract(body,'$.kind') IN ('permission_request','question') \
                 AND coalesce(json_extract(body,'$.resolved'),0)=0",
            )?;
            let rows = statement.query_map(params![session_id], |row| row.get::<_, String>(0))?;
            for row in rows {
                resolved.push(row?);
            }
        }
        for record_id in &resolved {
            transaction.execute(
                "UPDATE timeline_records SET revision=revision+1, \
                 body=json_set(body,'$.resolved',json('true')) WHERE id=?1",
                [record_id],
            )?;
            Self::append_event(
                &transaction,
                &format!("timeline:{session_id}"),
                "timeline.updated",
                record_id,
                serde_json::json!({"resolved": true}),
            )?;
        }
        transaction.commit()?;
        Ok(resolved.len())
    }

    pub fn archive_agent_session(&mut self, id: &str, failed: bool) -> Result<SessionHead> {
        let head = self.session(id)?;
        let run = self.agent_run(id)?;
        if !run.active {
            return Ok(head);
        }
        self.update_session_with(
            id,
            UpdateSession {
                revision: head.revision,
                title: None,
                lifecycle: Some(SessionLifecycle::Archived),
                status: Some(if failed {
                    SessionStatus::Failed
                } else {
                    SessionStatus::Completed
                }),
            },
            |tx| {
                tx.execute("UPDATE agent_runs SET active=0 WHERE session_id=?", [id])?;
                // Resolve any approvals/questions left pending by a dead process.
                tx.execute(
                    "UPDATE timeline_records SET revision=revision+1, \
                     body=json_set(body,'$.resolved',json('true')) \
                     WHERE session_id=?1 \
                     AND json_extract(body,'$.kind') IN ('permission_request','question') \
                     AND coalesce(json_extract(body,'$.resolved'),0)=0",
                    [id],
                )?;
                Ok(())
            },
        )
    }
}
