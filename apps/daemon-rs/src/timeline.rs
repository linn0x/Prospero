use std::collections::HashSet;

use rusqlite::{OptionalExtension, Transaction, params};

use crate::database::{Store, validate_id, validate_text};
use crate::error::{Error, Result};
use crate::protocol::*;

const MAX_POSITION: i64 = 9_007_199_254_740_991;
const MAX_BODY: i64 = 1024 * 1024 * 1024;
const PREVIEW_BYTES: usize = 4096;
const COLUMNS: &str = "r.id,r.turn_id,r.position,r.revision,r.generation,r.body,r.preview,c.bytes";
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
        if let Some(previous) = &previous {
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
        let transaction = self.connection.transaction()?;
        let next =
            Self::write_timeline_transaction(&transaction, session_id, input, body, previous)?;
        transaction.commit()?;
        Ok(next)
    }

    fn write_timeline_transaction(
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
        transaction.execute("INSERT INTO timeline_records(session_id,id,turn_id,position,revision,generation,body,preview) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(session_id,id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,body=excluded.body,preview=excluded.preview", params![session_id, input.id, input.turn_id, position, revision, generation, body, preview])?;
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
        let mut statement = self.connection.prepare_cached(&format!("SELECT {COLUMNS} FROM {SOURCE} WHERE r.session_id=?1 AND r.position {operator} ?2 ORDER BY r.position {order} LIMIT ?3"))?;
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
}
