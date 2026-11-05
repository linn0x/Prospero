use std::fs::{self, File, OpenOptions};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::protocol::*;

const APPLICATION_ID: i64 = 0x50525253;
const SCHEMA_VERSION: i64 = 36;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_CONTENT_BYTES: i64 = 1024 * 1024 * 1024;

pub(crate) struct OwnerLock(File);

impl Drop for OwnerLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

pub struct Store {
    pub(crate) connection: Connection,
    _lock: Arc<OwnerLock>,
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

pub(crate) fn now() -> i64 {
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
    pub(crate) fn read_snapshot<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        if !self.connection.is_autocommit() {
            return operation();
        }
        let transaction = self.connection.unchecked_transaction()?;
        let value = operation()?;
        transaction.commit()?;
        Ok(value)
    }

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
        if directory
            .join("RESTORE_REQUIRES_RECONCILIATION.json")
            .exists()
        {
            return Err(Error::Invalid(
                "restored database requires execution reconciliation before admission".into(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        }
        let lock = private_file(&directory.join("owner.lock"))?;
        lock.try_lock_exclusive()
            .map_err(|_| Error::AlreadyRunning)?;
        let lock = Arc::new(OwnerLock(lock));
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
            transaction.execute_batch(include_str!("orchestration/schema.sql"))?;
            transaction.execute_batch(include_str!("orchestration/schema-v10.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v11.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v12.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v13.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v14.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v15.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v16.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v17.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v18.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v19.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v21.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v22.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v23.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v24.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v25.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v26.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v27.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v28.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v29.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v30.sql"))?;
            transaction.execute_batch(include_str!("orchestration/schema-v31.sql"))?;
            transaction.execute_batch(include_str!("orchestration/schema-v32.sql"))?;
            transaction.execute_batch(include_str!("orchestration/schema-v33.sql"))?;
            transaction.execute_batch(include_str!("agent/schema-v34.sql"))?;
            transaction.execute_batch(include_str!("orchestration/schema-v35.sql"))?;
            transaction.execute_batch(include_str!("terminal/schema-v36.sql"))?;
            transaction.execute_batch(
                "CREATE TABLE IF NOT EXISTS workspace_tabs (
                    workspace TEXT PRIMARY KEY CHECK(length(workspace) BETWEEN 1 AND 4096),
                    open_session_ids TEXT NOT NULL DEFAULT '[]' CHECK(length(CAST(open_session_ids AS BLOB)) <= 16384),
                    active_session_id TEXT,
                    split_session_id TEXT,
                    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
                    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
                ) STRICT;",
            )?;
            transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
            transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            transaction.commit()?;
        } else if application != APPLICATION_ID || !(8..=SCHEMA_VERSION).contains(&version) {
            return Err(Error::Schema);
        } else {
            let transaction = connection.transaction()?;
            if version == 8 {
                transaction.execute_batch(include_str!("orchestration/schema.sql"))?;
            }
            if version <= 9 {
                transaction.execute_batch(include_str!("orchestration/schema-v10.sql"))?;
            }
            if version <= 10 {
                transaction.execute_batch(include_str!("agent/schema-v11.sql"))?;
            }
            if version <= 11 {
                transaction.execute_batch(include_str!("agent/schema-v12.sql"))?;
            }
            if version <= 12 {
                transaction.execute_batch(include_str!("agent/schema-v13.sql"))?;
            }
            if version <= 13 {
                transaction.execute_batch(include_str!("agent/schema-v14.sql"))?;
            }
            if version <= 14 {
                transaction.execute_batch(include_str!("agent/schema-v15.sql"))?;
            }
            if version <= 15 {
                transaction.execute_batch(include_str!("agent/schema-v16.sql"))?;
            }
            if version <= 16 {
                transaction.execute_batch(include_str!("agent/schema-v17.sql"))?;
            }
            if version <= 17 {
                transaction.execute_batch(include_str!("agent/schema-v18.sql"))?;
            }
            if version <= 18 {
                transaction.execute_batch(include_str!("agent/schema-v19.sql"))?;
            }
            if version <= 19 {
                let has_automation: i64 = transaction.query_row(
                    "SELECT count(*) FROM pragma_table_info('orch_runs') WHERE name='automation'",
                    [],
                    |row| row.get(0),
                )?;
                if has_automation == 0 {
                    transaction.execute_batch(
                        "ALTER TABLE orch_runs ADD COLUMN automation TEXT CHECK(automation IS NULL OR length(CAST(automation AS BLOB)) <= 32768);",
                    )?;
                }
            }
            if version <= 20 {
                transaction.execute_batch(include_str!("agent/schema-v21.sql"))?;
            }
            if version <= 21 {
                transaction.execute_batch(include_str!("agent/schema-v22.sql"))?;
            }
            if version <= 22 {
                transaction.execute_batch(include_str!("agent/schema-v23.sql"))?;
            }
            if version <= 23 {
                transaction.execute_batch(include_str!("agent/schema-v24.sql"))?;
            }
            if version <= 24 {
                transaction.execute_batch(include_str!("agent/schema-v25.sql"))?;
            }
            if version <= 25 {
                transaction.execute_batch(include_str!("agent/schema-v26.sql"))?;
            }
            if version <= 26 {
                transaction.execute_batch(include_str!("agent/schema-v27.sql"))?;
            }
            if version <= 27 {
                transaction.execute_batch(include_str!("agent/schema-v28.sql"))?;
            }
            if version <= 28 {
                transaction.execute_batch(include_str!("agent/schema-v29.sql"))?;
            }
            if version <= 29 {
                transaction.execute_batch(include_str!("agent/schema-v30.sql"))?;
            }
            if version <= 30 {
                transaction.execute_batch(include_str!("orchestration/schema-v31.sql"))?;
            }
            if version <= 31 {
                transaction.execute_batch(include_str!("orchestration/schema-v32.sql"))?;
            }
            if version <= 32 {
                transaction.execute_batch(include_str!("orchestration/schema-v33.sql"))?;
            }
            if version <= 33 {
                transaction.execute_batch(include_str!("agent/schema-v34.sql"))?;
            }
            if version <= 34 {
                transaction.execute_batch(include_str!("orchestration/schema-v35.sql"))?;
            }
            if version <= 35 {
                transaction.execute_batch(include_str!("terminal/schema-v36.sql"))?;
            }
            transaction.execute_batch(
                "CREATE TABLE IF NOT EXISTS workspace_tabs (
                    workspace TEXT PRIMARY KEY CHECK(length(workspace) BETWEEN 1 AND 4096),
                    open_session_ids TEXT NOT NULL DEFAULT '[]' CHECK(length(CAST(open_session_ids AS BLOB)) <= 16384),
                    active_session_id TEXT,
                    split_session_id TEXT,
                    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
                    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
                ) STRICT;",
            )?;
            let managed_accounts_sql: Option<String> = transaction
                .query_row(
                    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='managed_accounts'",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            if managed_accounts_sql
                .as_deref()
                .is_some_and(|sql| !sql.contains("'pi'"))
            {
                transaction.execute_batch(
                    "CREATE TABLE managed_accounts_pi_upgrade (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
                        is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),
                        created_at INTEGER NOT NULL CHECK(created_at >= 0),
                        updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
                        api_profile TEXT,
                        api_validation TEXT,
                        api_validation_revision TEXT,
                        api_engine_validation TEXT,
                        api_engine_validation_revision TEXT,
                        agent TEXT CHECK(agent IS NULL OR agent IN ('claude','codex','opencode','pi'))
                    ) STRICT;
                    INSERT INTO managed_accounts_pi_upgrade(
                        id,name,is_default,created_at,updated_at,
                        api_profile,api_validation,api_validation_revision,
                        api_engine_validation,api_engine_validation_revision,agent
                    )
                    SELECT
                        id,name,is_default,created_at,updated_at,
                        api_profile,api_validation,api_validation_revision,
                        api_engine_validation,api_engine_validation_revision,agent
                    FROM managed_accounts;
                    DROP TABLE managed_accounts;
                    ALTER TABLE managed_accounts_pi_upgrade RENAME TO managed_accounts;",
                )?;
            }
            let agent_runs_sql: Option<String> = transaction
                .query_row(
                    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='agent_runs'",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            if agent_runs_sql
                .as_deref()
                .is_some_and(|sql| !sql.contains("'pi'"))
            {
                transaction.execute_batch(
                    "DROP TRIGGER IF EXISTS orch_dispatch_legacy_unknown_insert;
                    DROP TRIGGER IF EXISTS orch_dispatch_legacy_unknown_update;
                    CREATE TABLE agent_runs_pi_upgrade (
                        session_id TEXT PRIMARY KEY REFERENCES session_heads(id) ON DELETE CASCADE,
                        agent TEXT NOT NULL CHECK(agent IN ('claude','codex','deepseek','opencode','pi')),
                        active INTEGER NOT NULL CHECK(active IN (0,1)),
                        approval_policy TEXT NOT NULL CHECK(approval_policy IN ('manual','auto')),
                        turn INTEGER NOT NULL DEFAULT 0 CHECK(turn >= 0),
                        native_id TEXT CHECK(native_id IS NULL OR length(native_id) <= 256),
                        permission_mode TEXT NOT NULL DEFAULT 'default' CHECK(permission_mode IN ('default','plan')),
                        model TEXT,
                        effort TEXT,
                        account_id TEXT,
                        agent_preset TEXT,
                        execution_unknown INTEGER NOT NULL DEFAULT 0 CHECK(execution_unknown IN (0,1))
                    ) STRICT;
                    INSERT INTO agent_runs_pi_upgrade(
                        session_id,agent,active,approval_policy,turn,native_id,
                        permission_mode,model,effort,account_id,agent_preset,execution_unknown
                    )
                    SELECT
                        session_id,agent,active,approval_policy,turn,native_id,
                        permission_mode,model,effort,account_id,agent_preset,execution_unknown
                    FROM agent_runs;
                    DROP TABLE agent_runs;
                    ALTER TABLE agent_runs_pi_upgrade RENAME TO agent_runs;
                    CREATE INDEX agent_active ON agent_runs(session_id) WHERE active=1;
                    CREATE TRIGGER orch_dispatch_legacy_unknown_insert
                    BEFORE INSERT ON orch_dispatches
                    WHEN NEW.state IN ('starting','running') AND EXISTS (
                        SELECT 1 FROM orch_dispatches d JOIN agent_runs a ON a.session_id=d.session_id
                        WHERE d.task_id=NEW.task_id AND d.id!=NEW.id AND (a.active=1 OR a.execution_unknown=1)
                    )
                    BEGIN
                        SELECT RAISE(ABORT,'legacy execution exit remains unknown');
                    END;
                    CREATE TRIGGER orch_dispatch_legacy_unknown_update
                    BEFORE UPDATE OF task_id,session_id,state ON orch_dispatches
                    WHEN NEW.state IN ('starting','running') AND EXISTS (
                        SELECT 1 FROM orch_dispatches d JOIN agent_runs a ON a.session_id=d.session_id
                        WHERE d.task_id=NEW.task_id AND d.id!=NEW.id AND (a.active=1 OR a.execution_unknown=1)
                    )
                    BEGIN
                        SELECT RAISE(ABORT,'legacy execution exit remains unknown');
                    END;",
                )?;
            }
            transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            transaction.commit()?;
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
        connection.execute(
            "DELETE FROM session_search WHERE rowid NOT IN (SELECT rowid FROM session_heads)",
            [],
        )?;
        connection.execute(
            "UPDATE session_heads \
             SET payload = json_set(payload, '$.nativeSession.state', 'failed') \
             WHERE lifecycle = 'archived' \
               AND json_extract(payload, '$.status') = 'failed' \
               AND json_extract(payload, '$.nativeSession.state') IN ('running', 'binding')",
            [],
        )?;
        connection.prepare(
            "SELECT id,created_at,lifecycle,revision,payload FROM session_heads LIMIT 0",
        )?;
        Ok(Self {
            connection,
            _lock: lock,
        })
    }

    pub(crate) fn owner_lock(&self) -> Arc<OwnerLock> {
        self._lock.clone()
    }

    pub(crate) fn open_reader(directory: &Path, lock: Arc<OwnerLock>) -> Result<Self> {
        let database = directory.join("prospero.sqlite");
        let connection = Connection::open_with_flags(
            database,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_millis(1000))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA query_only=ON;")?;
        let application: i64 =
            connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if application != APPLICATION_ID || version != SCHEMA_VERSION {
            return Err(Error::Schema);
        }
        connection.prepare(
            "SELECT id,created_at,lifecycle,revision,payload FROM session_heads LIMIT 0",
        )?;
        Ok(Self {
            connection,
            _lock: lock,
        })
    }

    pub fn create_session(&mut self, input: CreateSession) -> Result<SessionHead> {
        self.create_session_with(input, |_, _| Ok(()))
    }

    pub(crate) fn create_session_with(
        &mut self,
        input: CreateSession,
        extra: impl FnOnce(&Transaction<'_>, &SessionHead) -> Result<()>,
    ) -> Result<SessionHead> {
        self.create_session_with_id(input, None, extra)
    }

    pub(crate) fn create_session_with_id(
        &mut self,
        input: CreateSession,
        id: Option<String>,
        extra: impl FnOnce(&Transaction<'_>, &SessionHead) -> Result<()>,
    ) -> Result<SessionHead> {
        self.create_session_with_launch(input, id, SessionLaunchOptions::default(), extra)
    }

    pub(crate) fn create_session_with_launch(
        &mut self,
        input: CreateSession,
        id: Option<String>,
        launch: SessionLaunchOptions,
        extra: impl FnOnce(&Transaction<'_>, &SessionHead) -> Result<()>,
    ) -> Result<SessionHead> {
        if let Some(id) = &id {
            validate_id(id)?;
        }
        validate_text(&input.title, 512, false)?;
        validate_text(&input.workspace, 4096, false)?;
        let timestamp = now();
        let session = SessionHead {
            native_session: None,
            id: id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            agent: input.agent,
            kind: input.kind,
            title: input.title,
            workspace: input.workspace,
            lifecycle: SessionLifecycle::Active,
            status: SessionStatus::Idle,
            account_id: launch.account_id,
            model: launch.model,
            effort: launch.effort,
            approval_policy: launch.approval_policy,
            created_at: timestamp,
            updated_at: timestamp,
            revision: 1,
            busy_since: None,
        };
        let transaction = self.connection.transaction()?;
        Self::insert_session(&transaction, &session)?;
        extra(&transaction, &session)?;
        Self::record_workspace_session_opened(&transaction, &session.workspace, &session.id, timestamp)?;
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
        let rowid = transaction.last_insert_rowid();
        transaction.execute("DELETE FROM session_search WHERE rowid=?1", [rowid])?;
        transaction.execute(
            "INSERT INTO session_search(rowid,id,title,workspace) VALUES(?1,?2,?3,?4)",
            params![
                rowid,
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
        self.update_session_with(id, update, |_| Ok(()))
    }

    pub(crate) fn set_session_busy_since(
        &mut self,
        id: &str,
        busy_since: Option<i64>,
    ) -> Result<bool> {
        crate::database::validate_id(id)?;
        if busy_since.is_some_and(|value| !(0..MAX_SAFE_INTEGER).contains(&value)) {
            return Err(Error::Invalid("invalid busy timestamp".into()));
        }
        let mut session = self.session(id)?;
        if session.busy_since == busy_since {
            return Ok(false);
        }
        if session.kind != SessionKind::Pty
            || session.lifecycle != SessionLifecycle::Active
            || session.status != SessionStatus::Running
        {
            return Ok(false);
        }
        let revision = session.revision;
        session.busy_since = busy_since;
        session.revision += 1;
        session.updated_at = now();
        let transaction = self.connection.transaction()?;
        let changed = transaction.execute(
            "UPDATE session_heads SET revision=?1,payload=?2 WHERE id=?3 AND revision=?4",
            params![
                session.revision,
                serde_json::to_string(&session)?,
                id,
                revision
            ],
        )?;
        if changed != 1 {
            return Err(Error::Conflict);
        }
        for (scope, workspace) in [(0, ""), (1, session.workspace.as_str())] {
            transaction.execute(
                "UPDATE session_counts SET revision=revision+1 WHERE scope=?1 AND workspace=?2",
                params![scope, workspace],
            )?;
        }
        Self::append_event(
            &transaction,
            "sessions",
            "session.updated",
            id,
            serde_json::to_value(&session)?,
        )?;
        transaction.commit()?;
        Ok(true)
    }

    pub(crate) fn update_session_with(
        &mut self,
        id: &str,
        update: UpdateSession,
        extra: impl FnOnce(&Transaction<'_>) -> Result<()>,
    ) -> Result<SessionHead> {
        self.update_session_with_native(id, update, None, extra)
    }

    pub(crate) fn update_session_with_native(
        &mut self,
        id: &str,
        update: UpdateSession,
        native: Option<NativeSession>,
        extra: impl FnOnce(&Transaction<'_>) -> Result<()>,
    ) -> Result<SessionHead> {
        if update.revision <= 0 || update.revision >= MAX_SAFE_INTEGER {
            return Err(Error::Invalid("invalid revision".into()));
        }
        let mut session = self.session(id)?;
        let previous = session.clone();
        if let Some(native) = native {
            session.native_session = Some(native);
        }
        if session.revision != update.revision {
            return Err(Error::Conflict);
        }
        let timestamp = now();
        if let Some(title) = update.title {
            validate_text(&title, 512, false)?;
            session.title = title;
        }
        if let Some(lifecycle) = update.lifecycle {
            session.lifecycle = lifecycle;
            if lifecycle == SessionLifecycle::Archived {
                session.busy_since = None;
            }
        }
        if let Some(status) = update.status {
            session.status = status;
            session.busy_since = match status {
                SessionStatus::Running if session.kind == SessionKind::Structured => {
                    Some(session.busy_since.unwrap_or(timestamp))
                }
                SessionStatus::WaitingPermission | SessionStatus::WaitingInput => {
                    Some(session.busy_since.unwrap_or(timestamp))
                }
                SessionStatus::Running if session.kind == SessionKind::Pty => session.busy_since,
                SessionStatus::Idle
                | SessionStatus::Starting
                | SessionStatus::Completed
                | SessionStatus::Failed => None,
                SessionStatus::Running => session.busy_since,
            };
        }
        session.revision += 1;
        session.updated_at = timestamp;
        let transaction = self.connection.transaction()?;
        extra(&transaction)?;
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
            if session.lifecycle == SessionLifecycle::Archived
                && previous.lifecycle != SessionLifecycle::Archived
                && !(session.status == SessionStatus::Failed && session.native_session.is_some())
            {
                Self::record_workspace_session_closed(&transaction, &session.workspace, &session.id, timestamp)?;
            } else if session.lifecycle == SessionLifecycle::Active && previous.lifecycle != SessionLifecycle::Active {
                Self::record_workspace_session_opened(&transaction, &session.workspace, &session.id, timestamp)?;
            }
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

    pub(crate) fn update_session_metadata_with(
        &mut self,
        id: &str,
        update: impl FnOnce(&mut SessionHead),
        extra: impl FnOnce(&Transaction<'_>) -> Result<()>,
    ) -> Result<SessionHead> {
        validate_id(id)?;
        let mut session = self.session(id)?;
        let previous = session.clone();
        update(&mut session);
        session.revision += 1;
        session.updated_at = now();
        let transaction = self.connection.transaction()?;
        extra(&transaction)?;
        let changed = transaction.execute(
            "UPDATE session_heads SET revision=?1,payload=?2 WHERE id=?3 AND revision=?4",
            params![
                session.revision,
                serde_json::to_string(&session)?,
                id,
                previous.revision
            ],
        )?;
        if changed != 1 {
            return Err(Error::Conflict);
        }
        for (scope, workspace) in [(0, ""), (1, session.workspace.as_str())] {
            transaction.execute(
                "UPDATE session_counts SET revision=revision+1 WHERE scope=?1 AND workspace=?2",
                params![scope, workspace],
            )?;
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

    pub(crate) fn record_workspace_session_opened(
        transaction: &Transaction<'_>,
        workspace: &str,
        session_id: &str,
        timestamp: i64,
    ) -> Result<()> {
        let is_child: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM cross_model_children WHERE child_session_id=?1)",
                [session_id],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if is_child {
            return Ok(());
        }
        let existing: Option<(String, Option<String>)> = transaction
            .query_row(
                "SELECT open_session_ids,split_session_id FROM workspace_tabs WHERE workspace=?1",
                [workspace],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (mut ids, split_id) = match existing {
            Some((raw, split)) => (
                serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default(),
                split,
            ),
            None => (Vec::new(), None),
        };
        if !ids.iter().any(|id| id == session_id) {
            ids.push(session_id.to_owned());
        }
        if ids.len() > 64 {
            let drain = ids.len() - 64;
            ids.drain(0..drain);
        }
        let encoded = serde_json::to_string(&ids)?;
        transaction.execute(
            "INSERT INTO workspace_tabs(workspace,open_session_ids,active_session_id,split_session_id,updated_at,revision) \
             VALUES(?1,?2,?3,?4,?5,1) \
             ON CONFLICT(workspace) DO UPDATE SET open_session_ids=excluded.open_session_ids,active_session_id=excluded.active_session_id,updated_at=excluded.updated_at,revision=workspace_tabs.revision+1",
            params![workspace, encoded, session_id, split_id, timestamp],
        )?;
        Ok(())
    }

    pub(crate) fn record_workspace_session_closed(
        transaction: &Transaction<'_>,
        workspace: &str,
        session_id: &str,
        timestamp: i64,
    ) -> Result<()> {
        let existing: Option<(String, Option<String>, Option<String>)> = transaction
            .query_row(
                "SELECT open_session_ids,active_session_id,split_session_id FROM workspace_tabs WHERE workspace=?1",
                [workspace],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((raw, active_id, split_id)) = existing else {
            return Ok(());
        };
        let mut ids = serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default();
        let previous_index = ids.iter().position(|id| id == session_id);
        ids.retain(|id| id != session_id);
        let next_active = if active_id.as_deref() == Some(session_id) {
            previous_index
                .and_then(|idx| ids.get(idx.saturating_sub(1)).or_else(|| ids.first()))
                .cloned()
        } else {
            active_id
                .filter(|id| ids.contains(id))
                .or_else(|| ids.first().cloned())
        };
        let next_split = split_id.filter(|id| {
            id != session_id && next_active.as_ref() != Some(id) && ids.contains(id)
        });
        let encoded = serde_json::to_string(&ids)?;
        transaction.execute(
            "UPDATE workspace_tabs SET open_session_ids=?1,active_session_id=?2,split_session_id=?3,updated_at=?4,revision=revision+1 WHERE workspace=?5",
            params![encoded, next_active, next_split, timestamp, workspace],
        )?;
        Ok(())
    }

    pub fn set_workspace_tabs(&mut self, input: WorkspaceTabsUpdate) -> Result<WorkspaceTabsEntry> {
        validate_text(&input.workspace, 4096, false)?;
        if input.open_session_ids.len() > 64 {
            return Err(Error::Invalid("workspace open tabs must be at most 64".into()));
        }
        for id in &input.open_session_ids {
            validate_id(id)?;
        }
        if let Some(id) = &input.active_session_id {
            validate_id(id)?;
        }
        if let Some(id) = &input.split_session_id {
            validate_id(id)?;
        }
        let timestamp = now();
        let transaction = self.connection.transaction()?;
        let mut seen = std::collections::HashSet::new();
        let mut open_session_ids = Vec::with_capacity(input.open_session_ids.len());
        for id in input.open_session_ids {
            if !seen.insert(id.clone()) {
                continue;
            }
            let valid: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM session_heads WHERE id=?1 AND (lifecycle='active' OR COALESCE(json_extract(payload, '$.nativeSession.state'), '') IN ('archiving', 'failed')) AND NOT EXISTS(SELECT 1 FROM cross_model_children WHERE child_session_id=?1))",
                [&id],
                |row| row.get(0),
            )?;
            if valid {
                open_session_ids.push(id);
            }
        }
        let mut active_session_id = input
            .active_session_id
            .filter(|id| open_session_ids.contains(id));
        if active_session_id.is_none() {
            active_session_id = open_session_ids.first().cloned();
        }
        let split_session_id = input
            .split_session_id
            .filter(|id| open_session_ids.contains(id) && active_session_id.as_ref() != Some(id));
        let encoded = serde_json::to_string(&open_session_ids)?;
        transaction.execute(
            "INSERT INTO workspace_tabs(workspace,open_session_ids,active_session_id,split_session_id,updated_at,revision) \
             VALUES(?1,?2,?3,?4,?5,1) \
             ON CONFLICT(workspace) DO UPDATE SET open_session_ids=excluded.open_session_ids,active_session_id=excluded.active_session_id,split_session_id=excluded.split_session_id,updated_at=excluded.updated_at,revision=workspace_tabs.revision+1",
            params![
                input.workspace,
                encoded,
                active_session_id,
                split_session_id,
                timestamp
            ],
        )?;
        let revision: i64 = transaction.query_row(
            "SELECT revision FROM workspace_tabs WHERE workspace=?1",
            [&input.workspace],
            |row| row.get(0),
        )?;
        for (scope, workspace) in [(0, ""), (1, input.workspace.as_str())] {
            transaction.execute(
                "INSERT INTO session_counts(scope,workspace,total,active,attention) VALUES(?1,?2,0,0,0) ON CONFLICT DO NOTHING",
                params![scope, workspace],
            )?;
            transaction.execute(
                "UPDATE session_counts SET revision=revision+1 WHERE scope=?1 AND workspace=?2",
                params![scope, workspace],
            )?;
        }
        let entry = WorkspaceTabsEntry {
            workspace: input.workspace.clone(),
            open_session_ids,
            active_session_id,
            split_session_id,
            updated_at: timestamp,
            revision,
        };
        Self::append_event(
            &transaction,
            "sessions",
            "workspace.tabs",
            &input.workspace,
            serde_json::to_value(&entry)?,
        )?;
        transaction.commit()?;
        Ok(entry)
    }

    pub(crate) fn append_event(
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
        // The desktop polls idle streams frequently. The head read already
        // proves there can be no rows; avoid preparing/scanning the event table.
        if after == latest {
            return Ok(EventPage {
                items: vec![],
                next_seq: latest,
                latest_seq: latest,
                floor_seq: floor,
                has_more: false,
                resync_required: false,
            });
        }
        let mut statement = transaction.prepare_cached("SELECT seq,kind,entity_id,payload FROM change_events WHERE scope=?1 AND seq>?2 ORDER BY seq LIMIT ?3")?;
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
        self.read_snapshot(|| self.contents_inner(session_id, cursor, limit))
    }

    fn contents_inner(
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
        self.read_snapshot(|| self.content_inner(session_id, content_id, offset))
    }

    fn content_inner(&self, session_id: &str, content_id: &str, offset: i64) -> Result<Vec<u8>> {
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
                    native_session: None,
                    id: format!("session-{index:09}"),
                    agent: AgentKind::Codex,
                    kind: SessionKind::Structured,
                    title: format!("Archive {index}"),
                    workspace: "/synthetic".into(),
                    lifecycle: SessionLifecycle::Archived,
                    status: SessionStatus::Completed,
                    account_id: None,
                    model: None,
                    effort: None,
                    approval_policy: None,
                    created_at: index as i64 + 1,
                    updated_at: index as i64 + 1,
                    revision: 1,
                    busy_since: None,
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
