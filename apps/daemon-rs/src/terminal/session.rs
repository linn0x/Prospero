use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::database::{Store, now, validate_id};
use crate::error::{Error, Result};
use crate::protocol::{NativeSession, SessionHead, SessionLifecycle, SessionStatus, UpdateSession};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub native_id: String,
    pub cwd: String,
}

pub fn binding_path(home: &Path, runtime_id: &str) -> PathBuf {
    home.join("terminal-bindings")
        .join(format!("{runtime_id}.json"))
}

pub fn read_binding(path: &Path) -> Result<Option<Binding>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    match std::fs::File::open(path) {
        Ok(file) => {
            file.take(8193).read_to_end(&mut bytes)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    if bytes.len() > 8192 {
        return Err(Error::Invalid("原生会话绑定过大".into()));
    }
    let binding: Binding = serde_json::from_slice(&bytes)?;
    validate_native_id(&binding.native_id)?;
    Ok(Some(binding))
}

pub fn validate_native_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| Error::Invalid("原生会话 ID 必须是 UUID".into()))
}

impl Store {
    pub(crate) fn set_native_session(
        &mut self,
        id: &str,
        native: NativeSession,
    ) -> Result<SessionHead> {
        validate_id(id)?;
        validate_id(&native.runtime_id)?;
        let head = self.session(id)?;
        if let Some(native_id) = &native.native_id {
            if head.kind == crate::protocol::SessionKind::Pty {
                validate_native_id(native_id)?;
            } else {
                crate::database::validate_text(native_id, 500, false)?;
            }
            if head.lifecycle == SessionLifecycle::Active {
                self.ensure_native_available(id, native_id)?;
            }
        }
        let closing = native.is_archived();
        let workspace = head.workspace.clone();
        self.update_session_metadata_with(
            id,
            |head| head.native_session = Some(native),
            |tx| {
                if closing {
                    Self::record_workspace_session_closed(tx, &workspace, id, now())?;
                }
                Ok(())
            },
        )
    }

    pub(crate) fn reset_terminal_instance(
        &mut self,
        id: &str,
        native: NativeSession,
    ) -> Result<SessionHead> {
        let head = self.session(id)?;
        if head.lifecycle != SessionLifecycle::Archived {
            return Err(Error::Conflict);
        }
        if let Some(native_id) = &native.native_id {
            self.ensure_native_available(id, native_id)?;
        }
        self.update_session_with_native(
            id,
            UpdateSession {
                revision: head.revision,
                title: None,
                lifecycle: Some(SessionLifecycle::Active),
                status: Some(SessionStatus::Starting),
            },
            Some(native),
            |tx| {
                if tx.execute(
                    "UPDATE terminal_runs SET active=1,floor_seq=latest_seq+1,latest_seq=latest_seq+1,exit_code=NULL,snapshot=NULL WHERE session_id=? AND active=0",
                    [id],
                )? != 1
                {
                    return Err(Error::Conflict);
                }
                tx.execute("DELETE FROM terminal_output WHERE session_id=?", [id])?;
                Ok(())
            },
        )
    }

    pub(crate) fn set_native_state(
        &mut self,
        id: &str,
        state: &str,
        error: Option<String>,
    ) -> Result<SessionHead> {
        let head = self.session(id)?;
        let mut native = head.native_session.unwrap_or(NativeSession {
            output_start_seq: None,
            runtime_id: id.to_owned(),
            native_id: None,
            managed: false,
            state: state.into(),
            error: None,
        });
        native.state = state.into();
        native.error = error;
        self.set_native_session(id, native)
    }

    pub(crate) fn ensure_native_available(&self, id: &str, native_id: &str) -> Result<()> {
        let head = self.session(id)?;
        let in_use: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_heads h WHERE h.id<>?1 AND h.lifecycle='active' AND json_extract(h.payload,'$.agent')=?2 AND (json_extract(h.payload,'$.nativeSession.nativeId')=?3 OR h.id IN (SELECT session_id FROM agent_runs WHERE active=1 AND native_id=?3)))",
            params![id, crate::database::label(head.agent)?, native_id], |row| row.get(0),
        )?;
        if in_use {
            return Err(Error::Invalid("所选原生对话已绑定其他活动会话".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AgentKind, CreateTerminal, TerminalEvent, TerminalSize};

    #[test]
    fn replacing_an_instance_preserves_unserializable_terminal_history() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path()).unwrap();
        let head = store
            .create_terminal(CreateTerminal {
                title: "History".into(),
                workspace: root.path().to_string_lossy().into_owned(),
                size: TerminalSize { cols: 80, rows: 24 },
                agent: Some(AgentKind::Codex),
                command: None,
                account_id: None,
                model: None,
                effort: None,
                approval_policy: None,
            })
            .unwrap();
        let mut native = NativeSession {
            output_start_seq: Some(0),
            runtime_id: uuid::Uuid::new_v4().to_string(),
            native_id: Some(uuid::Uuid::new_v4().to_string()),
            managed: true,
            state: "running".into(),
            error: None,
        };
        store.set_native_session(&head.id, native.clone()).unwrap();
        store
            .finish_terminal(
                &head.id,
                super::super::Archive {
                    snapshot: None,
                    floor: 0,
                    start: 0,
                    seq: 1,
                    latest_seq: 1,
                    events: vec![TerminalEvent::Output {
                        data_b64: "aGlzdG9yeQ==".into(),
                    }],
                    exit_code: Some(0),
                },
            )
            .unwrap();
        let old = native.runtime_id.clone();
        native.runtime_id = uuid::Uuid::new_v4().to_string();
        native.output_start_seq = Some(2);
        native.state = "resuming".into();
        let resumed = store.reset_terminal_instance(&head.id, native).unwrap();
        assert_eq!(resumed.id, head.id);
        assert_eq!(resumed.lifecycle, SessionLifecycle::Active);
        let dead_rows: i64 = store
            .connection
            .query_row(
                "SELECT (SELECT count(*) FROM terminal_instance_output WHERE runtime_id=?1) + (SELECT count(*) FROM terminal_output WHERE session_id=?2)",
                params![old, head.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(dead_rows, 0);
        let cursor: i64 = store
            .connection
            .query_row(
                "SELECT latest_seq FROM terminal_runs WHERE session_id=?",
                [&head.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cursor, 2);
    }
}
