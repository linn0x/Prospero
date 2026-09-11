use std::collections::HashSet;
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};

use crate::database::{Store, label, validate_id, validate_text};
use crate::error::{Error, Result};
use crate::protocol::*;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    created_at: i64,
    id: String,
    lifecycle: Option<SessionLifecycle>,
    workspace: Option<String>,
    text: Option<String>,
}

struct QueryBudget<'a>(&'a Connection);

impl Drop for QueryBudget<'_> {
    fn drop(&mut self) {
        let _ = self.0.progress_handler(0, None::<fn() -> bool>);
    }
}

fn page_limit(limit: Option<usize>) -> Result<usize> {
    let limit = limit.unwrap_or(100);
    if limit == 0 || limit > MAX_PAGE_ITEMS {
        return Err(Error::Invalid("page limit must be 1..200".into()));
    }
    Ok(limit)
}

impl Store {
    fn query_budget<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        let deadline = Instant::now() + Duration::from_millis(250);
        self.connection
            .progress_handler(1000, Some(move || Instant::now() >= deadline))?;
        let _guard = QueryBudget(&self.connection);
        operation().map_err(|error| match error {
            Error::Storage(rusqlite::Error::SqliteFailure(code, _))
                if code.code == rusqlite::ErrorCode::OperationInterrupted =>
            {
                Error::Timeout
            }
            error => error,
        })
    }

    fn session_seq(&self) -> Result<i64> {
        Ok(self
            .connection
            .query_row(
                "SELECT last_seq FROM stream_heads WHERE scope='sessions'",
                [],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    pub fn session_summary(&self, workspace: Option<&str>) -> Result<SessionSummary> {
        if let Some(workspace) = workspace {
            validate_text(workspace, 4096, false)?;
        }
        let (total, active, attention) = self
            .connection
            .query_row(
                "SELECT total,active,attention FROM session_counts WHERE scope=?1 AND workspace=?2",
                params![i64::from(workspace.is_some()), workspace.unwrap_or("")],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?
            .unwrap_or((0, 0, 0));
        Ok(SessionSummary {
            total,
            active,
            archived: total - active,
            attention,
            latest_seq: self.session_seq()?,
        })
    }

    pub fn workspaces(&self, query: WorkspaceQuery) -> Result<WorkspacePage> {
        let limit = page_limit(query.limit)?;
        if let Some(cursor) = &query.cursor {
            validate_text(cursor, 4096, false)?;
        }
        let latest_seq = self.session_seq()?;
        let mut statement = self.connection.prepare_cached("SELECT workspace,total,active,attention FROM session_counts WHERE scope=1 AND workspace>?1 ORDER BY workspace LIMIT ?2")?;
        let rows = statement.query_map(
            params![query.cursor.unwrap_or_default(), (limit + 1) as i64],
            |row| {
                let total: i64 = row.get(1)?;
                let active: i64 = row.get(2)?;
                Ok(WorkspaceHead {
                    workspace: row.get(0)?,
                    summary: SessionSummary {
                        total,
                        active,
                        archived: total - active,
                        attention: row.get(3)?,
                        latest_seq,
                    },
                })
            },
        )?;
        let mut items = Vec::new();
        let mut bytes = 0;
        let mut has_more = false;
        for row in rows {
            let item = row?;
            let size = serde_json::to_vec(&item)?.len();
            if items.len() == limit || bytes + size > MAX_PAGE_BYTES {
                has_more = true;
                break;
            }
            bytes += size;
            items.push(item);
        }
        let next_cursor = if has_more {
            items.last().map(|item| item.workspace.clone())
        } else {
            None
        };
        Ok(WorkspacePage {
            items,
            next_cursor,
            has_more,
            latest_seq,
        })
    }

    pub fn lookup_sessions(&self, input: SessionLookup) -> Result<SessionLookupResult> {
        if input.ids.len() > 100 {
            return Err(Error::Invalid("lookup limit must be at most 100".into()));
        }
        for id in &input.ids {
            validate_id(id)?;
        }
        let mut seen = HashSet::new();
        let mut items = Vec::new();
        let mut missing_ids = Vec::new();
        for id in input.ids {
            if !seen.insert(id.clone()) {
                continue;
            }
            match self.session(&id) {
                Ok(head) => items.push(head),
                Err(Error::NotFound) => missing_ids.push(id),
                Err(error) => return Err(error),
            }
        }
        Ok(SessionLookupResult {
            items,
            missing_ids,
            latest_seq: self.session_seq()?,
        })
    }

    pub fn sessions(&self, mut query: SessionQuery) -> Result<SessionPage> {
        let limit = page_limit(query.limit)?;
        if let Some(workspace) = &query.workspace {
            validate_text(workspace, 4096, false)?;
        }
        if let Some(text) = &query.text {
            validate_text(text, 256, true)?;
        }
        query.text = query
            .text
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty());
        let cursor = if let Some(raw) = &query.cursor {
            if raw.len() > 16384 {
                return Err(Error::Invalid("invalid cursor".into()));
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(raw)
                .map_err(|_| Error::Invalid("invalid cursor".into()))?;
            let cursor: Cursor = serde_json::from_slice(&bytes)
                .map_err(|_| Error::Invalid("invalid cursor".into()))?;
            validate_id(&cursor.id)?;
            if !(0..=9_007_199_254_740_991).contains(&cursor.created_at)
                || cursor.lifecycle != query.lifecycle
                || cursor.workspace != query.workspace
                || cursor.text != query.text
            {
                return Err(Error::Invalid("cursor does not match query".into()));
            }
            Some(cursor)
        } else {
            None
        };
        let mut clauses = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        if let Some(lifecycle) = query.lifecycle {
            clauses.push("h.lifecycle=?");
            values.push(label(lifecycle)?.into());
        }
        if let Some(workspace) = &query.workspace {
            clauses.push("h.workspace=?");
            values.push(workspace.clone().into());
        }
        if let Some(text) = &query.text {
            let tokens: Vec<_> = text
                .split(|c: char| !c.is_alphanumeric())
                .filter(|token| !token.is_empty())
                .collect();
            if tokens.is_empty() {
                return Err(Error::Invalid("search requires letters or numbers".into()));
            }
            let terms = tokens
                .iter()
                .map(|token| format!("\"{token}\"*"))
                .collect::<Vec<_>>()
                .join(" AND ");
            clauses
                .push("h.rowid IN (SELECT rowid FROM session_search WHERE session_search MATCH ?)");
            values.push(terms.into());
        }
        self.query_budget(|| {
            let summary = self.session_summary(query.workspace.as_deref())?;
            let available = match query.lifecycle { Some(SessionLifecycle::Active) => summary.active, Some(SessionLifecycle::Archived) => summary.archived, None => summary.total };
            let global_total = if query.workspace.is_some() { self.session_summary(None)?.total } else { summary.total };
            let total = if query.text.is_some() {
                if available == global_total {
                    self.connection.query_row("SELECT count(*) FROM session_search WHERE session_search MATCH ?", [values.last().unwrap()], |row| row.get(0))?
                } else {
                    let sql = format!("SELECT count(*) FROM session_heads h WHERE {}", clauses.join(" AND "));
                    self.connection.query_row(&sql, params_from_iter(&values), |row| row.get(0))?
                }
            } else {
                available
            };
            if total == 0 { return Ok(SessionPage { items: vec![], next_cursor: None, has_more: false, total, latest_seq: summary.latest_seq }); }
            let mut source = "session_heads h".to_owned();
            if query.text.is_some() && total == available {
                clauses.pop(); values.pop();
            } else if query.text.is_some() && total > available / 4 {
                let index = match (query.workspace.is_some(), query.lifecycle.is_some()) {
                    (true, true) => "session_workspace_lifecycle_page",
                    (true, false) => "session_workspace_page",
                    (false, true) => "session_lifecycle_page",
                    (false, false) => "session_page",
                };
                source = format!("session_heads h INDEXED BY {index}");
            }
            clauses.push("(h.created_at,h.id)<(?,?)");
            let (time, id) = cursor.as_ref().map_or((i64::MAX, "~"), |cursor| (cursor.created_at, cursor.id.as_str()));
            values.extend([time.into(), id.to_owned().into(), ((limit + 1) as i64).into()]);
            let sql = format!("SELECT h.payload FROM {source} WHERE {} ORDER BY h.created_at DESC,h.id DESC LIMIT ?", clauses.join(" AND "));
            let mut statement = self.connection.prepare_cached(&sql)?;
            let mut items: Vec<SessionHead> = Vec::new();
            let mut bytes = 0;
            let mut has_more = false;
            for row in statement.query_map(params_from_iter(&values), |row| row.get::<_, String>(0))? {
                let value = row?;
                if items.len() == limit || bytes + value.len() > MAX_PAGE_BYTES { has_more = true; break; }
                bytes += value.len(); items.push(serde_json::from_str(&value)?);
            }
            let next_cursor = if has_more {
                items.last().map(|head| serde_json::to_vec(&Cursor { created_at: head.created_at, id: head.id.clone(), lifecycle: query.lifecycle, workspace: query.workspace.clone(), text: query.text.clone() }).map(|value| URL_SAFE_NO_PAD.encode(value))).transpose()?
            } else { None };
            Ok(SessionPage { items, next_cursor, has_more, total, latest_seq: summary.latest_seq })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expensive_sql_is_interrupted_and_the_worker_connection_remains_usable() {
        let directory = tempfile::TempDir::new().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let start = Instant::now();
        let result: Result<i64> = store.query_budget(|| Ok(store.connection.query_row("WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<1000000000) SELECT sum(n) FROM numbers", [], |row| row.get(0))?));
        assert!(matches!(result, Err(Error::Timeout)));
        assert!(start.elapsed() < Duration::from_secs(3));
        store
            .create_session(CreateSession {
                agent: AgentKind::Shell,
                kind: SessionKind::Pty,
                title: "After timeout".into(),
                workspace: "/synthetic".into(),
            })
            .unwrap();
        assert_eq!(store.session_summary(None).unwrap().total, 1);
        assert_eq!(store.check().unwrap(), "ok");
    }
}
