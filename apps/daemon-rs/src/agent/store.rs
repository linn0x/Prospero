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

    pub(crate) fn from_wire(value: &str) -> Result<Self> {
        match value {
            "strict" | "standard" | "manual" => Ok(ApprovalPolicy::Manual),
            "yolo" | "auto" => Ok(ApprovalPolicy::Auto),
            _ => Err(Error::Invalid("审批策略无效".into())),
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

    pub(crate) fn from_wire(value: &str) -> Result<Self> {
        match value {
            "default" => Ok(PermissionMode::Default),
            "plan" => Ok(PermissionMode::Plan),
            _ => Err(Error::Invalid("会话模式无效".into())),
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
    /// Launch-time model/effort selection; applied on every chained turn.
    pub model: Option<String>,
    pub effort: Option<String>,
    pub agent_preset: Option<String>,
    /// Managed account bound to the run; None for the native environment.
    pub account_id: Option<String>,
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

pub(crate) type CrossModelFanIn = (String, Vec<(String, i64)>);
pub(crate) type ClaimedCrossModelCheck = (super::CrossModelCheck, String);

const CROSS_MODEL_REPORT_BYTES: usize = 60_000;
const CROSS_MODEL_REPORT_CHILDREN: usize = 100;
// Timeline metadata is capped at 8192 bytes after JSON escaping. Keep enough
// headroom for quotes/backslashes expanding to two bytes plus the remaining
// subagent-card fields.
const CROSS_MODEL_CARD_TASK_BYTES: usize = 3_000;
const CROSS_MODEL_CARD_SUMMARY_BYTES: usize = 300;

pub(crate) fn truncate_utf8_bytes(value: &str, maximum: usize) -> String {
    if value.len() <= maximum {
        return value.to_owned();
    }
    let mut end = maximum;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

pub(crate) fn cross_model_card_task(value: &str) -> String {
    truncate_utf8_bytes(value, CROSS_MODEL_CARD_TASK_BYTES)
}

pub(crate) fn cross_model_card_summary(value: &str) -> String {
    truncate_utf8_bytes(value, CROSS_MODEL_CARD_SUMMARY_BYTES)
}

fn decode_attachments(raw: &str) -> Vec<crate::agent::AttachmentInput> {
    serde_json::from_str(raw).unwrap_or_default()
}

/// Validates a launch catalog selection (model alias / effort level):
/// trims, rejects empty values, control characters and over-long inputs.
/// Mirrors the desktop launch-dialog validation (model <= 160, effort <= 80).
fn normalize_selection(
    value: Option<String>,
    maximum: usize,
    message: &'static str,
) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    // Check the raw value: trimming must not launder an embedded newline.
    if value.chars().count() > maximum || value.chars().any(|c| c.is_control()) {
        return Err(Error::Invalid(message.into()));
    }
    let value = value.trim();
    if value.is_empty() {
        return Err(Error::Invalid(message.into()));
    }
    Ok(Some(value.to_owned()))
}

impl Store {
    pub(crate) fn register_cross_model_child(
        &mut self,
        child_session_id: &str,
        parent_session_id: &str,
        task: &str,
        source_id: &str,
        route_id: &str,
        account_id: &str,
    ) -> Result<super::CrossModelChild> {
        crate::database::validate_id(child_session_id)?;
        crate::database::validate_id(parent_session_id)?;
        crate::accounts::sources::validate_source_id(source_id)?;
        crate::accounts::sources::validate_source_id(route_id)?;
        crate::database::validate_id(account_id)?;
        crate::database::validate_text(task, 65_536, false)?;
        self.session(parent_session_id)?;
        self.session(child_session_id)?;
        let now = crate::database::now();
        self.connection.execute(
            "INSERT INTO cross_model_children(child_session_id,parent_session_id,task,source_id,route_id,account_id,status,result,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'starting',NULL,?7,?7)",
            params![child_session_id,parent_session_id,task,source_id,route_id,account_id,now],
        )?;
        self.cross_model_child(child_session_id)
    }

    pub(crate) fn cross_model_child(
        &self,
        child_session_id: &str,
    ) -> Result<super::CrossModelChild> {
        crate::database::validate_id(child_session_id)?;
        self.connection.query_row(
            "SELECT child_session_id,parent_session_id,task,source_id,route_id,account_id,status,result,created_at,updated_at FROM cross_model_children WHERE child_session_id=?",
            [child_session_id],
            |row| Ok(super::CrossModelChild {
                session_id: row.get(0)?, parent_session_id: row.get(1)?, task: row.get(2)?,
                source_id: row.get(3)?, route_id: row.get(4)?, account_id: row.get(5)?,
                status: row.get(6)?, result: row.get(7)?, created_at: row.get(8)?, updated_at: row.get(9)?,
            }),
        ).optional()?.ok_or(Error::NotFound)
    }

    pub(crate) fn cross_model_child_needs_reactivation(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
    ) -> Result<bool> {
        crate::database::validate_id(parent_session_id)?;
        crate::database::validate_id(child_session_id)?;
        let current = self.cross_model_child(child_session_id)?;
        if current.parent_session_id != parent_session_id {
            return Err(Error::NotFound);
        }
        if !matches!(current.status.as_str(), "completed" | "failed" | "stopped") {
            return Err(Error::Conflict);
        }
        let head = self.session(child_session_id)?;
        let run = self.agent_run(child_session_id)?;
        if head.kind != SessionKind::Structured {
            return Err(Error::Conflict);
        }
        if run.active != (head.lifecycle == SessionLifecycle::Active) {
            return Err(Error::Conflict);
        }
        if !run.active && run.native_id.is_none() {
            return Err(Error::Conflict);
        }
        Ok(!run.active)
    }

    pub(crate) fn reopen_cross_model_child(
        &mut self,
        parent_session_id: &str,
        child_session_id: &str,
        task: &str,
    ) -> Result<(super::CrossModelChild, bool)> {
        crate::database::validate_id(parent_session_id)?;
        crate::database::validate_id(child_session_id)?;
        crate::database::validate_text(task, 65_536, false)?;
        let current = self.cross_model_child(child_session_id)?;
        if current.parent_session_id != parent_session_id {
            return Err(Error::NotFound);
        }
        if !matches!(current.status.as_str(), "completed" | "failed" | "stopped") {
            return Err(Error::Conflict);
        }
        let head = self.session(child_session_id)?;
        let run = self.agent_run(child_session_id)?;
        if head.kind != SessionKind::Structured
            || run.active != (head.lifecycle == SessionLifecycle::Active)
            || (!run.active && run.native_id.is_none())
        {
            return Err(Error::Conflict);
        }
        let reactivated = !run.active;
        if reactivated {
            self.update_session_with(
                child_session_id,
                UpdateSession {
                    revision: head.revision,
                    title: None,
                    lifecycle: Some(SessionLifecycle::Active),
                    status: Some(SessionStatus::Idle),
                },
                |transaction| {
                    transaction.execute(
                        "UPDATE agent_runs SET active=1 WHERE session_id=?",
                        [child_session_id],
                    )?;
                    transaction.execute(
                        "UPDATE cross_model_children SET task=?1,status='starting',result=NULL,summary_delivered=0,task_generation=task_generation+1,task_turn=?2,updated_at=?3 WHERE child_session_id=?4",
                        params![task, run.turn + 1, crate::database::now(), child_session_id],
                    )?;
                    Ok(())
                },
            )?;
        } else {
            self.connection.execute(
                "UPDATE cross_model_children SET task=?1,status='starting',result=NULL,summary_delivered=0,task_generation=task_generation+1,task_turn=?2,updated_at=?3 WHERE child_session_id=?4",
                params![task, run.turn + 1, crate::database::now(), child_session_id],
            )?;
        }
        Ok((self.cross_model_child(child_session_id)?, reactivated))
    }

    /// Cross-model children are independently persisted sessions.  A daemon
    /// restart or an adapter edge case must not leave a completed provider
    /// turn stuck forever as `starting`, so the runtime periodically queries
    /// these rows and settles the ones whose session has reached a terminal
    /// state.
    pub(crate) fn unsettled_cross_model_children(&self) -> Result<Vec<super::CrossModelChild>> {
        let mut statement = self.connection.prepare(
            "SELECT child_session_id,parent_session_id,task,source_id,route_id,account_id,status,result,created_at,updated_at \
             FROM cross_model_children WHERE status IN ('starting','running') ORDER BY created_at,child_session_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(super::CrossModelChild {
                session_id: row.get(0)?,
                parent_session_id: row.get(1)?,
                task: row.get(2)?,
                source_id: row.get(3)?,
                route_id: row.get(4)?,
                account_id: row.get(5)?,
                status: row.get(6)?,
                result: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Error::from)
    }

    pub(crate) fn complete_cross_model_child(
        &mut self,
        child_session_id: &str,
        task_turn: i64,
        status: &str,
        result: Option<&str>,
    ) -> Result<super::CrossModelChild> {
        if task_turn <= 0 {
            return Err(Error::Invalid("跨模型子任务轮次无效".into()));
        }
        if !matches!(status, "completed" | "failed" | "stopped") {
            return Err(Error::Invalid("跨模型子任务状态无效".into()));
        }
        if let Some(result) = result {
            // Final answers are multiline Markdown in the normal case.  Do
            // not run the strict single-line user-input validator here: it
            // rejects newlines and used to leave an otherwise completed
            // cross-model child permanently in `starting`.
            if result.len() > 65_536 {
                return Err(Error::Invalid("跨模型子任务摘要过长".into()));
            }
        }
        let current = self.cross_model_child(child_session_id)?;
        if self.cross_model_child_task_turn(child_session_id)? != task_turn {
            return Err(Error::Conflict);
        }
        if matches!(current.status.as_str(), "completed" | "failed" | "stopped") {
            return Ok(current);
        }
        let updated = self.connection.execute(
            "UPDATE cross_model_children SET status=?1,result=?2,updated_at=?3 WHERE child_session_id=?4 AND task_turn=?5 AND status IN ('starting','running')",
            params![status,result,crate::database::now(),child_session_id,task_turn],
        )?;
        if updated != 1 {
            return Err(Error::Conflict);
        }
        self.cross_model_child(child_session_id)
    }

    pub(crate) fn cross_model_child_summary(
        &self,
        child_session_id: &str,
    ) -> Result<Option<String>> {
        crate::database::validate_id(child_session_id)?;
        let text = self.connection.query_row(
            "SELECT preview FROM timeline_records WHERE session_id=?1 AND turn_id='turn' || (SELECT task_turn FROM cross_model_children WHERE child_session_id=?1) AND json_extract(body,'$.kind')='message' AND json_extract(body,'$.role')='assistant' AND coalesce(json_extract(body,'$.finalAnswer'),0)=1 ORDER BY position DESC LIMIT 1",
            [child_session_id], |row| row.get::<_, String>(0),
        ).optional()?;
        Ok(text)
    }

    pub(crate) fn cross_model_child_task_turn(&self, child_session_id: &str) -> Result<i64> {
        crate::database::validate_id(child_session_id)?;
        self.connection
            .query_row(
                "SELECT task_turn FROM cross_model_children WHERE child_session_id=?",
                [child_session_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)
    }

    /// Claim every newly-terminal child exactly once and build an incremental
    /// report. Running siblings never block a completed result; the report
    /// produced for the last terminal child carries the all-finished marker.
    pub(crate) fn claim_cross_model_fan_in(
        &mut self,
        parent_session_id: &str,
    ) -> Result<Option<CrossModelFanIn>> {
        crate::database::validate_id(parent_session_id)?;
        let pending: i64 = self.connection.query_row(
            "SELECT count(*) FROM cross_model_children WHERE parent_session_id=? AND status IN ('starting','running')",
            [parent_session_id], |row| row.get(0),
        )?;
        let undelivered: i64 = self.connection.query_row(
            "SELECT count(*) FROM cross_model_children WHERE parent_session_id=? AND summary_delivered=0 AND status IN ('completed','failed','stopped')",
            [parent_session_id], |row| row.get(0),
        )?;
        if undelivered == 0 {
            return Ok(None);
        }
        let transaction = self.connection.transaction()?;
        let mut rows = Vec::new();
        {
            let mut statement = transaction.prepare(
                "SELECT child_session_id,task_generation,status,source_id,route_id,task,coalesce(result,'') FROM cross_model_children WHERE parent_session_id=? AND summary_delivered=0 AND status IN ('completed','failed','stopped') ORDER BY updated_at,child_session_id LIMIT ?2",
            )?;
            for row in statement.query_map(
                params![parent_session_id, CROSS_MODEL_REPORT_CHILDREN as i64],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )? {
                rows.push(row?);
            }
        }
        if rows.is_empty() {
            transaction.rollback()?;
            return Ok(None);
        }
        let claims = rows
            .iter()
            .map(|(session_id, generation, ..)| (session_id.clone(), *generation))
            .collect::<Vec<_>>();
        for (child_session_id, generation) in &claims {
            let claimed = transaction.execute(
                "UPDATE cross_model_children SET summary_delivered=1,updated_at=?1 WHERE parent_session_id=?2 AND child_session_id=?3 AND task_generation=?4 AND summary_delivered=0",
                params![crate::database::now(), parent_session_id, child_session_id, generation],
            )?;
            if claimed != 1 {
                transaction.rollback()?;
                return Ok(None);
            }
        }
        transaction.commit()?;
        let remaining_terminal = undelivered.saturating_sub(rows.len() as i64);
        let mut report = if pending == 0 && remaining_terminal == 0 {
            String::from(
                "跨模型子 Agent 最终 fan-in：本批所有子任务均已结束。请整合结果并继续主任务；不要未经核验直接采纳。\n",
            )
        } else if remaining_terminal > 0 {
            format!(
                "跨模型子 Agent 增量 fan-in：以下子任务刚刚结束；另有 {remaining_terminal} 个已结束结果等待下一批投递，{pending} 个子任务仍在运行。你可以先处理这些结果；不要未经核验直接采纳。\n"
            )
        } else {
            format!(
                "跨模型子 Agent 增量 fan-in：以下子任务刚刚结束，仍有 {pending} 个子任务运行中。你可以先处理这些结果，或继续等待后续 fan-in；不要未经核验直接采纳。\n"
            )
        };
        let row_count = rows.len();
        for (index, (session_id, _generation, status, source, route, task, result)) in
            rows.into_iter().enumerate()
        {
            // Share the remaining UTF-8 byte budget fairly across every row
            // so all claimed children are represented and send() can always
            // accept the resulting prompt.
            let remaining_rows = row_count - index;
            let section_budget = (CROSS_MODEL_REPORT_BYTES - report.len()) / remaining_rows;
            let prefix = format!(
                "\n[子任务 {} · {} · {}/{} · 会话 {}]\n任务：",
                index + 1,
                status,
                source,
                route,
                session_id,
            );
            let separator = "\n结果：";
            let suffix = "\n";
            let fixed = prefix.len() + separator.len() + suffix.len();
            let content_budget = section_budget.saturating_sub(fixed);
            let task_budget = content_budget.min(1_800).min(content_budget / 3);
            let task = truncate_utf8_bytes(&task, task_budget);
            let result = if result.is_empty() {
                "（没有可用摘要）".to_owned()
            } else {
                truncate_utf8_bytes(&result, content_budget.saturating_sub(task.len()))
            };
            report.push_str(&prefix);
            report.push_str(&task);
            report.push_str(separator);
            report.push_str(&truncate_utf8_bytes(
                &result,
                section_budget
                    .saturating_sub(prefix.len() + task.len() + separator.len() + suffix.len()),
            ));
            report.push_str(suffix);
        }
        debug_assert!(report.len() <= CROSS_MODEL_REPORT_BYTES);
        Ok(Some((report, claims)))
    }

    /// Persist a one-shot parent wakeup. The delay is represented as an
    /// absolute wall-clock deadline so it survives daemon restarts.
    pub(crate) fn schedule_cross_model_check(
        &mut self,
        parent_session_id: &str,
        delay_seconds: i64,
    ) -> Result<super::CrossModelCheck> {
        crate::database::validate_id(parent_session_id)?;
        if !(1..=7 * 24 * 60 * 60).contains(&delay_seconds) {
            return Err(Error::Invalid("检查延时必须在 1 秒到 7 天之间".into()));
        }
        self.session(parent_session_id)?;
        let now = crate::database::now();
        let due_at = now
            .checked_add(delay_seconds.saturating_mul(1_000))
            .ok_or_else(|| Error::Invalid("检查时间无效".into()))?;
        let id = format!("cross-check-{}", uuid::Uuid::new_v4().simple());
        self.connection.execute(
            "INSERT INTO cross_model_checks(id,parent_session_id,due_at,state,claimed_at,created_at,delivered_at) VALUES(?1,?2,?3,'pending',NULL,?4,NULL)",
            params![id, parent_session_id, due_at, now],
        )?;
        Ok(super::CrossModelCheck {
            id,
            parent_session_id: parent_session_id.to_owned(),
            due_at,
            state: "pending".into(),
            created_at: now,
        })
    }

    /// Claim the next due check, including a claim whose delivery lease
    /// expired after a daemon crash, and snapshot all current child states.
    pub(crate) fn claim_due_cross_model_check(
        &mut self,
        lease_millis: i64,
    ) -> Result<Option<ClaimedCrossModelCheck>> {
        if lease_millis <= 0 {
            return Err(Error::Invalid("检查租约无效".into()));
        }
        let now = crate::database::now();
        let stale_before = now.saturating_sub(lease_millis);
        let candidate = self
            .connection
            .query_row(
                "SELECT id,parent_session_id,due_at,state,created_at FROM cross_model_checks \
                 WHERE (state='pending' AND due_at<=?1) OR (state='claimed' AND claimed_at<=?2) \
                 ORDER BY due_at,id LIMIT 1",
                params![now, stale_before],
                |row| {
                    Ok(super::CrossModelCheck {
                        id: row.get(0)?,
                        parent_session_id: row.get(1)?,
                        due_at: row.get(2)?,
                        state: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                },
            )
            .optional()?;
        let Some(mut check) = candidate else {
            return Ok(None);
        };
        let claimed = self.connection.execute(
            "UPDATE cross_model_checks SET state='claimed',claimed_at=?1 \
             WHERE id=?2 AND ((state='pending' AND due_at<=?1) OR (state='claimed' AND claimed_at<=?3))",
            params![now, check.id, stale_before],
        )?;
        if claimed != 1 {
            return Ok(None);
        }
        check.state = "claimed".into();

        let (total, starting, running, completed, failed, stopped) = self.connection.query_row(
            "SELECT count(*), \
             coalesce(sum(status='starting'),0),coalesce(sum(status='running'),0), \
             coalesce(sum(status='completed'),0),coalesce(sum(status='failed'),0), \
             coalesce(sum(status='stopped'),0) \
             FROM cross_model_children WHERE parent_session_id=?1",
            [&check.parent_session_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )?;
        let mut rows = Vec::new();
        {
            let mut statement = self.connection.prepare(
                "SELECT child_session_id,task_generation,status,task,coalesce(result,'') \
                 FROM cross_model_children WHERE parent_session_id=?1 \
                 ORDER BY updated_at DESC,child_session_id LIMIT ?2",
            )?;
            for row in statement.query_map(
                params![&check.parent_session_id, CROSS_MODEL_REPORT_CHILDREN as i64],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )? {
                rows.push(row?);
            }
        }
        let mut report = format!(
            "跨模型子 Agent 定时检查（检查 {}）：共 {} 个；starting {}，running {}，completed {}，failed {}，stopped {}。请根据当前状态继续主任务；仍在运行的子任务无需重复派发。\n",
            check.id, total, starting, running, completed, failed, stopped,
        );
        if rows.is_empty() {
            report.push_str("当前主会话没有跨模型子 Agent。\n");
        } else if total > rows.len() as i64 {
            report.push_str(&format!(
                "以下仅列出最近更新的 {} 个子任务；汇总数量覆盖全部子任务。\n",
                rows.len()
            ));
        }
        let row_count = rows.len();
        for (index, (session_id, generation, status, task, result)) in rows.into_iter().enumerate()
        {
            let remaining_rows = row_count - index;
            let section_budget = (CROSS_MODEL_REPORT_BYTES - report.len()) / remaining_rows;
            let prefix = format!(
                "\n[子任务 {} · generation {} · {} · 会话 {}]\n任务：",
                index + 1,
                generation,
                status,
                session_id
            );
            let separator = "\n最近结果：";
            let suffix = "\n";
            let fixed = prefix.len() + separator.len() + suffix.len();
            let content_budget = section_budget.saturating_sub(fixed);
            let task_budget = content_budget.min(1_800).min(content_budget / 3);
            let task = truncate_utf8_bytes(&task, task_budget);
            let result = if result.is_empty() {
                "（尚无最终结果）".to_owned()
            } else {
                truncate_utf8_bytes(&result, content_budget.saturating_sub(task.len()))
            };
            report.push_str(&prefix);
            report.push_str(&task);
            report.push_str(separator);
            report.push_str(&truncate_utf8_bytes(
                &result,
                section_budget
                    .saturating_sub(prefix.len() + task.len() + separator.len() + suffix.len()),
            ));
            report.push_str(suffix);
        }
        debug_assert!(report.len() <= CROSS_MODEL_REPORT_BYTES);
        Ok(Some((check, report)))
    }

    pub(crate) fn mark_cross_model_check_delivered(&mut self, id: &str) -> Result<()> {
        crate::database::validate_id(id)?;
        let changed = self.connection.execute(
            "UPDATE cross_model_checks SET state='delivered',delivered_at=?1 WHERE id=?2 AND state='claimed'",
            params![crate::database::now(), id],
        )?;
        if changed != 1 {
            return Err(Error::Conflict);
        }
        Ok(())
    }

    pub(crate) fn release_cross_model_check(&mut self, id: &str) -> Result<()> {
        crate::database::validate_id(id)?;
        let changed = self.connection.execute(
            "UPDATE cross_model_checks SET state='pending',claimed_at=NULL WHERE id=?1 AND state='claimed'",
            [id],
        )?;
        if changed != 1 {
            return Err(Error::Conflict);
        }
        Ok(())
    }

    /// Undo a fan-in claim when delivery to the parent did not happen.  The
    /// report stays durable and can be retried after a transient daemon or
    /// terminal-host failure.
    pub(crate) fn release_cross_model_fan_in(
        &mut self,
        parent_session_id: &str,
        claims: &[(String, i64)],
    ) -> Result<()> {
        crate::database::validate_id(parent_session_id)?;
        let transaction = self.connection.transaction()?;
        for (child_session_id, generation) in claims {
            crate::database::validate_id(child_session_id)?;
            transaction.execute(
                "UPDATE cross_model_children SET summary_delivered=0,updated_at=?1 WHERE parent_session_id=?2 AND child_session_id=?3 AND task_generation=?4 AND summary_delivered=1",
                params![crate::database::now(), parent_session_id, child_session_id, generation],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Parents with fully-terminal children whose report has not yet reached
    /// the parent.  This lets startup recovery retry a failed delivery even
    /// after every individual child was already settled.
    pub(crate) fn pending_cross_model_fan_in_parents(&self) -> Result<Vec<String>> {
        let mut statement = self.connection.prepare(
            "SELECT parent_session_id FROM cross_model_children \
             GROUP BY parent_session_id \
             HAVING sum(summary_delivered=0 AND status IN ('completed','failed','stopped'))>0 \
             ORDER BY min(created_at),parent_session_id",
        )?;
        statement
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<Vec<String>, _>>()
            .map_err(Error::from)
    }

    pub fn create_agent_session(
        &mut self,
        input: CreateAgentSession,
        policy: ApprovalPolicy,
    ) -> Result<SessionHead> {
        let mode = match input.mode.as_deref() {
            Some(value) => PermissionMode::from_wire(value)?,
            None => PermissionMode::Default,
        };
        let model = normalize_selection(input.model, 300, "模型无效")?;
        let effort = normalize_selection(input.effort, 80, "思考强度无效")?;
        let agent_preset = normalize_selection(input.agent_preset, 300, "Agent 预设无效")?;
        let native_id = input
            .resume
            .map(|resume| resume.id)
            .map(|id| normalize_selection(Some(id), 256, "原生会话 ID 无效"))
            .transpose()?
            .flatten();
        // The native id collapses to NULL; anything else must reference a
        // surviving managed account so sessions never bind to a deleted row.
        let account_id = match input.account_id.as_deref() {
            None | Some(crate::accounts::NATIVE_CLAUDE_ID) => None,
            Some(id) => {
                crate::database::validate_id(id)?;
                let _record = self.managed_account(id)?;
                Some(id.to_owned())
            }
        };
        let agent = input.agent;
        self.create_session_with(
            CreateSession {
                agent,
                kind: SessionKind::Structured,
                title: input.title,
                workspace: input.workspace,
            },
            |tx, head| {
                tx.execute(
                    "INSERT INTO agent_runs(session_id,agent,active,approval_policy,permission_mode,turn,native_id,model,effort,account_id,agent_preset) \
                     VALUES(?1,?2,1,?3,?4,0,?5,?6,?7,?8,?9)",
                    params![head.id, crate::database::label(agent)?, policy.label(), mode.label(), native_id, model, effort, account_id, agent_preset],
                )?;
                Ok(())
            },
        )
    }

    pub(crate) fn agent_run(&self, id: &str) -> Result<AgentRun> {
        crate::database::validate_id(id)?;
        type Row = (
            String,
            bool,
            String,
            String,
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let row: Row = self
            .connection
            .query_row(
                "SELECT agent,active,approval_policy,permission_mode,turn,native_id,model,effort,account_id,agent_preset FROM agent_runs WHERE session_id=?",
                [id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
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
            "codex" => AgentKind::Codex,
            "deepseek" => AgentKind::Deepseek,
            "opencode" => AgentKind::Opencode,
            _ => {
                return Err(Error::Invalid(
                    "Agent 暂未接入 Rust structured runtime".into(),
                ));
            }
        };
        Ok(AgentRun {
            agent,
            active: row.1,
            policy,
            mode,
            turn: row.4,
            native_id: row.5,
            model: row.6,
            effort: row.7,
            account_id: row.8,
            agent_preset: row.9,
        })
    }

    pub(crate) fn set_approval_policy(&mut self, id: &str, policy: ApprovalPolicy) -> Result<()> {
        crate::database::validate_id(id)?;
        let run = self.agent_run(id)?;
        if !run.active {
            return Err(Error::Conflict);
        }
        self.connection.execute(
            "UPDATE agent_runs SET approval_policy=?1 WHERE session_id=?2",
            params![policy.label(), id],
        )?;
        Ok(())
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

    /// Persist an in-session model/effort switch. The selection applies to
    /// the next chained turn via argv; the live turn is notified separately.
    pub(crate) fn set_agent_selection(
        &mut self,
        id: &str,
        model: &str,
        effort: Option<&str>,
    ) -> Result<(String, Option<String>)> {
        crate::database::validate_id(id)?;
        let model = normalize_selection(Some(model.to_owned()), 160, "模型无效")?.unwrap();
        let effort = normalize_selection(effort.map(str::to_owned), 80, "思考强度无效")?;
        let run = self.agent_run(id)?;
        if !run.active {
            return Err(Error::Conflict);
        }
        self.connection.execute(
            "UPDATE agent_runs SET model=?1, effort=?2 WHERE session_id=?3",
            params![model, effort, id],
        )?;
        Ok((model, effort))
    }

    /// Active structured sessions' persisted selections, for the desktop
    /// `agentControls` projection in the session list.
    pub(crate) fn agent_controls(&self) -> Result<Vec<crate::agent::SessionAgentControls>> {
        let mut statement = self.connection.prepare(
            "SELECT ar.session_id,ar.agent,ar.permission_mode,ar.model,ar.effort,ar.approval_policy,
                    ma.api_profile IS NOT NULL
             FROM agent_runs ar
             LEFT JOIN managed_accounts ma ON ma.id = ar.account_id
             WHERE ar.active=1",
        )?;
        let rows = statement.query_map([], |row| {
            let agent: String = row.get(1)?;
            let mode: String = row.get(2)?;
            let profile_bound: bool = row.get(6)?;
            Ok(crate::agent::SessionAgentControls {
                session_id: row.get(0)?,
                approval_policy: row.get(5)?,
                compact: agent == "claude"
                    || agent == "codex"
                    || agent == "deepseek"
                    || agent == "opencode",
                model: (agent == "claude"
                    || agent == "codex"
                    || agent == "deepseek"
                    || agent == "opencode")
                    && !profile_bound,
                mode: (agent == "claude" || agent == "codex") && !profile_bound,
                current_model: row.get(3)?,
                current_effort: row.get(4)?,
                current_mode: Some(mode),
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Error::from)
    }

    pub(crate) fn begin_agent_turn(&mut self, id: &str) -> Result<(i64, Option<String>)> {
        let run = self.agent_run(id)?;
        if !run.active {
            return Err(Error::Conflict);
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
        let native_id = normalize_selection(Some(native_id.to_owned()), 256, "原生会话 ID 无效")?
            .ok_or_else(|| Error::Invalid("原生会话 ID 无效".into()))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AgentKind, CreateSession, SessionKind};

    fn session(store: &mut Store, title: &str) -> String {
        store
            .create_session(CreateSession {
                agent: AgentKind::Codex,
                kind: SessionKind::Structured,
                title: title.into(),
                workspace: "/synthetic".into(),
            })
            .unwrap()
            .id
    }

    fn active_child_session(store: &mut Store, title: &str) -> String {
        let id = session(store, title);
        store
            .connection
            .execute(
                "INSERT INTO agent_runs(session_id,agent,active,approval_policy,permission_mode,turn,native_id) VALUES(?1,'codex',1,'auto','default',1,'native-child')",
                [&id],
            )
            .unwrap();
        id
    }

    #[test]
    fn completed_cross_model_child_can_be_reopened_for_a_new_fan_in() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let parent = session(&mut store, "parent");
        let child = active_child_session(&mut store, "child");
        store
            .register_cross_model_child(
                &child,
                &parent,
                "first task",
                "source-b",
                "gemini-route",
                "account-b",
            )
            .unwrap();
        store
            .complete_cross_model_child(&child, 1, "completed", Some("first result"))
            .unwrap();

        let (first_report, first_claim) = store.claim_cross_model_fan_in(&parent).unwrap().unwrap();
        assert!(first_report.contains("first task"));
        assert!(first_report.contains("first result"));
        assert!(first_report.contains(&format!("会话 {child}")));
        assert_eq!(first_claim, vec![(child.clone(), 1)]);
        assert!(store.claim_cross_model_fan_in(&parent).unwrap().is_none());

        let (reopened, reactivated) = store
            .reopen_cross_model_child(&parent, &child, "refine the answer")
            .unwrap();
        assert!(!reactivated);
        assert_eq!(reopened.status, "starting");
        assert_eq!(reopened.task, "refine the answer");
        assert!(reopened.result.is_none());
        assert!(store.claim_cross_model_fan_in(&parent).unwrap().is_none());

        store
            .complete_cross_model_child(&child, 2, "completed", Some("refined result"))
            .unwrap();
        let (follow_up_report, follow_up_claim) =
            store.claim_cross_model_fan_in(&parent).unwrap().unwrap();
        assert!(!follow_up_report.contains("first task"));
        assert!(!follow_up_report.contains("first result"));
        assert!(follow_up_report.contains("refine the answer"));
        assert!(follow_up_report.contains("refined result"));
        assert_eq!(follow_up_claim, vec![(child, 2)]);
    }

    #[test]
    fn terminal_child_fans_in_while_a_sibling_is_still_running() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let parent = session(&mut store, "parent");
        let first = active_child_session(&mut store, "first child");
        let second = active_child_session(&mut store, "second child");
        for child in [&first, &second] {
            store
                .register_cross_model_child(child, &parent, "task", "source", "route", "account")
                .unwrap();
        }
        store
            .complete_cross_model_child(&first, 1, "completed", Some("first result"))
            .unwrap();

        let (incremental, first_claim) = store.claim_cross_model_fan_in(&parent).unwrap().unwrap();
        assert!(incremental.contains("增量 fan-in"));
        assert!(incremental.contains("仍有 1 个子任务运行中"));
        assert!(incremental.contains(&first));
        assert!(!incremental.contains(&second));
        assert_eq!(first_claim, vec![(first, 1)]);

        store
            .complete_cross_model_child(&second, 1, "completed", Some("second result"))
            .unwrap();
        let (final_report, second_claim) =
            store.claim_cross_model_fan_in(&parent).unwrap().unwrap();
        assert!(final_report.contains("最终 fan-in"));
        assert!(final_report.contains(&second));
        assert_eq!(second_claim, vec![(second, 1)]);
    }

    #[test]
    fn cross_model_checks_claim_reclaim_release_and_deliver() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let parent = session(&mut store, "parent");
        let child = active_child_session(&mut store, "child");
        store
            .register_cross_model_child(
                &child,
                &parent,
                "inspect progress",
                "source",
                "route",
                "account",
            )
            .unwrap();
        let check = store.schedule_cross_model_check(&parent, 1).unwrap();
        assert!(store.claim_due_cross_model_check(60_000).unwrap().is_none());
        store
            .connection
            .execute(
                "UPDATE cross_model_checks SET due_at=0 WHERE id=?1",
                [&check.id],
            )
            .unwrap();

        let (claimed, report) = store.claim_due_cross_model_check(60_000).unwrap().unwrap();
        assert_eq!(claimed.id, check.id);
        assert!(report.contains("starting 1"));
        assert!(report.contains(&child));
        assert!(report.contains("generation 1"));
        assert!(store.claim_due_cross_model_check(60_000).unwrap().is_none());

        store.release_cross_model_check(&check.id).unwrap();
        let (retried, _) = store.claim_due_cross_model_check(60_000).unwrap().unwrap();
        assert_eq!(retried.id, check.id);
        store
            .connection
            .execute(
                "UPDATE cross_model_checks SET claimed_at=0 WHERE id=?1",
                [&check.id],
            )
            .unwrap();
        let (reclaimed, _) = store.claim_due_cross_model_check(60_000).unwrap().unwrap();
        assert_eq!(reclaimed.id, check.id);

        store.mark_cross_model_check_delivered(&check.id).unwrap();
        assert!(store.claim_due_cross_model_check(60_000).unwrap().is_none());
        let state: String = store
            .connection
            .query_row(
                "SELECT state FROM cross_model_checks WHERE id=?1",
                [&check.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "delivered");
    }

    #[test]
    fn schema_27_is_upgraded_with_persistent_cross_model_checks() {
        let directory = tempfile::tempdir().unwrap();
        {
            let store = Store::open(directory.path()).unwrap();
            store
                .connection
                .execute_batch("DROP TABLE cross_model_checks; PRAGMA user_version=27;")
                .unwrap();
        }
        let store = Store::open(directory.path()).unwrap();
        let version: i64 = store
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let table: String = store
            .connection
            .query_row(
                "SELECT name FROM sqlite_schema WHERE type='table' AND name='cross_model_checks'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 28);
        assert_eq!(table, "cross_model_checks");
    }

    #[test]
    fn failed_delivery_releases_only_the_claimed_follow_up_batch() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let parent = session(&mut store, "parent");
        let first = active_child_session(&mut store, "first child");
        let second = active_child_session(&mut store, "second child");
        for (child, task) in [(&first, "first task"), (&second, "second task")] {
            store
                .register_cross_model_child(child, &parent, task, "source", "route", "account")
                .unwrap();
            store
                .complete_cross_model_child(child, 1, "completed", Some("done"))
                .unwrap();
        }
        let (_, original_claim) = store.claim_cross_model_fan_in(&parent).unwrap().unwrap();

        let _ = store
            .reopen_cross_model_child(&parent, &first, "follow-up")
            .unwrap();
        store
            .complete_cross_model_child(&first, 2, "completed", Some("new result"))
            .unwrap();
        store
            .release_cross_model_fan_in(&parent, &original_claim)
            .unwrap();

        let (report, claimed) = store.claim_cross_model_fan_in(&parent).unwrap().unwrap();
        assert!(report.contains("second task"));
        assert!(report.contains("follow-up"));
        assert_eq!(claimed, vec![(first, 2), (second, 1)]);
    }

    #[test]
    fn archived_completed_child_is_reactivated_with_its_native_context() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let parent = session(&mut store, "parent");
        let child = active_child_session(&mut store, "child");
        store
            .register_cross_model_child(&child, &parent, "first task", "source", "route", "account")
            .unwrap();
        store
            .complete_cross_model_child(&child, 1, "completed", Some("done"))
            .unwrap();
        store.archive_agent_session(&child, true).unwrap();

        assert!(
            store
                .cross_model_child_needs_reactivation(&parent, &child)
                .unwrap()
        );
        let (reopened, reactivated) = store
            .reopen_cross_model_child(&parent, &child, "continue")
            .unwrap();
        assert!(reactivated);
        assert_eq!(reopened.status, "starting");
        let head = store.session(&child).unwrap();
        assert_eq!(head.lifecycle, SessionLifecycle::Active);
        assert_eq!(head.status, SessionStatus::Idle);
        let run = store.agent_run(&child).unwrap();
        assert!(run.active);
        assert_eq!(run.native_id.as_deref(), Some("native-child"));
        assert_eq!(run.policy, ApprovalPolicy::Auto);
    }

    #[test]
    fn follow_up_summary_never_reuses_a_previous_turn_answer() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let parent = session(&mut store, "parent");
        let child = active_child_session(&mut store, "child");
        store
            .register_cross_model_child(&child, &parent, "first", "source", "route", "account")
            .unwrap();
        store
            .append_agent_records(
                &child,
                vec![TimelineWrite {
                    id: "turn1-answer".into(),
                    turn_id: "turn1".into(),
                    expected_revision: 0,
                    body: TimelineBody::Message {
                        role: MessageRole::Assistant,
                        final_answer: true,
                        attachments: Vec::new(),
                    },
                    text: "old answer".into(),
                    replace: false,
                    subagent_id: None,
                }],
            )
            .unwrap();
        assert_eq!(
            store.cross_model_child_summary(&child).unwrap().as_deref(),
            Some("old answer")
        );
        store
            .complete_cross_model_child(&child, 1, "completed", Some("old answer"))
            .unwrap();
        store
            .reopen_cross_model_child(&parent, &child, "follow-up")
            .unwrap();
        assert_eq!(store.cross_model_child_task_turn(&child).unwrap(), 2);
        assert_eq!(store.cross_model_child_summary(&child).unwrap(), None);
    }

    #[test]
    fn stale_completion_cannot_overwrite_a_new_generation() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let parent = session(&mut store, "parent");
        let child = active_child_session(&mut store, "child");
        store
            .register_cross_model_child(&child, &parent, "first", "source", "route", "account")
            .unwrap();
        store
            .complete_cross_model_child(&child, 1, "completed", Some("first"))
            .unwrap();
        store
            .reopen_cross_model_child(&parent, &child, "follow-up")
            .unwrap();
        assert!(matches!(
            store.complete_cross_model_child(&child, 1, "failed", Some("stale")),
            Err(Error::Conflict)
        ));
        let current = store.cross_model_child(&child).unwrap();
        assert_eq!(current.status, "starting");
        assert_eq!(current.task, "follow-up");
    }

    #[test]
    fn fan_in_stays_within_the_message_byte_limit_and_names_every_child() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let parent = session(&mut store, "parent");
        let mut children = Vec::new();
        for index in 0..20 {
            let child = active_child_session(&mut store, &format!("child {index}"));
            store
                .register_cross_model_child(
                    &child,
                    &parent,
                    &"任务".repeat(10_000),
                    "source",
                    "route",
                    "account",
                )
                .unwrap();
            store
                .complete_cross_model_child(&child, 1, "completed", Some(&"结果".repeat(10_000)))
                .unwrap();
            children.push(child);
        }
        let (report, claims) = store.claim_cross_model_fan_in(&parent).unwrap().unwrap();
        assert!(report.len() <= CROSS_MODEL_REPORT_BYTES);
        assert_eq!(claims.len(), children.len());
        assert!(children.iter().all(|child| report.contains(child)));
    }

    #[test]
    fn fan_in_claims_only_the_children_in_each_bounded_batch() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let parent = session(&mut store, "parent");
        for index in 0..101 {
            let child = active_child_session(&mut store, &format!("child {index}"));
            store
                .register_cross_model_child(&child, &parent, "task", "source", "route", "account")
                .unwrap();
            store
                .complete_cross_model_child(&child, 1, "completed", Some("done"))
                .unwrap();
        }
        let (_, first) = store.claim_cross_model_fan_in(&parent).unwrap().unwrap();
        assert_eq!(first.len(), 100);
        let (_, second) = store.claim_cross_model_fan_in(&parent).unwrap().unwrap();
        assert_eq!(second.len(), 1);
        assert!(store.claim_cross_model_fan_in(&parent).unwrap().is_none());
    }

    #[test]
    fn card_fields_are_utf8_byte_bounded() {
        assert_eq!(cross_model_card_task(&"中".repeat(8_000)).len(), 3_000);
        assert_eq!(cross_model_card_summary(&"中".repeat(1_000)).len(), 300);
        assert!(
            serde_json::to_vec(&TimelineBody::Subagent {
                subagent_id: "x".repeat(128),
                name: "x".repeat(201),
                role: Some("跨模型子 Agent · YOLO".into()),
                task: Some(cross_model_card_task(&"\"".repeat(65_536))),
                status: "completed".into(),
                can_message: false,
                summary: cross_model_card_summary(&"\"".repeat(65_536)),
                created_at: i64::MAX,
                updated_at: i64::MAX,
            })
            .unwrap()
            .len()
                <= 8_192
        );
    }
}
