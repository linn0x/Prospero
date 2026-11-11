use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use base64::Engine;
use base64::prelude::BASE64_STANDARD;

use tokio::sync::{Mutex, MutexGuard, Semaphore, oneshot, watch};

use super::claude::{AdapterEvent, ClaudeTurn, QuestionReply, TurnOptions, spawn_turn};
use super::codex::CodexTurn;
use super::deepseek::DeepseekTurn;
use super::lifecycle::{ProcessLifecycle, driver_error_from_error, driver_error_from_message};
use super::opencode::OpencodeTurn;
use super::store::{ApprovalPolicy, PermissionMode, QueuedRow};
use super::*;
use crate::error::{Error, Result};
use crate::orchestration::reliability::ControlEffectState;
use crate::protocol::*;
use crate::worker::Database;

/// Bounded structured-agent capacity shared by supervisors and workers.
///
/// The crawler shard can host up to 232 pending PSMs. Each PSM keeps a
/// supervisor session and may have a live stage worker, so the former 128
/// slots would exhaust before the batch scheduler's own admission limit.
/// Keep headroom for preflight and other control sessions; Controller budgets
/// and the daemon request/database semaphores still provide backpressure.
pub(crate) const MAX_TURNS: usize = 512;
const CROSS_MODEL_CHECK_LEASE_MILLIS: i64 = 60_000;
const STREAM_FLUSH_COALESCE_DELAY: Duration = Duration::from_millis(45);
const FAN_IN_CLAIM_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);

struct TurnOutcome {
    failed_error: Option<String>,
}

#[derive(Default)]
struct StreamSegmentTracker {
    index: usize,
    interrupted: bool,
    current_raw: String,
    prior_joined: String,
}

impl StreamSegmentTracker {
    fn mark_interrupted(&mut self) {
        if !self.current_raw.is_empty() {
            self.interrupted = true;
        }
    }

    fn resolve(&mut self, incoming: String, base_id: &str) -> Option<(String, String)> {
        if self.interrupted {
            let candidate_prior = if self.prior_joined.is_empty() {
                self.current_raw.clone()
            } else if self.current_raw.is_empty() {
                self.prior_joined.clone()
            } else {
                format!("{}\n\n{}", self.prior_joined, self.current_raw)
            };
            let post_tool_text = if !candidate_prior.is_empty() {
                if let Some(rest) = incoming.strip_prefix(&candidate_prior) {
                    rest.strip_prefix("\n\n").unwrap_or(rest).to_owned()
                } else {
                    incoming
                }
            } else {
                incoming
            };
            if post_tool_text.is_empty() {
                return None;
            }
            self.interrupted = false;
            self.prior_joined = candidate_prior;
            self.index += 1;
            self.current_raw = post_tool_text.clone();
            return Some((format!("{base_id}-{}", self.index + 1), post_tool_text));
        }

        let segment_text = if self.index > 0 && !self.prior_joined.is_empty() {
            if let Some(rest) = incoming.strip_prefix(&self.prior_joined) {
                rest.strip_prefix("\n\n").unwrap_or(rest).to_owned()
            } else {
                incoming
            }
        } else {
            incoming
        };
        if segment_text.is_empty() && self.current_raw.is_empty() {
            return None;
        }
        self.current_raw = segment_text.clone();
        let record_id = if self.index == 0 {
            base_id.to_owned()
        } else {
            format!("{base_id}-{}", self.index + 1)
        };
        Some((record_id, segment_text))
    }
}

fn upsert_pending_write(
    pending: &mut Vec<TimelineWrite>,
    revisions: &mut HashMap<String, i64>,
    record_id: String,
    turn_id: String,
    body: TimelineBody,
    text: String,
    subagent_id: Option<String>,
) {
    if let Some(existing) = pending.iter_mut().find(|w| w.id == record_id && w.replace) {
        existing.body = body;
        existing.text = text;
        return;
    }
    let revision = revisions.get(&record_id).copied().unwrap_or(0);
    pending.push(TimelineWrite {
        id: record_id.clone(),
        turn_id,
        expected_revision: revision,
        body,
        text,
        replace: true,
        subagent_id,
    });
    revisions.insert(record_id, revision + 1);
}

fn contains_http_status_token(lower: &str, code: &str) -> bool {
    let bytes = lower.as_bytes();
    let needle = code.as_bytes();
    if bytes.len() < needle.len() {
        return false;
    }
    let mut pos = 0;
    while let Some(rel) = lower[pos..].find(code) {
        let idx = pos + rel;
        let end = idx + needle.len();
        let prev = idx.checked_sub(1).map(|i| bytes[i]);
        let next = bytes.get(end).copied();
        let prev_ok = match prev {
            None => true,
            Some(b':') => {
                // Reject port numbers like `127.0.0.1:429` while allowing `status:429` / `code:401`.
                let prefix = &lower[..idx - 1];
                prefix.ends_with("status") || prefix.ends_with("code") || prefix.ends_with("http")
            }
            Some(b'.') | Some(b'/') | Some(b'-') | Some(b'_') => false,
            Some(b) => !b.is_ascii_alphanumeric(),
        };
        let next_ok = match next {
            None => true,
            Some(b'.') | Some(b'-') | Some(b'_') => false,
            Some(b) => !b.is_ascii_alphanumeric(),
        };
        if prev_ok && next_ok {
            return true;
        }
        pos = idx + 1;
    }
    false
}

fn should_pause_queue_on_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    for code in ["401", "403", "429"] {
        if contains_http_status_token(&lower, code) {
            return true;
        }
    }
    const ASCII_PATTERNS: &[&str] = &[
        "unauthorized",
        "authentication_error",
        "authentication failed",
        "auth failed",
        "invalid api key",
        "invalid_api_key",
        "api key not valid",
        "permission_error",
        "login required",
        "not logged in",
        "please log in",
        "re-authenticate",
        "token expired",
        "access_denied",
        "rate limit",
        "rate_limit",
        "ratelimit",
        "too many requests",
        "quota",
        "insufficient_quota",
        "insufficient balance",
        "credit balance",
        "usage limit",
        "out of credits",
        "payment required",
    ];
    if ASCII_PATTERNS.iter().any(|pat| lower.contains(pat)) {
        return true;
    }
    const CJK_PATTERNS: &[&str] = &[
        "未登录",
        "请先登录",
        "鉴权失败",
        "认证失败",
        "密钥无效",
        "登录已过期",
        "余额不足",
        "配额",
        "额度不足",
        "额度已用尽",
        "限流",
        "请求过于频繁",
    ];
    CJK_PATTERNS.iter().any(|pat| message.contains(pat))
}

/// Build UTF-8-safe bracketed paste chunks (`\x1b[200~` ... `\x1b[201~`) WITHOUT
/// the trailing `\r`. The caller sends `\r` only after every paste chunk succeeds.
fn build_safe_pty_paste_chunks(report: &str, max_chunk_bytes: usize) -> Vec<Vec<u8>> {
    const OPEN: &[u8] = b"\x1b[200~";
    const CLOSE: &[u8] = b"\x1b[201~";
    let cap = max_chunk_bytes.max(OPEN.len() + CLOSE.len() + 4);
    if report.is_empty() {
        let mut fallback = crate::cross_model_tool::terminal_fan_in_chunks(report, cap);
        if let Some(last) = fallback.last_mut()
            && last.ends_with(b"\r")
        {
            last.pop();
        }
        fallback.retain(|chunk| !chunk.is_empty());
        if !fallback.is_empty() {
            return fallback;
        }
    }
    let sanitized: String = report
        .trim_end_matches(['\r', '\n'])
        .replace("\x1b[200~", "")
        .replace("\x1b[201~", "")
        .chars()
        .map(|ch| if ch == '\x1b' { ' ' } else { ch })
        .collect();

    if OPEN.len() + sanitized.len() + CLOSE.len() <= cap {
        let mut single = Vec::with_capacity(OPEN.len() + sanitized.len() + CLOSE.len());
        single.extend_from_slice(OPEN);
        single.extend_from_slice(sanitized.as_bytes());
        single.extend_from_slice(CLOSE);
        return vec![single];
    }

    let mut chunks: Vec<Vec<u8>> = Vec::new();
    let mut offset = 0usize;
    let mut first = true;
    while offset < sanitized.len() {
        let prefix_len = if first { OPEN.len() } else { 0 };
        let budget = cap.saturating_sub(prefix_len);
        let remaining = &sanitized[offset..];
        let slice_len = if remaining.len() <= budget {
            remaining.len()
        } else {
            let boundary = remaining.floor_char_boundary(budget);
            if boundary > 0 {
                boundary
            } else {
                remaining.chars().next().map_or(0, char::len_utf8)
            }
        };
        let slice = &remaining[..slice_len];
        offset += slice_len;
        let is_last_body = offset >= sanitized.len();
        let can_append_close = is_last_body && (prefix_len + slice.len() + CLOSE.len() <= cap);
        let mut buf = Vec::with_capacity(
            prefix_len + slice.len() + if can_append_close { CLOSE.len() } else { 0 },
        );
        if first {
            buf.extend_from_slice(OPEN);
            first = false;
        }
        buf.extend_from_slice(slice.as_bytes());
        if can_append_close {
            buf.extend_from_slice(CLOSE);
        }
        chunks.push(buf);
        if is_last_body && !can_append_close {
            chunks.push(CLOSE.to_vec());
        }
    }
    if chunks.is_empty() {
        let mut empty = Vec::with_capacity(OPEN.len() + CLOSE.len());
        empty.extend_from_slice(OPEN);
        empty.extend_from_slice(CLOSE);
        chunks.push(empty);
    }
    chunks
}

async fn send_safe_pty_paste<F, Fut>(
    report: &str,
    max_chunk_bytes: usize,
    mut send_chunk: F,
) -> Result<()>
where
    F: FnMut(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let paste_chunks = build_safe_pty_paste_chunks(report, max_chunk_bytes);
    let total = paste_chunks.len();
    let mut paste_opened = false;
    let mut paste_closed = false;
    for (idx, chunk) in paste_chunks.into_iter().enumerate() {
        let closes_paste = idx + 1 == total;
        match send_chunk(chunk).await {
            Ok(()) => {
                paste_opened = true;
                if closes_paste {
                    paste_closed = true;
                }
            }
            Err(error) => {
                if paste_opened && !paste_closed {
                    // Best-effort close bracketed paste mode WITHOUT `\r` so the
                    // PTY is never left stuck swallowing user keystrokes.
                    let _ = send_chunk(b"\x1b[201~".to_vec()).await;
                }
                return Err(error);
            }
        }
    }
    // Only send Enter (`\r`) after every paste chunk + `\x1b[201~` succeeded!
    send_chunk(b"\r".to_vec()).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParentReportDelivery {
    Submitted,
    Queued,
    Delivered,
}

fn decode_base64_lenient(input: &str) -> Result<Vec<u8>> {
    fn value(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = input.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut sextets = [0u8; 4];
        for (index, byte) in chunk.iter().enumerate() {
            sextets[index] = value(*byte).ok_or_else(|| Error::Invalid("图片数据无效".into()))?;
        }
        match chunk.len() {
            4 => {
                out.push((sextets[0] << 2) | (sextets[1] >> 4));
                out.push((sextets[1] << 4) | (sextets[2] >> 2));
                out.push((sextets[2] << 6) | sextets[3]);
            }
            3 => {
                out.push((sextets[0] << 2) | (sextets[1] >> 4));
                out.push((sextets[1] << 4) | (sextets[2] >> 2));
            }
            2 => out.push((sextets[0] << 2) | (sextets[1] >> 4)),
            0 => {}
            _ => return Err(Error::Invalid("图片数据无效".into())),
        }
    }
    Ok(out)
}

/// Latest card state carried between card-record rewrites.
struct CardState {
    name: String,
    role: Option<String>,
    task: Option<String>,
    created_at: i64,
    status: String,
    can_message: bool,
    summary: String,
}

/// CLI task ids are only used as opaque keys by the renderer, but timeline
/// record ids must match `[A-Za-z0-9_-]{1,256}`; normalize defensively.
fn safe_owner(id: &str) -> String {
    let mut slug: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if slug.is_empty() {
        slug.push_str("subagent");
    }
    slug.truncate(120);
    slug
}

fn clone_timeline_writes(writes: &[TimelineWrite]) -> Vec<TimelineWrite> {
    writes
        .iter()
        .map(|write| TimelineWrite {
            id: write.id.clone(),
            turn_id: write.turn_id.clone(),
            expected_revision: write.expected_revision,
            body: write.body.clone(),
            text: write.text.clone(),
            replace: write.replace,
            subagent_id: write.subagent_id.clone(),
        })
        .collect()
}

fn copy_fork_attachments(data: &Path, source: &str, destination: &str) -> Result<()> {
    fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
        let metadata = std::fs::symlink_metadata(source)?;
        if metadata.file_type().is_symlink() {
            return Err(Error::Invalid("附件路径包含符号链接，无法创建分支".into()));
        }
        if metadata.is_dir() {
            std::fs::create_dir_all(destination)?;
            for entry in std::fs::read_dir(source)? {
                let entry = entry?;
                copy_tree(&entry.path(), &destination.join(entry.file_name()))?;
            }
        } else if metadata.is_file() {
            std::fs::copy(source, destination)?;
        } else {
            return Err(Error::Invalid("附件类型无效".into()));
        }
        Ok(())
    }
    let root = data.join("attachments").join(source);
    match std::fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => copy_tree(&root, &data.join("attachments").join(destination)),
    }
}

fn attachment_path(
    data: &Path,
    session_id: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<std::path::PathBuf> {
    crate::database::validate_id(session_id)?;
    crate::timeline::validate_record_id(message_id)?;
    crate::timeline::validate_record_id(attachment_id)?;
    Ok(data
        .join("attachments")
        .join(session_id)
        .join(message_id)
        .join(attachment_id))
}

async fn persist_attachment_bytes(
    data: std::path::PathBuf,
    session_id: String,
    message_id: String,
    refs: Vec<MessageAttachment>,
    attachments: Vec<AttachmentInput>,
) -> Result<()> {
    if attachments.is_empty() {
        return Ok(());
    }
    tokio::task::spawn_blocking(move || {
        let directory = data.join("attachments").join(&session_id).join(&message_id);
        std::fs::create_dir_all(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        }
        for (reference, attachment) in refs.into_iter().zip(attachments) {
            let path = attachment_path(&data, &session_id, &message_id, &reference.id)?;
            let bytes = decode_base64_lenient(&attachment.data_b64)?;
            std::fs::write(path, bytes)?;
        }
        Ok(())
    })
    .await
    .map_err(|_| Error::Closed)?
}

/// Build metadata-only attachment refs for the persisted user record. Ids are
/// generated by the daemon and bytes are stored in private session files.
fn attachment_refs(attachments: &[AttachmentInput]) -> Vec<MessageAttachment> {
    attachments
        .iter()
        .map(|attachment| MessageAttachment {
            id: uuid::Uuid::new_v4().simple().to_string(),
            mime_type: attachment.mime_type.clone(),
            name: attachment.name.clone(),
        })
        .collect()
}

enum Driver {
    Claude(ClaudeTurn),
    Codex(CodexTurn),
    Deepseek(DeepseekTurn),
    Opencode(OpencodeTurn),
    Pi(super::pi::PiTurn),
    Agy(super::agy::AgyTurn),
}

fn engine_agent(agent: AgentKind, profile: Option<&crate::accounts::ApiProfile>) -> AgentKind {
    if agent == AgentKind::Pi {
        return AgentKind::Pi;
    }
    if agent == AgentKind::Agy {
        return AgentKind::Agy;
    }
    profile
        .map(crate::accounts::profile::agent_kind)
        .unwrap_or(agent)
}

fn account_agent_matches(
    requested: AgentKind,
    record: &crate::accounts::managed::ManagedRecord,
) -> bool {
    record.agent == requested
        || record
            .api_profile
            .as_ref()
            .is_some_and(|profile| engine_agent(record.agent, Some(profile)) == requested)
}

impl Driver {
    fn take_events(&mut self) -> Option<tokio::sync::mpsc::Receiver<AdapterEvent>> {
        match self {
            Driver::Claude(driver) => driver.take_events(),
            Driver::Codex(driver) => driver.take_events(),
            Driver::Deepseek(driver) => driver.take_events(),
            Driver::Opencode(driver) => driver.take_events(),
            Driver::Pi(driver) => driver.take_events(),
            Driver::Agy(driver) => driver.take_events(),
        }
    }

    async fn interrupt(&self) -> ControlEffectState {
        match self {
            Driver::Claude(driver) => driver.interrupt(),
            Driver::Codex(driver) => driver.interrupt().await,
            Driver::Deepseek(driver) => driver.interrupt().await,
            Driver::Opencode(driver) => driver.interrupt().await,
            Driver::Pi(driver) => driver.interrupt(),
            Driver::Agy(driver) => driver.interrupt().await,
        }
    }

    async fn steer(
        &self,
        text: &str,
        attachments: &[AttachmentInput],
    ) -> Result<ControlEffectState> {
        match self {
            Driver::Claude(driver) => driver
                .steer(text, attachments)
                .await
                .map(|_| ControlEffectState::Received),
            Driver::Codex(driver) => {
                if !attachments.is_empty() {
                    return Err(Error::Invalid("Codex 同轮引导暂不支持附件".into()));
                }
                driver
                    .steer(text)
                    .await
                    .map(|_| ControlEffectState::Delivered)
            }
            Driver::Deepseek(driver) => driver
                .steer(text, attachments)
                .await
                .map(|_| ControlEffectState::Delivered),
            Driver::Opencode(driver) => {
                if !attachments.is_empty() {
                    return Err(Error::Invalid(
                        "OpenCode structured runtime 暂不支持图片附件".into(),
                    ));
                }
                driver
                    .steer(text)
                    .await
                    .map(|_| ControlEffectState::Delivered)
            }
            Driver::Pi(driver) => driver
                .steer(text, attachments)
                .await
                .map(|_| ControlEffectState::Delivered),
            Driver::Agy(_) => Err(Error::Conflict),
        }
    }

    async fn compact(&self) -> Result<()> {
        match self {
            Driver::Claude(driver) => driver.compact().await,
            Driver::Codex(driver) => driver.compact().await,
            Driver::Deepseek(driver) => driver.compact().await,
            Driver::Opencode(driver) => driver.compact().await,
            Driver::Pi(driver) => driver.compact().await,
            Driver::Agy(_) => Err(Error::Invalid(
                "Antigravity CLI 暂不支持手动压缩上下文".into(),
            )),
        }
    }

    async fn send_to_subagent(&self, subagent: &str, text: &str) -> Result<ControlEffectState> {
        match self {
            Driver::Codex(driver) => driver
                .send_to_subagent(subagent, text)
                .await
                .map(|_| ControlEffectState::Delivered),
            Driver::Claude(_)
            | Driver::Deepseek(_)
            | Driver::Opencode(_)
            | Driver::Pi(_)
            | Driver::Agy(_) => Err(Error::Invalid("这个 Agent 不支持子 Agent 定向消息".into())),
        }
    }

    async fn read_subagent_history(
        &self,
        subagent: &str,
    ) -> Result<Option<Vec<serde_json::Value>>> {
        match self {
            Driver::Codex(driver) => driver.read_subagent_history(subagent).await,
            Driver::Claude(_)
            | Driver::Deepseek(_)
            | Driver::Opencode(_)
            | Driver::Pi(_)
            | Driver::Agy(_) => Ok(None),
        }
    }

    async fn apply_selection(&mut self, model: &str, effort: Option<&str>) -> Result<()> {
        match self {
            Driver::Claude(driver) => driver.apply_selection(model, effort).await,
            Driver::Codex(driver) => driver.apply_selection(model, effort).await,
            Driver::Deepseek(driver) => driver.apply_selection(model, effort).await,
            Driver::Opencode(driver) => driver.apply_selection(model).await,
            Driver::Pi(driver) => driver.apply_selection(model, effort).await,
            Driver::Agy(_) => Ok(()),
        }
    }

    async fn models(&self, workspace: &str) -> Option<Result<AgentModelCatalog>> {
        match self {
            Driver::Deepseek(driver) => Some(driver.models().await),
            Driver::Opencode(driver) => Some(driver.models(workspace).await),
            Driver::Claude(_) | Driver::Codex(_) | Driver::Pi(_) | Driver::Agy(_) => None,
        }
    }

    async fn terminate(&self) -> ControlEffectState {
        match self {
            Driver::Claude(driver) => driver.kill().await,
            Driver::Codex(driver) => driver.kill().await,
            Driver::Deepseek(driver) => driver.kill().await,
            Driver::Opencode(driver) => driver.kill().await,
            Driver::Pi(driver) => driver.kill().await,
            Driver::Agy(driver) => driver.kill().await,
        }
    }

    fn lifecycle(&self) -> ProcessLifecycle {
        match self {
            Driver::Claude(driver) => driver.lifecycle(),
            Driver::Codex(driver) => driver.lifecycle(),
            Driver::Deepseek(driver) => driver.lifecycle(),
            Driver::Opencode(driver) => driver.lifecycle(),
            Driver::Pi(driver) => driver.lifecycle(),
            Driver::Agy(driver) => driver.lifecycle(),
        }
    }
}

struct Handle {
    driver: Mutex<Driver>,
    quiesced: watch::Sender<bool>,
    turn_finished: watch::Sender<bool>,
    quiescence_unknown: AtomicBool,
    replies: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    /// request id -> timeline record id of pending approvals.
    records: Mutex<HashMap<String, String>>,
    questions: Mutex<HashMap<String, QuestionPending>>,
    compact: Mutex<Option<oneshot::Sender<std::result::Result<(), String>>>>,
    /// Starts true; flipped once the turn's `result` frame has been observed.
    /// A steer delivered later cannot reach the CLI (its stdin is about to be
    /// closed), so busy-send/guide degrade to the front of the queue instead
    /// of trusting a write that the kernel pipe buffer may absorb silently.
    steerable: AtomicBool,
    permit: Mutex<Option<tokio::sync::OwnedSemaphorePermit>>,
}

impl Handle {
    async fn derived_running_status(&self) -> SessionStatus {
        if !self.replies.lock().await.is_empty() {
            SessionStatus::WaitingPermission
        } else if !self.questions.lock().await.is_empty() {
            SessionStatus::WaitingInput
        } else {
            SessionStatus::Running
        }
    }
}

/// Pending AskUserQuestion: the blocking CLI reply plus the map from public
/// question ids (`q1`) back to the native question text used in the answer.
struct QuestionPending {
    reply: oneshot::Sender<QuestionReply>,
    native_by_id: HashMap<String, String>,
}

struct Session {
    execution_unknown: AtomicBool,
    handle: Mutex<Option<Arc<Handle>>>,
    usage: Mutex<UsageReport>,
    /// Serializes drain loops so only the turn that just finished chains the
    /// queued turns (mirrors the legacy `drainingQueue` guard).
    draining: Mutex<()>,
    #[allow(dead_code)]
    permit: Mutex<Option<tokio::sync::OwnedSemaphorePermit>>,
}

struct State {
    database: Database,
    entries: Mutex<HashMap<String, Arc<Session>>>,
    entry_count: AtomicUsize,
    /// Serializes claim + delivery for each parent so a later final fan-in
    /// cannot overtake an earlier incremental batch.
    fan_in_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    slots: Arc<Semaphore>,
    worker_start_scheduler: AtomicBool,
    closed: AtomicBool,
    failed: AtomicBool,
    changed: watch::Sender<u64>,
    control_environment: std::sync::Mutex<Option<crate::control_cli::ControlEnvironment>>,
    execution_environment: Mutex<HashMap<String, Vec<(String, String)>>>,
}

fn profile_model_catalog(
    profile: crate::accounts::ApiProfile,
    current_effort: Option<String>,
) -> AgentModelCatalog {
    let supported_efforts = crate::accounts::profile::profile_supported_efforts(&profile);
    let current_effort =
        crate::accounts::profile::normalize_profile_effort(&profile, current_effort.as_deref());
    let current = profile.model.clone();
    AgentModelCatalog {
        models: vec![super::LaunchModelInfo {
            id: profile.model.clone(),
            label: profile.model,
            description: None,
            supported_efforts,
            default_effort: None,
            is_default: true,
        }],
        current_model: Some(current),
        current_effort,
    }
}

#[derive(Clone)]
pub struct Agents(Arc<State>);

impl Agents {
    pub fn new(database: Database) -> Self {
        Self(Arc::new(State {
            database,
            entries: Mutex::new(HashMap::new()),
            entry_count: AtomicUsize::new(0),
            fan_in_locks: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(MAX_TURNS)),
            worker_start_scheduler: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            changed: watch::channel(0).0,
            control_environment: std::sync::Mutex::new(None),
            execution_environment: Mutex::new(HashMap::new()),
        }))
    }

    pub async fn set_execution_environment(
        &self,
        session_id: &str,
        environment: Vec<(String, String)>,
    ) -> Result<()> {
        crate::database::validate_id(session_id)?;
        if environment.len() != 3
            || ![
                "PROSPERO_EXECUTION_HOST_SOCKET",
                "PROSPERO_EXECUTION_HOST_TOKEN_PATH",
                "PROSPERO_EXECUTION_IDENTITY_JSON",
            ]
            .iter()
            .all(|required| {
                environment
                    .iter()
                    .filter(|(key, value)| key == required && !value.is_empty())
                    .count()
                    == 1
            })
        {
            return Err(Error::Invalid("invalid execution Host environment".into()));
        }
        let mut environments = self.0.execution_environment.lock().await;
        if let Some(existing) = environments.get(session_id) {
            return if existing == &environment {
                Ok(())
            } else {
                Err(Error::Conflict)
            };
        }
        environments.insert(session_id.to_owned(), environment);
        Ok(())
    }

    pub fn count(&self) -> usize {
        self.0.entry_count.load(Ordering::Acquire)
    }

    pub fn active_turn_permits(&self) -> usize {
        MAX_TURNS - self.0.slots.available_permits()
    }

    fn sync_entry_count(&self, entries: &HashMap<String, Arc<Session>>) {
        self.0.entry_count.store(entries.len(), Ordering::Release);
    }

    async fn insert_entry(&self, id: String, session: Arc<Session>) {
        let mut entries = self.0.entries.lock().await;
        entries.insert(id, session);
        self.sync_entry_count(&entries);
    }

    async fn remove_entry(&self, id: &str) -> Option<Arc<Session>> {
        let mut entries = self.0.entries.lock().await;
        let removed = entries.remove(id);
        self.sync_entry_count(&entries);
        removed
    }

    async fn clear_entries(&self) {
        let mut entries = self.0.entries.lock().await;
        entries.clear();
        self.sync_entry_count(&entries);
    }

    /// Deactivate a settled `cross_model_children` session's active runtime
    /// (`active = 0`) once its turn is idle and its queue is empty, while
    /// keeping `session_heads`, `timeline_records`, and `cross_model_children`
    /// intact for summary/diff inspection and `follow_up_cross_model_child`.
    async fn deactivate_settled_cross_model_child(&self, child_session_id: &str) {
        let entry = self.session_entry(child_session_id).await.ok();
        if let Some(entry) = entry.as_ref() {
            if entry.execution_unknown.load(Ordering::Acquire)
                || entry.handle.lock().await.is_some()
            {
                return;
            }
        }
        let cid = child_session_id.to_owned();
        let deactivated = self
            .0
            .database
            .call(move |store| {
                let Ok(child) = store.cross_model_child(&cid) else {
                    return Ok(false);
                };
                if !child.is_terminal() {
                    return Ok(false);
                }
                let Ok(run) = store.agent_run(&cid) else {
                    return Ok(false);
                };
                if !run.active || store.agent_execution_unknown(&cid)? {
                    return Ok(true);
                }
                if !store.message_queue(&cid)?.is_empty() {
                    return Ok(false);
                }
                store.archive_agent_session(&cid, child.status == "failed")?;
                Ok(true)
            })
            .await
            .unwrap_or(false);
        if deactivated {
            if let Some(entry) = entry {
                entry.permit.lock().await.take();
            }
            self.remove_entry(child_session_id).await;
            self.0
                .execution_environment
                .lock()
                .await
                .remove(child_session_id);
            self.publish();
        }
    }

    pub(crate) fn changes(&self) -> watch::Sender<u64> {
        self.0.changed.clone()
    }

    pub(crate) fn database(&self) -> Database {
        self.0.database.clone()
    }

    pub fn configure_control_environment(
        &self,
        base_url: String,
        token_path: PathBuf,
        socket_path: String,
        cli_dir: Option<PathBuf>,
    ) {
        if let Ok(mut environment) = self.0.control_environment.lock() {
            *environment = Some(crate::control_cli::ControlEnvironment {
                home: self.0.database.directory().to_owned(),
                base_url,
                token_path,
                socket_path,
                cli_dir,
            });
        }
    }

    /// Reconcile cross-model child rows with their independently-persisted
    /// sessions.  A child can finish before the stream task reaches its
    /// normal fan-in path (notably when a provider emits `turn/completed`
    /// and closes immediately).  Without this pass it remains `starting`,
    /// preventing the parent from ever receiving the batch report.
    pub async fn recover_cross_model_fan_in_claims(&self) -> Result<usize> {
        self.0
            .database
            .call(|store| store.release_orphaned_cross_model_fan_in_claims())
            .await
    }

    /// Retry unclaimed terminal child reports that did not reach their parent.
    /// Claims without a queue row are released only during startup recovery;
    /// releasing them while a live delivery is in flight could duplicate it.
    pub async fn retry_durable_cross_model_fan_in_batch(
        &self,
        after_parent: Option<String>,
        limit: i64,
    ) -> Result<Option<String>> {
        let parents = self
            .0
            .database
            .call(move |store| {
                store.pending_cross_model_fan_in_parents_limit(after_parent.as_deref(), limit)
            })
            .await?;
        let last_parent = parents.last().cloned();
        for parent_id in parents {
            match self.deliver_pending_cross_model_fan_in(&parent_id).await {
                Ok(_) => {}
                Err(error) => self.0.database.record_recent_error(
                    "cross_model.fan_in_retry",
                    "agent_sessions",
                    &error.public().code,
                ),
            }
        }
        Ok(last_parent)
    }

    pub async fn reconcile_cross_model_children(&self) -> Result<usize> {
        let children = self
            .0
            .database
            .call(|store| store.unsettled_cross_model_children())
            .await?;
        let mut settled = 0;
        for child in children {
            let child_id = child.session_id.clone();
            let observed = self
                .0
                .database
                .call(move |store| {
                    let head = store.session(&child_id)?;
                    let run = store.agent_run(&child_id)?;
                    let task_turn = store.cross_model_child_task_turn(&child_id)?;
                    let summary = store.cross_model_child_summary(&child_id)?;
                    Ok((head.lifecycle, head.status, run.active, task_turn, summary))
                })
                .await?;
            let (lifecycle, status, active, task_turn, summary) = observed;
            let terminal = matches!(
                status,
                SessionStatus::Idle | SessionStatus::Completed | SessionStatus::Failed
            ) || lifecycle == SessionLifecycle::Archived
                || !active;
            if !terminal {
                continue;
            }
            // Do not archive the child here. A completed structured turn can
            // legitimately leave its session reusable (and its active run
            // registered); this reconciliation pass only owns the
            // cross-model relation and its fan-in report.
            let result = summary.filter(|text| !text.trim().is_empty()).or_else(|| {
                (status == SessionStatus::Failed || lifecycle == SessionLifecycle::Archived)
                    .then_some("子任务运行未生成可用的最终摘要。".into())
            });
            let state = if status == SessionStatus::Failed
                || lifecycle == SessionLifecycle::Archived
                || result.is_none()
            {
                "failed"
            } else {
                "completed"
            };
            let child_id = child.session_id.clone();
            let result_for_store = result.clone();
            let completed = self
                .0
                .database
                .call(move |store| {
                    store.complete_cross_model_child(
                        &child_id,
                        task_turn,
                        state,
                        result_for_store.as_deref(),
                    )
                })
                .await?;
            let summary = completed.result.clone().unwrap_or_else(|| {
                if state == "completed" {
                    "子任务已完成，但没有可回传的文本摘要。".into()
                } else {
                    "子任务未完成。".into()
                }
            });
            self.write_cross_model_card(&completed, state, bounded_text(summary))
                .await?;
            match self
                .deliver_pending_cross_model_fan_in(&completed.parent_session_id)
                .await
            {
                Ok(true) => settled += 1,
                Ok(false) => {}
                Err(
                    error @ (Error::Busy
                    | Error::Timeout
                    | Error::Backpressure(_)
                    | Error::Closed
                    | Error::Conflict
                    | Error::NotFound
                    | Error::TerminalInput),
                ) => {
                    if matches!(error, Error::Busy | Error::Timeout | Error::Backpressure(_)) {
                        self.spawn_delayed_fan_in_retry(completed.parent_session_id.clone());
                    }
                }
                Err(error) => return Err(error),
            }
            self.deactivate_settled_cross_model_child(&completed.session_id)
                .await;
        }
        // A prior delivery can fail after it has claimed the batch. Retry all
        // durable, fully-terminal batches even when this invocation did not
        // settle a child itself.
        let parents = self
            .0
            .database
            .call(|store| store.pending_cross_model_fan_in_parents())
            .await?;
        for parent_id in parents {
            match self.deliver_pending_cross_model_fan_in(&parent_id).await {
                Ok(true) => settled += 1,
                Ok(false) => {}
                Err(
                    error @ (Error::Busy
                    | Error::Timeout
                    | Error::Backpressure(_)
                    | Error::Closed
                    | Error::Conflict
                    | Error::NotFound
                    | Error::TerminalInput),
                ) => {
                    if matches!(error, Error::Busy | Error::Timeout | Error::Backpressure(_)) {
                        self.spawn_delayed_fan_in_retry(parent_id);
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Ok(settled)
    }

    fn spawn_delayed_fan_in_retry(&self, parent_id: String) {
        let agents = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let _ = agents.deliver_pending_cross_model_fan_in(&parent_id).await;
        });
    }

    async fn deliver_pending_cross_model_fan_in(&self, parent_session_id: &str) -> Result<bool> {
        let delivery_lock = {
            let mut locks = self.0.fan_in_locks.lock().await;
            locks
                .entry(parent_session_id.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _delivery = delivery_lock.lock().await;
        let parent_id = parent_session_id.to_owned();
        let parent = self
            .0
            .database
            .call(move |store| store.session(&parent_id))
            .await?;
        if parent.lifecycle != SessionLifecycle::Active
            || (parent.kind == SessionKind::Structured
                && self.session_entry(parent_session_id).await.is_err())
        {
            return Ok(false);
        }
        let mut delivered = false;
        loop {
            let parent_id = parent_session_id.to_owned();
            let report = self
                .0
                .database
                .call(move |store| store.claim_cross_model_fan_in(&parent_id))
                .await?;
            let Some(fan_in) = report else {
                return Ok(delivered);
            };
            let super::store::CrossModelFanIn {
                report,
                claim_id,
                children: claimed_children,
            } = fan_in;
            let delivery = self
                .deliver_cross_model_fan_in(parent_session_id, report, Some(claim_id.clone()))
                .await;
            let delivery = match delivery {
                Ok(delivery) => delivery,
                Err(error) => {
                    let parent_id = parent_session_id.to_owned();
                    let _ = self
                        .0
                        .database
                        .call(move |store| {
                            store.release_cross_model_fan_in(
                                &parent_id,
                                &claim_id,
                                &claimed_children,
                            )
                        })
                        .await;
                    return Err(error);
                }
            };
            if delivery == ParentReportDelivery::Submitted {
                let parent_id = parent_session_id.to_owned();
                self.0
                    .database
                    .call(move |store| {
                        store.mark_cross_model_fan_in_delivered(&parent_id, &claim_id)
                    })
                    .await?;
            }
            delivered = true;
        }
    }

    /// Return a completed child-batch report to either kind of parent.
    /// Structured parents use the normal agent message queue; CLI parents
    /// are hosted PTYs, so their prompt must be written through the durable
    /// terminal host rather than through `Agents::send`.
    async fn deliver_cross_model_fan_in(
        &self,
        parent_session_id: &str,
        report: String,
        cross_model_claim_id: Option<String>,
    ) -> Result<ParentReportDelivery> {
        let parent_id = parent_session_id.to_owned();
        let parent = self
            .0
            .database
            .call(move |store| store.session(&parent_id))
            .await?;
        match parent.kind {
            SessionKind::Structured => {
                self.send_internal(
                    parent_session_id,
                    report,
                    None,
                    Vec::new(),
                    cross_model_claim_id,
                )
                .await
            }
            SessionKind::Pty => {
                if parent.lifecycle != SessionLifecycle::Active
                    || matches!(
                        parent.status,
                        SessionStatus::Completed | SessionStatus::Failed
                    )
                {
                    return Err(Error::Conflict);
                }
                if parent.status == SessionStatus::WaitingPermission {
                    return Err(Error::Busy);
                }
                let directory = self.0.database.directory().join("terminal-hosts").join(
                    parent
                        .native_session
                        .as_ref()
                        .map(|native| native.runtime_id.as_str())
                        .unwrap_or(parent_session_id),
                );
                let host = crate::terminal::host::Host::attach(directory).await?;
                match host
                    .get::<crate::terminal::TerminalActivity>("activity")
                    .await
                {
                    Ok(activity) if activity.exited => return Err(Error::Conflict),
                    Ok(activity) if activity.busy_since.is_some() => return Err(Error::Busy),
                    Ok(_) | Err(Error::NotFound) => {}
                    Err(error) => return Err(error),
                }
                send_safe_pty_paste(&report, crate::terminal::INPUT_BYTES, |chunk| {
                    let host = &host;
                    async move {
                        host.input(TerminalInput {
                            data_b64: BASE64_STANDARD.encode(chunk),
                        })
                        .await
                    }
                })
                .await?;
                if let Some(claim_id) = cross_model_claim_id.as_deref() {
                    self.mark_cross_model_fan_in_delivered(parent_session_id, claim_id)
                        .await?;
                }
                Ok(if cross_model_claim_id.is_some() {
                    ParentReportDelivery::Delivered
                } else {
                    ParentReportDelivery::Submitted
                })
            }
        }
    }

    pub async fn schedule_cross_model_check(
        &self,
        parent_session_id: &str,
        input: super::ScheduleCrossModelCheck,
    ) -> Result<super::CrossModelCheck> {
        crate::database::validate_id(parent_session_id)?;
        let parent_id = parent_session_id.to_owned();
        let delay_seconds = input.delay_seconds;
        let check = self
            .0
            .database
            .call(move |store| store.schedule_cross_model_check(&parent_id, delay_seconds))
            .await?;
        self.publish();
        Ok(check)
    }

    /// Deliver every due one-shot child status check. Structured parents use
    /// the ordinary durable queue when busy; PTY parents receive the same
    /// prompt through their terminal host.
    pub async fn deliver_due_cross_model_checks(&self) -> Result<usize> {
        let mut delivered = 0;
        loop {
            let claimed = self
                .0
                .database
                .call(|store| store.claim_due_cross_model_check(CROSS_MODEL_CHECK_LEASE_MILLIS))
                .await?;
            let Some((check, report)) = claimed else {
                return Ok(delivered);
            };
            if let Err(error) = self
                .deliver_cross_model_fan_in(&check.parent_session_id, report, None)
                .await
            {
                let check_id = check.id.clone();
                let _ = self
                    .0
                    .database
                    .call(move |store| store.release_cross_model_check(&check_id))
                    .await;
                return Err(error);
            }
            let check_id = check.id;
            self.0
                .database
                .call(move |store| store.mark_cross_model_check_delivered(&check_id))
                .await?;
            delivered += 1;
            self.publish();
        }
    }

    pub async fn run_cross_model_check_worker(&self, mut stopping: watch::Receiver<bool>) {
        let mut ticker = tokio::time::interval(Duration::from_secs(2));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut fan_in_ticker = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(60),
            Duration::from_secs(60),
        );
        fan_in_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut fan_in_cursor = None;
        let mut archived_cursor = None;
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let _ = self.deliver_due_cross_model_checks().await;
                }
                _ = fan_in_ticker.tick() => {
                    if let Ok(next) = self.retry_durable_cross_model_fan_in_batch(fan_in_cursor.clone(), 8).await {
                        fan_in_cursor = next;
                    }
                    let (next, _) = self
                        .reap_confirmed_archived_idle_batch(archived_cursor.as_deref(), 64)
                        .await;
                    archived_cursor = next;
                }
                changed = stopping.changed() => {
                    if changed.is_err() || *stopping.borrow() {
                        return;
                    }
                }
            }
        }
    }

    pub fn capacity(&self) -> usize {
        MAX_TURNS
    }

    pub(crate) fn claim_worker_start_scheduler(&self) -> bool {
        !self.0.closed.load(Ordering::Acquire)
            && self
                .0
                .worker_start_scheduler
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }

    pub(crate) fn release_worker_start_scheduler(&self) {
        self.0
            .worker_start_scheduler
            .store(false, Ordering::Release);
    }

    pub(crate) fn worker_starts_closed(&self) -> bool {
        self.0.closed.load(Ordering::Acquire)
    }

    pub fn closed(&self) -> bool {
        self.0.closed.load(Ordering::Acquire)
    }

    pub fn failed(&self) -> bool {
        self.0.failed.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn mark_failed_for_test(&self) {
        self.0.failed.store(true, Ordering::Release);
    }

    pub fn check(&self) -> Result<()> {
        if self.closed() || self.failed() {
            Err(Error::Closed)
        } else {
            Ok(())
        }
    }

    pub async fn create(&self, input: CreateAgentSession) -> Result<SessionHead> {
        self.create_inner(input, None).await
    }

    pub async fn create_with_id(
        &self,
        input: CreateAgentSession,
        id: String,
    ) -> Result<SessionHead> {
        crate::database::validate_id(&id)?;
        self.create_inner(input, Some(id)).await
    }

    async fn create_inner(
        &self,
        input: CreateAgentSession,
        id: Option<String>,
    ) -> Result<SessionHead> {
        self.create_inner_with_history(input, id, None).await
    }

    async fn create_inner_with_history(
        &self,
        input: CreateAgentSession,
        id: Option<String>,
        history: Option<(String, i64)>,
    ) -> Result<SessionHead> {
        crate::database::validate_text(&input.title, 512, false)?;
        if input.workspace.len() > 4096 || input.workspace.trim().is_empty() {
            return Err(Error::Invalid("invalid workspace".into()));
        }
        if !Path::new(&input.workspace).is_absolute() {
            return Err(Error::Invalid("workspace must be absolute".into()));
        }
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let workspace = tokio::task::spawn_blocking({
            let workspace = input.workspace.clone();
            move || std::fs::canonicalize(workspace)
        })
        .await
        .map_err(|_| Error::Closed)??;
        if !workspace.is_dir() {
            return Err(Error::Invalid("workspace is not a directory".into()));
        }
        let workspace = workspace
            .to_str()
            .ok_or_else(|| Error::Invalid("workspace must be Unicode".into()))?
            .to_owned();
        let policy = if input.auto_approve {
            ApprovalPolicy::Auto
        } else {
            ApprovalPolicy::Manual
        };
        if !matches!(
            input.agent,
            crate::protocol::AgentKind::Claude
                | crate::protocol::AgentKind::Codex
                | crate::protocol::AgentKind::Deepseek
                | crate::protocol::AgentKind::Opencode
                | crate::protocol::AgentKind::Pi
                | crate::protocol::AgentKind::Agy
        ) {
            return Err(Error::Invalid(
                "Agent 暂未接入 Rust structured runtime".into(),
            ));
        }
        if input.agent == crate::protocol::AgentKind::Opencode && input.account_id.is_none() {
            return Err(Error::Invalid(
                "OpenCode structured runtime 需要 OpenAI Chat Completions API Profile".into(),
            ));
        }
        let mut input = input;
        if input.agent == crate::protocol::AgentKind::Deepseek {
            match input.account_id.as_deref() {
                None | Some("native-deepseek") => {
                    input.account_id = None;
                }
                Some(_) => {
                    return Err(Error::Invalid(
                        "DeepSeek Harness 使用本机 dsh 账号，不支持绑定 Prospero 账号".into(),
                    ));
                }
            }
        }
        if input.agent == crate::protocol::AgentKind::Codex
            && input.account_id.as_deref() == Some(crate::agent::NATIVE_CODEX_ID)
        {
            input.account_id = None;
        }
        if input.agent == crate::protocol::AgentKind::Pi
            && input.account_id.as_deref() == Some(crate::accounts::NATIVE_PI_ID)
        {
            input.account_id = None;
        }
        if input.agent == crate::protocol::AgentKind::Agy {
            match input.account_id.as_deref() {
                None | Some(crate::accounts::NATIVE_AGY_ID) => {
                    input.account_id = None;
                }
                Some(_) => {
                    return Err(Error::Invalid(
                        "Antigravity (agy) 仅支持使用本机 Antigravity 订阅账号".into(),
                    ));
                }
            }
            let (normalized_model, normalized_effort, _) = super::agy::resolve_cli_model_and_effort(
                input.model.as_deref(),
                input.effort.as_deref(),
            );
            input.model = normalized_model;
            input.effort = normalized_effort;
        }
        if input.agent == crate::protocol::AgentKind::Pi && input.mode.as_deref() == Some("plan") {
            return Err(Error::Invalid("Pi Agent 不支持 Plan 模式".into()));
        }
        if input.agent == crate::protocol::AgentKind::Codex {
            match input.account_id.as_deref() {
                None | Some(crate::agent::NATIVE_CODEX_ID) => {}
                Some(account_id) => {
                    let data = self.0.database.directory().to_owned();
                    let account_id = account_id.to_owned();
                    let record = self
                        .0
                        .database
                        .call_control("agent.create", move |store| {
                            store.managed_snapshot_row(&data, &account_id)
                        })
                        .await?;
                    match record
                        .api_profile
                        .as_ref()
                        .map(|profile| profile.protocol())
                    {
                        Some("openai_responses" | "openai_chat_completions") => {}
                        None if record.agent == crate::protocol::AgentKind::Codex => {}
                        _ => {
                            return Err(Error::Invalid(
                                "所选账号不支持 Codex structured runtime".into(),
                            ));
                        }
                    }
                }
            }
        }
        if input.agent == crate::protocol::AgentKind::Pi {
            match input.account_id.as_deref() {
                None | Some(crate::accounts::NATIVE_PI_ID) => {}
                Some(account_id) => {
                    let data = self.0.database.directory().to_owned();
                    let account_id = account_id.to_owned();
                    let profile = self
                        .0
                        .database
                        .call_control("agent.create", move |store| {
                            Ok(store.managed_snapshot_row(&data, &account_id)?.api_profile)
                        })
                        .await?;
                    match profile.as_ref().map(|profile| profile.protocol()) {
                        Some("anthropic" | "openai_responses" | "openai_chat_completions") => {}
                        _ => {
                            return Err(Error::Invalid(
                                "所选账号不支持 Pi structured runtime".into(),
                            ));
                        }
                    }
                }
            }
        }
        if input.agent == crate::protocol::AgentKind::Opencode {
            let Some(account_id) = input.account_id.as_deref() else {
                return Err(Error::Invalid(
                    "OpenCode structured runtime 需要 OpenAI Chat Completions API Profile".into(),
                ));
            };
            let data = self.0.database.directory().to_owned();
            let account_id = account_id.to_owned();
            let profile = self
                .0
                .database
                .call_control("agent.create", move |store| {
                    Ok(store.managed_snapshot_row(&data, &account_id)?.api_profile)
                })
                .await?;
            match profile.as_ref().map(|profile| profile.protocol()) {
                Some("openai_chat_completions") => {}
                _ => {
                    return Err(Error::Invalid(
                        "所选账号不支持 OpenCode structured runtime".into(),
                    ));
                }
            }
        }
        if let Some(fork) = input.resume.as_ref().and_then(|resume| resume.fork) {
            if fork {
                return Err(Error::Conflict);
            }
            return Err(Error::Invalid("接回选项无效".into()));
        }
        let mut create = CreateAgentSession {
            agent: input.agent,
            title: input
                .resume
                .as_ref()
                .and_then(|resume| resume.title.clone())
                .unwrap_or(input.title),
            workspace,
            auto_approve: input.auto_approve,
            mode: input.mode,
            model: input.model,
            effort: input.effort,
            agent_preset: input.agent_preset,
            account_id: input.account_id,
            resume: input.resume,
        };
        let database = self.0.database.clone();
        let data = self.0.database.directory().to_owned();
        let head = self
            .0
            .database
            .call_control("agent.create", move |store| {
                if let Some(account_id) = create.account_id.as_deref() {
                    if let Some(message) =
                        crate::accounts::source_bound_launch_error(&database, account_id)?
                    {
                        return Err(Error::Invalid(message));
                    }
                    if !matches!(
                        account_id,
                        crate::accounts::NATIVE_CLAUDE_ID
                            | crate::agent::NATIVE_CODEX_ID
                            | crate::accounts::NATIVE_PI_ID
                            | crate::accounts::NATIVE_AGY_ID
                    ) {
                        let record = store.managed_snapshot_row(&data, account_id)?;
                        if let Some(profile) = record.api_profile.as_ref() {
                            if !account_agent_matches(create.agent, &record) {
                                return Err(Error::Invalid("所选账号与 Agent 不匹配".into()));
                            }
                            create.agent = engine_agent(record.agent, Some(profile));
                            if profile
                                .model_capabilities
                                .as_ref()
                                .and_then(|caps| caps.tools)
                                == Some(false)
                            {
                                return Err(Error::Invalid(
                                    "模型 Profile 禁用了工具，无法启动 Code Agent".into(),
                                ));
                            }
                        } else if create.agent != record.agent {
                            return Err(Error::Invalid("所选账号与 Agent 不匹配".into()));
                        }
                        let target = crate::accounts::config::ConfigTarget {
                            account_id: record.id.clone(),
                            model: record
                                .api_profile
                                .as_ref()
                                .map(|profile| profile.model.clone()),
                            model_capabilities: record
                                .api_profile
                                .as_ref()
                                .and_then(|profile| profile.model_capabilities.clone()),
                            active_sessions: 0,
                        };
                        let (default_model, default_effort) =
                            crate::accounts::config::read_defaults(&data, &target)?;
                        let resuming = create.resume.is_some();
                        let effective_default_model = target
                            .model
                            .clone()
                            .or_else(|| (!resuming).then_some(default_model).flatten());
                        let apply_default_effort = !resuming
                            && create.effort.is_none()
                            && create
                                .model
                                .as_deref()
                                .map(|model| Some(model) == effective_default_model.as_deref())
                                .unwrap_or(true);
                        if create.model.is_none() {
                            create.model = effective_default_model;
                        }
                        if apply_default_effort {
                            create.effort = default_effort;
                        }
                        if let Some(profile) = record.api_profile.as_ref() {
                            create.effort = crate::accounts::profile::normalize_profile_effort(
                                profile,
                                create.effort.as_deref(),
                            );
                        }
                    } else {
                        let target = crate::accounts::config::ConfigTarget {
                            account_id: account_id.to_owned(),
                            model: None,
                            model_capabilities: None,
                            active_sessions: 0,
                        };
                        if let Ok((default_model, default_effort)) =
                            crate::accounts::config::read_defaults(&data, &target)
                        {
                            let resuming = create.resume.is_some();
                            if !resuming && create.model.is_none() {
                                create.model = default_model;
                            }
                            if !resuming && create.effort.is_none() {
                                create.effort = default_effort;
                            }
                        }
                    }
                } else {
                    let native_id = match create.agent {
                        crate::protocol::AgentKind::Claude => {
                            Some(crate::accounts::NATIVE_CLAUDE_ID)
                        }
                        crate::protocol::AgentKind::Codex => Some(crate::agent::NATIVE_CODEX_ID),
                        _ => None,
                    };
                    if let Some(native_id) = native_id {
                        let target = crate::accounts::config::ConfigTarget {
                            account_id: native_id.to_owned(),
                            model: None,
                            model_capabilities: None,
                            active_sessions: 0,
                        };
                        if let Ok((default_model, default_effort)) =
                            crate::accounts::config::read_defaults(&data, &target)
                        {
                            let resuming = create.resume.is_some();
                            if !resuming && create.model.is_none() {
                                create.model = default_model;
                            }
                            if !resuming && create.effort.is_none() {
                                create.effort = default_effort;
                            }
                        }
                    }
                }
                store.create_agent_session_with_history(create, policy, id, history)
            })
            .await?;
        self.insert_entry(
            head.id.clone(),
            Arc::new(Session {
                execution_unknown: AtomicBool::new(false),
                handle: Mutex::new(None),
                usage: Mutex::new(UsageReport {
                    windows: Vec::new(),
                    ..Default::default()
                }),
                draining: Mutex::new(()),
                permit: Mutex::new(None),
            }),
        )
        .await;
        self.publish();
        Ok(head)
    }

    /// Fork stored chat history into a distinct native conversation and independent timeline.
    pub async fn fork_chat(&self, source: &str) -> Result<SessionHead> {
        crate::database::validate_id(source)?;
        let source_id = source.to_owned();
        let (head, run) = self
            .0
            .database
            .call(move |store| Ok((store.session(&source_id)?, store.agent_run(&source_id)?)))
            .await?;
        if !matches!(
            run.agent,
            AgentKind::Codex | AgentKind::Claude | AgentKind::Pi
        ) || head.kind != SessionKind::Structured
        {
            return Err(Error::Invalid(
                "当前仅 Codex、Claude 和 Pi 对话支持保留历史的聊天分支".into(),
            ));
        }
        if !matches!(head.status, SessionStatus::Idle | SessionStatus::Completed) {
            return Err(Error::Invalid("请等待当前轮次结束后创建聊天分支".into()));
        }
        let native_id = run
            .native_id
            .as_deref()
            .ok_or_else(|| Error::Invalid("此聊天尚无可分支的历史".into()))?;
        let effective_env_account = run.account_id.clone().or_else(|| {
            (run.agent == AgentKind::Claude).then(|| crate::accounts::NATIVE_CLAUDE_ID.to_owned())
        });
        let options = TurnOptions {
            policy: run.policy,
            mode: run.mode,
            model: run.model.clone(),
            effort: run.effort.clone(),
            environment: Self::account_environment(&self.0.database, effective_env_account).await?,
            api_profile: Self::account_api_profile(&self.0.database, run.account_id.clone())
                .await?,
            agent_preset: run.agent_preset.clone(),
        };
        let forked_id = if run.agent == AgentKind::Claude {
            super::claude::fork_session(&head.workspace, native_id, &options).await?
        } else if run.agent == AgentKind::Pi {
            super::pi::fork_session_file(&options.environment, native_id, &head.workspace)?
        } else {
            super::codex::fork_thread(
                self.0.database.directory(),
                &head.workspace,
                native_id,
                &options,
            )
            .await?
        };
        let new_id = uuid::Uuid::new_v4().to_string();
        // Copy attachment files before publishing the new session, never follow links.
        let data = self.0.database.directory().to_owned();
        let source_id = source.to_owned();
        let destination_id = new_id.clone();
        let copied = tokio::task::spawn_blocking(move || {
            copy_fork_attachments(&data, &source_id, &destination_id)
        })
        .await
        .map_err(|_| Error::Closed)?;
        if let Err(error) = copied {
            let _ = std::fs::remove_dir_all(
                self.0
                    .database
                    .directory()
                    .join("attachments")
                    .join(&new_id),
            );
            return Err(error);
        }
        let created = self
            .create_inner_with_history(
                CreateAgentSession {
                    agent: run.agent,
                    title: head.title.chars().take(480).collect::<String>() + " · 分支",
                    workspace: head.workspace,
                    auto_approve: run.policy == ApprovalPolicy::Auto,
                    mode: Some(run.mode.label().into()),
                    model: run.model,
                    effort: run.effort,
                    agent_preset: run.agent_preset,
                    account_id: run.account_id,
                    resume: Some(super::ResumeInput {
                        id: forked_id,
                        title: None,
                        fork: None,
                    }),
                },
                Some(new_id.clone()),
                Some((source.to_owned(), run.turn)),
            )
            .await;
        if created.is_err() {
            let _ = std::fs::remove_dir_all(
                self.0.database.directory().join("attachments").join(new_id),
            );
        }
        created
    }

    /// Start an independent child structured session against a selected model
    /// source route.  It deliberately owns its own provider account and
    /// runtime rather than piggybacking on a parent Codex Task thread.
    pub async fn create_cross_model_child(
        &self,
        parent_session_id: &str,
        input: CreateCrossModelChild,
    ) -> Result<CrossModelChild> {
        crate::database::validate_id(parent_session_id)?;
        crate::database::validate_text(&input.task, 65_536, false)?;
        let use_model_source = !input.source_id.trim().is_empty()
            && !matches!(input.source_id.trim(), "subscription" | "native")
            && !input.route_id.trim().is_empty();
        if use_model_source {
            crate::accounts::sources::validate_source_id(&input.source_id)?;
            crate::accounts::sources::validate_source_id(&input.route_id)?;
            if !matches!(
                input.agent,
                AgentKind::Claude | AgentKind::Codex | AgentKind::Opencode | AgentKind::Pi
            ) {
                return Err(Error::Invalid(
                    "跨模型子任务仅支持 Claude、Codex、OpenCode 或 Pi".into(),
                ));
            }
        } else if !matches!(
            input.agent,
            AgentKind::Claude
                | AgentKind::Codex
                | AgentKind::Opencode
                | AgentKind::Pi
                | AgentKind::Deepseek
                | AgentKind::Agy
        ) {
            return Err(Error::Invalid(
                "派发子会话仅支持 Claude、Codex、OpenCode、Pi、DeepSeek 或 Antigravity".into(),
            ));
        }
        let data = self.0.database.directory().to_owned();
        let source_id = input.source_id.clone();
        let route_id = input.route_id.clone();
        let revision = input.revision;
        let agent = input.agent;
        let requested_account = input
            .account_id
            .clone()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let requested_model = input
            .model
            .clone()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let requested_effort = input
            .effort
            .clone()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let (
            account_id,
            resolved_model,
            resolved_effort,
            source_name,
            route_name,
            recorded_source_id,
            recorded_route_id,
        ) = self
            .0
            .database
            .call(move |store| {
                let accounts = store.list_managed_accounts(&data)?;
                if use_model_source {
                    let known = accounts
                        .iter()
                        .map(|account| account.id.clone())
                        .collect::<std::collections::HashSet<_>>();
                    let account_agents = accounts
                        .into_iter()
                        .map(|account| (account.id, account.agent))
                        .collect::<std::collections::HashMap<_, _>>();
                    let mut sources = crate::accounts::sources::ModelSources::open(&data)?;
                    let source = sources
                        .list()
                        .into_iter()
                        .find(|source| source.id == source_id)
                        .ok_or(Error::NotFound)?;
                    let route_name = source
                        .routes
                        .iter()
                        .find(|route| route.id == route_id)
                        .ok_or(Error::NotFound)?
                        .name
                        .clone();
                    let source_name = source.name.clone();
                    let outcome = sources.bind(
                        &source_id,
                        &route_id,
                        revision,
                        Some(agent),
                        &known,
                        &account_agents,
                    )?;
                    let (account_id, profile) = match outcome {
                        crate::accounts::sources::BindOutcome::Existing(account_id) => {
                            let profile = store
                                .managed_snapshot_row(&data, &account_id)?
                                .api_profile
                                .ok_or(Error::NotFound)?;
                            (account_id, profile)
                        }
                        crate::accounts::sources::BindOutcome::Created {
                            account_id,
                            agent,
                            profile,
                            name,
                            secret,
                        } => {
                            store.insert_api_profile_account_with_id(
                                &data,
                                &account_id,
                                &name,
                                agent,
                                &profile,
                                &secret,
                            )?;
                            (account_id, profile)
                        }
                    };
                    let default_effort = requested_effort.or_else(|| {
                        profile
                            .model_capabilities
                            .as_ref()
                            .and_then(|caps| caps.supported_efforts.as_ref())
                            .and_then(|values| values.first())
                            .cloned()
                    });
                    Ok((
                        Some(account_id),
                        Some(profile.model),
                        default_effort,
                        source_name,
                        route_name,
                        source_id,
                        route_id,
                    ))
                } else {
                    let agent_name = match agent {
                        AgentKind::Codex => "codex",
                        AgentKind::Claude => "claude",
                        AgentKind::Opencode => "opencode",
                        AgentKind::Pi => "pi",
                        AgentKind::Deepseek => "deepseek",
                        AgentKind::Agy => "agy",
                        _ => "agent",
                    };
                    let default_native_id = match agent {
                        AgentKind::Codex => Some(crate::agent::NATIVE_CODEX_ID.to_owned()),
                        AgentKind::Claude => Some(crate::accounts::NATIVE_CLAUDE_ID.to_owned()),
                        AgentKind::Deepseek => Some("native-deepseek".to_owned()),
                        AgentKind::Agy => Some(crate::accounts::NATIVE_AGY_ID.to_owned()),
                        _ => None,
                    };
                    let chosen_account_id = requested_account.or(default_native_id);
                    let (requested_model, requested_effort) = if agent == AgentKind::Agy {
                        let (m, e, _) = super::agy::resolve_cli_model_and_effort(
                            requested_model.as_deref(),
                            requested_effort.as_deref(),
                        );
                        (m, e)
                    } else {
                        (requested_model, requested_effort)
                    };
                    let account_label = if let Some(ref acc_id) = chosen_account_id {
                        if let Some(acc) = accounts.iter().find(|a| &a.id == acc_id) {
                            if acc.agent != agent {
                                return Err(Error::Invalid("账号与所选 Agent 类型不匹配".into()));
                            }
                            acc.name.clone()
                        } else {
                            match acc_id.as_str() {
                                crate::accounts::NATIVE_AGY_ID => "Antigravity 订阅".into(),
                                crate::agent::NATIVE_CODEX_ID => "Codex 本机默认".into(),
                                crate::accounts::NATIVE_CLAUDE_ID => "Claude 本机默认".into(),
                                crate::accounts::NATIVE_PI_ID => "Pi 本机默认".into(),
                                "native-deepseek" => "DeepSeek 本机默认".into(),
                                _ => acc_id.clone(),
                            }
                        }
                    } else {
                        agent_name.to_owned()
                    };
                    let route_label = match (&requested_model, &requested_effort) {
                        (Some(m), Some(e)) => format!("{m} ({e})"),
                        (Some(m), None) => m.clone(),
                        _ => agent_name.to_owned(),
                    };
                    let rec_account = chosen_account_id
                        .clone()
                        .unwrap_or_else(|| format!("native-{agent_name}"));
                    Ok((
                        chosen_account_id,
                        requested_model,
                        requested_effort,
                        account_label,
                        route_label.clone(),
                        "subscription".to_owned(),
                        rec_account,
                    ))
                }
            })
            .await?;
        let parent_workspace = {
            let id = parent_session_id.to_owned();
            self.0
                .database
                .call(move |store| Ok(store.session(&id)?.workspace))
                .await?
        };
        let target_workspace = input
            .workspace
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| parent_workspace.clone());
        let workspace_badge = if target_workspace != parent_workspace {
            std::path::Path::new(&target_workspace)
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .map(|name| format!("[{name}] "))
                .unwrap_or_default()
        } else {
            String::new()
        };
        let title = input
            .title
            .unwrap_or_else(|| format!("{workspace_badge}{source_name} · {route_name}"));
        let head = self
            .create(CreateAgentSession {
                agent,
                title,
                workspace: target_workspace,
                auto_approve: true,
                mode: None,
                model: resolved_model,
                effort: resolved_effort,
                agent_preset: None,
                account_id: account_id.clone(),
                resume: None,
            })
            .await?;
        let child = {
            let child_id = head.id.clone();
            let parent_id = parent_session_id.to_owned();
            let task = input.task.clone();
            let source_id = recorded_source_id;
            let route_id = recorded_route_id.clone();
            let account_id = account_id.unwrap_or(recorded_route_id);
            self.0
                .database
                .call(move |store| {
                    store.register_cross_model_child(
                        &child_id,
                        &parent_id,
                        &task,
                        &source_id,
                        &route_id,
                        &account_id,
                    )
                })
                .await?
        };
        self.write_cross_model_card(&child, "starting", String::new())
            .await?;
        match self.send(&head.id, input.task, None, Vec::new()).await {
            Ok(()) => {
                let running = {
                    let child_id = head.id.clone();
                    self.0
                        .database
                        .call(move |store| store.mark_cross_model_child_running(&child_id))
                        .await?
                };
                self.write_cross_model_card(&running, "running", String::new())
                    .await?;
                Ok(running)
            }
            Err(error) => {
                let failed = {
                    let child_id = head.id.clone();
                    let message = error.to_string();
                    self.0
                        .database
                        .call(move |store| {
                            store.complete_cross_model_child(&child_id, 1, "failed", Some(&message))
                        })
                        .await
                };
                if let Ok(failed) = failed {
                    let _ = self
                        .write_cross_model_card(&failed, "failed", bounded_text(error.to_string()))
                        .await;
                    let _ = self
                        .deliver_pending_cross_model_fan_in(&failed.parent_session_id)
                        .await;
                }
                Err(error)
            }
        }
    }

    /// Reuse a completed cross-model child session for another turn. The
    /// native conversation, pinned account, model route and YOLO policy stay
    /// unchanged; only this new turn participates in the next parent fan-in.
    pub async fn follow_up_cross_model_child(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
        input: super::FollowUpCrossModelChild,
    ) -> Result<CrossModelChild> {
        crate::database::validate_id(parent_session_id)?;
        crate::database::validate_id(child_session_id)?;
        crate::database::validate_text(&input.task, 65_536, false)?;
        let parent_id = parent_session_id.to_owned();
        let child_id = child_session_id.to_owned();
        let needs_reactivation = self
            .0
            .database
            .call(move |store| store.cross_model_child_needs_reactivation(&parent_id, &child_id))
            .await?;
        if needs_reactivation {
            let parent_id = parent_session_id.to_owned();
            let child_id = child_session_id.to_owned();
            let still_needs_reactivation = self
                .0
                .database
                .call(move |store| {
                    store.cross_model_child_needs_reactivation(&parent_id, &child_id)
                })
                .await?;
            if !still_needs_reactivation {
                return Err(Error::Conflict);
            }
        }
        let parent_id = parent_session_id.to_owned();
        let child_id = child_session_id.to_owned();
        let task = input.task.clone();
        let (child, reactivated) = self
            .0
            .database
            .call(move |store| store.reopen_cross_model_child(&parent_id, &child_id, &task))
            .await?;
        let task_turn = {
            let child_id = child_session_id.to_owned();
            self.0
                .database
                .call(move |store| store.cross_model_child_task_turn(&child_id))
                .await?
        };
        if reactivated {
            self.insert_entry(
                child_session_id.to_owned(),
                Arc::new(Session {
                    execution_unknown: AtomicBool::new(false),
                    handle: Mutex::new(None),
                    usage: Mutex::new(UsageReport {
                        windows: Vec::new(),
                        ..Default::default()
                    }),
                    draining: Mutex::new(()),
                    permit: Mutex::new(None),
                }),
            )
            .await;
        }
        let launched = async {
            self.write_cross_model_card(&child, "starting", String::new())
                .await?;
            self.send(child_session_id, input.task, None, Vec::new())
                .await?;
            let running = {
                let child_id = child_session_id.to_owned();
                self.0
                    .database
                    .call(move |store| store.mark_cross_model_child_running(&child_id))
                    .await?
            };
            self.write_cross_model_card(&running, "running", String::new())
                .await
        }
        .await;
        if let Err(error) = launched {
            let child_id = child_session_id.to_owned();
            let message = error.to_string();
            let failed = self
                .0
                .database
                .call(move |store| {
                    store.complete_cross_model_child(&child_id, task_turn, "failed", Some(&message))
                })
                .await;
            if let Ok(failed) = failed {
                let _ = self
                    .write_cross_model_card(&failed, "failed", bounded_text(error.to_string()))
                    .await;
                let _ = self
                    .deliver_pending_cross_model_fan_in(&failed.parent_session_id)
                    .await;
            }
            return Err(error);
        }
        Ok(child)
    }

    async fn cross_model_child_for_parent(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
    ) -> Result<CrossModelChild> {
        crate::database::validate_id(parent_session_id)?;
        crate::database::validate_id(child_session_id)?;
        let parent_id = parent_session_id.to_owned();
        let child_id = child_session_id.to_owned();
        self.0
            .database
            .call(move |store| {
                let child = store.cross_model_child(&child_id)?;
                if child.parent_session_id != parent_id {
                    return Err(Error::NotFound);
                }
                Ok(child)
            })
            .await
    }

    pub async fn list_cross_model_children(
        &self,
        query: CrossModelChildQuery,
    ) -> Result<CrossModelChildPage> {
        let parent = query.parent_session_id;
        let status = query.status;
        let pending_result = query.pending_result;
        let items = self
            .0
            .database
            .call(move |store| {
                store.list_cross_model_children(
                    parent.as_deref(),
                    status.as_deref(),
                    pending_result,
                )
            })
            .await?;
        Ok(CrossModelChildPage { items })
    }

    pub async fn cross_model_child(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
    ) -> Result<CrossModelChild> {
        self.cross_model_child_for_parent(parent_session_id, child_session_id)
            .await
    }

    pub async fn cross_model_child_logs(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
        query: CrossModelChildLogsQuery,
    ) -> Result<CrossModelChildLogs> {
        let limit = query.limit.unwrap_or(80);
        if !(1..=100).contains(&limit) {
            return Err(Error::Invalid("日志条数必须在 1 到 100 之间".into()));
        }
        let parent_id = parent_session_id.to_owned();
        let child_id = child_session_id.to_owned();
        let (child, events, ev_seq) = self
            .0
            .database
            .call(move |store| {
                let child = store.cross_model_child(&child_id)?;
                if child.parent_session_id != parent_id {
                    return Err(Error::NotFound);
                }
                let (events, ev_seq) = store.timeline_events(&child_id, limit)?;
                Ok((child, events, ev_seq))
            })
            .await?;
        Ok(CrossModelChildLogs {
            child,
            events,
            ev_seq,
        })
    }

    pub async fn cross_model_child_result(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
    ) -> Result<CrossModelChildResult> {
        let parent_id = parent_session_id.to_owned();
        let child_id = child_session_id.to_owned();
        let (child, full_result, diffs) = self
            .0
            .database
            .call(move |store| {
                let child = store.cross_model_child(&child_id)?;
                if child.parent_session_id != parent_id {
                    return Err(Error::NotFound);
                }
                let full_result = store.cross_model_child_result(&child_id)?;
                let diffs = store.cross_model_child_diffs(&child_id)?;
                Ok((child, full_result, diffs))
            })
            .await?;
        let delivered = child.summary_delivered;
        let acknowledged = child.summary_acknowledged;
        let result = if full_result.trim().is_empty() {
            child.result.clone().unwrap_or_default()
        } else {
            full_result
        };
        Ok(CrossModelChildResult {
            child,
            result,
            diffs,
            delivered,
            acknowledged,
        })
    }

    pub async fn message_cross_model_child(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
        input: MessageCrossModelChild,
    ) -> Result<CrossModelChild> {
        crate::database::validate_text(&input.text, 65_536, false)?;
        let child = self
            .cross_model_child_for_parent(parent_session_id, child_session_id)
            .await?;
        if !matches!(child.status.as_str(), "starting" | "running") {
            return Err(Error::Conflict);
        }
        let entry = self.session_entry(child_session_id).await?;
        let guard = entry.handle.lock().await;
        let handle = guard.as_ref().ok_or(Error::Conflict)?;
        if !handle.steerable.load(Ordering::Acquire) {
            return Err(Error::Conflict);
        }
        let workspace = {
            let child_id = child_session_id.to_owned();
            self.0
                .database
                .call(move |store| Ok(store.session(&child_id)?.workspace))
                .await?
        };
        let codex_native_skills = matches!(&*handle.driver.lock().await, Driver::Codex(_));
        let expanded = self
            .expand_prompt(&workspace, &input.text, codex_native_skills)
            .await?;
        handle.driver.lock().await.steer(&expanded, &[]).await?;
        drop(guard);
        self.record_steer(child_session_id, &input.text, &[])
            .await?;
        let running = {
            let child_id = child_session_id.to_owned();
            self.0
                .database
                .call(move |store| store.mark_cross_model_child_running(&child_id))
                .await?
        };
        self.write_cross_model_card(&running, "running", "已向子 Agent 追加要求。".into())
            .await?;
        self.publish();
        Ok(running)
    }

    pub async fn cancel_cross_model_child(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
        input: CancelCrossModelChild,
    ) -> Result<CrossModelChild> {
        let child = self
            .cross_model_child_for_parent(parent_session_id, child_session_id)
            .await?;
        if matches!(child.status.as_str(), "completed" | "failed" | "stopped") {
            return Ok(child);
        }
        let task_turn = {
            let child_id = child_session_id.to_owned();
            self.0
                .database
                .call(move |store| store.cross_model_child_task_turn(&child_id))
                .await?
        };
        let reason = input
            .reason
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "子任务已被主会话停止。".into());
        crate::database::validate_text(&reason, 65_536, false)?;
        let stopped = {
            let child_id = child_session_id.to_owned();
            let reason = reason.clone();
            self.0
                .database
                .call(move |store| {
                    store.complete_cross_model_child(&child_id, task_turn, "stopped", Some(&reason))
                })
                .await?
        };
        let _ = self.close(child_session_id).await;
        self.write_cross_model_card(&stopped, "stopped", bounded_text(reason))
            .await?;
        self.deliver_pending_cross_model_fan_in(parent_session_id)
            .await?;
        Ok(stopped)
    }

    pub async fn acknowledge_cross_model_child(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
    ) -> Result<CrossModelChild> {
        let parent_id = parent_session_id.to_owned();
        let child_id = child_session_id.to_owned();
        let child = self
            .0
            .database
            .call(move |store| store.acknowledge_cross_model_child(&parent_id, &child_id))
            .await?;
        self.publish();
        Ok(child)
    }

    pub async fn redeliver_cross_model_child(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
    ) -> Result<CrossModelChild> {
        let parent_id = parent_session_id.to_owned();
        let child_id = child_session_id.to_owned();
        self.0
            .database
            .call(move |store| store.reset_cross_model_delivery(&parent_id, &child_id))
            .await?;
        self.deliver_pending_cross_model_fan_in(parent_session_id)
            .await?;
        let child = self
            .cross_model_child_for_parent(parent_session_id, child_session_id)
            .await?;
        self.publish();
        Ok(child)
    }

    async fn write_cross_model_card(
        &self,
        child: &CrossModelChild,
        status: &str,
        summary: String,
    ) -> Result<()> {
        let parent_id = child.parent_session_id.clone();
        let child_id = child.session_id.clone();
        let card_id = format!("cross-child-{child_id}");
        let task = super::store::cross_model_card_task(&child.task);
        let source = format!("{} / {}", child.source_id, child.route_id);
        let created_at = child.created_at;
        let status = status.to_owned();
        let can_message = matches!(status.as_str(), "starting" | "running");
        self.0
            .database
            .call(move |store| {
                let expected_revision = store
                    .timeline_record(&parent_id, &card_id)
                    .map(|record| record.revision)
                    .unwrap_or(0);
                store.write_timeline(
                    &parent_id,
                    TimelineWrite {
                        id: card_id,
                        turn_id: format!("cross-{child_id}"),
                        expected_revision,
                        body: TimelineBody::Subagent {
                            subagent_id: child_id,
                            name: source,
                            role: Some("跨模型子 Agent · YOLO".into()),
                            task: Some(task),
                            status,
                            can_message,
                            summary: super::store::cross_model_card_summary(&summary),
                            created_at,
                            updated_at: crate::database::now(),
                        },
                        text: String::new(),
                        replace: false,
                        subagent_id: None,
                    },
                )?;
                Ok(())
            })
            .await?;
        self.publish();
        Ok(())
    }

    async fn session_entry(&self, id: &str) -> Result<Arc<Session>> {
        crate::database::validate_id(id)?;
        self.0
            .entries
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or(Error::NotFound)
    }

    pub async fn send(
        &self,
        id: &str,
        text: String,
        delivery: Option<String>,
        attachments: Vec<AttachmentInput>,
    ) -> Result<()> {
        self.send_internal(id, text, delivery, attachments, None)
            .await
            .map(|_| ())
    }

    async fn send_internal(
        &self,
        id: &str,
        text: String,
        delivery: Option<String>,
        attachments: Vec<AttachmentInput>,
        cross_model_claim_id: Option<String>,
    ) -> Result<ParentReportDelivery> {
        validate_message(&text, &attachments)?;
        let entry = self.session_entry(id).await?;
        let mut guard = entry.handle.lock().await;
        if self.0.closed.load(Ordering::Acquire) || entry.execution_unknown.load(Ordering::Acquire)
        {
            return Err(Error::Feature(
                "driver_exit_unknown".into(),
                "Executor is stopping or requires reconciliation".into(),
            ));
        }
        let Some(handle) = guard.clone() else {
            // Idle: start a fresh turn immediately.
            let claimed = cross_model_claim_id.is_some();
            let (turn, handle) = self
                .launch_turn(
                    id,
                    text,
                    attachments,
                    cross_model_claim_id.as_deref(),
                    &mut guard,
                )
                .await?;
            self.spawn_chain(id.to_owned(), turn, handle);
            return Ok(if claimed {
                ParentReportDelivery::Delivered
            } else {
                ParentReportDelivery::Submitted
            });
        };
        if handle.quiescence_unknown.load(Ordering::Acquire) {
            return Err(Error::Timeout);
        }
        // Busy turn: either steer the live CLI or park the message in the
        // persistent queue for the turn-end drain.
        let row = QueuedRow {
            id: uuid::Uuid::new_v4().simple().to_string(),
            kind: if delivery.as_deref() == Some("steer") {
                "guide"
            } else {
                "queue"
            }
            .to_owned(),
            text: text.clone(),
            created_at: crate::database::now(),
            attachments,
            cross_model_claim_id,
        };
        let steering = delivery.as_deref() == Some("steer");
        if steering && handle.steerable.load(Ordering::Acquire) {
            let workspace = {
                let id = id.to_owned();
                self.0
                    .database
                    .call(move |store| Ok(store.session(&id)?.workspace))
                    .await?
            };
            let codex_native_skills = matches!(&*handle.driver.lock().await, Driver::Codex(_));
            let expanded = self
                .expand_prompt(&workspace, &text, codex_native_skills)
                .await?;
            if handle
                .driver
                .lock()
                .await
                .steer(&expanded, &row.attachments)
                .await
                .is_ok()
            {
                self.record_steer(id, &text, &row.attachments).await?;
                self.publish();
                return Ok(ParentReportDelivery::Submitted);
            }
            // The current turn can no longer accept a steer (broken pipe /
            // result already emitted): degrade to the front of the queue. The
            // message and its images must not be lost.
        }
        self.enqueue(id, &row, steering).await?;
        Ok(ParentReportDelivery::Queued)
    }

    async fn enqueue(&self, id: &str, row: &QueuedRow, front: bool) -> Result<()> {
        let row = row.clone();
        let id = id.to_owned();
        self.0
            .database
            .call(move |store| store.enqueue_message(&id, &row, front))
            .await?;
        self.publish();
        Ok(())
    }

    async fn mark_cross_model_fan_in_delivered(
        &self,
        parent_session_id: &str,
        claim_id: &str,
    ) -> Result<()> {
        let claim_id = claim_id.to_owned();
        let parent_id = parent_session_id.to_owned();
        self.0
            .database
            .call(move |store| store.mark_cross_model_fan_in_delivered(&parent_id, &claim_id))
            .await?;
        Ok(())
    }

    async fn release_queued_cross_model_fan_in_claim(
        &self,
        parent_session_id: &str,
        row: &QueuedRow,
    ) {
        let Some(claim_id) = row.cross_model_claim_id.clone() else {
            return;
        };
        let parent_id = parent_session_id.to_owned();
        let _ = self
            .0
            .database
            .call(move |store| store.release_cross_model_fan_in_claim(&parent_id, &claim_id))
            .await;
    }

    async fn rollback_cross_model_fan_in_delivery(&self, parent_session_id: &str, claim_id: &str) {
        let parent_id = parent_session_id.to_owned();
        let claim_id = claim_id.to_owned();
        let _ = self
            .0
            .database
            .call(move |store| store.rollback_cross_model_fan_in_delivery(&parent_id, &claim_id))
            .await;
    }

    fn retry_pending_cross_model_fan_in(&self, parent_session_id: String) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let _ = runtime
                .deliver_pending_cross_model_fan_in(&parent_session_id)
                .await;
        });
    }

    /// Persist a successfully-delivered steer as a user message immediately:
    /// it cannot be unsent, and the audit trail must show it even though no
    /// queued row exists.
    async fn record_steer(
        &self,
        id: &str,
        text: &str,
        attachments: &[AttachmentInput],
    ) -> Result<()> {
        let (turn, _native) = {
            let id = id.to_owned();
            self.0
                .database
                .call(move |store| {
                    let run = store.agent_run(&id)?;
                    Ok((run.turn, run.native_id))
                })
                .await?
        };
        let refs = attachment_refs(attachments);
        let write = TimelineWrite {
            id: format!("turn{turn}-steer-{}", uuid::Uuid::new_v4().simple()),
            turn_id: format!("turn{turn}"),
            expected_revision: 0,
            body: TimelineBody::Message {
                role: MessageRole::User,
                final_answer: false,
                attachments: refs.clone(),
            },
            text: text.to_owned(),
            replace: false,
            subagent_id: None,
        };
        persist_attachment_bytes(
            self.0.database.directory().to_owned(),
            id.to_owned(),
            write.id.clone(),
            refs,
            attachments.to_vec(),
        )
        .await?;
        let result = self.append_timeline_resilient(id, &[write], None).await;
        if let Err(error) = &result
            && !matches!(error, Error::Closed)
        {
            self.0.failed.store(true, Ordering::Release);
        }
        result
    }

    async fn expand_prompt(
        &self,
        workspace: &str,
        prompt: &str,
        codex_native_skills: bool,
    ) -> Result<String> {
        let workspace = workspace.to_owned();
        let prompt = prompt.to_owned();
        tokio::task::spawn_blocking(move || {
            if codex_native_skills {
                // Codex resolves explicit $skill mentions itself. Inlining the
                // same SKILL.md here makes the first provider turn pay twice.
                crate::skills::expand_prompt_for_codex(&workspace, &prompt)
            } else {
                crate::skills::expand_prompt(&workspace, &prompt)
            }
        })
        .await
        .map_err(|_| Error::Closed)
    }

    /// Prepare and spawn one CLI turn, install its handle under `guard`, and
    /// return the turn number plus the handle. The caller owns chaining (it
    /// either spawns the chain task or continues the drain loop in place).
    async fn launch_turn(
        &self,
        id: &str,
        text: String,
        attachments: Vec<AttachmentInput>,
        cross_model_claim_id: Option<&str>,
        guard: &mut MutexGuard<'_, Option<Arc<Handle>>>,
    ) -> Result<(i64, Arc<Handle>)> {
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        if self
            .session_entry(id)
            .await
            .is_ok_and(|session| session.execution_unknown.load(Ordering::Acquire))
        {
            return Err(Error::Feature(
                "driver_exit_unknown".into(),
                "Previous executor exit requires reconciliation".into(),
            ));
        }
        let turn_permit = self.0.slots.clone().try_acquire_owned().map_err(|_| {
            self.0
                .database
                .record_rejection("session.launch", "agent_turns");
            self.0.database.record_recent_error(
                "session.launch",
                "agent_turns",
                "Concurrent agent turn capacity exhausted",
            );
            Error::Backpressure(crate::error::ResourceBackpressure {
                retry_after_ms: 1000,
                operation: "session.launch".into(),
                resource: "agent_turns".into(),
                queue_depth: self.active_turn_permits(),
                queue_capacity: MAX_TURNS,
                side_effect_committed: Some(false),
            })
        })?;
        let run = {
            let id = id.to_owned();
            let expected_claim = cross_model_claim_id.map(str::to_owned);
            self.0
                .database
                .call_control("session.launch", move |store| {
                    let run = store.agent_run(&id)?;
                    if store.agent_execution_unknown(&id)? {
                        return Err(Error::Feature(
                            "driver_exit_unknown".into(),
                            "Previous executor exit requires reconciliation".into(),
                        ));
                    }
                    if !run.active {
                        return Err(Error::Conflict);
                    }
                    if let Some(claim_id) = expected_claim.as_deref() {
                        let valid: i64 = store.connection.query_row(
                            "SELECT count(*) FROM cross_model_children WHERE parent_session_id=?1 AND summary_claim_id=?2 AND summary_delivered=0",
                            rusqlite::params![&id, claim_id],
                            |row| row.get(0),
                        )?;
                        if valid == 0 {
                            return Err(Error::Conflict);
                        }
                    }
                    Ok(run)
                })
                .await?
        };
        if let Ok(session) = self.session_entry(id).await {
            session.usage.lock().await.usage_finalized = Some(false);
        }
        let (turn, native_id) = {
            let id = id.to_owned();
            self.0
                .database
                .call_control("session.turn_start", move |store| {
                    store.begin_agent_turn(&id)
                })
                .await?
        };
        let workspace = {
            let id = id.to_owned();
            self.0
                .database
                .call_control("session.launch", move |store| {
                    Ok(store.session(&id)?.workspace)
                })
                .await?
        };
        // Expand @file/$skill mentions for the CLI while the stored user
        // record keeps the original text (mirrors legacy structured-session).
        let api_profile =
            Self::account_api_profile(&self.0.database, run.account_id.clone()).await?;
        let engine = engine_agent(run.agent, api_profile.as_ref());
        let expanded = self
            .expand_prompt(&workspace, &text, engine == AgentKind::Codex)
            .await?;
        self.set_status(id, SessionStatus::Running).await?;
        // Persist the user's original message before invoking the provider.
        let refs = attachment_refs(&attachments);
        let user_message_id = format!("turn{turn}-user");
        persist_attachment_bytes(
            self.0.database.directory().to_owned(),
            id.to_owned(),
            user_message_id.clone(),
            refs.clone(),
            attachments.clone(),
        )
        .await?;
        let user_write = TimelineWrite {
            id: user_message_id,
            turn_id: format!("turn{turn}"),
            expected_revision: 0,
            body: TimelineBody::Message {
                role: MessageRole::User,
                final_answer: false,
                attachments: refs,
            },
            text,
            replace: false,
            subagent_id: None,
        };
        if let Err(error) = self
            .append_timeline_resilient(id, &[user_write], Some("session.launch"))
            .await
        {
            if !matches!(error, Error::Closed) {
                self.0.failed.store(true, Ordering::Release);
            }
            return Err(error);
        }
        let effective_env_account = run.account_id.clone().or_else(|| {
            (run.agent == AgentKind::Claude).then(|| crate::accounts::NATIVE_CLAUDE_ID.to_owned())
        });
        let mut environment =
            Self::account_environment(&self.0.database, effective_env_account).await?;
        if let Ok(control) = self.0.control_environment.lock()
            && let Some(control) = control.as_ref()
        {
            environment.extend(control.vars(Some(id)));
        }
        if let Some(execution) = self.0.execution_environment.lock().await.get(id) {
            environment.extend(execution.iter().cloned());
        }
        let effort = api_profile.as_ref().map_or_else(
            || run.effort.clone(),
            |profile| {
                crate::accounts::profile::normalize_profile_effort(profile, run.effort.as_deref())
            },
        );
        let options = TurnOptions {
            policy: run.policy,
            mode: run.mode,
            model: run.model.clone(),
            effort,
            environment,
            api_profile,
            agent_preset: run.agent_preset.clone(),
        };
        if let Some(claim_id) = cross_model_claim_id {
            self.mark_cross_model_fan_in_delivered(id, claim_id).await?;
        }
        let driver = match match engine {
            AgentKind::Claude => spawn_turn(
                &workspace,
                &expanded,
                &attachments,
                native_id.as_deref(),
                &options,
            )
            .map(Driver::Claude),
            AgentKind::Codex => {
                if !attachments.is_empty() {
                    Err(Error::Invalid(
                        "Codex structured runtime 暂不支持图片附件".into(),
                    ))
                } else {
                    super::codex::spawn_turn(
                        self.0.database.directory(),
                        &workspace,
                        &expanded,
                        native_id.as_deref(),
                        &options,
                    )
                    .await
                    .map(Driver::Codex)
                }
            }
            AgentKind::Deepseek => super::deepseek::spawn_turn(
                &workspace,
                &expanded,
                &attachments,
                native_id.as_deref(),
                &options,
            )
            .await
            .map(Driver::Deepseek),
            AgentKind::Opencode => super::opencode::spawn_turn(
                &workspace,
                &expanded,
                &attachments,
                native_id.as_deref(),
                &options,
            )
            .await
            .map(Driver::Opencode),
            AgentKind::Pi => super::pi::spawn_turn(
                &workspace,
                &expanded,
                &attachments,
                native_id.as_deref(),
                &options,
            )
            .await
            .map(Driver::Pi),
            AgentKind::Agy => super::agy::spawn_turn(
                &workspace,
                &expanded,
                &attachments,
                native_id.as_deref(),
                &options,
            )
            .await
            .map(Driver::Agy),
            _ => Err(Error::Invalid(
                "Agent 暂未接入 Rust structured runtime".into(),
            )),
        } {
            Ok(driver) => driver,
            Err(error) => {
                if let Ok(session) = self.session_entry(id).await {
                    let mut usage = session.usage.lock().await;
                    usage.usage_complete = Some(false);
                    usage.usage_finalized = Some(!super::lifecycle::exit_unknown(&error));
                }
                if super::lifecycle::exit_unknown(&error) {
                    if let Ok(session) = self.session_entry(id).await {
                        session.execution_unknown.store(true, Ordering::Release);
                    }
                    let session_id = id.to_owned();
                    self.0
                        .database
                        .call_control("agent.exit_unknown", move |store| {
                            store.mark_agent_execution_unknown(&session_id)
                        })
                        .await?;
                }
                if let Some(claim_id) = cross_model_claim_id {
                    self.rollback_cross_model_fan_in_delivery(id, claim_id)
                        .await;
                }
                let mut driver_error =
                    driver_error_from_error(&error, crate::protocol::DriverPhase::Create);
                driver_error.diagnostic_ref = Some(format!("timeline:{id}:turn{turn}-error"));
                let message = error.to_string();
                if let Err(storage) = self
                    .append_driver_error_resilient(id, turn, &driver_error)
                    .await
                    && !matches!(storage, Error::Closed)
                {
                    self.0.failed.store(true, Ordering::Release);
                }
                let terminal = vec![
                    TimelineWrite {
                        id: format!("turn{turn}-error"),
                        turn_id: format!("turn{turn}"),
                        expected_revision: 0,
                        body: TimelineBody::Error {
                            driver_error: Some(driver_error),
                        },
                        text: bounded_text(message),
                        replace: false,
                        subagent_id: None,
                    },
                    TimelineWrite {
                        id: format!("turn{turn}-end"),
                        turn_id: format!("turn{turn}"),
                        expected_revision: 0,
                        body: TimelineBody::TurnEnd {
                            finish: "failed".into(),
                            diffs: Vec::new(),
                        },
                        text: String::new(),
                        replace: false,
                        subagent_id: None,
                    },
                ];
                if let Err(storage) = self
                    .append_timeline_resilient(id, &terminal, Some("event.turn_terminal"))
                    .await
                    && !matches!(storage, Error::Closed)
                {
                    self.0.failed.store(true, Ordering::Release);
                }
                if let Err(storage) = self
                    .finish_turn_status_resilient(id, SessionStatus::Failed)
                    .await
                    && !matches!(storage, Error::Closed)
                {
                    self.0.failed.store(true, Ordering::Release);
                }
                self.publish();
                return Err(error);
            }
        };
        let handle = Arc::new(Handle {
            driver: Mutex::new(driver),
            quiesced: watch::channel(false).0,
            turn_finished: watch::channel(false).0,
            quiescence_unknown: AtomicBool::new(false),
            replies: Mutex::new(HashMap::new()),
            records: Mutex::new(HashMap::new()),
            questions: Mutex::new(HashMap::new()),
            compact: Mutex::new(None),
            steerable: AtomicBool::new(true),
            permit: Mutex::new(Some(turn_permit)),
        });
        **guard = Some(handle.clone());
        Ok((turn, handle))
    }

    /// Run one turn, then drain queued messages as chained turns, all in a
    /// single task so only the turn that just finished starts the next one.
    fn spawn_chain(&self, id: String, first_turn: i64, first_handle: Arc<Handle>) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let mut turn = first_turn;
            let mut handle = first_handle;
            loop {
                let outcome = runtime.run_turn(id.clone(), turn, handle.clone()).await;
                handle.turn_finished.send_replace(true);
                let lifecycle = handle.driver.lock().await.lifecycle();
                if !lifecycle
                    .await_quiescence(Duration::from_secs(3))
                    .await
                    .permits_direct_release()
                {
                    handle.quiescence_unknown.store(true, Ordering::Release);
                    if let Ok(session) = runtime.session_entry(&id).await {
                        session.execution_unknown.store(true, Ordering::Release);
                        if let Some(permit) = handle.permit.lock().await.take() {
                            *session.permit.lock().await = Some(permit);
                        }
                    }
                    let session_id = id.clone();
                    if runtime
                        .0
                        .database
                        .call_control("agent.exit_unknown", move |store| {
                            store.mark_agent_execution_unknown(&session_id)
                        })
                        .await
                        .is_err()
                    {
                        runtime.0.failed.store(true, Ordering::Release);
                    }
                    runtime.publish();
                    break;
                }
                handle.quiesced.send_replace(true);
                let Ok(entry) = runtime.session_entry(&id).await else {
                    handle.permit.lock().await.take();
                    break;
                };
                // Hold the drain lock for the whole pop+launch window so a
                // concurrent steer/guide/send can't start a duplicate turn.
                let _drain = entry.draining.lock().await;
                let mut guard = entry.handle.lock().await;
                if guard
                    .as_ref()
                    .is_none_or(|live| !Arc::ptr_eq(live, &handle))
                {
                    handle.permit.lock().await.take();
                    break;
                }
                let session_id = id.clone();
                if runtime
                    .0
                    .database
                    .call_control("agent.exit_confirmed", move |store| {
                        store.clear_agent_execution_unknown(&session_id)
                    })
                    .await
                    .is_err()
                {
                    entry.execution_unknown.store(true, Ordering::Release);
                    handle.quiescence_unknown.store(true, Ordering::Release);
                    if let Some(permit) = handle.permit.lock().await.take() {
                        *entry.permit.lock().await = Some(permit);
                    }
                    runtime.0.failed.store(true, Ordering::Release);
                    runtime.publish();
                    break;
                }
                entry.execution_unknown.store(false, Ordering::Release);
                handle.quiescence_unknown.store(false, Ordering::Release);
                // Release the `MAX_TURNS` turn permit immediately upon quiesced idle transition.
                handle.permit.lock().await.take();
                *guard = None;
                // A worker can deliver its task while its agent turn is still
                // unwinding. The dispatch close archives the session, but
                // cannot release its permit until this process exits. Once
                // exit and the durable stop claim are both confirmed, finish
                // that close here; otherwise the archived session keeps a
                // runtime slot for the daemon's entire lifetime.
                let archived_id = id.clone();
                let archived_and_stopped = runtime
                    .0
                    .database
                    .call_control("agent.quiesced_archive", move |store| {
                        store.agent_execution_stopped(&archived_id)
                    })
                    .await
                    .unwrap_or(false);
                if archived_and_stopped {
                    drop(guard);
                    drop(_drain);
                    if let Err(error) = runtime.release_confirmed_archived_idle(&id).await {
                        runtime.0.database.record_recent_error(
                            "agent.quiesced_archive",
                            "agent_sessions",
                            &error.to_string(),
                        );
                    }
                    break;
                }
                if outcome
                    .failed_error
                    .as_deref()
                    .is_some_and(should_pause_queue_on_error)
                {
                    // Fatal auth (401/403) or rate-limit/quota (429) failure:
                    // pause queue draining so queued user messages are not
                    // popped and burned in a tight failure loop.
                    drop(guard);
                    drop(_drain);
                    runtime.deactivate_settled_cross_model_child(&id).await;
                    runtime.publish();
                    break;
                }
                runtime.publish();
                let queued = {
                    let id = id.clone();
                    runtime
                        .0
                        .database
                        .call(move |store| store.pop_message(&id))
                        .await
                };
                let Some(row) = queued.unwrap_or(None) else {
                    drop(guard);
                    drop(_drain);
                    runtime.deactivate_settled_cross_model_child(&id).await;
                    break;
                };
                match runtime
                    .launch_turn(
                        &id,
                        row.text.clone(),
                        row.attachments.clone(),
                        row.cross_model_claim_id.as_deref(),
                        &mut guard,
                    )
                    .await
                {
                    Ok((next_turn, next_handle)) => {
                        turn = next_turn;
                        handle = next_handle;
                        // Popping one queue row frees capacity. Retry a fan-in
                        // that previously rolled back because the queue was
                        // full; the active handle makes it re-enter at the tail.
                        runtime.retry_pending_cross_model_fan_in(id.clone());
                        // Guard drops here; run_turn runs without it, and the
                        // next loop iteration takes the drain slot again.
                    }
                    // Archive raced the pop: the queue was cleared by design
                    // (user killed the session); do not replay it.
                    Err(Error::Conflict) | Err(Error::NotFound) => {
                        runtime
                            .release_queued_cross_model_fan_in_claim(&id, &row)
                            .await;
                        break;
                    }
                    Err(Error::Closed) => {
                        // Daemon shutdown: put the popped row back so a future
                        // daemon can drain it rather than dropping the text.
                        if runtime.enqueue(&id, &row, true).await.is_err() {
                            runtime
                                .release_queued_cross_model_fan_in_claim(&id, &row)
                                .await;
                        }
                        break;
                    }
                    Err(error) => {
                        // Transient failure: keep the message at the front;
                        // the next user-sent turn drains it on completion.
                        if runtime.enqueue(&id, &row, true).await.is_err() {
                            runtime
                                .release_queued_cross_model_fan_in_claim(&id, &row)
                                .await;
                        }
                        runtime.drain_error(&id, turn, &error.to_string()).await;
                        break;
                    }
                }
            }
        });
    }

    async fn append_timeline_resilient(
        &self,
        id: &str,
        writes: &[TimelineWrite],
        control_operation: Option<&str>,
    ) -> Result<()> {
        if writes.is_empty() {
            return Ok(());
        }
        loop {
            if self.0.closed.load(Ordering::Acquire) || !self.0.database.health().alive {
                return Err(Error::Closed);
            }
            let id = id.to_owned();
            let batch = clone_timeline_writes(writes);
            let result = if let Some(operation) = control_operation {
                self.0
                    .database
                    .call_control(operation, move |store| {
                        store.append_agent_records(&id, batch)
                    })
                    .await
            } else {
                self.0
                    .database
                    .call_background("event.timeline", move |store| {
                        store.append_agent_records(&id, batch)
                    })
                    .await
            };
            match result {
                Ok(()) => return Ok(()),
                Err(Error::Backpressure(_) | Error::Busy) => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    async fn append_driver_error_resilient(
        &self,
        id: &str,
        turn: i64,
        failure: &DriverError,
    ) -> Result<()> {
        for attempt in 0..3 {
            let session_id = id.to_owned();
            let failure = failure.clone();
            let result = self
                .0
                .database
                .call_control("agent.driver_error", move |store| {
                    store.append_agent_driver_error(&session_id, turn, &failure)
                })
                .await;
            match result {
                Ok(()) => return Ok(()),
                Err(Error::Backpressure(_) | Error::Busy) if attempt < 2 => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(error) => return Err(error),
            }
        }
        Err(Error::Closed)
    }

    async fn set_native_id_resilient(&self, id: &str, turn: i64, native_id: &str) -> Result<()> {
        loop {
            if self.0.closed.load(Ordering::Acquire) || !self.0.database.health().alive {
                return Err(Error::Closed);
            }
            let id = id.to_owned();
            let native_id = native_id.to_owned();
            let result = self
                .0
                .database
                .call_control("session.native_id", move |store| {
                    store.set_agent_native_id(&id, turn, &native_id)
                })
                .await;
            match result {
                Ok(()) => return Ok(()),
                Err(Error::Backpressure(_) | Error::Busy) => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    async fn drain_error(&self, id: &str, turn: i64, message: &str) {
        let write = TimelineWrite {
            id: format!("turn{turn}-drain-error"),
            turn_id: format!("turn{turn}"),
            expected_revision: 0,
            body: TimelineBody::Error { driver_error: None },
            text: bounded_text(message.to_owned()),
            replace: false,
            subagent_id: None,
        };
        let _ = self.append_timeline_resilient(id, &[write], None).await;
        self.publish();
    }

    /// Kick the drain when a queue mutation happens while no turn is running
    /// (e.g. guideQueued on an idle session dispatches the row immediately).
    async fn kick_drain(&self, id: &str) {
        let Ok(entry) = self.session_entry(id).await else {
            return;
        };
        let runtime = self.clone();
        let id = id.to_owned();
        tokio::spawn(async move {
            let _drain = entry.draining.lock().await;
            let mut guard = entry.handle.lock().await;
            if guard.is_some() {
                return;
            }
            let row = match runtime
                .0
                .database
                .call({
                    let id = id.clone();
                    move |store| store.pop_message(&id)
                })
                .await
            {
                Ok(Some(row)) => row,
                _ => return,
            };
            match runtime
                .launch_turn(
                    &id,
                    row.text.clone(),
                    row.attachments.clone(),
                    row.cross_model_claim_id.as_deref(),
                    &mut guard,
                )
                .await
            {
                Ok((turn, handle)) => {
                    drop(guard);
                    runtime.spawn_chain(id.clone(), turn, handle);
                    runtime.retry_pending_cross_model_fan_in(id.clone());
                }
                Err(error) => {
                    if runtime.enqueue(&id, &row, true).await.is_err() {
                        runtime
                            .release_queued_cross_model_fan_in_claim(&id, &row)
                            .await;
                    }
                    runtime.drain_error(&id, 0, &error.to_string()).await;
                }
            }
        });
    }

    pub async fn compact(&self, id: &str, request_id: &str) -> Result<AgentControlResult> {
        crate::database::validate_id(id)?;
        let entry = self.session_entry(id).await?;
        let handle = entry.handle.lock().await.clone().ok_or(Error::Conflict)?;
        {
            let mut waiter = handle.compact.lock().await;
            if waiter.is_some() {
                return Err(Error::Backpressure(crate::error::ResourceBackpressure {
                    retry_after_ms: 1000,
                    operation: "agent.compact".into(),
                    resource: "agent_compaction".into(),
                    queue_depth: 1,
                    queue_capacity: 1,
                    side_effect_committed: Some(false),
                }));
            }
            let (sender, receiver) = oneshot::channel();
            *waiter = Some(sender);
            drop(waiter);
            let send_result = handle.driver.lock().await.compact().await;
            if let Err(error) = send_result {
                let _ = handle.compact.lock().await.take();
                return Err(error);
            }
            match tokio::time::timeout(Duration::from_secs(180), receiver).await {
                Ok(Ok(Ok(()))) => Ok(AgentControlResult {
                    kind: "agent.control.result".into(),
                    sid: id.to_owned(),
                    request_id: request_id.chars().take(100).collect(),
                    action: "compact".into(),
                    ok: true,
                    message: None,
                }),
                Ok(Ok(Err(message))) => Ok(AgentControlResult {
                    kind: "agent.control.result".into(),
                    sid: id.to_owned(),
                    request_id: request_id.chars().take(100).collect(),
                    action: "compact".into(),
                    ok: false,
                    message: Some(message),
                }),
                Ok(Err(_)) => Err(Error::Closed),
                Err(_) => {
                    let _ = handle.compact.lock().await.take();
                    Err(Error::Timeout)
                }
            }
        }
    }

    async fn run_turn(&self, id: String, turn: i64, handle: Arc<Handle>) -> TurnOutcome {
        let mut events = {
            let mut driver = handle.driver.lock().await;
            match driver.take_events() {
                Some(events) => events,
                None => return TurnOutcome { failed_error: None },
            }
        };
        // Revision counters for streaming records that get rewritten in place.
        let mut revisions: HashMap<String, i64> = HashMap::new();
        // Per-owner multi-step segment trackers so post-tool prose/reasoning
        // writes to `turn{turn}-answer-2`, etc., instead of overwriting pre-tool text.
        let mut text_segments: HashMap<Option<String>, StreamSegmentTracker> = HashMap::new();
        let mut thinking_segments: HashMap<Option<String>, StreamSegmentTracker> = HashMap::new();
        // The single subagent card per Task-tool subagent is rewritten as
        // lifecycle frames arrive; keyed by native subagent id.
        let mut card_revisions: HashMap<String, i64> = HashMap::new();
        // Card metadata carried across the rewrites (the stored record body is
        // replaced wholesale on every update).
        let mut cards: HashMap<String, CardState> = HashMap::new();
        let mut pending: Vec<TimelineWrite> = Vec::new();
        let mut flush_deadline: Option<tokio::time::Instant> = None;
        let mut fan_in_heartbeat = tokio::time::interval_at(
            tokio::time::Instant::now() + FAN_IN_CLAIM_HEARTBEAT_INTERVAL,
            FAN_IN_CLAIM_HEARTBEAT_INTERVAL,
        );
        fan_in_heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut native_persisted = false;
        let mut interrupted = false;
        let mut failure: Option<String> = None;
        let mut turn_diffs: Vec<FileDiff> = Vec::new();

        macro_rules! flush {
            () => {{
                let _ = flush_deadline.take();
                if !pending.is_empty() {
                    let result = self.append_timeline_resilient(&id, &pending, None).await;
                    if let Err(error) = result {
                        if !matches!(error, Error::Closed) {
                            self.0.failed.store(true, Ordering::Release);
                        }
                        failure = Some(error.to_string());
                        break;
                    }
                    pending.clear();
                }
            }};
        }

        loop {
            let next_event = tokio::select! {
                biased;
                maybe_event = events.recv() => Some(maybe_event),
                _ = async {
                    if let Some(deadline) = flush_deadline {
                        tokio::time::sleep_until(deadline).await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                }, if flush_deadline.is_some() => None,
                _ = fan_in_heartbeat.tick() => {
                    let parent_id = id.clone();
                    let _ = self
                        .0
                        .database
                        .call(move |store| store.renew_cross_model_fan_in_claims(&parent_id))
                        .await;
                    continue;
                }
            };

            let Some(maybe_event) = next_event else {
                flush!();
                continue;
            };
            let Some(event) = maybe_event else {
                flush!();
                failure.get_or_insert_with(|| "agent stream closed".into());
                break;
            };
            match event {
                AdapterEvent::NativeId(native_id) => {
                    if !native_persisted {
                        if let Err(error) =
                            self.set_native_id_resilient(&id, turn, &native_id).await
                        {
                            if !matches!(error, Error::Closed) {
                                self.0.failed.store(true, Ordering::Release);
                            }
                            failure = Some(error.to_string());
                            break;
                        }
                        native_persisted = true;
                    }
                }
                AdapterEvent::SubagentStarted {
                    subagent,
                    name,
                    role,
                    task,
                } => {
                    text_segments.entry(None).or_default().mark_interrupted();
                    thinking_segments
                        .entry(None)
                        .or_default()
                        .mark_interrupted();
                    let slug = safe_owner(&subagent);
                    let now = crate::database::now();
                    cards.insert(
                        slug.clone(),
                        CardState {
                            name: name.clone(),
                            role: role.clone(),
                            task: task.clone(),
                            created_at: now,
                            status: "starting".into(),
                            can_message: true,
                            summary: String::new(),
                        },
                    );
                    pending.push(TimelineWrite {
                        id: format!("card-{slug}"),
                        turn_id: format!("turn{turn}"),
                        expected_revision: 0,
                        body: TimelineBody::Subagent {
                            subagent_id: slug.clone(),
                            name,
                            role,
                            task,
                            status: "starting".into(),
                            can_message: true,
                            summary: String::new(),
                            created_at: now,
                            updated_at: now,
                        },
                        text: String::new(),
                        replace: false,
                        subagent_id: None,
                    });
                    card_revisions.insert(slug, 1);
                    flush!();
                }
                AdapterEvent::SubagentUpdate {
                    subagent,
                    status,
                    can_message,
                    summary,
                } => {
                    text_segments.entry(None).or_default().mark_interrupted();
                    thinking_segments
                        .entry(None)
                        .or_default()
                        .mark_interrupted();
                    let slug = safe_owner(&subagent);
                    // A late progress/notification without a task_started still
                    // needs a card (matches legacy registerSubagent-on-message).
                    if !cards.contains_key(&slug) {
                        let now = crate::database::now();
                        cards.insert(
                            slug.clone(),
                            CardState {
                                name: String::new(),
                                role: None,
                                task: None,
                                created_at: now,
                                status: "starting".into(),
                                can_message: true,
                                summary: String::new(),
                            },
                        );
                    }
                    let card = cards.get_mut(&slug).expect("card state inserted above");
                    card.status = status.to_owned();
                    card.can_message = can_message;
                    if let Some(text) = summary {
                        card.summary = super::store::cross_model_card_summary(&text);
                    }
                    let CardState {
                        name,
                        role,
                        task,
                        created_at,
                        status: card_status,
                        can_message: card_can,
                        summary: card_summary,
                    } = &*card;
                    let created = !card_revisions.contains_key(&slug);
                    let revision = card_revisions.get(&slug).copied().unwrap_or(0);
                    pending.push(TimelineWrite {
                        id: format!("card-{slug}"),
                        turn_id: format!("turn{turn}"),
                        expected_revision: if created { 0 } else { revision },
                        body: TimelineBody::Subagent {
                            subagent_id: slug.clone(),
                            name: name.clone(),
                            role: role.clone(),
                            task: task.clone(),
                            status: card_status.clone(),
                            can_message: *card_can,
                            summary: card_summary.clone(),
                            created_at: *created_at,
                            updated_at: crate::database::now(),
                        },
                        text: String::new(),
                        replace: false,
                        subagent_id: None,
                    });
                    card_revisions.insert(slug.clone(), revision + 1);
                    flush!();
                }
                AdapterEvent::Text { subagent, text } => {
                    let owner = subagent.map(|value| safe_owner(&value));
                    let base = match &owner {
                        Some(slug) => format!("sub-{slug}-turn{turn}-answer"),
                        None => format!("turn{turn}-answer"),
                    };
                    if let Some((record, segment_text)) = text_segments
                        .entry(owner.clone())
                        .or_default()
                        .resolve(text, &base)
                    {
                        upsert_pending_write(
                            &mut pending,
                            &mut revisions,
                            record,
                            format!("turn{turn}"),
                            TimelineBody::Message {
                                role: MessageRole::Assistant,
                                final_answer: true,
                                attachments: Vec::new(),
                            },
                            bounded_text(segment_text),
                            owner,
                        );
                        flush_deadline.get_or_insert_with(|| {
                            tokio::time::Instant::now() + STREAM_FLUSH_COALESCE_DELAY
                        });
                    }
                }
                AdapterEvent::Thinking { subagent, text } => {
                    let owner = subagent.map(|value| safe_owner(&value));
                    let base = match &owner {
                        Some(slug) => format!("sub-{slug}-turn{turn}-reasoning"),
                        None => format!("turn{turn}-reasoning"),
                    };
                    if let Some((record, segment_text)) = thinking_segments
                        .entry(owner.clone())
                        .or_default()
                        .resolve(text, &base)
                    {
                        upsert_pending_write(
                            &mut pending,
                            &mut revisions,
                            record,
                            format!("turn{turn}"),
                            TimelineBody::Reasoning,
                            bounded_text(segment_text),
                            owner,
                        );
                        flush_deadline.get_or_insert_with(|| {
                            tokio::time::Instant::now() + STREAM_FLUSH_COALESCE_DELAY
                        });
                    }
                }
                AdapterEvent::ToolCall {
                    subagent,
                    call_id,
                    name,
                    summary,
                    diff,
                } => {
                    let owner = subagent.map(|value| safe_owner(&value));
                    text_segments
                        .entry(owner.clone())
                        .or_default()
                        .mark_interrupted();
                    thinking_segments
                        .entry(owner.clone())
                        .or_default()
                        .mark_interrupted();
                    let record = match &owner {
                        Some(slug) => format!("sub-{slug}-{call_id}"),
                        None => call_id.clone(),
                    };
                    pending.push(TimelineWrite {
                        id: record.clone(),
                        turn_id: format!("turn{turn}"),
                        expected_revision: 0,
                        body: TimelineBody::Tool {
                            name,
                            state: ToolState::Running,
                            summary,
                            diff,
                            has_more: false,
                        },
                        text: String::new(),
                        replace: false,
                        subagent_id: owner,
                    });
                    revisions.insert(record, 1);
                    flush!();
                }
                AdapterEvent::ToolResult {
                    subagent,
                    call_id,
                    name,
                    summary,
                    error,
                    diff,
                    has_more,
                } => {
                    let owner = subagent.map(|value| safe_owner(&value));
                    text_segments
                        .entry(owner.clone())
                        .or_default()
                        .mark_interrupted();
                    thinking_segments
                        .entry(owner.clone())
                        .or_default()
                        .mark_interrupted();
                    let record = match &owner {
                        Some(slug) => format!("sub-{slug}-{call_id}"),
                        None => call_id.clone(),
                    };
                    let revision = revisions.get(&record).copied().unwrap_or(1);
                    pending.push(TimelineWrite {
                        id: record.clone(),
                        turn_id: format!("turn{turn}"),
                        expected_revision: revision,
                        body: TimelineBody::Tool {
                            name,
                            state: if error {
                                ToolState::Failed
                            } else {
                                ToolState::Success
                            },
                            summary: String::new(),
                            diff,
                            has_more,
                        },
                        text: summary,
                        replace: false,
                        subagent_id: owner,
                    });
                    revisions.insert(record, revision + 1);
                    flush!();
                }
                AdapterEvent::Permission {
                    subagent,
                    request_id,
                    tool,
                    summary,
                    reply,
                } => {
                    let owner = subagent.as_deref().map(safe_owner);
                    text_segments
                        .entry(owner.clone())
                        .or_default()
                        .mark_interrupted();
                    thinking_segments
                        .entry(owner)
                        .or_default()
                        .mark_interrupted();
                    flush!();
                    // Approvals stay on the main timeline so they can be
                    // answered there; the subagent id rides along as metadata
                    // and the detail pane picks them up via body.subagent.
                    let record_id = format!("turn{turn}-perm-{request_id}");
                    handle
                        .replies
                        .lock()
                        .await
                        .insert(request_id.clone(), reply);
                    handle
                        .records
                        .lock()
                        .await
                        .insert(request_id.clone(), record_id.clone());
                    let write = TimelineWrite {
                        id: record_id,
                        turn_id: format!("turn{turn}"),
                        expected_revision: 0,
                        body: TimelineBody::PermissionRequest {
                            request_id,
                            tool,
                            resolved: false,
                            subagent,
                        },
                        text: summary,
                        replace: false,
                        subagent_id: None,
                    };
                    if let Err(error) = self.append_timeline_resilient(&id, &[write], None).await {
                        if !matches!(error, Error::Closed) {
                            self.0.failed.store(true, Ordering::Release);
                        }
                        failure = Some(error.to_string());
                        break;
                    }
                    if let Err(error) = self.set_status(&id, SessionStatus::WaitingPermission).await
                    {
                        if !matches!(error, Error::Closed) {
                            self.0.failed.store(true, Ordering::Release);
                        }
                        failure = Some(error.to_string());
                        break;
                    }
                }
                AdapterEvent::Question {
                    subagent,
                    request_id,
                    questions,
                    reply,
                } => {
                    let owner = subagent.as_deref().map(safe_owner);
                    text_segments
                        .entry(owner.clone())
                        .or_default()
                        .mark_interrupted();
                    thinking_segments
                        .entry(owner)
                        .or_default()
                        .mark_interrupted();
                    flush!();
                    let record_id = format!("turn{turn}-q-{request_id}");
                    let native_by_id = questions
                        .iter()
                        .map(|spec| (spec.id.clone(), spec.native_question.clone()))
                        .collect::<HashMap<_, _>>();
                    let payload = questions
                        .into_iter()
                        .map(|spec| AgentQuestion {
                            id: spec.id,
                            header: spec.header,
                            question: spec.question,
                            options: spec
                                .options
                                .into_iter()
                                .map(|option| QuestionOption {
                                    label: option.label,
                                    description: option.description,
                                    preview: option.preview,
                                })
                                .collect(),
                            multi_select: spec.multi_select,
                            allow_other: true,
                        })
                        .collect::<Vec<_>>();
                    handle.questions.lock().await.insert(
                        request_id.clone(),
                        QuestionPending {
                            reply,
                            native_by_id,
                        },
                    );
                    // The records map is shared with approvals; the `q:`
                    // prefix keeps the two request-id spaces apart.
                    handle
                        .records
                        .lock()
                        .await
                        .insert(format!("q:{request_id}"), record_id.clone());
                    let write = TimelineWrite {
                        id: record_id,
                        turn_id: format!("turn{turn}"),
                        expected_revision: 0,
                        body: TimelineBody::Question {
                            request_id,
                            questions: payload,
                            resolved: false,
                            subagent,
                        },
                        text: String::new(),
                        replace: false,
                        subagent_id: None,
                    };
                    if let Err(error) = self.append_timeline_resilient(&id, &[write], None).await {
                        if !matches!(error, Error::Closed) {
                            self.0.failed.store(true, Ordering::Release);
                        }
                        failure = Some(error.to_string());
                        break;
                    }
                    let next_status = handle.derived_running_status().await;
                    if let Err(error) = self.set_status(&id, next_status).await {
                        if !matches!(error, Error::Closed) {
                            self.0.failed.store(true, Ordering::Release);
                        }
                        failure = Some(error.to_string());
                        break;
                    }
                }
                AdapterEvent::Compact { ok, message } => {
                    if let Some(waiter) = handle.compact.lock().await.take() {
                        let _ = waiter.send(if ok { Ok(()) } else { Err(message.clone()) });
                    }
                    if ok {
                        pending.push(TimelineWrite {
                            id: format!("turn{turn}-compact-{}", uuid::Uuid::new_v4().simple()),
                            turn_id: format!("turn{turn}"),
                            expected_revision: 0,
                            body: TimelineBody::TurnEnd {
                                finish: "compact".into(),
                                diffs: Vec::new(),
                            },
                            text: String::new(),
                            replace: false,
                            subagent_id: None,
                        });
                        flush!();
                    } else {
                        pending.push(TimelineWrite {
                            id: format!("turn{turn}-compact-error"),
                            turn_id: format!("turn{turn}"),
                            expected_revision: 0,
                            body: TimelineBody::Error { driver_error: None },
                            text: bounded_text(message),
                            replace: false,
                            subagent_id: None,
                        });
                        flush!();
                    }
                }
                AdapterEvent::Finish {
                    interrupted: was_interrupted,
                    error,
                    cost_usd,
                    input_tokens,
                    output_tokens,
                    diffs,
                } => {
                    flush!();
                    handle.steerable.store(false, Ordering::Release);
                    if let Ok(session) = self.session_entry(&id).await {
                        let mut usage = session.usage.lock().await;
                        let complete =
                            cost_usd.is_some() && input_tokens.is_some() && output_tokens.is_some();
                        usage.usage_complete =
                            Some(usage.usage_complete.unwrap_or(true) && complete);
                        usage.usage_finalized = Some(true);
                        if let Some(value) = cost_usd {
                            usage.cost_usd = Some(usage.cost_usd.unwrap_or(0.0) + value);
                        }
                        if let Some(value) = input_tokens {
                            usage.input_tokens =
                                Some(usage.input_tokens.unwrap_or(0).saturating_add(value));
                        }
                        if let Some(value) = output_tokens {
                            usage.output_tokens =
                                Some(usage.output_tokens.unwrap_or(0).saturating_add(value));
                        }
                    }
                    interrupted = was_interrupted;
                    turn_diffs = diffs;
                    failure = error;
                    break;
                }
            }
        }

        if !pending.is_empty() {
            if let Err(error) = self.append_timeline_resilient(&id, &pending, None).await {
                if !matches!(error, Error::Closed) {
                    self.0.failed.store(true, Ordering::Release);
                }
                failure.get_or_insert_with(|| error.to_string());
            }
            pending.clear();
        }

        if let Some(waiter) = handle.compact.lock().await.take() {
            let _ = waiter.send(Err(failure
                .clone()
                .unwrap_or_else(|| "Claude 上下文压缩未完成".into())));
        }

        // Terminal records: error (if any) and the turn end marker.
        let finish = if interrupted {
            "interrupted"
        } else if failure.is_some() {
            "failed"
        } else {
            "completed"
        };
        let mut terminal = Vec::new();
        if let Some(message) = &failure {
            let mut driver_error =
                driver_error_from_message(message.clone(), crate::protocol::DriverPhase::Observe);
            driver_error.diagnostic_ref = Some(format!("timeline:{id}:turn{turn}-error"));
            if let Err(storage) = self
                .append_driver_error_resilient(&id, turn, &driver_error)
                .await
                && !matches!(storage, Error::Closed)
            {
                self.0.failed.store(true, Ordering::Release);
            }
            terminal.push(TimelineWrite {
                id: format!("turn{turn}-error"),
                turn_id: format!("turn{turn}"),
                expected_revision: 0,
                body: TimelineBody::Error {
                    driver_error: Some(driver_error),
                },
                text: bounded_text(message.clone()),
                replace: false,
                subagent_id: None,
            });
        }
        terminal.push(TimelineWrite {
            id: format!("turn{turn}-end"),
            turn_id: format!("turn{turn}"),
            expected_revision: 0,
            body: TimelineBody::TurnEnd {
                finish: finish.into(),
                diffs: turn_diffs,
            },
            text: String::new(),
            replace: false,
            subagent_id: None,
        });
        if let Err(error) = self
            .append_timeline_resilient(&id, &terminal, Some("event.turn_terminal"))
            .await
        {
            if !matches!(error, Error::Closed) {
                self.0.failed.store(true, Ordering::Release);
            }
            return TurnOutcome {
                failed_error: failure,
            };
        }
        let status = if failure.is_some() {
            SessionStatus::Failed
        } else {
            SessionStatus::Idle
        };
        // Skip the write (and publish) when the session was archived while the
        // turn was still running; archival owns the terminal status then.
        let updated = self.finish_turn_status_resilient(&id, status).await;
        match updated {
            Ok(true) => self.publish(),
            Ok(false) | Err(Error::Closed) => {}
            Err(_) => {
                self.0.failed.store(true, Ordering::Release);
                return TurnOutcome {
                    failed_error: failure,
                };
            }
        }
        // A cross-model child is a full independent session.  Once its first
        // assigned task settles, persist its outcome and rewrite the parent
        // card with a bounded final answer (or the concrete failure).
        let child = {
            let id = id.clone();
            self.0
                .database
                .call(move |store| store.cross_model_child(&id))
                .await
        };
        if let Ok(existing) = child {
            let task_turn = {
                let id = id.clone();
                self.0
                    .database
                    .call(move |store| store.cross_model_child_task_turn(&id))
                    .await
            };
            let Ok(task_turn) = task_turn else {
                return TurnOutcome {
                    failed_error: failure,
                };
            };
            if task_turn != turn {
                return TurnOutcome {
                    failed_error: failure,
                };
            }
            let result = if let Some(error) = failure.as_deref() {
                Some(super::store::truncate_utf8_bytes(error, 65_536))
            } else {
                let id = id.clone();
                self.0
                    .database
                    .call(move |store| store.cross_model_child_summary(&id))
                    .await
                    .ok()
                    .flatten()
            };
            let state = if result.as_deref().is_some_and(|value| !value.is_empty())
                && finish == "completed"
            {
                "completed"
            } else if finish == "interrupted" {
                "stopped"
            } else {
                "failed"
            };
            let completed = {
                let id = id.clone();
                let result = result.clone();
                self.0
                    .database
                    .call(move |store| {
                        store.complete_cross_model_child(&id, task_turn, state, result.as_deref())
                    })
                    .await
            };
            if let Ok(completed) = completed {
                let card_status = completed.status.clone();
                let summary = completed.result.clone().unwrap_or_else(|| {
                    if card_status == "completed" {
                        "子任务已完成，没有可回传的文本摘要。".into()
                    } else {
                        "子任务未完成。".into()
                    }
                });
                let _ = self
                    .write_cross_model_card(&completed, &card_status, bounded_text(summary))
                    .await;
                // Structured parents are queued/resumed through Agents;
                // hosted CLI parents receive identical text as PTY input.
                // A failed delivery releases its claim for startup recovery.
                let _ = self
                    .deliver_pending_cross_model_fan_in(&completed.parent_session_id)
                    .await;
            } else {
                let _ = existing;
            }
        }
        TurnOutcome {
            failed_error: failure,
        }
    }

    async fn set_status(&self, id: &str, status: SessionStatus) -> Result<SessionHead> {
        let head = loop {
            if self.0.closed.load(Ordering::Acquire) || !self.0.database.health().alive {
                return Err(Error::Closed);
            }
            let result = self
                .0
                .database
                .call_control("session.status", {
                    let id = id.to_owned();
                    move |store| {
                        let head = store.session(&id)?;
                        if head.lifecycle == SessionLifecycle::Archived {
                            return Err(Error::Closed);
                        }
                        store.update_session(
                            &id,
                            UpdateSession {
                                revision: head.revision,
                                title: None,
                                lifecycle: None,
                                status: Some(status),
                            },
                        )
                    }
                })
                .await;
            match result {
                Ok(head) => break head,
                Err(Error::Backpressure(_) | Error::Busy) => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(error) => return Err(error),
            }
        };
        self.publish();
        Ok(head)
    }

    async fn finish_turn_status_resilient(&self, id: &str, status: SessionStatus) -> Result<bool> {
        loop {
            if self.0.closed.load(Ordering::Acquire) || !self.0.database.health().alive {
                return Err(Error::Closed);
            }
            let id = id.to_owned();
            let result = self
                .0
                .database
                .call_control("session.turn_finish", move |store| {
                    store.finish_agent_turn_status(&id, status)
                })
                .await;
            match result {
                Ok(updated) => return Ok(updated),
                Err(Error::Backpressure(_) | Error::Busy) => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn publish(&self) {
        self.0.changed.send_modify(|seq| *seq = seq.wrapping_add(1));
    }

    pub async fn respond_permission(&self, id: &str, request_id: &str, allow: bool) -> Result<()> {
        crate::database::validate_id(request_id)?;
        let entry = self.session_entry(id).await?;
        let guard = entry.handle.lock().await;
        let handle = guard.as_ref().ok_or(Error::NotFound)?;
        let reply = handle
            .replies
            .lock()
            .await
            .remove(request_id)
            .ok_or(Error::NotFound)?;
        let record_id = handle.records.lock().await.remove(request_id);
        let next_status = handle.derived_running_status().await;
        // The translator's reply task owns the control_response frame.
        let _ = reply.send(allow);
        drop(guard);
        if let Some(record_id) = record_id {
            let id = id.to_owned();
            let result = self
                .0
                .database
                .call(move |store| store.resolve_agent_permission(&id, &record_id))
                .await;
            // A concurrently-archived session makes the record update moot.
            if !matches!(result, Err(Error::NotFound)) {
                result?;
            }
        }
        self.set_status(id, next_status).await?;
        Ok(())
    }

    pub async fn respond_question(
        &self,
        id: &str,
        request_id: &str,
        answers: Vec<QuestionAnswer>,
        cancelled: bool,
    ) -> Result<()> {
        crate::database::validate_id(request_id)?;
        for answer in &answers {
            crate::database::validate_id(&answer.question_id)?;
            if answer.values.iter().any(|value| value.len() > 8192) {
                return Err(Error::Invalid("answer exceeds limit".into()));
            }
        }
        let entry = self.session_entry(id).await?;
        let guard = entry.handle.lock().await;
        let handle = guard.as_ref().ok_or(Error::NotFound)?;
        let pending = handle
            .questions
            .lock()
            .await
            .remove(request_id)
            .ok_or(Error::NotFound)?;
        let record_id = handle
            .records
            .lock()
            .await
            .remove(&format!("q:{request_id}"));
        let next_status = handle.derived_running_status().await;
        let native = answers
            .into_iter()
            .filter_map(|answer| {
                pending
                    .native_by_id
                    .get(&answer.question_id)
                    .map(|native| (native.clone(), answer.values.join(", ")))
            })
            .collect::<HashMap<_, _>>();
        // Dropping would deny; an explicit cancel still allows with {}.
        let _ = pending.reply.send(QuestionReply {
            answers: native,
            cancelled,
        });
        drop(guard);
        if let Some(record_id) = record_id {
            let id = id.to_owned();
            let result = self
                .0
                .database
                .call(move |store| store.resolve_agent_question(&id, &record_id))
                .await;
            if !matches!(result, Err(Error::NotFound)) {
                result?;
            }
        }
        self.set_status(id, next_status).await?;
        Ok(())
    }

    /// Pending messages for one session (desktop "待发送" list).
    pub async fn queue(&self, id: &str) -> Result<Vec<QueuedMessage>> {
        crate::database::validate_id(id)?;
        let id = id.to_owned();
        let rows = self
            .0
            .database
            .call(move |store| store.message_queue(&id))
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| QueuedMessage {
                id: row.id,
                text: row.text,
                kind: row.kind,
                created_at: row.created_at,
                attachment_count: row.attachments.len(),
            })
            .collect())
    }

    /// Non-empty queues across all active sessions (session-list projection).
    pub async fn queues(&self) -> Result<AgentQueues> {
        let rows = self.0.database.call(|store| store.message_queues()).await?;
        Ok(AgentQueues {
            queues: rows
                .into_iter()
                .map(|(session_id, items)| AgentQueue {
                    session_id,
                    items: items
                        .into_iter()
                        .map(|row| QueuedMessage {
                            id: row.id,
                            text: row.text,
                            kind: row.kind,
                            created_at: row.created_at,
                            attachment_count: row.attachments.len(),
                        })
                        .collect(),
                })
                .collect(),
        })
    }

    /// Cancel a message that has not been dispatched yet. A steer that was
    /// already delivered has no queue row and cannot be withdrawn.
    pub async fn remove_queued(&self, id: &str, queue_id: &str) -> Result<()> {
        let parent_id = id.to_owned();
        let id = id.to_owned();
        let queue_id = queue_id.to_owned();
        self.0
            .database
            .call(move |store| store.remove_message(&id, &queue_id))
            .await?;
        self.publish();
        // Removing any row frees a slot; removing a fan-in row also releases
        // its durable claim in the same database transaction.
        self.retry_pending_cross_model_fan_in(parent_id);
        Ok(())
    }

    /// Upgrade a queued message into a live steer. When the current turn
    /// cannot accept it (idle, or the CLI pipe is gone) the row moves to the
    /// front of the queue and is dispatched first on the next drain; the
    /// message text is never lost.
    pub async fn guide_queued(&self, id: &str, queue_id: &str) -> Result<()> {
        crate::database::validate_id(queue_id)?;
        let entry = self.session_entry(id).await?;
        let row = {
            let id = id.to_owned();
            let queue_id = queue_id.to_owned();
            let items = self
                .0
                .database
                .call(move |store| store.message_queue(&id))
                .await?;
            items
                .into_iter()
                .find(|item| item.id == queue_id)
                .ok_or(Error::NotFound)?
        };
        if row.cross_model_claim_id.is_some() {
            // Internal fan-in reports must start a distinct parent turn so the
            // durable claim can be completed exactly at that boundary.
            return Err(Error::Conflict);
        }
        let mut steered = false;
        let guard = entry.handle.lock().await;
        if let Some(handle) = guard.as_ref()
            && handle.steerable.load(Ordering::Acquire)
        {
            let workspace = {
                let id = id.to_owned();
                self.0
                    .database
                    .call(move |store| Ok(store.session(&id)?.workspace))
                    .await?
            };
            let codex_native_skills = matches!(&*handle.driver.lock().await, Driver::Codex(_));
            let expanded = self
                .expand_prompt(&workspace, &row.text, codex_native_skills)
                .await?;
            if handle
                .driver
                .lock()
                .await
                .steer(&expanded, &row.attachments)
                .await
                .is_ok()
            {
                steered = true;
            }
        }
        drop(guard);
        if steered {
            // The steer reached the CLI: delete the row and audit the message.
            let removed_id = id.to_owned();
            let removed_qid = queue_id.to_owned();
            let removed = self
                .0
                .database
                .call(move |store| store.remove_message(&removed_id, &removed_qid))
                .await;
            if matches!(removed, Err(Error::NotFound)) {
                // A concurrent removal (other client) still must record the
                // text that was already steered into the CLI.
            } else {
                removed?;
            }
            self.record_steer(id, &row.text, &row.attachments).await?;
            self.publish();
            self.retry_pending_cross_model_fan_in(id.to_owned());
            return Ok(());
        }
        // Not steered: mark guide and move to the front, then kick the drain
        // in case the turn ended while we were trying.
        let guided_id = id.to_owned();
        let guided_qid = queue_id.to_owned();
        self.0
            .database
            .call(move |store| store.guide_message(&guided_id, &guided_qid))
            .await?;
        self.publish();
        drop(entry);
        self.kick_drain(id).await;
        Ok(())
    }

    /// Fetch the launch model catalog by speaking the CLI's headless
    /// `initialize` handshake (no user turn runs). Every request probes the
    /// CLI fresh, matching the legacy node adapter.
    pub async fn launch_catalog() -> Result<LaunchModelCatalog> {
        let models = super::claude::fetch_launch_catalog(&[]).await?;
        let current_model = models.first().map(|model| model.id.clone());
        Ok(LaunchModelCatalog {
            models,
            current_model,
            current_effort: None,
            presets: Vec::new(),
            current_preset: None,
        })
    }

    pub async fn deepseek_launch_catalog() -> Result<LaunchModelCatalog> {
        super::deepseek::launch_catalog().await
    }

    pub async fn opencode_launch_catalog() -> Result<LaunchModelCatalog> {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        super::opencode::launch_catalog(Path::new(&home)).await
    }

    pub async fn pi_launch_catalog(&self, account_id: Option<&str>) -> Result<LaunchModelCatalog> {
        let account_id = match account_id {
            None | Some(crate::accounts::NATIVE_PI_ID) => None,
            Some(id) => {
                crate::database::validate_id(id)?;
                let id_owned = id.to_owned();
                self.0
                    .database
                    .call(move |store| Ok(store.managed_account(&id_owned)?.id))
                    .await?;
                Some(id.to_owned())
            }
        };
        let environment = Self::account_environment(&self.0.database, account_id.clone()).await?;
        if let Some(id) = account_id.as_deref() {
            let data = self.0.database.directory().to_owned();
            let id = id.to_owned();
            let profile = self
                .0
                .database
                .call(move |store| Ok(store.managed_snapshot_row(&data, &id)?.api_profile))
                .await?;
            if let Some(profile) = profile {
                let efforts = crate::accounts::profile::profile_supported_efforts(&profile);
                let model = profile.model.clone();
                return Ok(LaunchModelCatalog {
                    models: vec![LaunchModelInfo {
                        id: model,
                        label: profile.model.clone(),
                        description: None,
                        supported_efforts: efforts,
                        default_effort: None,
                        is_default: true,
                    }],
                    current_model: Some(profile.model),
                    current_effort: None,
                    presets: Vec::new(),
                    current_preset: None,
                });
            }
        }
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        super::pi::launch_catalog(Path::new(&home), &environment).await
    }

    pub async fn agy_launch_catalog(&self) -> Result<LaunchModelCatalog> {
        super::agy::launch_catalog().await
    }

    /// Catalog for a specific account: managed accounts probe through their
    /// isolated config root, so the directory reflects their own identity.
    pub async fn launch_catalog_for(&self, account_id: Option<&str>) -> Result<LaunchModelCatalog> {
        let account_id = match account_id {
            None | Some(crate::accounts::NATIVE_CLAUDE_ID) => {
                Some(crate::accounts::NATIVE_CLAUDE_ID.to_owned())
            }
            Some(id) => {
                crate::database::validate_id(id)?;
                let id_owned = id.to_owned();
                self.0
                    .database
                    .call(move |store| Ok(store.managed_account(&id_owned)?.id))
                    .await?;
                Some(id.to_owned())
            }
        };
        let environment = Self::account_environment(&self.0.database, account_id.clone()).await?;
        // Profile accounts pin exactly one model through the profile itself;
        // never spawn the headless CLI catalog probe against their gateway.
        if let Some(id) = account_id.as_deref()
            && id != crate::accounts::NATIVE_CLAUDE_ID
        {
            let data = self.0.database.directory().to_owned();
            let id = id.to_owned();
            let record = self
                .0
                .database
                .call(move |store| store.managed_snapshot_row(&data, &id))
                .await?;
            if let Some(profile) = record.api_profile {
                let efforts = crate::accounts::profile::profile_supported_efforts(&profile);
                let model = profile.model.clone();
                return Ok(LaunchModelCatalog {
                    models: vec![LaunchModelInfo {
                        id: model,
                        label: profile.model.clone(),
                        description: None,
                        supported_efforts: efforts,
                        default_effort: None,
                        is_default: true,
                    }],
                    current_model: Some(profile.model),
                    current_effort: None,
                    presets: Vec::new(),
                    current_preset: None,
                });
            }
            if record.agent == AgentKind::Codex {
                return super::usage::read_codex_models_for_account(
                    self.0.database.directory(),
                    &record.id,
                )
                .await;
            }
        }
        let models = super::claude::fetch_launch_catalog(&environment).await?;
        let data = self.0.database.directory().to_owned();
        let target_account = account_id
            .clone()
            .unwrap_or_else(|| crate::accounts::NATIVE_CLAUDE_ID.to_owned());
        let (override_model, override_effort) = tokio::task::spawn_blocking(move || {
            let target = crate::accounts::config::ConfigTarget {
                account_id: target_account,
                model: None,
                model_capabilities: None,
                active_sessions: 0,
            };
            crate::accounts::config::read_defaults(&data, &target).unwrap_or((None, None))
        })
        .await
        .map_err(|_| Error::Closed)?;
        let (settings_model, settings_effort) = if std::env::var_os("PROSPERO_CLAUDE_BIN").is_none()
        {
            let config_dir = environment
                .iter()
                .find(|(key, _)| key == "CLAUDE_CONFIG_DIR")
                .map(|(_, value)| PathBuf::from(value));
            super::claude::claude_settings_defaults(config_dir.as_deref())
        } else {
            (None, None)
        };
        let preferred_model = override_model.or(settings_model);
        let preferred_effort = override_effort.or(settings_effort);
        let current_model = preferred_model
            .filter(|id| models.iter().any(|model| model.id == *id))
            .or_else(|| models.first().map(|model| model.id.clone()));
        let current_effort = preferred_effort.filter(|effort| {
            models
                .iter()
                .find(|model| Some(model.id.as_str()) == current_model.as_deref())
                .or_else(|| models.first())
                .is_some_and(|model| model.supported_efforts.iter().any(|item| item == effort))
        });
        Ok(LaunchModelCatalog {
            models,
            current_model,
            current_effort,
            presets: Vec::new(),
            current_preset: None,
        })
    }

    async fn account_api_profile(
        database: &crate::worker::Database,
        account_id: Option<String>,
    ) -> Result<Option<crate::accounts::ApiProfile>> {
        let Some(id) = account_id else {
            return Ok(None);
        };
        if matches!(
            id.as_str(),
            crate::accounts::NATIVE_CLAUDE_ID
                | crate::agent::NATIVE_CODEX_ID
                | crate::accounts::NATIVE_PI_ID
                | crate::accounts::NATIVE_AGY_ID
        ) {
            return Ok(None);
        }
        let data = database.directory().to_owned();
        database
            .call_control("session.account_profile", move |store| {
                Ok(store.managed_snapshot_row(&data, &id)?.api_profile)
            })
            .await
    }

    /// Private environment overrides for a session's bound account (empty for
    /// the native environment unless runtime overrides are configured). Profile
    /// accounts get the isolated API-key profile environment; managed subscription
    /// accounts get their isolated OAuth/CLI environment.
    /// Credential files are read off the async pool.
    async fn account_environment(
        database: &crate::worker::Database,
        account_id: Option<String>,
    ) -> Result<Vec<(String, String)>> {
        let Some(id) = account_id else {
            return Ok(Vec::new());
        };
        let data = database.directory().to_owned();
        if id == crate::accounts::NATIVE_CLAUDE_ID {
            return tokio::task::spawn_blocking(move || {
                crate::accounts::managed::native_claude_environment(&data)
            })
            .await
            .map_err(|_| Error::Closed)?;
        }
        if id == crate::agent::NATIVE_CODEX_ID
            || id == crate::accounts::NATIVE_PI_ID
            || id == crate::accounts::NATIVE_AGY_ID
        {
            return tokio::task::spawn_blocking(move || {
                crate::accounts::config::read_runtime_environment(&data, &id)
            })
            .await
            .map_err(|_| Error::Closed)?;
        }
        let record = database
            .call_control("session.account_environment", {
                let data = data.clone();
                let id = id.clone();
                move |store| store.managed_snapshot_row(&data, &id)
            })
            .await?;
        tokio::task::spawn_blocking(move || match record.api_profile {
            Some(profile) => crate::accounts::managed::profile_account_environment(
                &data,
                &record.id,
                record.agent,
                &profile,
            ),
            None if record.agent == crate::protocol::AgentKind::Codex => {
                crate::accounts::managed::codex_subscription_environment(&data, &record.id)
            }
            None => crate::accounts::managed::claude_environment(&data, &record.id, false),
        })
        .await
        .map_err(|_| Error::Closed)?
    }

    pub async fn usage(&self, id: &str) -> Result<Option<UsageReport>> {
        let entry = self.session_entry(id).await?;
        let report = entry.usage.lock().await.clone();
        if report.cost_usd.is_none()
            && report.input_tokens.is_none()
            && report.output_tokens.is_none()
            && report.usage_finalized.is_none()
            && report.windows.is_empty()
            && report.subscription.is_none()
        {
            Ok(None)
        } else {
            Ok(Some(report))
        }
    }

    pub async fn account_usage(&self) -> Result<Vec<UsageAccount>> {
        let snapshot = crate::accounts::list_accounts(&self.0.database, "usage").await?;
        let entries: Vec<_> = self
            .0
            .entries
            .lock()
            .await
            .iter()
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect();
        let sessions = if entries.is_empty() {
            Vec::new()
        } else {
            let ids: Vec<String> = entries.iter().map(|(id, _)| id.clone()).collect();
            let runs = self
                .0
                .database
                .call(move |store| {
                    ids.into_iter()
                        .map(|id| store.agent_run(&id))
                        .collect::<Result<Vec<_>>>()
                })
                .await?;
            runs.into_iter()
                .zip(entries.into_iter().map(|(_, entry)| entry))
                .map(|(run, entry)| (run.account_id, run.agent, entry))
                .collect()
        };
        let data_dir = self.0.database.directory();
        let filtered_accounts: Vec<_> = snapshot
            .accounts
            .into_iter()
            .filter(|row| {
                row.status != crate::accounts::AccountStatus::Unavailable
                    && row.id != super::usage::NATIVE_CODEX_ID
            })
            .collect();
        let account_futures = filtered_accounts.into_iter().map(|account| {
            let live_entry = sessions
                .iter()
                .find(|(account_id, agent, _)| {
                    *agent == account.agent
                        && (account_id.as_deref() == Some(account.id.as_str())
                            || (account_id.is_none() && !account.managed))
                })
                .map(|(_, _, entry)| entry.clone());
            async move {
                let mut report = if let Some(entry) = live_entry {
                    let report = entry.usage.lock().await.clone();
                    (report.cost_usd.is_some()
                        || report.input_tokens.is_some()
                        || report.output_tokens.is_some()
                        || report.usage_finalized.is_some()
                        || !report.windows.is_empty()
                        || report.subscription.is_some())
                    .then_some(report)
                } else {
                    None
                };
                if report.is_none()
                    && account.agent == crate::protocol::AgentKind::Codex
                    && account.api_profile.is_none()
                    && account.managed
                    && account.status == crate::accounts::AccountStatus::SignedIn
                {
                    report = super::usage::read_codex_usage_for_account(data_dir, &account.id)
                        .await
                        .ok()
                        .flatten();
                }
                let source = if account.api_profile.is_some()
                    || account
                        .auth_method
                        .as_deref()
                        .is_some_and(|value| value.to_ascii_lowercase().contains("api"))
                {
                    "api"
                } else if report
                    .as_ref()
                    .and_then(|value| value.subscription.as_ref())
                    .is_some()
                    || account.status == crate::accounts::AccountStatus::SignedIn
                {
                    "subscription"
                } else {
                    "unknown"
                }
                .to_owned();
                let available = report.is_some() || source == "api";
                let reason = if report.is_none() {
                    Some(
                        if source == "api" {
                            "API 模型由服务商按 API 用量计费，不提供订阅窗口。"
                        } else {
                            "暂时读不到账号额度，请确认 CLI 已登录并刷新。"
                        }
                        .into(),
                    )
                } else if report
                    .as_ref()
                    .is_some_and(|value| value.windows.is_empty())
                {
                    Some("这个后端不提供套餐限流窗口。".into())
                } else {
                    None
                };
                UsageAccount {
                    agent: account.agent,
                    account_id: Some(account.id),
                    account_name: Some(account.name),
                    source: Some(source),
                    available,
                    report: report.unwrap_or_else(|| UsageReport {
                        windows: Vec::new(),
                        ..Default::default()
                    }),
                    reason,
                }
            }
        });
        let (mut accounts, native_codex) = tokio::join!(
            futures_util::future::join_all(account_futures),
            super::usage::read_native_codex_usage(data_dir),
        );
        match native_codex {
            Ok(Some(report)) => {
                accounts.push(UsageAccount {
                    agent: crate::protocol::AgentKind::Codex,
                    account_id: Some(super::usage::NATIVE_CODEX_ID.into()),
                    account_name: Some("本机默认".into()),
                    source: Some("subscription".into()),
                    available: true,
                    reason: if report.windows.is_empty() {
                        Some("这个后端不提供套餐限流窗口。".into())
                    } else {
                        None
                    },
                    report,
                });
            }
            Ok(None) => {
                accounts.push(UsageAccount {
                    agent: crate::protocol::AgentKind::Codex,
                    account_id: Some(super::usage::NATIVE_CODEX_ID.into()),
                    account_name: Some("本机默认".into()),
                    source: Some("unknown".into()),
                    available: false,
                    report: UsageReport {
                        windows: Vec::new(),
                        ..Default::default()
                    },
                    reason: Some("暂时读不到账号额度，请确认 Codex CLI 已登录并刷新。".into()),
                });
            }
            Err(Error::Feature(code, _)) if code == "agent_unavailable" => {}
            Err(_) => {
                accounts.push(UsageAccount {
                    agent: crate::protocol::AgentKind::Codex,
                    account_id: Some(super::usage::NATIVE_CODEX_ID.into()),
                    account_name: Some("本机默认".into()),
                    source: Some("unknown".into()),
                    available: false,
                    report: UsageReport {
                        windows: Vec::new(),
                        ..Default::default()
                    },
                    reason: Some("暂时读不到账号额度，请确认 Codex CLI 已登录并刷新。".into()),
                });
            }
        }
        accounts.sort_by(|a, b| {
            let score = |account: &UsageAccount| -> f64 {
                if !account.available {
                    return -1.0;
                }
                account
                    .report
                    .windows
                    .iter()
                    .map(|window| window.utilization)
                    .fold(0.0, f64::max)
            };
            score(b)
                .partial_cmp(&score(a))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(accounts)
    }

    /// Current collaboration mode (`default`/`plan`).
    pub async fn mode(&self, id: &str) -> Result<PermissionMode> {
        let id = id.to_owned();
        self.0
            .database
            .call(move |store| Ok(store.agent_run(&id)?.mode))
            .await
    }

    pub async fn set_approval_policy(&self, id: &str, policy: ApprovalPolicy) -> Result<()> {
        let id = id.to_owned();
        self.0
            .database
            .call({
                let id = id.clone();
                move |store| store.set_approval_policy(&id, policy)
            })
            .await?;
        if policy == ApprovalPolicy::Auto
            && let Ok(entry) = self.session_entry(&id).await
        {
            let pending = {
                let guard = entry.handle.lock().await;
                if let Some(handle) = guard.as_ref() {
                    let replies = std::mem::take(&mut *handle.replies.lock().await);
                    let mut records = handle.records.lock().await;
                    let has_questions = !handle.questions.lock().await.is_empty();
                    replies
                        .into_iter()
                        .map(|(request_id, reply)| (reply, records.remove(&request_id)))
                        .collect::<Vec<_>>()
                        .into_iter()
                        .map(|pending| (pending, has_questions))
                        .collect::<Vec<_>>()
                } else {
                    Vec::new()
                }
            };
            let resolved_any = !pending.is_empty();
            let has_questions = pending
                .first()
                .map(|(_, has_questions)| *has_questions)
                .unwrap_or(false);
            for ((reply, record_id), _) in pending {
                let _ = reply.send(true);
                if let Some(record_id) = record_id {
                    let result = self
                        .0
                        .database
                        .call({
                            let id = id.clone();
                            move |store| store.resolve_agent_permission(&id, &record_id)
                        })
                        .await;
                    if !matches!(result, Err(Error::NotFound)) {
                        result?;
                    }
                }
            }
            if resolved_any {
                self.set_status(
                    &id,
                    if has_questions {
                        SessionStatus::WaitingInput
                    } else {
                        SessionStatus::Running
                    },
                )
                .await?;
                return Ok(());
            }
        }
        self.publish();
        Ok(())
    }

    /// Switch the collaboration mode. The change applies to the next turn;
    /// a turn already running keeps the mode it started with.
    pub async fn set_mode(&self, id: &str, mode: PermissionMode) -> Result<()> {
        let id = id.to_owned();
        self.0
            .database
            .call(move |store| {
                if mode == PermissionMode::Plan && store.agent_run(&id)?.agent == AgentKind::Pi {
                    return Err(Error::Invalid("Pi Agent 不支持 Plan 模式".into()));
                }
                store.set_agent_mode(&id, mode)
            })
            .await?;
        self.publish();
        Ok(())
    }

    /// In-session model catalog. The catalog itself comes fresh from the
    /// headless `initialize` handshake; currentModel/currentEffort are the
    /// session's persisted selection.
    pub async fn models(&self, id: &str) -> Result<AgentModelCatalog> {
        let id = id.to_owned();
        let id_for_run = id.clone();
        let run = self
            .0
            .database
            .call(move |store| store.agent_run(&id_for_run))
            .await?;
        if !run.active {
            return Err(Error::Conflict);
        }
        if run.agent == AgentKind::Deepseek {
            let workspace = {
                let id = id.clone();
                self.0
                    .database
                    .call(move |store| Ok(store.session(&id)?.workspace))
                    .await?
            };
            if let Ok(entry) = self.session_entry(&id).await {
                let guard = entry.handle.lock().await;
                if let Some(handle) = guard.as_ref()
                    && let Some(catalog) = handle.driver.lock().await.models(&workspace).await
                {
                    return catalog;
                }
            }
            if run.agent == AgentKind::Deepseek {
                return super::deepseek::session_catalog(
                    &workspace,
                    run.native_id.as_deref(),
                    run.model.as_deref(),
                    run.effort.as_deref(),
                )
                .await;
            }
        }
        let effective_env_account = run.account_id.clone().or_else(|| {
            (run.agent == AgentKind::Claude).then(|| crate::accounts::NATIVE_CLAUDE_ID.to_owned())
        });
        let environment =
            Self::account_environment(&self.0.database, effective_env_account).await?;
        // Profile sessions expose the pinned model only.
        if let Some(id) = run.account_id.as_deref()
            && !matches!(
                id,
                crate::accounts::NATIVE_CLAUDE_ID
                    | crate::agent::NATIVE_CODEX_ID
                    | crate::accounts::NATIVE_PI_ID
                    | crate::accounts::NATIVE_AGY_ID
            )
        {
            let data = self.0.database.directory().to_owned();
            let id = id.to_owned();
            let profile = self
                .0
                .database
                .call(move |store| Ok(store.managed_snapshot_row(&data, &id)?.api_profile))
                .await?;
            if let Some(profile) = profile {
                return Ok(profile_model_catalog(profile, run.effort));
            }
        }
        if run.agent == AgentKind::Opencode {
            let workspace = {
                let id = id.clone();
                self.0
                    .database
                    .call(move |store| Ok(store.session(&id)?.workspace))
                    .await?
            };
            if let Ok(entry) = self.session_entry(&id).await {
                let guard = entry.handle.lock().await;
                if let Some(handle) = guard.as_ref()
                    && let Some(catalog) = handle.driver.lock().await.models(&workspace).await
                {
                    return catalog;
                }
            }
        }
        let models = if run.agent == AgentKind::Codex {
            match run.account_id.as_deref() {
                Some(acct_id) if acct_id != super::usage::NATIVE_CODEX_ID => {
                    super::usage::read_codex_models_for_account(
                        self.0.database.directory(),
                        acct_id,
                    )
                    .await?
                    .models
                }
                _ => {
                    super::usage::read_native_codex_models(self.0.database.directory())
                        .await?
                        .models
                }
            }
        } else if run.agent == AgentKind::Pi {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
            super::pi::launch_catalog(Path::new(&home), &environment)
                .await?
                .models
        } else if run.agent == AgentKind::Agy {
            super::agy::launch_catalog().await?.models
        } else {
            super::claude::fetch_launch_catalog(&environment).await?
        };
        let (run_model, run_effort) = if run.agent == AgentKind::Agy {
            let (m, e, _) = super::agy::resolve_cli_model_and_effort(
                run.model.as_deref(),
                run.effort.as_deref(),
            );
            (m, e)
        } else {
            (run.model, run.effort)
        };
        let current_model = run_model.or_else(|| models.first().map(|model| model.id.clone()));
        Ok(AgentModelCatalog {
            models,
            current_model,
            current_effort: run_effort,
        })
    }

    /// Switch the session's model/effort. Validated against the fresh
    /// catalog, persisted for every later chained turn, and forwarded to a
    /// live turn through the CLI control channel.
    pub async fn set_model(
        &self,
        id: &str,
        model: String,
        effort: Option<String>,
    ) -> Result<AgentModelSelectionResult> {
        crate::database::validate_id(id)?;
        let effort = effort
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if model.trim().is_empty()
            || model.chars().count() > 300
            || model.chars().any(|c| c.is_control())
        {
            return Err(Error::Invalid("模型无效".into()));
        }
        if let Some(effort) = &effort
            && (effort.chars().count() > 80 || effort.chars().any(|c| c.is_control()))
        {
            return Err(Error::Invalid("思考强度无效".into()));
        }
        let id_for_env = id.to_owned();
        let run = self
            .0
            .database
            .call(move |store| store.agent_run(&id_for_env))
            .await?;
        let account_id = run.account_id.clone();
        if run.agent == AgentKind::Deepseek {
            if account_id.is_some() {
                return Err(Error::Invalid(
                    "DeepSeek Harness 使用本机 dsh 账号，不支持绑定 Prospero 账号".into(),
                ));
            }
            let catalog = self.models(id).await?;
            let selected = catalog
                .models
                .iter()
                .find(|entry| entry.id == model)
                .ok_or_else(|| Error::Invalid(format!("DeepSeek 模型不可用:{model}")))?;
            if let Some(effort) = &effort
                && !selected
                    .supported_efforts
                    .iter()
                    .any(|level| level == effort)
            {
                return Err(Error::Invalid(format!("{model} 不支持推理强度 {effort}")));
            }
            let id_owned = id.to_owned();
            let model_owned = model.clone();
            let effort_owned = effort.clone();
            let (model, effort) = self
                .0
                .database
                .call(move |store| {
                    store.set_agent_selection(&id_owned, &model_owned, effort_owned.as_deref())
                })
                .await?;
            if let Ok(entry) = self.session_entry(id).await {
                let guard = entry.handle.lock().await;
                if let Some(handle) = guard.as_ref() {
                    match handle
                        .driver
                        .lock()
                        .await
                        .apply_selection(&model, effort.as_deref())
                        .await
                    {
                        Ok(()) | Err(Error::Closed) => {}
                        Err(error) => return Err(error),
                    }
                }
            }
            self.publish();
            return Ok(AgentModelSelectionResult {
                current_model: model,
                current_effort: effort,
            });
        }
        let effective_env_account = account_id.clone().or_else(|| {
            (run.agent == AgentKind::Claude).then(|| crate::accounts::NATIVE_CLAUDE_ID.to_owned())
        });
        let environment =
            Self::account_environment(&self.0.database, effective_env_account).await?;
        // Profile sessions expose only the pinned model and never switch.
        if let Some(id) = account_id
            && !matches!(
                id.as_str(),
                crate::accounts::NATIVE_CLAUDE_ID
                    | crate::agent::NATIVE_CODEX_ID
                    | crate::accounts::NATIVE_PI_ID
                    | crate::accounts::NATIVE_AGY_ID
            )
        {
            let data = self.0.database.directory().to_owned();
            let profile = self
                .0
                .database
                .call(move |store| Ok(store.managed_snapshot_row(&data, &id)?.api_profile))
                .await?;
            if profile.is_some() {
                return Err(Error::Invalid(
                    "第三方 API Profile 的模型由 Profile 固定，无法在会话内切换".into(),
                ));
            }
        }
        let catalog = if run.agent == AgentKind::Codex {
            match run.account_id.as_deref() {
                Some(acct_id) if acct_id != super::usage::NATIVE_CODEX_ID => {
                    super::usage::read_codex_models_for_account(
                        self.0.database.directory(),
                        acct_id,
                    )
                    .await?
                    .models
                }
                _ => {
                    super::usage::read_native_codex_models(self.0.database.directory())
                        .await?
                        .models
                }
            }
        } else if run.agent == AgentKind::Pi {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
            super::pi::launch_catalog(Path::new(&home), &environment)
                .await?
                .models
        } else if run.agent == AgentKind::Agy {
            super::agy::launch_catalog().await?.models
        } else {
            super::claude::fetch_launch_catalog(&environment).await?
        };
        let (model, effort) =
            if run.agent == AgentKind::Agy && catalog.iter().all(|entry| entry.id != model) {
                let (norm_model, norm_effort, _) =
                    super::agy::resolve_cli_model_and_effort(Some(&model), effort.as_deref());
                (norm_model.unwrap_or(model), norm_effort.or(effort))
            } else {
                (model, effort)
            };
        let selected = catalog
            .iter()
            .find(|entry| entry.id == model)
            .ok_or_else(|| {
                Error::Invalid(format!(
                    "{} 模型不可用:{model}",
                    match run.agent {
                        AgentKind::Codex => "Codex",
                        AgentKind::Pi => "Pi",
                        AgentKind::Agy => "Antigravity",
                        _ => "Claude",
                    }
                ))
            })?;
        if let Some(effort) = &effort
            && !selected
                .supported_efforts
                .iter()
                .any(|level| level == effort)
        {
            return Err(Error::Invalid(format!("{model} 不支持推理强度 {effort}")));
        }
        let id_owned = id.to_owned();
        let model_owned = model.clone();
        let effort_owned = effort.clone();
        let (model, effort) = self
            .0
            .database
            .call(move |store| {
                store.set_agent_selection(&id_owned, &model_owned, effort_owned.as_deref())
            })
            .await?;

        // Forward to a running turn. A closed pipe means the turn is already
        // ending; the persisted selection still applies to the next turn.
        if let Ok(entry) = self.session_entry(id).await {
            let guard = entry.handle.lock().await;
            if let Some(handle) = guard.as_ref() {
                match handle
                    .driver
                    .lock()
                    .await
                    .apply_selection(&model, effort.as_deref())
                    .await
                {
                    Ok(()) | Err(Error::Closed) => {}
                    Err(error) => return Err(error),
                }
            }
        }
        self.publish();
        Ok(AgentModelSelectionResult {
            current_model: model,
            current_effort: effort,
        })
    }

    /// Active sessions' model/mode control flags for the desktop projection.
    pub async fn controls(&self) -> Result<AgentControlsProjection> {
        let controls = self.0.database.call(|store| store.agent_controls()).await?;
        Ok(AgentControlsProjection { controls })
    }

    /// Send a direct follow-up prompt to a live Codex subagent thread.
    pub async fn send_to_subagent(&self, id: &str, subagent: &str, text: String) -> Result<()> {
        crate::database::validate_id(id)?;
        crate::database::validate_id(subagent)?;
        crate::database::validate_text(&text, 65_536, false)?;
        let subagent_id = subagent.to_owned();
        let snapshot = {
            let id = id.to_owned();
            let subagent = subagent_id.clone();
            self.0
                .database
                .call(move |store| store.subagent_snapshot(&id, &subagent))
                .await?
        };
        if !snapshot.subagent.can_message {
            return Err(Error::Conflict);
        }
        let entry = self.session_entry(id).await?;
        let guard = entry.handle.lock().await;
        let handle = guard.as_ref().ok_or(Error::Conflict)?;
        handle
            .driver
            .lock()
            .await
            .send_to_subagent(&subagent_id, &text)
            .await
            .map(|_| ())
    }

    /// On-demand transcript for a Task-tool subagent's "查看执行详情" pane.
    pub async fn subagent_snapshot(
        &self,
        id: &str,
        subagent: &str,
    ) -> Result<crate::agent::SubagentSnapshot> {
        crate::database::validate_id(id)?;
        crate::database::validate_id(subagent)?;
        let mut snapshot = {
            let id = id.to_owned();
            let subagent = subagent.to_owned();
            self.0
                .database
                .call(move |store| store.subagent_snapshot(&id, &subagent))
                .await?
        };

        let native = match self.session_entry(id).await {
            Ok(entry) => {
                let handle = entry.handle.lock().await.clone();
                if let Some(handle) = handle {
                    handle
                        .driver
                        .lock()
                        .await
                        .read_subagent_history(subagent)
                        .await
                        .ok()
                        .flatten()
                } else {
                    self.read_codex_subagent_history_once(id, subagent).await
                }
            }
            Err(_) => None,
        };
        if let Some(native) = native
            && !native.is_empty()
        {
            let mut events = native;
            events.extend(
                snapshot
                    .events
                    .iter()
                    .filter(|event| {
                        matches!(
                            event.get("kind").and_then(serde_json::Value::as_str),
                            Some(
                                "permission.request"
                                    | "permission.resolved"
                                    | "permission.auto"
                                    | "question.request"
                                    | "question.resolved"
                            )
                        )
                    })
                    .cloned(),
            );
            snapshot.events = events;
        }
        Ok(snapshot)
    }

    async fn read_codex_subagent_history_once(
        &self,
        id: &str,
        subagent: &str,
    ) -> Option<Vec<serde_json::Value>> {
        let (workspace, parent) = {
            let id = id.to_owned();
            self.0
                .database
                .call(move |store| {
                    let run = store.agent_run(&id)?;
                    if run.agent != AgentKind::Codex {
                        return Ok(None);
                    }
                    let Some(parent) = run.native_id else {
                        return Ok(None);
                    };
                    let workspace = store.session(&id)?.workspace;
                    Ok(Some((workspace, parent)))
                })
                .await
                .ok()
                .flatten()?
        };
        super::codex::read_subagent_history_once(
            self.0.database.directory(),
            &workspace,
            &parent,
            subagent,
        )
        .await
        .ok()
        .flatten()
    }

    pub async fn interrupt(&self, id: &str) -> Result<()> {
        let entry = self.session_entry(id).await?;
        let guard = entry.handle.lock().await;
        let handle = guard.as_ref().ok_or(Error::NotFound)?;
        // Any unresolved approvals are rejected and pending questions are
        // denied when the turn is interrupted.
        let pending: Vec<_> = std::mem::take(&mut *handle.replies.lock().await)
            .into_iter()
            .collect();
        std::mem::take(&mut *handle.questions.lock().await);
        std::mem::take(&mut *handle.records.lock().await);
        for (_request_id, reply) in pending {
            // The translator's reply task writes the deny frame.
            let _ = reply.send(false);
        }
        drop(guard);
        let resolved = {
            let id = id.to_owned();
            self.0
                .database
                .call(move |store| store.resolve_all_agent_requests(&id))
                .await?
        };
        if resolved > 0 {
            self.publish();
        }
        // Tell the CLI to stop after it finishes the current response.
        let entry = self.session_entry(id).await?;
        if let Some(handle) = entry.handle.lock().await.as_ref() {
            match handle.driver.lock().await.interrupt().await {
                ControlEffectState::Received | ControlEffectState::Delivered => {}
                ControlEffectState::Unknown => return Err(Error::Timeout),
                ControlEffectState::Failed => return Err(Error::Closed),
                ControlEffectState::None => return Err(Error::Conflict),
            }
        }
        Ok(())
    }

    pub async fn archive(&self, id: &str) -> Result<SessionHead> {
        let sid = id.to_owned();
        self.0
            .database
            .call(move |store| {
                let head = store.session(&sid)?;
                let run = store.agent_run(&sid)?;
                store.set_native_session(
                    &sid,
                    NativeSession {
                        output_start_seq: None,
                        runtime_id: head
                            .native_session
                            .map(|n| n.runtime_id)
                            .unwrap_or_else(|| sid.clone()),
                        native_id: run.native_id,
                        managed: true,
                        state: "archiving".into(),
                        error: None,
                    },
                )
            })
            .await?;
        let result = self.close(id).await;
        let sid = id.to_owned();
        match result {
            Ok(()) => {
                self.0
                    .database
                    .call(move |store| store.set_native_state(&sid, "archived", None))
                    .await
            }
            Err(error) => {
                let detail = error.to_string();
                self.0
                    .database
                    .call(move |store| store.set_native_state(&sid, "failed", Some(detail)))
                    .await?;
                Err(error)
            }
        }
    }

    pub async fn resume(&self, id: &str) -> Result<SessionHead> {
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let mut entries = self.0.entries.lock().await;
        if entries.contains_key(id) {
            return Err(Error::Conflict);
        }
        let sid = id.to_owned();
        let head = self
            .0
            .database
            .call(move |store| store.resume_archived_agent(&sid))
            .await?;
        entries.insert(
            id.to_owned(),
            Arc::new(Session {
                execution_unknown: AtomicBool::new(false),
                handle: Mutex::new(None),
                usage: Mutex::new(UsageReport {
                    windows: Vec::new(),
                    ..Default::default()
                }),
                draining: Mutex::new(()),
                permit: Mutex::new(None),
            }),
        );
        self.sync_entry_count(&entries);
        drop(entries);
        self.publish();
        Ok(head)
    }

    pub async fn close(&self, id: &str) -> Result<()> {
        let entry = self.session_entry(id).await.ok();
        let _drain = match entry.as_ref() {
            Some(entry) => Some(entry.draining.lock().await),
            None => None,
        };
        let handle = match entry.as_ref() {
            Some(entry) => Some(entry.handle.lock().await),
            None => None,
        };
        let local_idle = handle.as_ref().is_some_and(|handle| handle.is_none());
        let previous_memory = entry
            .as_ref()
            .is_some_and(|entry| entry.execution_unknown.swap(true, Ordering::AcqRel));
        let archived = id.to_owned();
        let stop_intent = self
            .0
            .database
            .call_control("agent.close", move |store| {
                let stopped = store.agent_execution_stopped(&archived)?;
                let previous = store.archive_agent_session_for_stop(&archived, true)?;
                Ok((previous, stopped))
            })
            .await;
        let (previous_unknown, previously_stopped) = match stop_intent {
            Ok(intent) => intent,
            Err(error) => {
                if local_idle
                    && !previous_memory
                    && let Some(entry) = entry.as_ref()
                {
                    entry.execution_unknown.store(false, Ordering::Release);
                }
                return Err(error);
            }
        };
        drop(handle);
        let known_idle = (local_idle && previously_stopped)
            || (!previous_memory && !previous_unknown && (local_idle || previously_stopped));
        self.finish_close(id, false, known_idle).await
    }

    /// Expire only an idle worker with an overdue, still-live dispatch. The
    /// database claim checks the state again so a concurrent follow-up or
    /// explicit delivery cannot be cut off by the health monitor.
    pub async fn close_stale_idle_worker(
        &self,
        id: &str,
        stale_before: i64,
    ) -> Result<Option<Vec<String>>> {
        let entry = self.session_entry(id).await.ok();
        let _drain = match entry.as_ref() {
            Some(entry) => Some(entry.draining.lock().await),
            None => None,
        };
        let handle = match entry.as_ref() {
            Some(entry) => Some(entry.handle.lock().await),
            None => None,
        };
        let local_idle = handle.as_ref().is_some_and(|handle| handle.is_none());
        let previous_memory = entry
            .as_ref()
            .is_some_and(|entry| entry.execution_unknown.load(Ordering::Acquire));
        let session_id = id.to_owned();
        let (previous_unknown, run_ids) = self
            .0
            .database
            .call_control("worker.idle_timeout", move |store| {
                let previous = store.agent_execution_unknown(&session_id)?;
                let run_ids = store.archive_stale_idle_worker_session(&session_id, stale_before)?;
                Ok((previous, run_ids))
            })
            .await?;
        if run_ids.is_some() {
            if let Some(entry) = entry.as_ref() {
                entry.execution_unknown.store(true, Ordering::Release);
            }
            drop(handle);
            self.finish_close(
                id,
                true,
                local_idle && !previous_memory && !previous_unknown,
            )
            .await?;
        }
        Ok(run_ids)
    }

    async fn finish_close(&self, id: &str, idle_timeout: bool, known_idle: bool) -> Result<()> {
        let session_id = id.to_owned();
        let execution_unknown = self
            .0
            .database
            .call_control("agent.close", move |store| {
                store.agent_execution_unknown(&session_id)
            })
            .await?;
        if let Ok(entry) = self.session_entry(id).await {
            let execution_unknown =
                execution_unknown || entry.execution_unknown.load(Ordering::Acquire);
            let handle = { entry.handle.lock().await.as_ref().cloned() };
            if let Some(handle) = handle {
                let pending = std::mem::take(&mut *handle.replies.lock().await);
                // Dropping pending question senders makes the translator
                // answer deny; no explicit send needed.
                std::mem::take(&mut *handle.questions.lock().await);
                for (_request_id, reply) in pending {
                    // The translator's reply task owns the deny frame; sending
                    // here is enough, calling driver.respond_permission too
                    // would write the frame twice.
                    let _ = reply.send(false);
                }
                let lifecycle = {
                    let driver = handle.driver.lock().await;
                    driver.lifecycle()
                };
                let stop_effect = handle.driver.lock().await.terminate().await;
                let mut turn_finished = handle.turn_finished.subscribe();
                let (process_exit, turn_quiescence) = tokio::join!(
                    lifecycle.await_quiescence(Duration::from_secs(3)),
                    wait_for_quiescence(&mut turn_finished, Duration::from_secs(3)),
                );
                if !process_exit.permits_direct_release() || !turn_quiescence {
                    entry.execution_unknown.store(true, Ordering::Release);
                    if let Some(permit) = handle.permit.lock().await.take() {
                        *entry.permit.lock().await = Some(permit);
                    }
                    let session_id = id.to_owned();
                    self.0
                        .database
                        .call_control("agent.exit_unknown", move |store| {
                            store.mark_agent_execution_unknown(&session_id)
                        })
                        .await?;
                    return Err(Error::Timeout);
                }
                let session_id = id.to_owned();
                self.0
                    .database
                    .call_control("agent.exit_confirmed", move |store| {
                        store.clear_agent_execution_unknown(&session_id)
                    })
                    .await?;
                entry.execution_unknown.store(false, Ordering::Release);
                handle.quiesced.send_replace(true);
                handle.permit.lock().await.take();
                let _ = stop_effect;
                let mut slot = entry.handle.lock().await;
                if slot
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &handle))
                {
                    slot.take();
                }
            } else if known_idle {
                let session_id = id.to_owned();
                self.0
                    .database
                    .call_control("agent.exit_confirmed", move |store| {
                        store.clear_agent_execution_unknown(&session_id)
                    })
                    .await?;
                entry.execution_unknown.store(false, Ordering::Release);
            } else if execution_unknown {
                return Err(Error::Feature(
                    "driver_exit_unknown".into(),
                    "Executor exit requires reconciliation".into(),
                ));
            }
            entry.permit.lock().await.take();
            self.remove_entry(id).await;
            self.0.execution_environment.lock().await.remove(id);
        } else if known_idle {
            let session_id = id.to_owned();
            self.0
                .database
                .call_control("agent.exit_confirmed", move |store| {
                    store.clear_agent_execution_unknown(&session_id)
                })
                .await?;
        } else if execution_unknown {
            return Err(Error::Feature(
                "driver_exit_unknown".into(),
                "Executor exit requires reconciliation".into(),
            ));
        }
        let archived = id.to_owned();
        self.0
            .database
            .call_control("dispatch.reconcile", move |store| {
                if idle_timeout {
                    store.reconcile_stale_idle_worker_session(&archived)
                } else {
                    store.reconcile_dispatch_session(&archived)
                }
            })
            .await?;
        let sid = id.to_owned();
        self.0
            .database
            .call(move |store| {
                let head = store.session(&sid)?;
                let lifecycle = head.lifecycle;
                let run_native_id = store.agent_run(&sid)?.native_id;
                if let Some(mut native) = head.native_session.filter(|native| {
                    native.state == "archiving"
                        || (lifecycle == SessionLifecycle::Archived && native.state == "failed")
                }) {
                    native.native_id = run_native_id.or(native.native_id);
                    native.state = "archived".into();
                    native.error = None;
                    store.set_native_session(&sid, native)?;
                }
                Ok(())
            })
            .await?;
        self.publish();
        Ok(())
    }

    /// Reclaim a quiesced archived session only after durable stop proof.
    /// This also covers a close whose first attempt timed out while the turn
    /// was still unwinding.
    async fn release_confirmed_archived_idle(&self, id: &str) -> Result<bool> {
        let session_id = id.to_owned();
        let stopped = self
            .0
            .database
            .call_control("agent.quiesced_archive", move |store| {
                store.agent_execution_stopped(&session_id)
            })
            .await?;
        if !stopped {
            return Ok(false);
        }
        if let Ok(entry) = self.session_entry(id).await
            && entry.handle.lock().await.is_some()
        {
            return Ok(false);
        }
        self.finish_close(id, false, true).await?;
        Ok(true)
    }

    async fn reap_confirmed_archived_idle_batch(
        &self,
        after: Option<&str>,
        limit: usize,
    ) -> (Option<String>, usize) {
        let mut ids = self
            .0
            .entries
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        ids.sort();
        let start = after
            .map(|cursor| ids.partition_point(|id| id.as_str() <= cursor))
            .unwrap_or(0);
        let scan = ids[start..]
            .iter()
            .chain(ids[..start].iter())
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let next = scan.last().cloned();
        let mut reclaimed = 0;
        for id in scan {
            match self.release_confirmed_archived_idle(&id).await {
                Ok(true) => reclaimed += 1,
                Ok(false) => {}
                Err(error) => self.0.database.record_recent_error(
                    "agent.quiesced_archive",
                    "agent_sessions",
                    &error.to_string(),
                ),
            }
        }
        (next, reclaimed)
    }

    /// Archive runs left active by a previous daemon process. The provider
    /// process is gone with that daemon, so turns are never replayed.
    pub async fn recover(&self) -> Result<usize> {
        let unknown: Vec<String> = self.0.database.call_control("agent.recover", |store| {
            let mut statement = store.connection.prepare("SELECT session_id FROM agent_runs WHERE execution_unknown=1 ORDER BY session_id")?;
            let ids = statement.query_map([], |row| row.get(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(ids)
        }).await?;
        for id in unknown {
            let mut entries = self.0.entries.lock().await;
            if entries.contains_key(&id) {
                continue;
            }
            let permit = match self.0.slots.clone().try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    self.0.closed.store(true, Ordering::Release);
                    return Err(Error::Feature(
                        "driver_exit_unknown".into(),
                        "Unresolved executor occupancy exceeds capacity".into(),
                    ));
                }
            };
            entries.insert(
                id,
                Arc::new(Session {
                    execution_unknown: AtomicBool::new(true),
                    handle: Mutex::new(None),
                    usage: Mutex::new(UsageReport::default()),
                    draining: Mutex::new(()),
                    permit: Mutex::new(Some(permit)),
                }),
            );
            self.sync_entry_count(&entries);
        }
        let _ = super::codex::cleanup_stale_app_servers(self.0.database.directory()).await;
        let ids: Vec<String> = self
            .0
            .database
            .call_control("agent.close", |store| {
                let mut statement = store.connection.prepare(
                    "SELECT session_id FROM agent_runs WHERE active=1 AND execution_unknown=0 ORDER BY session_id",
                )?;
                let ids = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(ids)
            })
            .await?;
        for id in &ids {
            let id = id.clone();
            self.0
                .database
                .call_control("agent.close", move |store| {
                    store.archive_agent_session(&id, true)
                })
                .await?;
        }
        Ok(ids.len())
    }

    pub async fn attachment_chunk(
        &self,
        id: &str,
        message_id: &str,
        attachment_id: &str,
        offset: u64,
        length: usize,
    ) -> Result<Option<AttachmentChunk>> {
        crate::database::validate_id(id)?;
        crate::timeline::validate_record_id(message_id)?;
        crate::timeline::validate_record_id(attachment_id)?;
        if length == 0 || length > 1024 * 1024 {
            return Err(Error::Invalid("附件读取长度无效".into()));
        }
        let record = {
            let id = id.to_owned();
            let message_id = message_id.to_owned();
            self.0
                .database
                .call(move |store| store.timeline_record(&id, &message_id))
                .await?
        };
        let attachment = match record.body {
            TimelineBody::Message { attachments, .. } => attachments
                .into_iter()
                .find(|attachment| attachment.id == attachment_id),
            _ => None,
        };
        let Some(attachment) = attachment else {
            return Ok(None);
        };
        let path = attachment_path(self.0.database.directory(), id, message_id, attachment_id)?;
        let mime_type = attachment.mime_type;
        tokio::task::spawn_blocking(move || {
            let Ok(metadata) = std::fs::metadata(&path) else {
                return Ok(None);
            };
            if !metadata.is_file() {
                return Ok(None);
            }
            let total = metadata.len();
            if offset >= total {
                return Ok(Some(AttachmentChunk {
                    mime_type,
                    data_b64: String::new(),
                    total: total.min(i64::MAX as u64) as i64,
                    eof: true,
                }));
            }
            let want = length.min((total - offset).min(1024 * 1024) as usize);
            use std::io::{Read, Seek};
            let mut file = std::fs::File::open(path)?;
            file.seek(std::io::SeekFrom::Start(offset))?;
            let mut buffer = vec![0; want];
            let read = file.read(&mut buffer)?;
            buffer.truncate(read);
            Ok(Some(AttachmentChunk {
                mime_type,
                data_b64: BASE64_STANDARD.encode(buffer),
                total: total.min(i64::MAX as u64) as i64,
                eof: offset + read as u64 >= total,
            }))
        })
        .await
        .map_err(|_| Error::Closed)?
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.0.closed.store(true, Ordering::Release);
        let sessions: Vec<(String, Arc<Session>)> = self
            .0
            .entries
            .lock()
            .await
            .iter()
            .map(|(id, session)| (id.clone(), session.clone()))
            .collect();
        let mut all_confirmed = true;
        for (session_id, session) in &sessions {
            let _drain = session.draining.lock().await;
            let slot = session.handle.lock().await;
            let handle = slot.as_ref().cloned();
            let previous_memory = session.execution_unknown.swap(true, Ordering::AcqRel);
            let id = session_id.clone();
            let stop_intent = self
                .0
                .database
                .call_control("agent.shutdown", move |store| {
                    let previous = store.agent_execution_unknown(&id)?;
                    store.mark_agent_execution_unknown(&id)?;
                    Ok(previous)
                })
                .await;
            let previous_unknown = match stop_intent {
                Ok(previous) => previous,
                Err(error) => {
                    if handle.is_none() && !previous_memory {
                        session.execution_unknown.store(false, Ordering::Release);
                    }
                    return Err(error);
                }
            };
            let execution_unknown = previous_unknown || previous_memory;
            drop(slot);
            if let Some(handle) = handle {
                let pending = std::mem::take(&mut *handle.replies.lock().await);
                std::mem::take(&mut *handle.questions.lock().await);
                for (_request_id, reply) in pending {
                    // See close(): the translator task writes the deny frame.
                    let _ = reply.send(false);
                }
                let lifecycle = {
                    let driver = handle.driver.lock().await;
                    driver.lifecycle()
                };
                let stop_effect = handle.driver.lock().await.terminate().await;
                let mut turn_finished = handle.turn_finished.subscribe();
                let (process_exit, turn_quiescence) = tokio::join!(
                    lifecycle.await_quiescence(Duration::from_secs(3)),
                    wait_for_quiescence(&mut turn_finished, Duration::from_secs(3)),
                );
                if process_exit.permits_direct_release() && turn_quiescence {
                    let id = session_id.clone();
                    self.0
                        .database
                        .call_control("agent.exit_confirmed", move |store| {
                            store.clear_agent_execution_unknown(&id)
                        })
                        .await?;
                    session.execution_unknown.store(false, Ordering::Release);
                    handle.quiesced.send_replace(true);
                    handle.permit.lock().await.take();
                    let mut slot = session.handle.lock().await;
                    if slot
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &handle))
                    {
                        slot.take();
                    }
                    session.permit.lock().await.take();
                } else {
                    session.execution_unknown.store(true, Ordering::Release);
                    if let Some(permit) = handle.permit.lock().await.take() {
                        *session.permit.lock().await = Some(permit);
                    }
                    let id = session_id.clone();
                    self.0
                        .database
                        .call_control("agent.exit_unknown", move |store| {
                            store.mark_agent_execution_unknown(&id)
                        })
                        .await?;
                    all_confirmed = false;
                }
                let _ = stop_effect;
            } else if execution_unknown {
                all_confirmed = false;
            } else {
                let id = session_id.clone();
                self.0
                    .database
                    .call_control("agent.exit_confirmed", move |store| {
                        store.clear_agent_execution_unknown(&id)
                    })
                    .await?;
                session.execution_unknown.store(false, Ordering::Release);
                session.permit.lock().await.take();
            }
        }
        if !all_confirmed {
            return Err(Error::Timeout);
        }
        self.clear_entries().await;
        self.0.execution_environment.lock().await.clear();
        Ok(())
    }
}

/// Cap text persisted with a single streaming rewrite.
async fn wait_for_quiescence(receiver: &mut watch::Receiver<bool>, timeout: Duration) -> bool {
    if *receiver.borrow() {
        return true;
    }
    tokio::time::timeout(timeout, async {
        while !*receiver.borrow_and_update() {
            if receiver.changed().await.is_err() {
                return false;
            }
        }
        true
    })
    .await
    .unwrap_or(false)
}

/// Cap text persisted with a single streaming rewrite (512 KiB UTF-8-safe;
/// `timeline.rs` slices large bodies into 64 KiB storage chunks).
fn bounded_text(mut text: String) -> String {
    const LIMIT: usize = 512 * 1024;
    if text.len() <= LIMIT {
        return text;
    }
    text.truncate(text.floor_char_boundary(LIMIT));
    text
}

#[cfg(test)]
mod persistence_tests {
    use super::*;

    #[tokio::test]
    async fn quiesced_archived_session_releases_runtime_capacity_after_stop_proof() {
        let root = tempfile::tempdir().unwrap();
        let database = Database::open(root.path().join("data")).await.unwrap();
        let agents = Agents::new(database.clone());
        let head = agents
            .create(CreateAgentSession {
                agent: AgentKind::Claude,
                title: "completed worker".into(),
                workspace: root.path().to_string_lossy().into_owned(),
                auto_approve: false,
                mode: None,
                model: None,
                effort: None,
                agent_preset: None,
                account_id: None,
                resume: None,
            })
            .await
            .unwrap();
        let session_id = head.id.clone();
        database
            .call_control("test.archive_during_turn", move |store| {
                store.archive_agent_session_for_stop(&session_id, true)?;
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(agents.count(), 1);
        assert!(
            !agents
                .release_confirmed_archived_idle(&head.id)
                .await
                .unwrap()
        );
        assert_eq!(agents.count(), 1);

        let session_id = head.id.clone();
        database
            .call_control("test.exit_confirmed", move |store| {
                store.clear_agent_execution_unknown(&session_id)
            })
            .await
            .unwrap();
        let (_, reclaimed) = agents.reap_confirmed_archived_idle_batch(None, 8).await;
        assert_eq!(reclaimed, 1);
        assert_eq!(agents.count(), 0);
        assert!(
            agents
                .release_confirmed_archived_idle(&head.id)
                .await
                .unwrap()
        );
        database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn late_status_update_does_not_change_an_archived_session() {
        let root = tempfile::tempdir().unwrap();
        let database = Database::open(root.path().join("data")).await.unwrap();
        let agents = Agents::new(database.clone());
        let head = agents
            .create(CreateAgentSession {
                agent: AgentKind::Claude,
                title: "late status".into(),
                workspace: root.path().to_string_lossy().into_owned(),
                auto_approve: false,
                mode: None,
                model: None,
                effort: None,
                agent_preset: None,
                account_id: None,
                resume: None,
            })
            .await
            .unwrap();
        agents.close(&head.id).await.unwrap();
        assert!(matches!(
            agents
                .set_status(&head.id, SessionStatus::WaitingInput)
                .await,
            Err(Error::Closed)
        ));
        assert!(agents.check().is_ok());
        let current = database
            .read("test.closed_session", move |store| store.session(&head.id))
            .await
            .unwrap();
        assert_eq!(current.lifecycle, SessionLifecycle::Archived);
        assert_eq!(current.status, SessionStatus::Failed);
        database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn idle_close_clears_only_its_new_stop_intent() {
        let root = tempfile::tempdir().unwrap();
        let database = Database::open(root.path().join("data")).await.unwrap();
        let agents = Agents::new(database.clone());
        let create = |title: &str| CreateAgentSession {
            agent: AgentKind::Claude,
            title: title.into(),
            workspace: root.path().to_string_lossy().into_owned(),
            auto_approve: false,
            mode: None,
            model: None,
            effort: None,
            agent_preset: None,
            account_id: None,
            resume: None,
        };
        let idle = agents.create(create("idle")).await.unwrap();
        database.call_control("test.reject_stop", |store| {
            store.connection.execute_batch("CREATE TRIGGER reject_idle_stop BEFORE INSERT ON orch_recovery_jobs WHEN NEW.kind='legacy_session' BEGIN SELECT RAISE(ABORT,'injected failure'); END;")?;
            Ok(())
        }).await.unwrap();
        assert!(agents.close(&idle.id).await.is_err());
        assert_eq!(agents.count(), 1);
        assert!(
            !agents
                .session_entry(&idle.id)
                .await
                .unwrap()
                .execution_unknown
                .load(Ordering::Acquire)
        );
        database
            .call_control("test.allow_stop", |store| {
                store
                    .connection
                    .execute_batch("DROP TRIGGER reject_idle_stop")?;
                Ok(())
            })
            .await
            .unwrap();
        agents.close(&idle.id).await.unwrap();
        agents.close(&idle.id).await.unwrap();
        assert_eq!(agents.count(), 0);
        let closed_id = idle.id.clone();
        assert!(
            database
                .call_control("test.stopped", move |store| store
                    .agent_execution_stopped(&closed_id))
                .await
                .unwrap()
        );
        let unresolved = agents.create(create("unresolved")).await.unwrap();
        let unknown_id = unresolved.id.clone();
        database
            .call_control("test.unknown", move |store| {
                store.mark_agent_execution_unknown(&unknown_id)
            })
            .await
            .unwrap();
        assert!(agents.close(&unresolved.id).await.is_err());
        assert_eq!(agents.count(), 1);
        let unknown_id = unresolved.id.clone();
        assert!(
            database
                .call_control("test.unknown", move |store| store
                    .agent_execution_unknown(&unknown_id))
                .await
                .unwrap()
        );
        assert!(agents.shutdown().await.is_err());
        assert_eq!(agents.count(), 1);
        database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn idle_shutdown_confirms_only_owned_known_idle_sessions() {
        let root = tempfile::tempdir().unwrap();
        let database = Database::open(root.path().join("data")).await.unwrap();
        let agents = Agents::new(database.clone());
        let idle = agents
            .create(CreateAgentSession {
                agent: AgentKind::Claude,
                title: "idle shutdown".into(),
                workspace: root.path().to_string_lossy().into_owned(),
                auto_approve: false,
                mode: None,
                model: None,
                effort: None,
                agent_preset: None,
                account_id: None,
                resume: None,
            })
            .await
            .unwrap();
        agents.shutdown().await.unwrap();
        assert_eq!(agents.count(), 0);
        assert!(
            !database
                .call_control("test.unknown", move |store| store
                    .agent_execution_unknown(&idle.id))
                .await
                .unwrap()
        );
        database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn closing_a_never_created_session_reports_not_found_without_unknown_occupancy() {
        let root = tempfile::tempdir().unwrap();
        let database = Database::open(root.path().join("data")).await.unwrap();
        let agents = Agents::new(database.clone());
        assert!(matches!(
            agents.close("never-created").await,
            Err(Error::NotFound)
        ));
        assert_eq!(agents.count(), 0);
        let responsibilities: i64 = database
            .call_control("test.no_session", |store| {
                Ok(store.connection.query_row(
                    "SELECT count(*) FROM orch_recovery_jobs WHERE kind='legacy_session'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .await
            .unwrap();
        assert_eq!(responsibilities, 0);
        database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn finish_close_converges_timed_out_failed_archive_native_state() {
        let root = tempfile::tempdir().unwrap();
        let database = Database::open(root.path().join("data")).await.unwrap();
        let agents = Agents::new(database.clone());
        let head = agents
            .create(CreateAgentSession {
                agent: AgentKind::Claude,
                title: "timed out archive".into(),
                workspace: root.path().to_string_lossy().into_owned(),
                auto_approve: false,
                mode: None,
                model: None,
                effort: None,
                agent_preset: None,
                account_id: None,
                resume: None,
            })
            .await
            .unwrap();
        let session_id = head.id.clone();
        database
            .call_control("test.archive_timed_out", move |store| {
                store.begin_agent_turn(&session_id)?;
                store.set_agent_native_id(&session_id, 1, "native-session-1")?;
                store.set_native_session(
                    &session_id,
                    NativeSession {
                        output_start_seq: None,
                        runtime_id: session_id.clone(),
                        native_id: Some("native-session-1".into()),
                        managed: true,
                        state: "failed".into(),
                        error: Some("Timed out".into()),
                    },
                )?;
                store.archive_agent_session_for_stop(&session_id, true)?;
                store.clear_agent_execution_unknown(&session_id)?;
                Ok(())
            })
            .await
            .unwrap();

        assert!(
            agents
                .release_confirmed_archived_idle(&head.id)
                .await
                .unwrap()
        );
        let current = database
            .read("test.archived_session", move |store| {
                store.session(&head.id)
            })
            .await
            .unwrap();
        let native = current.native_session.unwrap();
        assert_eq!(native.state, "archived");
        assert_eq!(native.native_id.as_deref(), Some("native-session-1"));
        assert_eq!(native.error, None);
        database.shutdown().await.unwrap();
    }

    #[test]
    fn stream_segment_tracker_preserves_pre_and_post_tool_prose_for_block_and_cumulative_drivers() {
        // 1. Per-block driver (Claude / Codex / DeepSeek / OpenCode): resets buffer after tool call.
        let mut block_tracker = StreamSegmentTracker::default();
        assert_eq!(
            block_tracker.resolve("Analyzing...".into(), "turn1-answer"),
            Some(("turn1-answer".into(), "Analyzing...".into()))
        );
        assert_eq!(
            block_tracker.resolve("Analyzing the codebase.".into(), "turn1-answer"),
            Some(("turn1-answer".into(), "Analyzing the codebase.".into()))
        );
        block_tracker.mark_interrupted();
        assert_eq!(
            block_tracker.resolve("Done".into(), "turn1-answer"),
            Some(("turn1-answer-2".into(), "Done".into()))
        );
        assert_eq!(
            block_tracker.resolve("Done fixing!".into(), "turn1-answer"),
            Some(("turn1-answer-2".into(), "Done fixing!".into()))
        );

        // 2. Cumulative driver (Pi / Agy): emits `seg1 + "\n\n" + seg2` after tool call.
        let mut cumulative = StreamSegmentTracker::default();
        assert_eq!(
            cumulative.resolve("Step 1 analysis".into(), "turn1-answer"),
            Some(("turn1-answer".into(), "Step 1 analysis".into()))
        );
        cumulative.mark_interrupted();
        assert_eq!(
            cumulative.resolve("Step 1 analysis\n\nStep 2 summary".into(), "turn1-answer"),
            Some(("turn1-answer-2".into(), "Step 2 summary".into()))
        );
        assert_eq!(
            cumulative.resolve(
                "Step 1 analysis\n\nStep 2 summary complete".into(),
                "turn1-answer"
            ),
            Some(("turn1-answer-2".into(), "Step 2 summary complete".into()))
        );
    }

    #[test]
    fn upsert_pending_write_coalesces_without_bumping_expected_revision() {
        let mut pending = Vec::new();
        let mut revisions = HashMap::new();
        upsert_pending_write(
            &mut pending,
            &mut revisions,
            "turn1-answer".into(),
            "turn1".into(),
            TimelineBody::Message {
                role: MessageRole::Assistant,
                final_answer: true,
                attachments: Vec::new(),
            },
            "Hello".into(),
            None,
        );
        upsert_pending_write(
            &mut pending,
            &mut revisions,
            "turn1-answer".into(),
            "turn1".into(),
            TimelineBody::Message {
                role: MessageRole::Assistant,
                final_answer: true,
                attachments: Vec::new(),
            },
            "Hello world".into(),
            None,
        );
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].expected_revision, 0);
        assert_eq!(pending[0].text, "Hello world");
        assert_eq!(revisions.get("turn1-answer"), Some(&1));

        // After a flush clears `pending`, the next delta advances expected_revision to 1.
        pending.clear();
        upsert_pending_write(
            &mut pending,
            &mut revisions,
            "turn1-answer".into(),
            "turn1".into(),
            TimelineBody::Message {
                role: MessageRole::Assistant,
                final_answer: true,
                attachments: Vec::new(),
            },
            "Hello world!".into(),
            None,
        );
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].expected_revision, 1);
        assert_eq!(revisions.get("turn1-answer"), Some(&2));
    }

    #[test]
    fn bounded_text_lifts_60kb_cap_and_preserves_utf8() {
        let eighty_kb = "中文🚀abc\n".repeat(9_000);
        assert!(eighty_kb.len() > 60_000);
        assert_eq!(bounded_text(eighty_kb.clone()), eighty_kb);

        let over_512kb = "中文🚀".repeat(90_000);
        assert!(over_512kb.len() > 512 * 1024);
        let capped = bounded_text(over_512kb);
        assert!(capped.len() <= 512 * 1024);
        assert!(capped.len() + 4 > 512 * 1024);
    }

    #[test]
    fn should_pause_queue_on_auth_and_quota_errors_only() {
        assert!(should_pause_queue_on_error("HTTP 401 Unauthorized"));
        assert!(should_pause_queue_on_error(
            "API error (status:429): rate limit exceeded"
        ));
        assert!(should_pause_queue_on_error(
            "403 Forbidden: permission_error"
        ));
        assert!(should_pause_queue_on_error(
            "insufficient_quota: out of credits"
        ));
        assert!(should_pause_queue_on_error("请先登录账号后再继续"));
        assert!(should_pause_queue_on_error("请求过于频繁，触发限流"));

        // Non-auth/rate-limit errors and port numbers must NOT pause the queue.
        assert!(!should_pause_queue_on_error(
            "connect ECONNREFUSED 127.0.0.1:429"
        ));
        assert!(!should_pause_queue_on_error(
            "file line-401-429 failed to parse"
        ));
        assert!(!should_pause_queue_on_error("command exited with status 1"));
    }

    #[tokio::test]
    async fn send_safe_pty_paste_closes_bracketed_paste_without_enter_on_mid_chunk_busy() {
        let payload = "报告第一段🚀".repeat(8);
        let mut sent: Vec<Vec<u8>> = Vec::new();
        let mut call_index = 0usize;
        let result = send_safe_pty_paste(&payload, 32, |chunk| {
            call_index += 1;
            let fail = call_index == 2;
            if !fail {
                sent.push(chunk);
            }
            async move { if fail { Err(Error::Busy) } else { Ok(()) } }
        })
        .await;
        assert!(matches!(result, Err(Error::Busy)));
        assert!(sent[0].starts_with(b"\x1b[200~"));
        // Must have sent best-effort `\x1b[201~` cleanup and NEVER sent `\r`.
        assert_eq!(sent.last().map(Vec::as_slice), Some(&b"\x1b[201~"[..]));
        assert!(!sent.iter().any(|chunk| chunk.as_slice() == b"\r"));

        // Full success path sends `\x1b[200~ ... \x1b[201~` followed by `\r`.
        let mut ok_sent: Vec<Vec<u8>> = Vec::new();
        send_safe_pty_paste("hello中文\n", 1024, |chunk| {
            ok_sent.push(chunk);
            async { Ok(()) }
        })
        .await
        .unwrap();
        assert_eq!(ok_sent.len(), 2);
        assert_eq!(
            ok_sent[0],
            b"\x1b[200~hello\xe4\xb8\xad\xe6\x96\x87\x1b[201~"
        );
        assert_eq!(ok_sent[1], b"\r");
    }

    #[tokio::test]
    async fn idle_sessions_hold_zero_turn_permits_and_settled_cross_model_children_deactivate() {
        let root = tempfile::tempdir().unwrap();
        let database = Database::open(root.path().join("data")).await.unwrap();
        let agents = Agents::new(database.clone());
        let workspace = root.path().to_string_lossy().into_owned();

        // Create > MAX_TURNS idle sessions to prove idle sessions consume 0 turn permits.
        let mut created_ids = Vec::with_capacity(MAX_TURNS + 4);
        for index in 0..(MAX_TURNS + 4) {
            let head = agents
                .create(CreateAgentSession {
                    agent: AgentKind::Claude,
                    title: format!("idle-{index}"),
                    workspace: workspace.clone(),
                    auto_approve: false,
                    mode: None,
                    model: None,
                    effort: None,
                    agent_preset: None,
                    account_id: None,
                    resume: None,
                })
                .await
                .unwrap();
            created_ids.push(head.id);
        }
        assert_eq!(agents.count(), MAX_TURNS + 4);
        assert_eq!(agents.active_turn_permits(), 0);

        // Register a completed cross-model child and verify automatic runtime deactivation
        // sets `active = 0` while preserving child result lookup and reactivation support.
        let parent_id = created_ids[0].clone();
        let child_id = created_ids[1].clone();
        {
            let parent_id = parent_id.clone();
            let child_id = child_id.clone();
            database
                .call(move |store| {
                    store.register_cross_model_child(
                        &child_id,
                        &parent_id,
                        "inspect auth flow",
                        "native-claude",
                        "native-claude",
                        "native-claude",
                    )?;
                    let (turn, _) = store.begin_agent_turn(&child_id)?;
                    store.append_agent_records(
                        &child_id,
                        vec![TimelineWrite {
                            id: format!("turn{turn}-answer"),
                            turn_id: format!("turn{turn}"),
                            expected_revision: 0,
                            body: TimelineBody::Message {
                                role: MessageRole::Assistant,
                                final_answer: true,
                                attachments: Vec::new(),
                            },
                            text: "Auth flow verified.".into(),
                            replace: false,
                            subagent_id: None,
                        }],
                    )?;
                    store.finish_agent_turn_status(&child_id, SessionStatus::Idle)?;
                    store.complete_cross_model_child(
                        &child_id,
                        turn,
                        "completed",
                        Some("Auth flow verified."),
                    )?;
                    Ok(())
                })
                .await
                .unwrap();
        }

        agents.deactivate_settled_cross_model_child(&child_id).await;
        assert_eq!(agents.count(), MAX_TURNS + 3);
        let (active, result, needs_reactivation) = {
            let parent_id = parent_id.clone();
            let child_id = child_id.clone();
            database
                .call(move |store| {
                    let run = store.agent_run(&child_id)?;
                    let result = store.cross_model_child_result(&child_id)?;
                    let needs =
                        store.cross_model_child_needs_reactivation(&parent_id, &child_id)?;
                    Ok((run.active, result, needs))
                })
                .await
                .unwrap()
        };
        assert!(!active);
        assert_eq!(result, "Auth flow verified.");
        assert!(needs_reactivation);

        agents.shutdown().await.unwrap();
        database.shutdown().await.unwrap();
    }
}
