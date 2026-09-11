use std::fs::{self, File, OpenOptions};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::protocol::*;

const APPLICATION_ID: i64 = 0x50525253;
const SCHEMA_VERSION: i64 = 4;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_CONTENT_BYTES: i64 = 1024 * 1024 * 1024;

pub struct Store {
    pub(crate) connection: Connection,
    _lock: File,
}

pub(crate) fn label<T: Serialize>(value: T) -> Result<String> {
    let value = serde_json::to_value(value)?;
    value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::Invalid("invalid enum".into()))
}

pub(crate) fn validate_text(value: &str, maximum: usize, empty: bool) -> Result<()> {
    if (!empty && value.trim().is_empty())
        || value.len() > maximum
        || value.chars().any(char::is_control)
    {
        return Err(Error::Invalid("invalid text field".into()));
    }
    Ok(())
}

pub(crate) fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(Error::Invalid("invalid record id".into()));
    }
    Ok(())
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn private_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(Error::Invalid("invalid database file".into()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if file.metadata()?.nlink() != 1 {
            return Err(Error::Invalid("linked data file".into()));
        }
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        if directory.join("orchestration.json").exists()
            || directory.join("sessions.sqlite").exists()
        {
            return Err(Error::Invalid("use an isolated Rust data directory".into()));
        }
        if directory.exists() && fs::symlink_metadata(directory)?.file_type().is_symlink() {
            return Err(Error::Invalid(
                "data directory must not be a symlink".into(),
            ));
        }
        fs::create_dir_all(directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        }
        let lock = private_file(&directory.join("owner.lock"))?;
        lock.try_lock_exclusive()
            .map_err(|_| Error::AlreadyRunning)?;
        let database = directory.join("prospero.sqlite");
        let existed = database.try_exists()?;
        let file = private_file(&database)?;
        if !existed {
            file.sync_all()?;
        }
        drop(file);
        for suffix in ["-wal", "-shm", "-journal"] {
            let sidecar = directory.join(format!("prospero.sqlite{suffix}"));
            if sidecar.exists() || fs::symlink_metadata(&sidecar).is_ok() {
                private_file(&sidecar)?;
            }
        }
        let mut connection = Connection::open(&database)?;
        connection.busy_timeout(Duration::from_millis(1000))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-8192; PRAGMA mmap_size=0;")?;
        let application: i64 = connection.query_row("PRAGMA application_id", [], |r| r.get(0))?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if application == 0 && version == 0 {
            let tables: i64 =
                connection.query_row("SELECT count(*) FROM sqlite_schema", [], |r| r.get(0))?;
            if tables != 0 {
                return Err(Error::Schema);
            }
            let transaction = connection.transaction()?;
            transaction.execute_batch(include_str!("schema.sql"))?;
            transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
            transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            transaction.commit()?;
        } else if application != APPLICATION_ID || version != SCHEMA_VERSION {
            return Err(Error::Schema);
        }
        let sqlite_version: String =
            connection.query_row("SELECT sqlite_version()", [], |r| r.get(0))?;
        let parts: Vec<u32> = sqlite_version
            .split('.')
            .map(|s| s.parse().unwrap_or_default())
            .collect();
        if parts.as_slice() < [3, 51, 3].as_slice() {
            return Err(Error::Schema);
        }
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=8388608;")?;
        connection.prepare(
            "SELECT id,created_at,lifecycle,revision,payload FROM session_heads LIMIT 0",
        )?;
        Ok(Self {
            connection,
            _lock: lock,
        })
    }

    pub fn create_session(&mut self, input: CreateSession) -> Result<SessionHead> {
        validate_text(&input.title, 512, false)?;
        validate_text(&input.workspace, 4096, false)?;
        let timestamp = now();
        let session = SessionHead {
            id: uuid::Uuid::new_v4().to_string(),
            agent: input.agent,
            kind: input.kind,
            title: input.title,
            workspace: input.workspace,
            lifecycle: SessionLifecycle::Active,
            status: SessionStatus::Idle,
            created_at: timestamp,
            updated_at: timestamp,
            revision: 1,
        };
        let transaction = self.connection.transaction()?;
        Self::insert_session(&transaction, &session)?;
        Self::append_event(
            &transaction,
            "sessions",
            "session.created",
            &session.id,
            serde_json::to_value(&session)?,
        )?;
        transaction.commit()?;
        Ok(session)
    }

    fn insert_session(transaction: &Transaction<'_>, session: &SessionHead) -> Result<()> {
        let json = serde_json::to_string(session)?;
        if json.len() > 8192 {
            return Err(Error::Invalid("session metadata too large".into()));
        }
        transaction.execute("INSERT INTO session_heads(id,created_at,lifecycle,revision,payload) VALUES(?1,?2,?3,?4,?5)",
            params![session.id, session.created_at, label(session.lifecycle)?, session.revision, json])?;
        transaction.execute(
            "INSERT INTO session_search(rowid,id,title,workspace) VALUES(?1,?2,?3,?4)",
            params![
                transaction.last_insert_rowid(),
                session.id,
                session.title,
                session.workspace
            ],
        )?;
        Self::adjust_counts(transaction, session, 1)?;
        Ok(())
    }

    pub fn session(&self, id: &str) -> Result<SessionHead> {
        validate_id(id)?;
        let json: String = self
            .connection
            .query_row("SELECT payload FROM session_heads WHERE id=?", [id], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or(Error::NotFound)?;
        Ok(serde_json::from_str(&json)?)
    }

    pub fn update_session(&mut self, id: &str, update: UpdateSession) -> Result<SessionHead> {
        if update.revision <= 0 || update.revision >= MAX_SAFE_INTEGER {
            return Err(Error::Invalid("invalid revision".into()));
        }
        let mut session = self.session(id)?;
        let previous = session.clone();
        if session.revision != update.revision {
            return Err(Error::Conflict);
        }
        if let Some(title) = update.title {
            validate_text(&title, 512, false)?;
            session.title = title;
        }
        if let Some(lifecycle) = update.lifecycle {
            session.lifecycle = lifecycle;
        }
        if let Some(status) = update.status {
            session.status = status;
        }
        session.revision += 1;
        session.updated_at = now();
        let transaction = self.connection.transaction()?;
        let changed = transaction.execute("UPDATE session_heads SET lifecycle=?1,revision=?2,payload=?3 WHERE id=?4 AND revision=?5",
            params![label(session.lifecycle)?, session.revision, serde_json::to_string(&session)?, id, update.revision])?;
        if changed != 1 {
            return Err(Error::Conflict);
        }
        if previous.title != session.title {
            transaction.execute("UPDATE session_search SET title=?1 WHERE rowid=(SELECT rowid FROM session_heads WHERE id=?2)", params![session.title, id])?;
        }
        if previous.lifecycle != session.lifecycle || previous.status != session.status {
            Self::adjust_counts(&transaction, &previous, -1)?;
            Self::adjust_counts(&transaction, &session, 1)?;
        } else {
            for (scope, workspace) in [(0, ""), (1, session.workspace.as_str())] {
                transaction.execute(
                    "UPDATE session_counts SET revision=revision+1 WHERE scope=?1 AND workspace=?2",
                    params![scope, workspace],
                )?;
            }
        }
        Self::append_event(
            &transaction,
            "sessions",
            "session.updated",
            id,
            serde_json::to_value(&session)?,
        )?;
        transaction.commit()?;
        Ok(session)
    }

    fn adjust_counts(
        transaction: &Transaction<'_>,
        session: &SessionHead,
        delta: i64,
    ) -> Result<()> {
        let active = i64::from(session.lifecycle == SessionLifecycle::Active);
        let attention = active
            * i64::from(matches!(
                session.status,
                SessionStatus::WaitingInput | SessionStatus::WaitingPermission
            ));
        for (scope, workspace) in [(0, ""), (1, session.workspace.as_str())] {
            transaction.execute("INSERT INTO session_counts(scope,workspace,total,active,attention) VALUES(?1,?2,0,0,0) ON CONFLICT DO NOTHING", params![scope, workspace])?;
            transaction.execute("UPDATE session_counts SET total=total+?1,active=active+?2,attention=attention+?3,revision=revision+max(?1,0) WHERE scope=?4 AND workspace=?5", params![delta, delta * active, delta * attention, scope, workspace])?;
        }
        Ok(())
    }

    fn append_event(
        transaction: &Transaction<'_>,
        scope: &str,
        kind: &str,
        id: &str,
        data: serde_json::Value,
    ) -> Result<i64> {
        let json = serde_json::to_string(&data)?;
        if json.len() > MAX_EVENT_BYTES {
            return Err(Error::Invalid(
                "event metadata too large; use content chunks".into(),
            ));
        }
        transaction.execute("INSERT INTO stream_heads(scope,last_seq,floor_seq) VALUES(?1,0,0) ON CONFLICT(scope) DO NOTHING", [scope])?;
        let previous: i64 = transaction.query_row(
            "SELECT last_seq FROM stream_heads WHERE scope=?",
            [scope],
            |r| r.get(0),
        )?;
        if previous >= MAX_SAFE_INTEGER {
            return Err(Error::Conflict);
        }
        let seq = previous + 1;
        let floor = seq.saturating_sub(EVENT_RETENTION).max(0);
        transaction.execute(
            "INSERT INTO change_events(scope,seq,kind,entity_id,payload) VALUES(?1,?2,?3,?4,?5)",
            params![scope, seq, kind, id, json],
        )?;
        transaction.execute(
            "UPDATE stream_heads SET last_seq=?1,floor_seq=?2 WHERE scope=?3",
            params![seq, floor, scope],
        )?;
        transaction.execute(
            "DELETE FROM change_events WHERE scope=?1 AND seq<=?2",
            params![scope, floor],
        )?;
        Ok(seq)
    }

    pub fn events(&mut self, scope: &str, after: i64, limit: usize) -> Result<EventPage> {
        validate_text(scope, 256, false)?;
        if limit == 0 || limit > MAX_PAGE_ITEMS || !(0..=MAX_SAFE_INTEGER).contains(&after) {
            return Err(Error::Invalid("invalid event page".into()));
        }
        let transaction = self.connection.transaction()?;
        let (latest, floor): (i64, i64) = transaction
            .query_row(
                "SELECT last_seq,floor_seq FROM stream_heads WHERE scope=?",
                [scope],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .unwrap_or((0, 0));
        if after > latest {
            return Err(Error::Invalid("event cursor is ahead of the stream".into()));
        }
        if after < floor {
            return Ok(EventPage {
                items: vec![],
                next_seq: latest,
                latest_seq: latest,
                floor_seq: floor,
                has_more: false,
                resync_required: true,
            });
        }
        let mut statement = transaction.prepare("SELECT seq,kind,entity_id,payload FROM change_events WHERE scope=?1 AND seq>?2 ORDER BY seq LIMIT ?3")?;
        let rows = statement.query_map(params![scope, after, (limit + 1) as i64], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        let mut bytes = 0;
        let mut items = Vec::new();
        let mut has_more = false;
        for row in rows {
            let (seq, kind, entity_id, payload) = row?;
            if items.len() == limit || bytes + payload.len() > MAX_PAGE_BYTES {
                has_more = true;
                break;
            }
            bytes += payload.len();
            items.push(ChangeEvent {
                scope: scope.into(),
                seq,
                kind,
                entity_id,
                data: serde_json::from_str(&payload)?,
            });
        }
        let next_seq = items.last().map_or(after, |event| event.seq);
        Ok(EventPage {
            items,
            next_seq,
            latest_seq: latest,
            floor_seq: floor,
            has_more,
            resync_required: false,
        })
    }

    pub fn append_content(
        &mut self,
        session_id: &str,
        content_id: &str,
        expected_offset: i64,
        bytes: &[u8],
    ) -> Result<i64> {
        validate_id(session_id)?;
        validate_id(content_id)?;
        if bytes.is_empty()
            || bytes.len() > CONTENT_CHUNK_BYTES
            || expected_offset < 0
            || expected_offset > MAX_CONTENT_BYTES - bytes.len() as i64
        {
            return Err(Error::Invalid("invalid content chunk size".into()));
        }
        let transaction = self.connection.transaction()?;
        let present: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_heads WHERE id=?)",
            [session_id],
            |r| r.get(0),
        )?;
        if !present {
            return Err(Error::NotFound);
        }
        transaction.execute("INSERT INTO content_heads(session_id,id,bytes) VALUES(?1,?2,0) ON CONFLICT(session_id,id) DO NOTHING", params![session_id, content_id])?;
        let offset: i64 = transaction.query_row(
            "SELECT bytes FROM content_heads WHERE session_id=?1 AND id=?2",
            params![session_id, content_id],
            |r| r.get(0),
        )?;
        if offset != expected_offset {
            return Err(Error::Conflict);
        }
        let next = offset + bytes.len() as i64;
        transaction.execute(
            "INSERT INTO content_chunks(session_id,content_id,offset,body) VALUES(?1,?2,?3,?4)",
            params![session_id, content_id, offset, bytes],
        )?;
        transaction.execute(
            "UPDATE content_heads SET bytes=?1 WHERE session_id=?2 AND id=?3",
            params![next, session_id, content_id],
        )?;
        transaction.commit()?;
        Ok(next)
    }

    pub fn contents(
        &self,
        session_id: &str,
        cursor: Option<String>,
        limit: usize,
    ) -> Result<ContentPage> {
        validate_id(session_id)?;
        if let Some(cursor) = &cursor {
            validate_id(cursor)?;
        }
        if !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid content page limit".into()));
        }
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_heads WHERE id=?)",
            [session_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(Error::NotFound);
        }
        let mut statement = self.connection.prepare_cached(
            "SELECT id,bytes FROM content_heads WHERE session_id=?1 AND id>?2 ORDER BY id LIMIT ?3",
        )?;
        let mut items = statement
            .query_map(
                params![session_id, cursor.unwrap_or_default(), (limit + 1) as i64],
                |row| {
                    Ok(ContentHead {
                        id: row.get(0)?,
                        bytes: row.get(1)?,
                    })
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit;
        items.truncate(limit);
        let next_cursor = if has_more {
            items.last().map(|item| item.id.clone())
        } else {
            None
        };
        Ok(ContentPage {
            items,
            next_cursor,
            has_more,
        })
    }

    pub fn content(&self, session_id: &str, content_id: &str, offset: i64) -> Result<Vec<u8>> {
        validate_id(session_id)?;
        validate_id(content_id)?;
        if !(0..=MAX_CONTENT_BYTES).contains(&offset) {
            return Err(Error::Invalid("invalid content offset".into()));
        }
        let length: i64 = self
            .connection
            .query_row(
                "SELECT bytes FROM content_heads WHERE session_id=?1 AND id=?2",
                params![session_id, content_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        if offset > length {
            return Err(Error::Invalid(
                "content cursor is ahead of the value".into(),
            ));
        }
        let mut statement = self.connection.prepare_cached("SELECT offset,body FROM content_chunks WHERE session_id=?1 AND content_id=?2 AND offset>=?3 ORDER BY offset LIMIT 16")?;
        let mut output = Vec::new();
        let mut expected = offset;
        for row in statement.query_map(params![session_id, content_id, offset], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
        })? {
            let (position, bytes) = row?;
            if position != expected {
                return Err(Error::Invalid(
                    "content cursor must be a chunk boundary".into(),
                ));
            }
            expected += bytes.len() as i64;
            output.extend(bytes);
        }
        if output.is_empty() && offset < length {
            return Err(Error::Invalid(
                "content cursor must be a chunk boundary".into(),
            ));
        }
        Ok(output)
    }

    pub fn seed_archives(&mut self, count: usize) -> Result<()> {
        if count == 0 || count > 100_000 {
            return Err(Error::Invalid("invalid fixture size".into()));
        }
        let existing: i64 =
            self.connection
                .query_row("SELECT count(*) FROM session_heads", [], |r| r.get(0))?;
        if existing != 0 {
            return Err(Error::Invalid(
                "benchmark seeding requires an empty database".into(),
            ));
        }
        let transaction = self.connection.transaction()?;
        for index in 0..count {
            Self::insert_session(
                &transaction,
                &SessionHead {
                    id: format!("session-{index:09}"),
                    agent: AgentKind::Codex,
                    kind: SessionKind::Structured,
                    title: format!("Archive {index}"),
                    workspace: "/synthetic".into(),
                    lifecycle: SessionLifecycle::Archived,
                    status: SessionStatus::Completed,
                    created_at: index as i64 + 1,
                    updated_at: index as i64 + 1,
                    revision: 1,
                },
            )?;
            let id = format!("session-{index:09}");
            transaction.execute(
                "INSERT INTO content_heads(session_id,id,bytes) VALUES(?1,'history',1024)",
                [&id],
            )?;
            transaction.execute("INSERT INTO content_chunks(session_id,content_id,offset,body) VALUES(?1,'history',0,?2)", params![id, vec![b'x'; 1024]])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn check(&self) -> Result<String> {
        Ok(self
            .connection
            .query_row("PRAGMA quick_check", [], |r| r.get(0))?)
    }
}
