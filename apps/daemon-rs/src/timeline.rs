use std::collections::HashSet;

use rusqlite::{OptionalExtension, Transaction, params};

use crate::database::{Store, validate_id, validate_text};
use crate::error::{Error, Result};
use crate::protocol::*;

const MAX_POSITION: i64 = 9_007_199_254_740_991;
const MAX_BODY: i64 = 1024 * 1024 * 1024;
const PREVIEW_BYTES: usize = 4096;
const COLUMNS: &str =
    "r.id,r.turn_id,r.position,r.revision,r.generation,r.body,r.preview,c.bytes,r.subagent_id";
const SOURCE: &str =
    "timeline_records r JOIN content_heads c ON c.session_id=r.session_id AND c.id=r.id";

fn record(row: &rusqlite::Row<'_>) -> rusqlite::Result<TimelineRecord> {
    let json: String = row.get(5)?;
    let body = serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let preview: String = row.get(6)?;
    let bytes: i64 = row.get(7)?;
    Ok(TimelineRecord {
        id: row.get(0)?,
        turn_id: row.get(1)?,
        position: row.get(2)?,
        revision: row.get(3)?,
        generation: row.get(4)?,
        body,
        truncated: bytes > preview.len() as i64,
        preview,
        bytes,
        subagent_id: row.get(8)?,
    })
}

fn preview(mut text: String) -> String {
    let mut end = text.len().min(PREVIEW_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text
}

/// Agent-generated record ids carry prefixes (`sub-{id}-…`, permission uuids)
/// and may be longer than the generic 128-char id limit.
fn validate_record_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 256
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(Error::Invalid("invalid record id".into()));
    }
    Ok(())
}

impl Store {
    pub fn seed_conversation(&mut self, turns: usize) -> Result<SessionHead> {
        if turns == 0 || turns > 25000 || self.session_summary(None)?.total != 0 {
            return Err(Error::Invalid(
                "conversation seeding requires an empty database and 1..25000 turns".into(),
            ));
        }
        let session = self.create_session(CreateSession {
            agent: AgentKind::Codex,
            kind: SessionKind::Structured,
            title: "Conversation benchmark".into(),
            workspace: "/synthetic".into(),
        })?;
        let transaction = self.connection.transaction()?;
        for index in 0..turns {
            let entries = [
                (
                    TimelineBody::Message {
                        role: MessageRole::User,
                        final_answer: false,
                    },
                    format!("Synthetic prompt {index}"),
                ),
                (
                    TimelineBody::Tool {
                        name: "Example tool".into(),
                        state: ToolState::Success,
                        summary: format!("Synthetic tool result {index}"),
                    },
                    "Synthetic tool output. 中文 🦀\n".repeat(if index + 1 == turns {
                        5000
                    } else {
                        1
                    }),
                ),
                (
                    TimelineBody::Message {
                        role: MessageRole::Assistant,
                        final_answer: true,
                    },
                    format!("Synthetic response {index}. 中文 🦀\n")
                        .repeat(if index + 1 == turns { 5000 } else { 1 }),
                ),
                (
                    TimelineBody::TurnEnd {
                        finish: "completed".into(),
                    },
                    String::new(),
                ),
            ];
            for (part, (body, text)) in entries.into_iter().enumerate() {
                let encoded = serde_json::to_string(&body)?;
                Self::write_timeline_transaction(
                    &transaction,
                    &session.id,
                    TimelineWrite {
                        id: format!("record-{:09}", index * 4 + part),
                        turn_id: format!("turn-{index}"),
                        expected_revision: 0,
                        body,
                        text,
                        replace: false,
                        subagent_id: None,
                    },
                    encoded,
                    None,
                )?;
            }
        }
        transaction.commit()?;
        self.update_session(
            &session.id,
            UpdateSession {
                revision: 1,
                title: None,
                lifecycle: Some(SessionLifecycle::Archived),
                status: Some(SessionStatus::Completed),
            },
        )
    }

    pub fn timeline_record(&self, session_id: &str, id: &str) -> Result<TimelineRecord> {
        validate_id(session_id)?;
        validate_id(id)?;
        self.connection
            .query_row(
                &format!("SELECT {COLUMNS} FROM {SOURCE} WHERE r.session_id=?1 AND r.id=?2"),
                params![session_id, id],
                record,
            )
            .optional()?
            .ok_or(Error::NotFound)
    }

    pub fn write_timeline(
        &mut self,
        session_id: &str,
        input: TimelineWrite,
    ) -> Result<TimelineRecord> {
        self.session(session_id)?;
        validate_id(&input.id)?;
        validate_id(&input.turn_id)?;
        if !(0..MAX_POSITION).contains(&input.expected_revision)
            || input.text.len() > CONTENT_CHUNK_BYTES
        {
            return Err(Error::Invalid("invalid timeline write".into()));
        }
        match &input.body {
            TimelineBody::Tool { name, summary, .. } => {
                validate_text(name, 128, false)?;
                if summary.len() > 2048 {
                    return Err(Error::Invalid("tool summary exceeds limit".into()));
                }
            }
            TimelineBody::TurnEnd { finish }
                if !["completed", "failed", "interrupted"].contains(&finish.as_str())
                    || !input.text.is_empty() =>
            {
                return Err(Error::Invalid("invalid turn result".into()));
            }
            _ => {}
        }
        let body = serde_json::to_string(&input.body)?;
        if body.len() > 8192 {
            return Err(Error::Invalid("timeline metadata exceeds limit".into()));
        }
        let previous = match self.timeline_record(session_id, &input.id) {
            Ok(record) => Some(record),
            Err(Error::NotFound) => None,
            Err(error) => return Err(error),
        };
        if previous.as_ref().map_or(0, |record| record.revision) != input.expected_revision {
            return Err(Error::Conflict);
        }
        Self::check_timeline_identity(previous.as_ref(), &input)?;
        let transaction = self.connection.transaction()?;
        let next =
            Self::write_timeline_transaction(&transaction, session_id, input, body, previous)?;
        transaction.commit()?;
        Ok(next)
    }

    fn check_timeline_identity(
        previous: Option<&TimelineRecord>,
        input: &TimelineWrite,
    ) -> Result<()> {
        if let Some(previous) = previous {
            if previous.turn_id != input.turn_id
                || std::mem::discriminant(&previous.body) != std::mem::discriminant(&input.body)
            {
                return Err(Error::Invalid("timeline identity is immutable".into()));
            }
            if let (
                TimelineBody::Message { role: before, .. },
                TimelineBody::Message { role: after, .. },
            ) = (&previous.body, &input.body)
                && before != after
            {
                return Err(Error::Invalid("message role is immutable".into()));
            }
        }
        Ok(())
    }

    /// Append several agent records in one transaction. Streaming deltas reuse
    /// the same record id and carry the revision last seen by the caller.
    pub(crate) fn append_agent_records(
        &mut self,
        session_id: &str,
        writes: Vec<TimelineWrite>,
    ) -> Result<()> {
        if writes.is_empty() {
            return Ok(());
        }
        validate_id(session_id)?;
        self.session(session_id)?;
        let transaction = self.connection.transaction()?;
        for input in writes {
            validate_record_id(&input.id)?;
            validate_id(&input.turn_id)?;
            if let Some(subagent) = &input.subagent_id {
                validate_id(subagent)?;
            }
            if input.text.len() > CONTENT_CHUNK_BYTES {
                return Err(Error::Invalid("invalid timeline write".into()));
            }
            if let TimelineBody::Tool { name, summary, .. } = &input.body {
                validate_text(name, 128, false)?;
                if summary.len() > 2048 {
                    return Err(Error::Invalid("tool summary exceeds limit".into()));
                }
            }
            if let TimelineBody::Subagent {
                subagent_id,
                name,
                role,
                task,
                status,
                summary,
                ..
            } = &input.body
            {
                if subagent_id != input.subagent_id.as_deref().unwrap_or_default()
                    && input.subagent_id.is_some()
                {
                    return Err(Error::Invalid("subagent identity mismatch".into()));
                }
                validate_text(name, 300, false)?;
                if role.as_deref().is_some_and(|role| role.len() > 300)
                    || task.as_deref().is_some_and(|task| task.len() > 8000)
                    || summary.len() > 1000
                    || !matches!(
                        status.as_str(),
                        "starting" | "running" | "idle" | "completed" | "failed" | "stopped"
                    )
                {
                    return Err(Error::Invalid("invalid subagent card".into()));
                }
            }
            let body = serde_json::to_string(&input.body)?;
            if body.len() > 8192 {
                return Err(Error::Invalid("timeline metadata exceeds limit".into()));
            }
            let previous = transaction
                .query_row(
                    &format!("SELECT {COLUMNS} FROM {SOURCE} WHERE r.session_id=?1 AND r.id=?2"),
                    params![session_id, input.id],
                    record,
                )
                .optional()?;
            if previous
                .as_ref()
                .map_or(0, |record: &TimelineRecord| record.revision)
                != input.expected_revision
            {
                return Err(Error::Conflict);
            }
            Self::check_timeline_identity(previous.as_ref(), &input)?;
            Self::write_timeline_transaction(&transaction, session_id, input, body, previous)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn write_timeline_transaction(
        transaction: &Transaction<'_>,
        session_id: &str,
        input: TimelineWrite,
        body: String,
        previous: Option<TimelineRecord>,
    ) -> Result<TimelineRecord> {
        let position = if let Some(previous) = &previous {
            previous.position
        } else {
            transaction.execute("INSERT INTO timeline_heads(session_id,position) VALUES(?1,0) ON CONFLICT DO NOTHING", [session_id])?;
            transaction.execute(
                "INSERT INTO content_heads(session_id,id,bytes) VALUES(?1,?2,0)",
                params![session_id, input.id],
            )?;
            transaction.query_row("UPDATE timeline_heads SET position=position+1 WHERE session_id=?1 RETURNING position", [session_id], |row| row.get(0))?
        };
        let old_bytes = if input.replace {
            0
        } else {
            previous.as_ref().map_or(0, |record| record.bytes)
        };
        let bytes = old_bytes + input.text.len() as i64;
        if bytes > MAX_BODY {
            return Err(Error::Invalid("timeline body exceeds limit".into()));
        }
        let generation = previous
            .as_ref()
            .map_or(1, |record| record.generation + i64::from(input.replace));
        if input.replace {
            transaction.execute(
                "DELETE FROM content_chunks WHERE session_id=?1 AND content_id=?2",
                params![session_id, input.id],
            )?;
        }
        if !input.text.is_empty() {
            let tail_offset = old_bytes / CONTENT_CHUNK_BYTES as i64 * CONTENT_CHUNK_BYTES as i64;
            let mut tail: Vec<u8> = if old_bytes % CONTENT_CHUNK_BYTES as i64 != 0 {
                transaction.query_row("SELECT body FROM content_chunks WHERE session_id=?1 AND content_id=?2 AND offset=?3", params![session_id, input.id, tail_offset], |row| row.get(0))?
            } else {
                Vec::new()
            };
            if tail.len() as i64 != old_bytes - tail_offset {
                return Err(Error::Schema);
            }
            tail.extend(input.text.as_bytes());
            for (index, chunk) in tail.chunks(CONTENT_CHUNK_BYTES).enumerate() {
                transaction.execute("INSERT INTO content_chunks(session_id,content_id,offset,body) VALUES(?1,?2,?3,?4) ON CONFLICT(session_id,content_id,offset) DO UPDATE SET body=excluded.body", params![session_id, input.id, tail_offset + (index * CONTENT_CHUNK_BYTES) as i64, chunk])?;
            }
        }
        transaction.execute(
            "UPDATE content_heads SET bytes=?1 WHERE session_id=?2 AND id=?3",
            params![bytes, session_id, input.id],
        )?;
        let preview = match &previous {
            Some(previous) if !input.replace && previous.bytes < PREVIEW_BYTES as i64 => {
                preview(format!("{}{}", previous.preview, input.text))
            }
            Some(previous) if !input.replace => previous.preview.clone(),
            _ => preview(input.text),
        };
        let revision = input.expected_revision + 1;
        transaction.execute("INSERT INTO timeline_records(session_id,id,turn_id,position,revision,generation,body,preview,subagent_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(session_id,id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,body=excluded.body,preview=excluded.preview", params![session_id, input.id, input.turn_id, position, revision, generation, body, preview, input.subagent_id])?;
        if let TimelineBody::Subagent {
            subagent_id,
            name,
            role,
            task,
            status,
            can_message,
            summary,
            created_at,
            updated_at,
        } = &input.body
        {
            // The card doubles as the source of truth for the registry; an
            // empty synthetic name inherits the previous one (or a numbered
            // fallback), matching the legacy adapter.
            let existing_name: Option<String> = transaction
                .query_row(
                    "SELECT name FROM agent_subagents WHERE session_id=?1 AND subagent_id=?2",
                    params![session_id, subagent_id],
                    |row| row.get(0),
                )
                .optional()?;
            let fallback_name = match existing_name {
                Some(name) if !name.is_empty() => name,
                _ => {
                    let count: i64 = transaction.query_row(
                        "SELECT count(*) FROM agent_subagents WHERE session_id=?1",
                        [session_id],
                        |row| row.get(0),
                    )?;
                    format!("Claude 子 Agent {}", count + 1)
                }
            };
            let effective_name = if name.is_empty() {
                fallback_name
            } else {
                name.clone()
            };
            transaction.execute(
                "INSERT INTO agent_subagents(session_id,subagent_id,name,role,task,status,can_message,summary,created_at,updated_at) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) \
                 ON CONFLICT(session_id,subagent_id) DO UPDATE SET \
                 name=excluded.name, role=COALESCE(excluded.role,agent_subagents.role), \
                 task=COALESCE(excluded.task,agent_subagents.task), status=excluded.status, \
                 can_message=excluded.can_message, \
                 summary=CASE WHEN excluded.summary<>'' THEN excluded.summary ELSE agent_subagents.summary END, \
                 updated_at=excluded.updated_at",
                params![session_id, subagent_id, effective_name, role, task, status,
                    i64::from(*can_message), summary, created_at, updated_at],
            )?;
        }
        Self::append_event(
            transaction,
            &format!("timeline:{session_id}"),
            "timeline.updated",
            &input.id,
            serde_json::json!({"position":position,"revision":revision}),
        )?;
        Ok(TimelineRecord {
            id: input.id,
            turn_id: input.turn_id,
            position,
            revision,
            body: input.body,
            truncated: bytes > preview.len() as i64,
            preview,
            bytes,
            generation,
            subagent_id: input.subagent_id,
        })
    }

    fn timeline_head(&self, session_id: &str) -> Result<(i64, i64)> {
        validate_id(session_id)?;
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_heads WHERE id=?)",
            [session_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(Error::NotFound);
        }
        let position = self
            .connection
            .query_row(
                "SELECT position FROM timeline_heads WHERE session_id=?",
                [session_id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let revision = self
            .connection
            .query_row(
                "SELECT last_seq FROM stream_heads WHERE scope=?",
                [format!("timeline:{session_id}")],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        Ok((position, revision))
    }

    pub fn timeline(&self, session_id: &str, query: TimelineQuery) -> Result<TimelinePage> {
        let (latest_position, revision) = self.timeline_head(session_id)?;
        let limit = query.limit.unwrap_or(40);
        if !(1..=100).contains(&limit)
            || query.before.is_some() && query.after.is_some()
            || query
                .before
                .into_iter()
                .chain(query.after)
                .any(|cursor| !(0..=MAX_POSITION).contains(&cursor))
        {
            return Err(Error::Invalid("invalid timeline page".into()));
        }
        let ascending = query.after.is_some();
        let (operator, order, cursor) = if let Some(after) = query.after {
            (">", "ASC", after)
        } else {
            ("<", "DESC", query.before.unwrap_or(i64::MAX))
        };
        let mut statement = self.connection.prepare_cached(&format!("SELECT {COLUMNS} FROM {SOURCE} WHERE r.session_id=?1 AND r.position {operator} ?2 AND r.subagent_id IS NULL ORDER BY r.position {order} LIMIT ?3"))?;
        let mut items = Vec::new();
        let mut bytes = 0;
        for row in statement.query_map(params![session_id, cursor, limit as i64], record)? {
            let item = row?;
            bytes += serde_json::to_vec(&item)?.len();
            if bytes > MAX_PAGE_BYTES {
                break;
            }
            items.push(item);
        }
        if !ascending {
            items.reverse();
        }
        let older = items
            .first()
            .filter(|item| item.position > 1)
            .map(|item| item.position);
        let newer = items
            .last()
            .filter(|item| item.position < latest_position)
            .map(|item| item.position);
        Ok(TimelinePage {
            items,
            older,
            newer,
            latest_position,
            revision,
        })
    }

    pub fn timeline_lookup(
        &self,
        session_id: &str,
        ids: Vec<String>,
    ) -> Result<TimelineLookupResult> {
        let (latest_position, revision) = self.timeline_head(session_id)?;
        if ids.len() > 40 {
            return Err(Error::Invalid("timeline lookup limit is 40".into()));
        }
        let mut seen = HashSet::new();
        let mut items = Vec::new();
        for id in ids {
            validate_id(&id)?;
            if !seen.insert(id.clone()) {
                continue;
            }
            match self.timeline_record(session_id, &id) {
                Ok(record) => items.push(record),
                Err(Error::NotFound) => {}
                Err(error) => return Err(error),
            }
        }
        items.sort_by_key(|record| record.position);
        Ok(TimelineLookupResult {
            items,
            latest_position,
            revision,
        })
    }

    pub fn timeline_text(
        &self,
        session_id: &str,
        id: &str,
        query: TimelineTextQuery,
    ) -> Result<TimelineTextPage> {
        let head = self.timeline_record(session_id, id)?;
        if query
            .generation
            .is_some_and(|generation| generation != head.generation)
        {
            return Err(Error::Conflict);
        }
        let part = query.part.unwrap_or(0);
        let offset = i64::from(part) * CONTENT_CHUNK_BYTES as i64;
        if offset > head.bytes || offset == head.bytes && part != 0 {
            return Err(Error::Invalid("body page is beyond the content".into()));
        }
        let mut statement = self.connection.prepare_cached("SELECT offset,body FROM content_chunks WHERE session_id=?1 AND content_id=?2 AND offset>=?3 ORDER BY offset LIMIT 2")?;
        let mut data = Vec::new();
        let mut expected = offset;
        for row in statement.query_map(params![session_id, id, offset], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })? {
            let (position, bytes) = row?;
            if position != expected {
                return Err(Error::Schema);
            }
            expected += bytes.len() as i64;
            data.extend(bytes);
        }
        if expected != head.bytes.min(offset + (CONTENT_CHUNK_BYTES * 2) as i64) {
            return Err(Error::Schema);
        }
        let mut start = 0;
        while start < data.len() && data[start] & 0xc0 == 0x80 {
            start += 1;
        }
        let mut end = data.len().min(CONTENT_CHUNK_BYTES);
        while end < data.len() && data[end] & 0xc0 == 0x80 {
            end += 1;
        }
        if start > 3 || end > CONTENT_CHUNK_BYTES + 3 || end < start {
            return Err(Error::Schema);
        }
        let text = std::str::from_utf8(&data[start..end])
            .map_err(|_| Error::Schema)?
            .to_owned();
        Ok(TimelineTextPage {
            text,
            part,
            next_part: (offset + (end as i64) < head.bytes).then_some(part + 1),
            previous_part: part.checked_sub(1),
            total_bytes: head.bytes,
            generation: head.generation,
        })
    }

    /// Full persisted text of a timeline record (used by the on-demand
    /// subagent transcript, whose preview may be truncated). Bounded to keep
    /// a single snapshot response small.
    fn record_full_text(&self, session_id: &str, id: &str) -> Result<String> {
        validate_id(session_id)?;
        validate_record_id(id)?;
        let mut statement = self.connection.prepare_cached(
            "SELECT body FROM content_chunks WHERE session_id=?1 AND content_id=?2 ORDER BY offset",
        )?;
        let chunks: Vec<Vec<u8>> = statement
            .query_map(params![session_id, id], |row| row.get::<_, Vec<u8>>(0))?
            .take(32)
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut data = Vec::new();
        for chunk in chunks {
            data.extend(chunk);
        }
        let text = String::from_utf8_lossy(&data).into_owned();
        Ok(text)
    }

    /// List a session's known Task-tool subagents, newest first.
    pub fn list_subagents(&self, session_id: &str) -> Result<Vec<crate::agent::SubagentInfo>> {
        validate_id(session_id)?;
        let mut statement = self.connection.prepare_cached(
            "SELECT subagent_id,name,role,task,status,can_message,created_at,updated_at,summary \
             FROM agent_subagents WHERE session_id=?1 ORDER BY created_at DESC, subagent_id",
        )?;
        let rows = statement.query_map([session_id], |row| {
            let can_message: i64 = row.get(5)?;
            Ok(crate::agent::SubagentInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                role: row.get(2)?,
                task: row.get(3)?,
                status: row.get(4)?,
                can_message: can_message != 0,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                preview: row.get::<_, String>(8).ok().filter(|text| !text.is_empty()),
            })
        })?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        Ok(items)
    }

    /// The "查看执行详情" snapshot: metadata plus legacy-shaped chat events
    /// for everything attributed to the subagent (its own transcript and any
    /// approval cards that rode along in the main timeline).
    pub fn subagent_snapshot(
        &self,
        session_id: &str,
        subagent: &str,
    ) -> Result<crate::agent::SubagentSnapshot> {
        validate_id(session_id)?;
        validate_id(subagent)?;
        let info = self
            .connection
            .query_row(
                "SELECT subagent_id,name,role,task,status,can_message,created_at,updated_at,summary \
                 FROM agent_subagents WHERE session_id=?1 AND subagent_id=?2",
                params![session_id, subagent],
                |row| {
                    let can_message: i64 = row.get(5)?;
                    Ok(crate::agent::SubagentInfo {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        role: row.get(2)?,
                        task: row.get(3)?,
                        status: row.get(4)?,
                        can_message: can_message != 0,
                        created_at: row.get(6)?,
                        updated_at: row.get(7)?,
                        preview: row
                            .get::<_, String>(8)
                            .ok()
                            .filter(|text| !text.is_empty()),
                    })
                },
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        let mut statement = self.connection.prepare_cached(&format!(
            "SELECT {COLUMNS} FROM {SOURCE} WHERE r.session_id=?1 AND (\
             r.subagent_id=?2 OR (\
             r.subagent_id IS NULL AND json_extract(r.body,'$.kind') IN \
             ('permission_request','question') \
             AND json_extract(r.body,'$.subagent')=?2)) \
             ORDER BY r.position ASC LIMIT 1000"
        ))?;
        let records: Vec<TimelineRecord> = statement
            .query_map(params![session_id, subagent], record)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut events = Vec::with_capacity(records.len());
        for item in records {
            if let Some(event) =
                subagent_chat_event(&item, &|id| self.record_full_text(session_id, id))
            {
                events.push(event);
            }
        }
        let (_, ev_seq) = self.timeline_head(session_id)?;
        Ok(crate::agent::SubagentSnapshot {
            subagent: info,
            events,
            ev_seq,
        })
    }
}

/// Map one persisted timeline record into the legacy chat-event shape the
/// renderer's subagent detail pane already understands.
fn subagent_chat_event(
    record: &TimelineRecord,
    full_text: &dyn Fn(&str) -> Result<String>,
) -> Option<serde_json::Value> {
    use serde_json::json;
    let shared = json!({"msgId": record.turn_id, "callId": record.id});
    let text = full_text(&record.id).unwrap_or_else(|_| record.preview.clone());
    let event = match &record.body {
        TimelineBody::Message {
            role: MessageRole::Assistant,
            ..
        } => json!({ "kind": "assistant.text", "text": text }),
        TimelineBody::Message {
            role: MessageRole::User,
            ..
        } => json!({ "kind": "user.message", "text": text }),
        TimelineBody::Reasoning => json!({ "kind": "reasoning", "text": text }),
        TimelineBody::Tool { name, state, .. } => {
            let running = *state == ToolState::Running;
            json!({
                "kind": if running { "tool.start" } else { "tool.end" },
                "tool": name,
                "state": match state {
                    ToolState::Running => "running",
                    ToolState::Success => "success",
                    ToolState::Failed => "failed",
                },
                "summary": text,
            })
        }
        TimelineBody::PermissionRequest {
            request_id,
            tool,
            resolved,
            ..
        } => json!({
            "kind": "permission.request",
            "reqId": request_id,
            "tool": tool,
            "summary": record.preview,
            "resolved": resolved,
        }),
        TimelineBody::Error => json!({ "kind": "agent.error", "message": record.preview }),
        // Questions in a subagent transcript render with the same card shape
        // as main-timeline questions.
        TimelineBody::Question {
            request_id,
            questions,
            resolved,
            ..
        } => json!({
            "kind": "question.request",
            "reqId": request_id,
            "questions": questions,
            "resolved": resolved,
        }),
        // Cards, turn markers and user prompts don't belong in the detail log.
        TimelineBody::Subagent { .. } | TimelineBody::TurnEnd { .. } => return None,
    };
    let mut merged = shared;
    if let (Some(base), Some(extra)) = (merged.as_object_mut(), event.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    Some(merged)
}
