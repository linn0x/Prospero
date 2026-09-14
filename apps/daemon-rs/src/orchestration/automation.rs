//! Static DAG automation runner: one run-wide workspace, one worker at a time.

use std::path::{Path, PathBuf};

use crate::database::{now, validate_text};
use crate::error::{Error, Result};
use crate::worker::Database;

use super::gitops::{create_worktree, repo_root, worktree_default_path};
use super::workers::start_worker;
use super::{
    AutomationState, AutomationWorkspace, RegisterWorktree, Run, RunAutomation, RunStatus,
    StartAutomation, StartWorker, TaskStatus, WorktreeAssetKind,
};
use crate::agent::Agents;

fn canonical_directory(path: &str) -> Result<String> {
    let requested = PathBuf::from(path.trim());
    if !requested.is_absolute() {
        return Err(Error::Invalid("cwd must be absolute".into()));
    }
    let meta = std::fs::metadata(&requested).map_err(|_| {
        Error::Invalid(format!(
            "project directory does not exist: {}",
            requested.display()
        ))
    })?;
    if !meta.is_dir() {
        return Err(Error::Invalid(format!(
            "project path is not a directory: {}",
            requested.display()
        )));
    }
    Ok(std::fs::canonicalize(&requested)
        .unwrap_or(requested)
        .to_string_lossy()
        .into_owned())
}

fn relative_to(repo: &Path, cwd: &Path) -> PathBuf {
    cwd.strip_prefix(repo)
        .unwrap_or(Path::new(""))
        .to_path_buf()
}

pub async fn start_automation(
    database: &Database,
    agents: &Agents,
    input: StartAutomation,
) -> Result<Run> {
    validate_text(&input.approval_policy, 64, false)?;
    if !matches!(
        input.approval_policy.as_str(),
        "strict" | "standard" | "yolo"
    ) {
        return Err(Error::Invalid("approvalPolicy is invalid".into()));
    }
    if !matches!(
        input.agent,
        crate::protocol::AgentKind::Claude | crate::protocol::AgentKind::Codex
    ) {
        return Err(Error::Invalid(
            "automation currently supports Claude/Codex workers".into(),
        ));
    }
    let cwd = canonical_directory(&input.cwd)?;
    let (run, tasks) = database
        .call({
            let run_id = input.run_id.clone();
            move |store| {
                let run = store.orch_run(&run_id)?;
                let tasks = store.list_tasks(Some(&run_id))?;
                Ok((run, tasks))
            }
        })
        .await?;
    if run.coordinator_session_id.is_some() {
        return Err(Error::Invalid(
            "coordinator runs cannot enable static automation".into(),
        ));
    }
    if run.status != RunStatus::Active {
        return Err(Error::Invalid("run is not active".into()));
    }
    if tasks.is_empty() {
        return Err(Error::Invalid("task graph is empty".into()));
    }

    let mut workspace_path = cwd.clone();
    let mut branch = None;
    if input.workspace == AutomationWorkspace::Run {
        if let Some(existing) = &run.automation
            && existing.workspace == AutomationWorkspace::Run
            && existing.cwd == cwd
            && Path::new(&existing.workspace_path).is_dir()
        {
            workspace_path = existing.workspace_path.clone();
            branch = existing.branch.clone();
        }
        if branch.is_none() {
            let repo = repo_root(Path::new(&cwd))?
                .ok_or_else(|| Error::Invalid(format!("{cwd} is not in a git repository")))?;
            let stamp = crate::database::now().to_string();
            let name = format!("auto-{}-{stamp}", run.id);
            let branch_name = format!("prospero/{}/auto-{stamp}", run.id);
            let path = worktree_default_path(&repo, &name);
            create_worktree(
                &repo,
                &super::WorktreeCreate {
                    path: path.clone(),
                    branch: branch_name.clone(),
                },
            )?;
            let created_path = path.to_string_lossy().into_owned();
            database
                .call({
                    let run_id = run.id.clone();
                    let repo_s = repo.to_string_lossy().into_owned();
                    let path = created_path.clone();
                    let branch = Some(branch_name.clone());
                    move |store| {
                        store
                            .register_worktree_asset(RegisterWorktree {
                                kind: WorktreeAssetKind::Run,
                                run_id,
                                task_id: None,
                                repo: repo_s,
                                path,
                                branch,
                            })
                            .map(|_| ())
                    }
                })
                .await?;
            let subdir = relative_to(&repo, Path::new(&cwd));
            workspace_path = Path::new(&created_path)
                .join(subdir)
                .to_string_lossy()
                .into_owned();
            branch = Some(branch_name);
        }
    }

    let timestamp = now();
    database
        .call({
            let run_id = input.run_id.clone();
            let automation = RunAutomation {
                state: AutomationState::Running,
                agent: input.agent,
                account_id: input.account_id,
                approval_policy: input.approval_policy,
                workspace: input.workspace,
                cwd,
                workspace_path,
                branch,
                started_at: run
                    .automation
                    .as_ref()
                    .map(|value| value.started_at)
                    .unwrap_or(timestamp),
                updated_at: timestamp,
                last_error: None,
            };
            move |store| {
                store
                    .set_run_automation(&run_id, Some(automation))
                    .map(|_| ())
            }
        })
        .await?;
    tick_automation(database, agents, &input.run_id).await?;
    let run_id = input.run_id;
    database.call(move |store| store.orch_run(&run_id)).await
}

pub async fn pause_automation(database: &Database, run_id: &str) -> Result<Run> {
    let run_id = run_id.to_owned();
    database
        .call(move |store| store.pause_automation_with_error(&run_id, None))
        .await
}

pub async fn kick_automation(database: &Database, agents: &Agents, run_id: &str) {
    if let Err(error) = tick_automation(database, agents, run_id).await {
        let run_id = run_id.to_owned();
        let _ = database
            .call(move |store| {
                store
                    .pause_automation_with_error(
                        &run_id,
                        Some(format!("automation tick failed: {error}")),
                    )
                    .map(|_| ())
            })
            .await;
    }
}

pub async fn tick_automation(database: &Database, agents: &Agents, run_id: &str) -> Result<()> {
    let run_id = run_id.to_owned();
    let (run, tasks, ready, dispatches) = database
        .call({
            let run_id = run_id.clone();
            move |store| {
                Ok((
                    store.orch_run(&run_id)?,
                    store.list_tasks(Some(&run_id))?,
                    store.list_ready_tasks(&run_id)?,
                    store.list_dispatches(Some(&run_id))?,
                ))
            }
        })
        .await?;
    let Some(automation) = run.automation.clone() else {
        return Ok(());
    };
    if automation.state != AutomationState::Running || run.status != RunStatus::Active {
        return Ok(());
    }
    if tasks.is_empty() {
        pause_with_error(database, &run_id, "任务图为空，自动执行已暂停").await?;
        return Ok(());
    }
    if dispatches.iter().any(|dispatch| dispatch.state.active()) {
        return Ok(());
    }
    if tasks.iter().all(|task| task.status == TaskStatus::Done) {
        database
            .call(move |store| store.complete_run_from_automation(&run_id).map(|_| ()))
            .await?;
        return Ok(());
    }
    if let Some(stopped) = tasks.iter().find(|task| {
        matches!(
            task.status,
            TaskStatus::Failed | TaskStatus::Blocked | TaskStatus::Cancelled
        )
    }) {
        pause_with_error(
            database,
            &run_id,
            &format!(
                "任务“{}”处于 {}，请处理后继续",
                stopped.title,
                stopped.status.label()
            ),
        )
        .await?;
        return Ok(());
    }
    let Some(next) = ready.first() else {
        pause_with_error(
            database,
            &run_id,
            "当前没有可运行任务；请检查依赖或任务状态",
        )
        .await?;
        return Ok(());
    };
    let input = StartWorker {
        task_id: next.id.clone(),
        agent: automation.agent,
        cwd: automation.workspace_path.clone(),
        worktree: "none".into(),
        approval_policy: Some(automation.approval_policy.clone()),
        account_id: automation.account_id.clone(),
        operation_id: Some(format!("automation-{run_id}-{}", next.id)),
    };
    if let Err(error) = start_worker(database, agents, input).await {
        pause_with_error(
            database,
            &run_id,
            &format!("派发“{}”失败: {error}", next.title),
        )
        .await?;
    }
    Ok(())
}

async fn pause_with_error(database: &Database, run_id: &str, message: &str) -> Result<()> {
    let run_id = run_id.to_owned();
    let message = message.to_owned();
    database
        .call(move |store| {
            store
                .pause_automation_with_error(&run_id, Some(message))
                .map(|_| ())
        })
        .await
}
