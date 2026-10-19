//! Static DAG automation runner: one run-wide workspace, one worker at a time.

use std::path::{Path, PathBuf};

use crate::database::{now, validate_text};
use crate::error::{Error, Result};
use crate::worker::Database;

use super::gitops::{create_worktree, repo_root, worktree_default_path};
use super::start::start_worker;
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
        crate::protocol::AgentKind::Claude
            | crate::protocol::AgentKind::Codex
            | crate::protocol::AgentKind::Deepseek
            | crate::protocol::AgentKind::Opencode
    ) {
        return Err(Error::Invalid(
            "automation currently supports Claude/Codex/DeepSeek/OpenCode workers".into(),
        ));
    }
    if input.agent == crate::protocol::AgentKind::Deepseek && input.account_id.is_some() {
        return Err(Error::Invalid(
            "DeepSeek automation uses the native dsh account".into(),
        ));
    }
    if input.agent == crate::protocol::AgentKind::Opencode {
        let Some(account_id) = input.account_id.as_deref() else {
            return Err(Error::Invalid(
                "OpenCode automation requires an OpenAI Chat Completions API Profile".into(),
            ));
        };
        let data = database.directory().to_owned();
        let account_id = account_id.to_owned();
        let profile = database
            .call(move |store| Ok(store.managed_snapshot_row(&data, &account_id)?.api_profile))
            .await?;
        match profile.as_ref().map(|profile| profile.protocol()) {
            Some("openai_chat_completions") => {}
            _ => {
                return Err(Error::Invalid(
                    "OpenCode automation requires an OpenAI Chat Completions API Profile".into(),
                ));
            }
        }
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
        if pending_execution_error(&error) {
            return;
        }
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
    let (run, tasks, ready, dispatches, pending_execution) = database
        .call({
            let run_id = run_id.clone();
            move |store| {
                Ok((
                    store.orch_run(&run_id)?,
                    store.list_tasks(Some(&run_id))?,
                    store.list_ready_tasks(&run_id)?,
                    store.list_dispatches(Some(&run_id))?,
                    store.run_has_pending_execution(&run_id)?,
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
    if pending_execution || dispatches.iter().any(|dispatch| dispatch.state.active()) {
        return Ok(());
    }
    if tasks.iter().all(|task| task.status == TaskStatus::Done) {
        return match database
            .call(move |store| store.complete_run_from_automation(&run_id).map(|_| ()))
            .await
        {
            Err(error) if pending_execution_error(&error) => Ok(()),
            result => result,
        };
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
        kind: Some("structured".into()),
        skills: Vec::new(),
        approval_policy: Some(automation.approval_policy.clone()),
        account_id: automation.account_id.clone(),
        plugin_id: None,
        profile_id: None,
        operation_id: Some(format!("automation-{run_id}-{}", next.id)),
    };
    if let Err(error) = start_worker(database, agents, input).await {
        if pending_execution_error(&error) {
            return Ok(());
        }
        let id = run_id.clone();
        if database
            .call_control("automation.physical_wait", move |store| {
                store.run_has_pending_execution(&id)
            })
            .await?
        {
            return Ok(());
        }
        pause_with_error(
            database,
            &run_id,
            &format!("派发“{}”失败: {error}", next.title),
        )
        .await?;
    }
    Ok(())
}

fn pending_execution_error(error: &Error) -> bool {
    matches!(error,Error::Feature(code,_) if matches!(code.as_str(),"execution_pending"|"operation_pending"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::reliability::{
        ExecutionIdentity, ExecutionState, ExitProofKind, ExitProofVerifier, HostIdentity,
        NewExecution, VerifiedExitProof,
    };
    use crate::orchestration::{CreateRun, CreateTask};
    use crate::protocol::{AgentKind, SessionKind};
    use rusqlite::params;

    struct Fixture {
        _directory: tempfile::TempDir,
        database: Database,
        agents: Agents,
        run_id: String,
        session_id: String,
        identity: Option<ExecutionIdentity>,
    }

    async fn delivered_fixture(hosted: bool) -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("data")).await.unwrap();
        let agents = Agents::new(database.clone());
        let (run_id,session_id,identity)=database.call_control("test.automation.fixture",move|store|{
            let run=store.create_run(CreateRun{objective:"physical completion gate".into(),coordinator_session_id:None})?;
            let task=store.create_task(CreateTask{run_id:run.id.clone(),title:"delivered".into(),spec:"explicit delivery".into(),skills:vec![],deps:vec![],parent_id:None})?;
            let session=if hosted {
                store.create_session(crate::protocol::CreateSession{agent:AgentKind::Claude,kind:SessionKind::Structured,title:"hosted placeholder".into(),workspace:"/tmp".into()})?
            }else{
                store.create_agent_session(crate::agent::CreateAgentSession{agent:AgentKind::Claude,title:"direct worker".into(),workspace:"/tmp".into(),auto_approve:false,mode:None,model:None,effort:None,agent_preset:None,account_id:None,resume:None},crate::agent::ApprovalPolicy::Manual)?
            };
            let dispatch=store.dispatch_task(&task.id,&session.id,None,None)?.dispatch;
            let identity=if hosted {
                let identity=ExecutionIdentity{task_id:task.id,dispatch_id:Some(dispatch.id.clone()),attempt_id:session.id.clone(),execution_epoch:1,host:Some(HostIdentity{host_id:"automation-host".into(),host_epoch:"automation-epoch".into()}),config_digest:"a".repeat(64)};
                store.connection.execute("INSERT INTO orch_host_registry(host_id,host_epoch,protocol_version,runtime_digest,capabilities,registered_at,state) VALUES('automation-host','automation-epoch',1,?1,'[]',?2,'active')",params!["b".repeat(64),now()])?;
                store.reliability_transaction(|tx|{
                    super::super::reliability::insert_execution(tx,&NewExecution{identity:identity.clone(),state:ExecutionState::StopRequested,created_at:now()})?;
                    super::super::reliability::update_result_state(tx,&identity.attempt_id,1,super::super::reliability::ResultState::Accepted,now())
                })?;
                Some(identity)
            }else{None};
            store.settle_dispatch(&dispatch.id,true,"verified delivery")?;
            store.set_run_automation(&run.id,Some(RunAutomation{state:AutomationState::Running,agent:AgentKind::Claude,account_id:None,approval_policy:"standard".into(),workspace:AutomationWorkspace::Current,cwd:"/tmp".into(),workspace_path:"/tmp".into(),branch:None,started_at:now(),updated_at:now(),last_error:None}))?;
            Ok((run.id,session.id,identity))
        }).await.unwrap();
        Fixture {
            _directory: directory,
            database,
            agents,
            run_id,
            session_id,
            identity,
        }
    }

    async fn assert_waiting(fixture: &Fixture) {
        kick_automation(&fixture.database, &fixture.agents, &fixture.run_id).await;
        let id = fixture.run_id.clone();
        let run = fixture
            .database
            .call_control("test.automation.run", move |store| store.orch_run(&id))
            .await
            .unwrap();
        assert_eq!(run.status, RunStatus::Active);
        let automation = run.automation.unwrap();
        assert_eq!(automation.state, AutomationState::Running);
        assert!(automation.last_error.is_none());
    }

    #[tokio::test]
    async fn delivered_hosted_task_waits_without_pausing_until_exit_proof_then_completes() {
        let fixture = delivered_fixture(true).await;
        assert_waiting(&fixture).await;
        let identity = fixture.identity.clone().unwrap();
        let proof = VerifiedExitProof {
            proof_id: "automation-proof".into(),
            attempt_id: identity.attempt_id.clone(),
            execution_epoch: 1,
            host: identity.host.clone(),
            config_digest: identity.config_digest.clone(),
            kind: ExitProofKind::DriverQuiescence,
            verifier: ExitProofVerifier::Driver,
            evidence_digest: "c".repeat(64),
            verified_at: now(),
        };
        let run = super::super::reliability_operations::confirm_execution_exit(
            &fixture.database,
            identity.clone(),
            proof.clone(),
        )
        .await
        .unwrap();
        assert_eq!(run, fixture.run_id);
        assert_eq!(
            super::super::reliability_operations::confirm_execution_exit(
                &fixture.database,
                identity,
                proof
            )
            .await
            .unwrap(),
            fixture.run_id
        );
        kick_automation(&fixture.database, &fixture.agents, &run).await;
        assert_eq!(
            fixture
                .database
                .call_control("test.automation.completed", move |store| Ok(store
                    .orch_run(&run)?
                    .status))
                .await
                .unwrap(),
            RunStatus::Completed
        );
        fixture.database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn delivered_direct_task_waits_for_active_and_unknown_ownership_without_pausing() {
        let fixture = delivered_fixture(false).await;
        assert_waiting(&fixture).await;
        let session = fixture.session_id.clone();
        fixture
            .database
            .call_control("test.automation.stopping", move |store| {
                store
                    .archive_agent_session_for_stop(&session, false)
                    .map(|_| ())
            })
            .await
            .unwrap();
        assert_waiting(&fixture).await;
        let session = fixture.session_id.clone();
        fixture
            .database
            .call_control("test.automation.proved_idle", move |store| {
                store.clear_agent_execution_unknown(&session)
            })
            .await
            .unwrap();
        kick_automation(&fixture.database, &fixture.agents, &fixture.run_id).await;
        let id = fixture.run_id.clone();
        assert_eq!(
            fixture
                .database
                .call_control("test.automation.completed", move |store| Ok(store
                    .orch_run(&id)?
                    .status))
                .await
                .unwrap(),
            RunStatus::Completed
        );
        fixture.database.shutdown().await.unwrap();
    }
}
