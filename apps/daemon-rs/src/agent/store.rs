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

/// Maximum number of messages that may wait for the current turn to finish
/// (mirrors legacy `MAX_MESSAGE_QUEUE`).
pub(crate) const MAX_MESSAGE_QUEUE: i64 = 50;

#[derive(Debug, Clone)]
pub(crate) struct QueuedRow {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub created_at: i64,
    pub attachments: Vec<crate::agent::AttachmentInput>,
}

fn decode_attachments(raw: &str) -> Vec<crate::agent::AttachmentInput> {
    serde_json::from_str(raw).unwrap_or_default()
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

    /// Terminal status for a turn (Idle/Failed). The write is a no-op when
    /// the session has been archived meanwhile (e.g. user closed the session
    /// while the turn was still running): archival's Failed/Completed status
    /// must not be resurrected to Idle by a late turn completion.
    pub(crate) fn finish_agent_turn_status(
        &mut self,
        id: &str,
        status: SessionStatus,
    ) -> Result<bool> {
        crate::database::validate_id(id)?;
        let head = self.session(id)?;
        let run = self.agent_run(id)?;
        if !run.active {
            return Ok(false);
        }
        self.update_session(
            id,
            UpdateSession {
                revision: head.revision,
                title: None,
                lifecycle: None,
                status: Some(status),
            },
        )?;
        Ok(true)
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
                // Queued text can never be delivered to a dead process, and
                // pending approvals/questions must not survive archiving.
                tx.execute("DELETE FROM agent_message_queue WHERE session_id=?", [id])?;
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

    /// Enqueue a message to be dispatched after the current turn finishes.
    /// `front=true` inserts before all existing rows (steer fallback / guide).
    pub(crate) fn enqueue_message(
        &mut self,
        session_id: &str,
        row: &QueuedRow,
        front: bool,
    ) -> Result<()> {
        crate::database::validate_id(session_id)?;
        crate::database::validate_id(&row.id)?;
        if row.kind != "queue" && row.kind != "guide" {
            return Err(Error::Invalid("invalid queue kind".into()));
        }
        crate::agent::validate_message(&row.text, &row.attachments)?;
        let transaction = self.connection.transaction()?;
        let count: i64 = transaction.query_row(
            "SELECT count(*) FROM agent_message_queue WHERE session_id=?",
            [session_id],
            |r| r.get(0),
        )?;
        if count >= MAX_MESSAGE_QUEUE {
            return Err(Error::Invalid(format!(
                "消息队列已满（最多 {MAX_MESSAGE_QUEUE} 条）"
            )));
        }
        let run_active: Option<bool> = transaction
            .query_row(
                "SELECT active=1 FROM agent_runs WHERE session_id=?",
                [session_id],
                |r| r.get(0),
            )
            .optional()?;
        if !run_active.unwrap_or(false) {
            return Err(Error::Conflict);
        }
        let position: i64 = if front {
            // Minus one keeps a stable FIFO tie-break across multiple
            // front inserts; position is a synthetic ordering key.
            transaction.query_row(
                "SELECT coalesce(min(position)-1,0) FROM agent_message_queue WHERE session_id=?",
                [session_id],
                |r| r.get(0),
            )?
        } else {
            transaction.query_row(
                "SELECT coalesce(max(position)+1,0) FROM agent_message_queue WHERE session_id=?",
                [session_id],
                |r| r.get(0),
            )?
        };
        let attachments = serde_json::to_string(&row.attachments).unwrap_or_else(|_| "[]".into());
        transaction.execute(
            "INSERT INTO agent_message_queue(session_id,queue_id,position,kind,text,created_at,attachments) \
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            rusqlite::params![
                session_id,
                row.id,
                position,
                row.kind,
                row.text,
                row.created_at,
                attachments
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Read the queue in dispatch order (guide rows first, otherwise FIFO).
    pub(crate) fn message_queue(&self, session_id: &str) -> Result<Vec<QueuedRow>> {
        crate::database::validate_id(session_id)?;
        let mut statement = self.connection.prepare(
            "SELECT queue_id,kind,text,created_at,attachments FROM agent_message_queue \
             WHERE session_id=?1 ORDER BY position ASC",
        )?;
        let rows = statement.query_map([session_id], |row| {
            Ok(QueuedRow {
                id: row.get(0)?,
                kind: row.get(1)?,
                text: row.get(2)?,
                created_at: row.get(3)?,
                attachments: decode_attachments(&row.get::<_, String>(4)?),
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// All non-empty queues across active sessions (desktop list projection).
    /// Attachment bytes are not decoded here — the projection only carries the
    /// count; `message_queue` returns a single session's full rows.
    pub(crate) fn message_queues(&self) -> Result<Vec<(String, Vec<QueuedRow>)>> {
        let mut statement = self.connection.prepare(
            "SELECT q.session_id,q.queue_id,q.kind,q.text,q.created_at,q.attachments \
             FROM agent_message_queue q \
             JOIN session_heads h ON h.id=q.session_id \
             WHERE h.lifecycle='active' \
             ORDER BY q.session_id ASC, q.position ASC",
        )?;
        let rows = statement.query_map([], |row| {
            let attachments_raw: String = row.get(5)?;
            Ok((
                row.get::<_, String>(0)?,
                QueuedRow {
                    id: row.get(1)?,
                    kind: row.get(2)?,
                    text: row.get(3)?,
                    created_at: row.get(4)?,
                    attachments: decode_attachments(&attachments_raw),
                },
            ))
        })?;
        let mut queues: Vec<(String, Vec<QueuedRow>)> = Vec::new();
        for row in rows {
            let (session_id, item) = row?;
            match queues.last_mut() {
                Some(entry) if entry.0 == session_id => entry.1.push(item),
                _ => queues.push((session_id, vec![item])),
            }
        }
        Ok(queues)
    }

    /// Delete a queued message. NotFound when no such row exists.
    pub(crate) fn remove_message(&mut self, session_id: &str, queue_id: &str) -> Result<()> {
        crate::database::validate_id(session_id)?;
        crate::database::validate_id(queue_id)?;
        let changed = self.connection.execute(
            "DELETE FROM agent_message_queue WHERE session_id=?1 AND queue_id=?2",
            rusqlite::params![session_id, queue_id],
        )?;
        if changed != 1 {
            return Err(Error::NotFound);
        }
        Ok(())
    }

    /// Move a queued message to the front and mark it as a guide.
    /// NotFound when no such row exists.
    pub(crate) fn guide_message(&mut self, session_id: &str, queue_id: &str) -> Result<()> {
        crate::database::validate_id(session_id)?;
        crate::database::validate_id(queue_id)?;
        let transaction = self.connection.transaction()?;
        let (text, created_at, attachments): (String, i64, String) = transaction
            .query_row(
                "SELECT text,created_at,attachments FROM agent_message_queue \
                 WHERE session_id=?1 AND queue_id=?2",
                rusqlite::params![session_id, queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        transaction.execute(
            "DELETE FROM agent_message_queue WHERE session_id=?1 AND queue_id=?2",
            rusqlite::params![session_id, queue_id],
        )?;
        let front: i64 = transaction.query_row(
            "SELECT coalesce(min(position)-1,0) FROM agent_message_queue WHERE session_id=?",
            [session_id],
            |r| r.get(0),
        )?;
        transaction.execute(
            "INSERT INTO agent_message_queue(session_id,queue_id,position,kind,text,created_at,attachments) \
             VALUES(?1,?2,?3,'guide',?4,?5,?6)",
            rusqlite::params![session_id, queue_id, front, text, created_at, attachments],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Atomically remove and return the front queued message. Used by the
    /// drain loop when a turn has ended.
    pub(crate) fn pop_message(&mut self, session_id: &str) -> Result<Option<QueuedRow>> {
        crate::database::validate_id(session_id)?;
        let transaction = self.connection.transaction()?;
        let row = transaction
            .query_row(
                "SELECT queue_id,kind,text,created_at,attachments FROM agent_message_queue \
                 WHERE session_id=?1 ORDER BY position ASC LIMIT 1",
                [session_id],
                |row| {
                    Ok(QueuedRow {
                        id: row.get(0)?,
                        kind: row.get(1)?,
                        text: row.get(2)?,
                        created_at: row.get(3)?,
                        attachments: decode_attachments(&row.get::<_, String>(4)?),
                    })
                },
            )
            .optional()?;
        if let Some(row) = &row {
            transaction.execute(
                "DELETE FROM agent_message_queue WHERE session_id=?1 AND queue_id=?2",
                rusqlite::params![session_id, row.id],
            )?;
        }
        transaction.commit()?;
        Ok(row)
    }
}
