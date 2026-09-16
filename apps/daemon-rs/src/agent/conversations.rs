//! Read-only discovery of provider-native conversations that can be resumed.
//!
//! This mirrors the TypeScript daemon's managed-Claude path: scan Claude's
//! `projects/**/*.jsonl` metadata and return only bounded summaries. The
//! actual context remains owned by Claude Code and is attached later via
//! `session.create({ resume })` / `--resume`.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::Value;

use crate::agent::ResumableConversation;
use crate::error::{Error, Result};
use crate::protocol::AgentKind;

const MAX_QUERY_CHARS: usize = 300;
const MAX_RESULTS: usize = 50;
const MAX_SCAN_FILES: usize = 2_000;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_HEADER_LINES: usize = 120;

fn home_dir() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| Error::Invalid("home directory unavailable".into()))
}

fn contains_subagents(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::Normal(name) if name == "subagents"))
}

fn trim_chars(value: &str, maximum: usize) -> String {
    let value = value.trim();
    let end = value
        .char_indices()
        .nth(maximum)
        .map_or(value.len(), |(index, _)| index);
    value[..end].to_owned()
}

fn text_from_content(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_owned();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    blocks
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
}

fn collect_jsonl_files(root: &Path, files: &mut Vec<PathBuf>) {
    if files.len() >= MAX_SCAN_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if files.len() >= MAX_SCAN_FILES {
            return;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect_jsonl_files(&path, files);
        } else if kind.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
            && !contains_subagents(&path)
        {
            files.push(path);
        }
    }
}

fn parse_claude_file(
    path: &Path,
    needle: &str,
    fallback_cwd: &str,
) -> Option<ResumableConversation> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    let mut session_id = path.file_stem()?.to_str()?.to_owned();
    let mut cwd = fallback_cwd.to_owned();
    let mut first_prompt = String::new();
    let mut title = String::new();
    let mut created_at = None;

    for line in raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(MAX_HEADER_LINES)
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(value) = value.get("sessionId").and_then(Value::as_str) {
            session_id = value.to_owned();
        }
        if let Some(value) = value.get("cwd").and_then(Value::as_str)
            && !value.trim().is_empty()
        {
            cwd = value.to_owned();
        }
        if created_at.is_none()
            && let Some(value) = value.get("timestamp").and_then(Value::as_str)
        {
            created_at = chrono_like_parse_millis(value);
        }
        if let Some(value) = value.get("customTitle").and_then(Value::as_str) {
            title = value.to_owned();
        }
        if value.get("type").and_then(Value::as_str) == Some("user")
            && first_prompt.is_empty()
            && let Some(message) = value.get("message").and_then(Value::as_object)
            && let Some(content) = message.get("content")
        {
            first_prompt = text_from_content(content);
        }
        if !first_prompt.is_empty() && !title.is_empty() {
            break;
        }
    }

    let display_title = trim_chars(
        if title.trim().is_empty() {
            if first_prompt.trim().is_empty() {
                "Claude 对话"
            } else {
                &first_prompt
            }
        } else {
            &title
        },
        500,
    );
    let preview = (!first_prompt.trim().is_empty()).then(|| trim_chars(&first_prompt, 4_000));
    if !needle.is_empty() {
        let matches = [&display_title, first_prompt.trim(), cwd.trim()]
            .iter()
            .any(|value| value.to_lowercase().contains(needle));
        if !matches {
            return None;
        }
    }
    let updated_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_else(crate::database::now);
    Some(ResumableConversation {
        id: trim_chars(&session_id, 256),
        agent: AgentKind::Claude,
        title: display_title,
        preview,
        cwd: trim_chars(&cwd, 4096),
        created_at,
        updated_at,
    })
}

/// Parse the common RFC3339 UTC shape emitted by Claude Code sufficiently for
/// metadata display. Unknown formats are simply omitted, matching TS' optional
/// `createdAt` behavior on parse failures.
fn chrono_like_parse_millis(value: &str) -> Option<i64> {
    if let Ok(raw) = value.parse::<i64>() {
        return (raw >= 0).then_some(if raw < 10_000_000_000 {
            raw * 1000
        } else {
            raw
        });
    }
    let value = value.trim();
    let (date, time) = value.split_once('T')?;
    let time = time.strip_suffix('Z').unwrap_or(time);
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    if date_parts.next().is_some() {
        return None;
    }
    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let second_raw = time_parts.next()?;
    if time_parts.next().is_some() {
        return None;
    }
    let (second_text, millis) = match second_raw.split_once('.') {
        Some((seconds, fraction)) => {
            let mut padded = fraction.chars().take(3).collect::<String>();
            while padded.len() < 3 {
                padded.push('0');
            }
            (seconds, padded.parse::<i64>().ok()?)
        }
        None => (second_raw, 0),
    };
    let second = second_text.parse::<i64>().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=60).contains(&second)
    {
        return None;
    }
    // Howard Hinnant's days-from-civil algorithm, Unix epoch based.
    let y = year - (month <= 2) as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * month_prime + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second;
    (seconds >= 0).then_some(seconds.saturating_mul(1000).saturating_add(millis))
}

pub(crate) fn search_claude_config_dir(
    config_dir: &Path,
    query: &str,
    requested_limit: Option<usize>,
) -> Result<Vec<ResumableConversation>> {
    if query.chars().count() > MAX_QUERY_CHARS || query.chars().any(char::is_control) {
        return Err(Error::Invalid("对话搜索词无效".into()));
    }
    let limit = requested_limit.unwrap_or(20).clamp(1, MAX_RESULTS);
    let fallback = home_dir()
        .unwrap_or_else(|_| PathBuf::from("/"))
        .to_string_lossy()
        .into_owned();
    let needle = query.trim().to_lowercase();
    let mut files = Vec::new();
    collect_jsonl_files(&config_dir.join("projects"), &mut files);
    let mut results = files
        .iter()
        .filter_map(|path| parse_claude_file(path, &needle, &fallback))
        .collect::<Vec<_>>();
    results.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
    results.truncate(limit);
    Ok(results)
}

pub(crate) async fn search_codex_conversations(
    database: &crate::worker::Database,
    account_id: Option<String>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<ResumableConversation>> {
    if query.chars().count() > MAX_QUERY_CHARS || query.chars().any(char::is_control) {
        return Err(Error::Invalid("对话搜索词无效".into()));
    }
    let limit = limit.unwrap_or(20).clamp(1, MAX_RESULTS);
    match account_id.as_deref() {
        None | Some(crate::agent::NATIVE_CODEX_ID) => {}
        Some(_) => {
            return Err(Error::Invalid(
                "Rust daemon 当前仅支持本机 Codex 对话搜索".into(),
            ));
        }
    }
    let data = database.directory().to_owned();
    crate::agent::usage::search_native_codex_conversations(&data, &query, limit).await
}

pub(crate) async fn search_deepseek_conversations(
    account_id: Option<String>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<ResumableConversation>> {
    if account_id.is_some() {
        return Err(Error::Invalid(
            "Rust daemon 当前仅支持本机 DeepSeek 对话搜索".into(),
        ));
    }
    crate::agent::deepseek::search_conversations(query, limit).await
}

pub(crate) async fn search_claude_conversations(
    database: &crate::worker::Database,
    account_id: Option<String>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<ResumableConversation>> {
    let data = database.directory().to_owned();
    let config_dir = match account_id.as_deref() {
        None | Some(crate::accounts::NATIVE_CLAUDE_ID) => home_dir()?.join(".claude"),
        Some(id) => {
            let id = id.to_owned();
            let record = database
                .call({
                    let data = data.clone();
                    let id = id.clone();
                    move |store| store.managed_snapshot_row(&data, &id)
                })
                .await?;
            if record.api_profile.is_some() {
                return Err(Error::Invalid("API Profile 暂不支持接回历史对话".into()));
            }
            crate::accounts::managed::account_root(&data, &id)?
        }
    };
    tokio::task::spawn_blocking(move || search_claude_config_dir(&config_dir, &query, limit))
        .await
        .map_err(|_| Error::Closed)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_history(root: &Path, relative: &str, content: &str) -> PathBuf {
        let path = root.join("projects").join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn scans_claude_jsonl_metadata_and_filters_subagents() {
        let root = TempDir::new().unwrap();
        write_history(
            root.path(),
            "repo/session-1.jsonl",
            r#"{"sessionId":"native-1","cwd":"/repo","timestamp":"2026-09-13T20:00:00.123Z","type":"user","message":{"content":[{"type":"text","text":"Build a rust daemon"}]}}
{"customTitle":"Rust daemon parity"}
"#,
        );
        write_history(
            root.path(),
            "repo/subagents/session-2.jsonl",
            r#"{"sessionId":"hidden","type":"user","message":{"content":"hidden"}}
"#,
        );

        let results = search_claude_config_dir(root.path(), "daemon", Some(10)).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "native-1");
        assert_eq!(results[0].title, "Rust daemon parity");
        assert_eq!(results[0].preview.as_deref(), Some("Build a rust daemon"));
        assert_eq!(results[0].cwd, "/repo");
        assert_eq!(results[0].created_at, Some(1_789_329_600_123));
    }

    #[test]
    fn search_limits_and_validates_query() {
        let root = TempDir::new().unwrap();
        for index in 0..60 {
            write_history(
                root.path(),
                &format!("repo/{index}.jsonl"),
                &format!(
                    r#"{{"sessionId":"session-{index}","type":"user","message":{{"content":"hello {index}"}}}}
"#
                ),
            );
        }
        assert_eq!(
            search_claude_config_dir(root.path(), "", Some(99))
                .unwrap()
                .len(),
            50
        );
        assert!(search_claude_config_dir(root.path(), "bad\n", Some(1)).is_err());
    }
}
