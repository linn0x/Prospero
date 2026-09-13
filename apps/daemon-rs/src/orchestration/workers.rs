//! Worker launch/stop and worktree lifecycle service (Stage 8).
//!
//! This is the Rust-mode counterpart of the legacy `DispatchService` +
//! `WorktreeAssetService`: it wires the DAG store to the structured Claude
//! agent runtime and to `git worktree`. Two deliberate scope reductions versus
//! legacy:
//!
//! * only structured Claude workers are launched (other agents/PTYs stay
//!   explicitly unbridged and the desktop rejects them with "尚未接入");
//! * there is no `prospero` CLI in Rust mode, so the worker cannot self-deliver
//!   `task done/fail`. Delivery is a manual desktop action against the
//!   `/dispatches/:id/settle` route; the worker prompt says so.
//!
//! Worktree safety is unchanged: directories are registered before the worker
//! session exists, preserved on every settle/stop/run outcome, and only removed
//! through an explicit cleanup that re-inspects with read-only git commands.

use std::path::{Path, PathBuf};

use super::gitops::{
    WorktreeCreate, create_worktree, delete_branch, inspect_asset, remove_worktree, repo_root,
    worktree_default_path,
};
use super::store::{OperationReplay, fingerprint};
use super::*;
use crate::agent::{Agents, CreateAgentSession};
use crate::database::{now, validate_text};
use crate::error::{Error, Result};
use crate::worker::Database;

fn to_base36(mut value: u128) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Adapted worker brief. Without the `prospero` CLI there is no self-delivery;
/// the operator records the result manually, which the final line makes
/// explicit so the worker does not invent a command. Bound skills are listed
/// as `$name` mentions; the agent send path expands them against the worker
/// cwd into full SKILL.md contents (same portable-skill flow as the composer).
fn worker_prompt(
    task: &Task,
    session_id: &str,
    cwd: &str,
    coordinator: Option<&str>,
    skills: &[String],
) -> String {
    let mut lines = vec![
        "你是 Prospero 编排中的 worker。只处理下面这一个任务，不要自行创建或派发其他 worker。"
            .to_string(),
        format!("任务 ID: {}", task.id),
        format!("会话 ID: {session_id}"),
        format!("协调者会话: {}", coordinator.unwrap_or("未指定")),
        format!("工作目录: {cwd}"),
        format!("任务: {}", task.title),
    ];
    if !skills.is_empty() {
        let list = skills
            .iter()
            .map(|skill| format!("${skill}"))
            .collect::<Vec<_>>()
            .join(" ");
        lines.push(format!("显式 Skills: {list}"));
    }
    lines.push(format!("要求:\n{}", task.spec));
    lines.extend([
        "完成并自行验证后，在最终回复中给出简短交付摘要（改了什么、如何验证）；".to_string(),
        "当前 Rust 模式没有 prospero CLI，请勿伪造命令；由操作者在 Prospero 界面对任务做人工交付（完成/失败）。".to_string(),
        "如果无法完成，在最终回复中说明原因与下一步，由操作者标记失败。".to_string(),
        "仅停止、空闲或退出不会把任务标记为完成。".to_string(),
    ]);
    lines.join("\n")
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Launch a structured Claude worker for one task. The ordering mirrors legacy
/// persistence boundaries: worktree directory → asset registration (so the
/// disk resource is indexed even if the next step crashes) → agent session →
/// dispatch row + task `dispatched` in one transaction → worker brief →
/// dispatch `running`.
pub async fn start_worker(
    database: &Database,
    agents: &Agents,
    input: StartWorker,
) -> Result<WorkerStartOutcome> {
    validate_text(&input.cwd, 4096, false)?;
    if !Path::new(&input.cwd).is_absolute() {
        return Err(Error::Invalid("cwd must be absolute".into()));
    }
    let mode = match input.worktree.as_str() {
        "new" => "new",
        "none" => "none",
        _ => return Err(Error::Invalid("worktree must be new or none".into())),
    };
    if input.agent != crate::protocol::AgentKind::Claude {
        return Err(Error::Invalid("Rust worker 当前仅支持 Claude".into()));
    }
    let policy = match input.approval_policy.as_deref().unwrap_or("standard") {
        "strict" | "standard" => false,
        "yolo" => true,
        _ => return Err(Error::Invalid("approvalPolicy is invalid".into())),
    };
    let account_id = match input.account_id.as_deref() {
        None | Some("") | Some(crate::accounts::NATIVE_CLAUDE_ID) => None,
        Some(id) => {
            crate::database::validate_id(id)?;
            let data = database.directory().to_owned();
            let id = id.to_owned();
            let record = database
                .call(move |store| store.managed_snapshot_row(&data, &id))
                .await?;
            Some(record.id)
        }
    };
    let operation_id = match &input.operation_id {
        Some(id) => {
            crate::database::validate_id(id)?;
            Some(id.clone())
        }
        None => None,
    };
    let request_fingerprint = fingerprint(
        "worker.start",
        &serde_json::json!({
            "taskId": input.task_id,
            "cwd": input.cwd,
            "worktree": input.worktree,
        }),
    );
    if let Some(id) = &operation_id {
        let replay = {
            let id = id.clone();
            let fp = request_fingerprint.clone();
            database
                .call(move |store| store.probe_operation::<WorkerStartOutcome>(&id, &fp))
                .await?
        };
        if let OperationReplay::Replay(outcome) = replay {
            return Ok(outcome);
        }
    }

    // Load the task and owning run.
    let task = {
        let id = input.task_id.clone();
        database.call(move |store| store.task(&id)).await?
    };
    let run = {
        let id = task.run_id.clone();
        database.call(move |store| store.orch_run(&id)).await?
    };
    if run.status != RunStatus::Active {
        return Err(Error::Invalid(
            "the run is settled; history is read-only".into(),
        ));
    }

    // ── Worktree (optional external resource) ──────────────────────────────
    let mut asset: Option<WorktreeAsset> = None;
    let worker_cwd = if mode == "new" {
        let cwd = input.cwd.clone();
        let stamp = to_base36(now() as u128);
        let name = format!("worker-{}-{}", task.id, stamp);
        let branch = format!("prospero/{}/{}/{}", task.run_id, task.id, stamp);
        let created = tokio::task::spawn_blocking(move || -> Result<(PathBuf, PathBuf, String)> {
            let repo = repo_root(Path::new(&cwd))?.ok_or_else(|| {
                Error::Invalid(format!("{cwd} 不在 git 仓库中，不能创建 worktree"))
            })?;
            let path = worktree_default_path(&repo, &name);
            create_worktree(
                &repo,
                &WorktreeCreate {
                    path: path.clone(),
                    branch: branch.clone(),
                },
            )?;
            Ok((canonical(&repo), canonical(&path), branch))
        })
        .await
        .map_err(|_| Error::Closed)??;
        let (repo, path, branch) = created;
        let registered = {
            let run_id = task.run_id.clone();
            let task_id = task.id.clone();
            let repo_text = repo.to_string_lossy().into_owned();
            let path_text = path.to_string_lossy().into_owned();
            database
                .call(move |store| {
                    store.register_worktree_asset(RegisterWorktree {
                        kind: WorktreeAssetKind::Worker,
                        run_id,
                        task_id: Some(task_id),
                        repo: repo_text,
                        path: path_text,
                        branch: Some(branch),
                    })
                })
                .await?
        };
        let cwd = registered.path.clone();
        asset = Some(registered);
        cwd
    } else {
        canonical(Path::new(&input.cwd))
            .to_string_lossy()
            .into_owned()
    };

    // ── Explicit skill bindings (strict: every name must resolve) ──────────
    // Mirrors legacy dispatch: undeclared `$mentions` in the spec are
    // rejected, and bound skills must exist and be readable in the worker cwd.
    let skill_names = {
        let worker_cwd = worker_cwd.clone();
        let spec = task.spec.clone();
        let requested = task.skills.clone();
        match tokio::task::spawn_blocking(move || -> Result<Vec<String>> {
            crate::skills::assert_mentions_bound(&spec, &requested)?;
            let resolved = crate::skills::resolve_explicit_skills(&worker_cwd, &requested)?;
            Ok(resolved.into_iter().map(|skill| skill.name).collect())
        })
        .await
        .map_err(|_| Error::Closed)?
        {
            Ok(names) => names,
            Err(error) => {
                // The worktree already exists on disk and is registered; a
                // strict skill failure must preserve it rather than orphan it.
                if let Some(asset) = &asset {
                    let id = asset.id.clone();
                    let message = format!(
                        "worker Skill 解析失败；已保留工作树和分支：{}",
                        error_message(&error)
                    );
                    let _ = database
                        .call(move |store| store.preserve_worktree_asset(&id, Some(&message)))
                        .await;
                }
                return Err(error);
            }
        }
    };

    // ── Agent session ──────────────────────────────────────────────────────
    let title = {
        let raw = format!("worker {}", task.title);
        if raw.chars().count() > 200 {
            let cut = raw.char_indices().nth(200).map_or(raw.len(), |(i, _)| i);
            format!("{}…", &raw[..cut])
        } else {
            raw
        }
    };
    let head = match agents
        .create(CreateAgentSession {
            agent: input.agent,
            title,
            workspace: worker_cwd.clone(),
            auto_approve: policy,
            mode: None,
            model: None,
            effort: None,
            account_id,
            resume: None,
        })
        .await
    {
        Ok(head) => head,
        Err(error) => {
            if let Some(asset) = &asset {
                let id = asset.id.clone();
                let message = format!(
                    "worker 会话创建失败；已保留工作树和分支：{}",
                    error_message(&error)
                );
                let _ = database
                    .call(move |store| store.preserve_worktree_asset(&id, Some(&message)))
                    .await;
            }
            return Err(error);
        }
    };

    // ── Dispatch row + asset link (one transaction) ────────────────────────
    let outcome = {
        let task_id = task.id.clone();
        let session_id = head.id.clone();
        let worktree_path = asset.as_ref().map(|value| value.path.clone());
        let asset_id = asset.as_ref().map(|value| value.id.clone());
        database
            .call(move |store| {
                let outcome =
                    store.dispatch_task(&task_id, &session_id, None, worktree_path.as_deref())?;
                if let Some(asset_id) = &asset_id {
                    store.link_worktree_dispatch(asset_id, &outcome.dispatch.id)?;
                }
                Ok(outcome)
            })
            .await
    };
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            // Never leave an orphaned agent process after a failed dispatch.
            let _ = agents.close(&head.id).await;
            if let Some(asset) = &asset {
                let id = asset.id.clone();
                let message = format!(
                    "worker 派发未完成；已保留工作树和分支：{}",
                    error_message(&error)
                );
                let _ = database
                    .call(move |store| store.preserve_worktree_asset(&id, Some(&message)))
                    .await;
            }
            return Err(error);
        }
    };

    // ── Worker brief, then running ─────────────────────────────────────────
    let prompt = worker_prompt(
        &outcome.task,
        &head.id,
        &worker_cwd,
        run.coordinator_session_id.as_deref(),
        &skill_names,
    );
    if let Err(error) = agents.send(&head.id, prompt, None, Vec::new()).await {
        let reason = format!("worker prompt delivery failed: {}", error_message(&error));
        let _ = agents.close(&head.id).await;
        let dispatch_id = outcome.dispatch.id.clone();
        let task_id = outcome.task.id.clone();
        let _ = database
            .call(move |store| {
                store.abandon_dispatch(&dispatch_id, &reason, TaskStatus::Failed)?;
                store.task(&task_id)
            })
            .await;
        return Err(error);
    }
    let dispatch_id = outcome.dispatch.id.clone();
    let dispatch = {
        let id = dispatch_id.clone();
        database
            .call(move |store| {
                let current = store.dispatch(&id)?;
                if current.state == DispatchState::Starting {
                    store.set_dispatch_running(&id)
                } else {
                    // A very fast manual delivery can already have settled it.
                    Ok(current)
                }
            })
            .await?
    };

    if asset.is_some() {
        let id = asset.as_ref().expect("asset present").id.clone();
        let refreshed = database
            .call(move |store| store.worktree_asset(&id))
            .await?;
        asset = Some(refreshed);
    }
    let result = WorkerStartOutcome {
        task: outcome.task,
        dispatch,
        session_id: head.id.clone(),
        worktree: asset,
    };
    if let Some(id) = &operation_id {
        let id = id.clone();
        let fp = request_fingerprint;
        let frozen = result.clone();
        database
            .call(move |store| store.remember_operation(&id, &fp, &frozen))
            .await?;
    }
    Ok(result)
}

/// Stop a live worker: kill its agent session and converge the dispatch to
/// abandoned (task fails by default; `cancelled` is opt-in). Killing an
/// already-gone session is a no-op, so retrying stop is safe: with no live
/// dispatch the latest dispatch and current task are returned.
pub async fn stop_worker(
    database: &Database,
    agents: &Agents,
    input: StopWorker,
) -> Result<SettleOutcome> {
    crate::database::validate_id(&input.task_id)?;
    let reason = input
        .reason
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "由用户停止 worker".into());
    validate_text(&reason, 8192, false)?;
    let final_status = match input.final_status.as_deref() {
        None | Some("failed") => TaskStatus::Failed,
        Some("cancelled") => TaskStatus::Cancelled,
        Some(_) => {
            return Err(Error::Invalid(
                "finalStatus must be failed or cancelled".into(),
            ));
        }
    };
    let live = {
        let id = input.task_id.clone();
        database
            .call(move |store| store.live_dispatch_for_task(&id))
            .await?
    };
    let Some(dispatch) = live else {
        // Idempotent replay shape: nothing live to stop.
        let task_id = input.task_id.clone();
        let task = database.call(move |store| store.task(&task_id)).await?;
        let run_id = task.run_id.clone();
        let dispatches = database
            .call(move |store| store.list_dispatches(Some(&run_id)))
            .await?;
        let dispatch = dispatches
            .into_iter()
            .filter(|candidate| candidate.task_id == task.id)
            .max_by_key(|candidate| candidate.started_at)
            .ok_or(Error::NotFound)?;
        return Ok(SettleOutcome { task, dispatch });
    };
    agents.close(&dispatch.session_id).await?;
    let dispatch_id = dispatch.id.clone();
    let reason_text = reason.clone();
    let outcome = database
        .call(move |store| store.abandon_dispatch(&dispatch_id, &reason_text, final_status))
        .await?;
    Ok(outcome)
}

/// Read-only inspection; the result is recorded on the asset.
pub async fn inspect_worktree(
    database: &Database,
    asset_id: &str,
    target_ref: Option<String>,
) -> Result<WorktreeInspection> {
    crate::database::validate_id(asset_id)?;
    let asset = {
        let id = asset_id.to_owned();
        database
            .call(move |store| store.worktree_asset(&id))
            .await?
    };
    let target = target_ref.unwrap_or_else(|| "HEAD".into());
    let inspected = {
        let path = asset.path.clone();
        let repo = asset.repo.clone();
        let branch = asset.branch.clone();
        let target = target.clone();
        tokio::task::spawn_blocking(move || {
            inspect_asset(
                Path::new(&path),
                Path::new(&repo),
                branch.as_deref(),
                &target,
                now(),
            )
        })
        .await
        .map_err(|_| Error::Closed)?
    };
    let id = asset.id.clone();
    let inspection = inspected.inspection.clone();
    database
        .call(move |store| store.record_worktree_inspection(&id, &inspection))
        .await?;
    Ok(inspected.inspection)
}

/// Explicit, freshly re-inspected cleanup. Every refusal state preserves the
/// directory; only `safe_to_clean`/`equivalent` after a new read-only pass can
/// proceed, and `git worktree remove` runs without force as the second gate.
pub async fn cleanup_worktree(
    database: &Database,
    asset_id: &str,
    request: CleanupWorktree,
) -> Result<WorktreeCleanupResult> {
    if !request.confirm {
        return Err(Error::Invalid(
            "清理工作树必须显式传 confirm: true；默认始终保留目录和分支".into(),
        ));
    }
    crate::database::validate_id(asset_id)?;
    let asset = {
        let id = asset_id.to_owned();
        database
            .call(move |store| store.worktree_asset(&id))
            .await?
    };
    // A delivered dispatch does not mean its structured session has exited;
    // never remove a tree a live session may still write into.
    let leases = {
        let path = asset.path.clone();
        database
            .call(move |store| store.active_sessions_under(&path))
            .await?
    };
    if !leases.is_empty() {
        let id = asset.id.clone();
        let message = format!(
            "会话 {} 仍在使用此工作树；已保留目录，待其终态后再清理",
            leases.join(", ")
        );
        let preserved = message.clone();
        let _ = database
            .call(move |store| store.preserve_worktree_asset(&id, Some(&preserved)))
            .await;
        return Err(Error::Invalid(message));
    }
    let target = request.target_ref.unwrap_or_else(|| "HEAD".into());
    let resolved = {
        let path = asset.path.clone();
        let repo = asset.repo.clone();
        let branch = asset.branch.clone();
        let target = target.clone();
        tokio::task::spawn_blocking(move || {
            inspect_asset(
                Path::new(&path),
                Path::new(&repo),
                branch.as_deref(),
                &target,
                now(),
            )
        })
        .await
        .map_err(|_| Error::Closed)?
    };
    let inspection = resolved.inspection.clone();
    let id = asset.id.clone();
    let recorded_inspection = inspection.clone();
    let recorded = database
        .call(move |store| store.record_worktree_inspection(&id, &recorded_inspection))
        .await?;
    if !matches!(
        inspection.state,
        WorktreeAssetState::SafeToClean | WorktreeAssetState::Equivalent
    ) {
        return Err(Error::Invalid(format!(
            "工作树当前为 {}，不能安全清理：{}",
            asset_state(inspection.state),
            inspection
                .message
                .as_deref()
                .unwrap_or("请先处理或显式保留")
        )));
    }
    let (Some(repo), Some(worktree_path), Some(source_commit)) = (
        resolved.repo,
        resolved.worktree_path,
        resolved.source_commit,
    ) else {
        return Err(Error::Invalid(
            "缺少可靠的源仓或待删分支提交；已保留工作树和分支".into(),
        ));
    };

    let removed = {
        let repo = repo.clone();
        let path = worktree_path.clone();
        tokio::task::spawn_blocking(move || {
            remove_worktree(Path::new(&repo), Path::new(&path), false)
        })
        .await
        .map_err(|_| Error::Closed)?
    };
    if let Err(error) = removed {
        return Err(Error::Invalid(format!(
            "Git 拒绝清理工作树；已保留目录和分支：{}",
            error_message(&error)
        )));
    }
    if Path::new(&worktree_path).exists() {
        return Err(Error::Invalid(
            "Git 返回成功但工作树路径仍存在；为避免误报，资产保持未清理状态".into(),
        ));
    }

    let mut branch_deleted = false;
    let mut warning: Option<String> = None;
    if request.delete_branch
        && let Some(branch) = &inspection.branch
    {
        let delete = {
            let repo = repo.clone();
            let branch = branch.clone();
            let commit = source_commit.clone();
            tokio::task::spawn_blocking(move || delete_branch(Path::new(&repo), &branch, &commit))
                .await
                .map_err(|_| Error::Closed)?
        };
        match delete {
            Ok(()) => branch_deleted = true,
            Err(error) => {
                warning = Some(format!(
                    "工作树已移除，但分支 {branch} 已保留：{}",
                    error_message(&error)
                ));
            }
        }
    }

    let cleanup = WorktreeCleanup {
        removed_at: now(),
        branch_deleted,
        warning: warning.clone(),
    };
    let id = asset.id.clone();
    let cleaned = database
        .call(move |store| store.mark_worktree_cleaned(&id, &cleanup))
        .await?;
    Ok(WorktreeCleanupResult {
        asset: cleaned,
        inspection: recorded.last_inspection.unwrap_or(inspection),
        branch_deleted,
        warning,
    })
}

fn asset_state(state: WorktreeAssetState) -> &'static str {
    match state {
        WorktreeAssetState::Active => "active",
        WorktreeAssetState::Preserved => "preserved",
        WorktreeAssetState::Missing => "missing",
        WorktreeAssetState::Dirty => "dirty",
        WorktreeAssetState::Unmerged => "unmerged",
        WorktreeAssetState::Equivalent => "equivalent",
        WorktreeAssetState::SafeToClean => "safe_to_clean",
        WorktreeAssetState::Cleaned => "cleaned",
        WorktreeAssetState::Unknown => "unknown",
    }
}

fn error_message(error: &Error) -> String {
    match error {
        Error::Invalid(message) => message.clone(),
        other => other.to_string(),
    }
}
