#![cfg(unix)]
//! Stage 8 worktree lifecycle acceptance tests, run against a real throwaway
//! git repository (never the daemon author's own checkout). They cover the
//! read-only safety matrix ported from legacy — dirty / unmerged / equivalent
//! / safe_to_clean — plus the worker start/stop service and the session-lease
//! block on cleanup.

use std::path::{Path, PathBuf};
use std::process::Command;

use prosperod_rs::{
    agent::Agents,
    orchestration::{
        CleanupWorktree, CreateRun, CreateTask, RegisterWorktree, StartWorker, StopWorker,
        WorktreeAssetKind, WorktreeAssetState, WorktreeCreate, cleanup_worktree, create_worktree,
        inspect_worktree, start_worker, stop_worker, worktree_default_path,
    },
    protocol::{AgentKind, CreateSession, SessionKind, UpdateSession},
    worker::Database,
};
use tempfile::TempDir;

/// `PROSPERO_CLAUDE_BIN` is process-global, so every test that points the
/// daemon at a fake CLI must hold this lock for its whole lifetime.
static CLI_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Fake `claude` CLI: announce the init frame, swallow the prompt, then stay
/// alive until the daemon kills the process group (worker stop test). It writes
/// nothing into its working directory, so the worktree stays clean for the
/// post-stop inspection.
const FAKE_CLI: &str = r#"#!/usr/bin/env python3
import json, sys, time

sys.stdout.write(json.dumps({"type": "system", "subtype": "init", "session_id": "fake-worker-1"}) + "\n")
sys.stdout.flush()
sys.stdin.readline()
while True:
    time.sleep(1)
"#;

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn init_repo() -> (TempDir, PathBuf) {
    let directory = TempDir::new().unwrap();
    let repo = directory.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["symbolic-ref", "HEAD", "refs/heads/master"]);
    git(&repo, &["config", "user.email", "test@prospero.local"]);
    git(&repo, &["config", "user.name", "Prospero Test"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.join("README.md"), "# base\n").unwrap();
    git(&repo, &["add", "README.md"]);
    git(&repo, &["commit", "-q", "-m", "base"]);
    (directory, repo)
}

fn commit_in(path: &Path, name: &str, content: &str) -> String {
    std::fs::write(path.join(name), content).unwrap();
    git(path, &["add", name]);
    git(path, &["commit", "-q", "-m", name]);
    git(path, &["rev-parse", "HEAD"])
}

async fn register_worker_asset(
    database: &Database,
    run_id: &str,
    task_id: &str,
    repo: &Path,
    path: &Path,
    branch: &str,
) -> prosperod_rs::orchestration::WorktreeAsset {
    let run_id = run_id.to_owned();
    let task_id = task_id.to_owned();
    let repo = repo.to_path_buf();
    let path = path.to_path_buf();
    let branch = branch.to_owned();
    database
        .call(move |store| {
            store.register_worktree_asset(RegisterWorktree {
                kind: WorktreeAssetKind::Worker,
                run_id,
                task_id: Some(task_id),
                repo: repo.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                branch: Some(branch),
            })
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn safety_matrix_blocks_dirty_and_unmerged_then_allows_equivalent_cleanup() {
    let (directory, repo) = init_repo();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();

    let run = database
        .call({
            let repo = repo.clone();
            move |store| {
                let run = store.create_run(CreateRun {
                    objective: "worktree matrix".into(),
                    coordinator_session_id: None,
                })?;
                let task = store.create_task(CreateTask {
                    run_id: run.id.clone(),
                    title: "worker task".into(),
                    spec: "do it".into(),
                    skills: vec![],
                    deps: vec![],
                    parent_id: None,
                })?;
                let path = worktree_default_path(&repo, "worker-matrix-0001");
                create_worktree(
                    &repo,
                    &WorktreeCreate {
                        path: path.clone(),
                        branch: "prospero/matrix/0001".into(),
                    },
                )?;
                Ok((run.id, task.id, path))
            }
        })
        .await
        .unwrap();
    let (run_id, task_id, path) = run;
    let asset = register_worker_asset(
        &database,
        &run_id,
        &task_id,
        &repo,
        &path,
        "prospero/matrix/0001",
    )
    .await;
    let path = std::fs::canonicalize(&path).unwrap();

    // Fresh worktree, no commits: contained in master.
    let inspection = inspect_worktree(&database, &asset.id, Some("master".into()))
        .await
        .unwrap();
    assert_eq!(inspection.state, WorktreeAssetState::SafeToClean);

    // Cleanup always requires an explicit confirm.
    let unconfirmed = cleanup_worktree(
        &database,
        &asset.id,
        CleanupWorktree {
            target_ref: Some("master".into()),
            confirm: false,
            delete_branch: false,
        },
    )
    .await;
    assert!(unconfirmed.is_err());

    // A worker-only commit is unmerged and must stay on disk.
    let worker_commit = commit_in(&path, "worker-only.txt", "unique worker output\n");
    let inspection = inspect_worktree(&database, &asset.id, Some("master".into()))
        .await
        .unwrap();
    assert_eq!(inspection.state, WorktreeAssetState::Unmerged);
    let refused = cleanup_worktree(
        &database,
        &asset.id,
        CleanupWorktree {
            target_ref: Some("master".into()),
            confirm: true,
            delete_branch: false,
        },
    )
    .await;
    assert!(refused.is_err(), "unmerged cleanup must be refused");
    assert!(path.exists(), "refused cleanup never removes the tree");

    // Untracked file means dirty — also refused even after the branch lands.
    git(&repo, &["cherry-pick", &worker_commit]);
    std::fs::write(path.join("scratch.txt"), "leftover\n").unwrap();
    let inspection = inspect_worktree(&database, &asset.id, Some("master".into()))
        .await
        .unwrap();
    assert_eq!(inspection.state, WorktreeAssetState::Dirty);
    let refused = cleanup_worktree(
        &database,
        &asset.id,
        CleanupWorktree {
            target_ref: Some("master".into()),
            confirm: true,
            delete_branch: false,
        },
    )
    .await;
    assert!(refused.is_err(), "dirty cleanup must be refused");

    // Clean tree, patch cherry-picked onto master: equivalent, cleanup proceeds
    // and compare-deletes the branch.
    std::fs::remove_file(path.join("scratch.txt")).unwrap();
    let inspection = inspect_worktree(&database, &asset.id, Some("master".into()))
        .await
        .unwrap();
    assert_eq!(inspection.state, WorktreeAssetState::Equivalent);
    let result = cleanup_worktree(
        &database,
        &asset.id,
        CleanupWorktree {
            target_ref: Some("master".into()),
            confirm: true,
            delete_branch: true,
        },
    )
    .await
    .unwrap();
    assert!(result.branch_deleted);
    assert!(!path.exists());
    assert_eq!(result.asset.state, WorktreeAssetState::Cleaned);
    let branch_check = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["rev-parse", "--verify", "--quiet", "prospero/matrix/0001"])
        .status()
        .unwrap();
    assert!(!branch_check.success(), "recovery branch was deleted");
}

#[tokio::test]
async fn cleanup_is_blocked_by_a_live_session_lease_then_succeeds() {
    let (directory, repo) = init_repo();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();

    let path = worktree_default_path(&repo, "worker-lease-0001");
    create_worktree(
        &repo,
        &WorktreeCreate {
            path: path.clone(),
            branch: "prospero/lease/0001".into(),
        },
    )
    .unwrap();
    let canonical_path = std::fs::canonicalize(&path).unwrap();

    let (run_id, task_id, session_id, revision) = database
        .call({
            let path = canonical_path.clone();
            move |store| {
                let run = store.create_run(CreateRun {
                    objective: "lease".into(),
                    coordinator_session_id: None,
                })?;
                let task = store.create_task(CreateTask {
                    run_id: run.id.clone(),
                    title: "leased".into(),
                    spec: "lease".into(),
                    skills: vec![],
                    deps: vec![],
                    parent_id: None,
                })?;
                let head = store.create_session(CreateSession {
                    agent: AgentKind::Claude,
                    kind: SessionKind::Structured,
                    title: "worker lease".into(),
                    workspace: path.to_string_lossy().into_owned(),
                })?;
                Ok((run.id, task.id, head.id, head.revision))
            }
        })
        .await
        .unwrap();

    let asset = register_worker_asset(
        &database,
        &run_id,
        &task_id,
        &repo,
        &canonical_path,
        "prospero/lease/0001",
    )
    .await;

    // Active session whose workspace is the tree: cleanup refuses and preserves.
    let blocked = cleanup_worktree(
        &database,
        &asset.id,
        CleanupWorktree {
            target_ref: None,
            confirm: true,
            delete_branch: false,
        },
    )
    .await;
    assert!(blocked.is_err());
    let preserved = database
        .call({
            let id = asset.id.clone();
            move |store| store.worktree_asset(&id)
        })
        .await
        .unwrap();
    assert_eq!(preserved.state, WorktreeAssetState::Preserved);
    assert!(
        preserved
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("仍在使用此工作树"),
        "unexpected last_error: {:?}",
        preserved.last_error
    );

    // Archive the session; the same confirmed cleanup now goes through.
    database
        .call(move |store| {
            store.update_session(
                &session_id,
                UpdateSession {
                    revision,
                    title: None,
                    lifecycle: Some(prosperod_rs::protocol::SessionLifecycle::Archived),
                    status: None,
                },
            )
        })
        .await
        .unwrap();
    let result = cleanup_worktree(
        &database,
        &asset.id,
        CleanupWorktree {
            target_ref: None,
            confirm: true,
            delete_branch: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(result.asset.state, WorktreeAssetState::Cleaned);
    assert!(!canonical_path.exists());
}

#[tokio::test]
async fn externally_deleted_tree_is_reported_missing_not_cleaned() {
    let (directory, repo) = init_repo();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();
    let path = worktree_default_path(&repo, "worker-gone-0001");
    create_worktree(
        &repo,
        &WorktreeCreate {
            path: path.clone(),
            branch: "prospero/gone/0001".into(),
        },
    )
    .unwrap();
    let canonical_path = std::fs::canonicalize(&path).unwrap();
    let (run_id, task_id) = database
        .call(|store| {
            let run = store.create_run(CreateRun {
                objective: "missing".into(),
                coordinator_session_id: None,
            })?;
            let task = store.create_task(CreateTask {
                run_id: run.id.clone(),
                title: "gone".into(),
                spec: "gone".into(),
                skills: vec![],
                deps: vec![],
                parent_id: None,
            })?;
            Ok((run.id, task.id))
        })
        .await
        .unwrap();
    let asset = register_worker_asset(
        &database,
        &run_id,
        &task_id,
        &repo,
        &canonical_path,
        "prospero/gone/0001",
    )
    .await;
    git(
        &repo,
        &[
            "worktree",
            "remove",
            "--force",
            canonical_path.to_str().unwrap(),
        ],
    );

    let inspection = inspect_worktree(&database, &asset.id, None).await.unwrap();
    assert_eq!(inspection.state, WorktreeAssetState::Missing);
    let recorded = database
        .call(move |store| store.worktree_asset(&asset.id))
        .await
        .unwrap();
    assert_eq!(recorded.state, WorktreeAssetState::Missing);
}

#[tokio::test]
async fn worker_start_is_idempotent_and_stop_preserves_the_tree() {
    let (directory, repo) = init_repo();
    let _cli_env = CLI_ENV_LOCK.lock().await;
    let cli = directory.path().join("fake-claude.py");
    std::fs::write(&cli, FAKE_CLI).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
    }

    let database = Database::open(directory.path().join("data")).await.unwrap();
    let agents = Agents::new(database.clone());

    let (run_id, task_id) = database
        .call(|store| {
            let run = store.create_run(CreateRun {
                objective: "worker lifecycle".into(),
                coordinator_session_id: None,
            })?;
            let task = store.create_task(CreateTask {
                run_id: run.id.clone(),
                title: "ship it".into(),
                spec: "ship the thing".into(),
                skills: vec![],
                deps: vec![],
                parent_id: None,
            })?;
            Ok((run.id, task.id))
        })
        .await
        .unwrap();

    let outcome = start_worker(
        &database,
        &agents,
        StartWorker {
            agent: AgentKind::Claude,
            kind: None,
            skills: vec![],
            approval_policy: None,
            account_id: None,
            task_id: task_id.clone(),
            cwd: repo.to_string_lossy().into_owned(),
            worktree: "new".into(),
            operation_id: Some("op-worker-start-1".into()),
        },
    )
    .await
    .unwrap();

    let asset = outcome.worktree.expect("worktree registered");
    assert_eq!(asset.task_id.as_deref(), Some(task_id.as_str()));
    assert_eq!(asset.state, WorktreeAssetState::Active);
    assert_eq!(
        outcome.dispatch.worktree_path.as_deref(),
        Some(asset.path.as_str())
    );
    let tree_path = PathBuf::from(&asset.path);
    assert!(tree_path.exists());
    assert!(
        git(
            &repo,
            &["branch", "--list", asset.branch.as_deref().unwrap()]
        )
        .lines()
        .any(|line| !line.trim().is_empty())
    );

    // Retrying the same operation returns the frozen outcome and makes no
    // second worktree.
    let replay = start_worker(
        &database,
        &agents,
        StartWorker {
            agent: AgentKind::Claude,
            kind: None,
            skills: vec![],
            approval_policy: None,
            account_id: None,
            task_id: task_id.clone(),
            cwd: repo.to_string_lossy().into_owned(),
            worktree: "new".into(),
            operation_id: Some("op-worker-start-1".into()),
        },
    )
    .await
    .unwrap();
    assert_eq!(replay.dispatch.id, outcome.dispatch.id);
    let assets = database
        .call({
            let run_id = run_id.clone();
            move |store| store.list_worktree_assets(Some(&run_id))
        })
        .await
        .unwrap();
    assert_eq!(assets.len(), 1, "replay must not register another worktree");

    // Stop kills the fake CLI, converges the dispatch and preserves the tree.
    let stopped = stop_worker(
        &database,
        &agents,
        StopWorker {
            task_id: task_id.clone(),
            reason: Some("Stopped from Prospero desktop".into()),
            final_status: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        stopped.task.status,
        prosperod_rs::orchestration::TaskStatus::Failed
    );
    let asset_id = asset.id.clone();
    let preserved = database
        .call(move |store| store.worktree_asset(&asset_id))
        .await
        .unwrap();
    assert_eq!(preserved.state, WorktreeAssetState::Preserved);

    // Stopping again is an idempotent replay of the settled dispatch.
    let again = stop_worker(
        &database,
        &agents,
        StopWorker {
            task_id: task_id.clone(),
            reason: None,
            final_status: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(again.dispatch.id, stopped.dispatch.id);

    // The tree (branch still at base) is cleanable after the session archived.
    let cleaned = cleanup_worktree(
        &database,
        &asset.id,
        CleanupWorktree {
            target_ref: None,
            confirm: true,
            delete_branch: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(cleaned.asset.state, WorktreeAssetState::Cleaned);
    assert!(!tree_path.exists());
}

/// Fake `claude` CLI with a per-test capture path baked into the script (the
/// daemon environment is process-global, so the capture target must not depend
/// on another env var racing between parallel tests).
fn install_capture_cli(directory: &Path, capture: &Path) -> PathBuf {
    let cli = directory.join("fake-claude-capture.py");
    std::fs::write(
        &cli,
        format!(
            r#"#!/usr/bin/env python3
import json, sys, time

sys.stdout.write(json.dumps({{"type": "system", "subtype": "init", "session_id": "fake-worker-skills"}}) + "\n")
sys.stdout.flush()
target = {capture:?}
while True:
    line = sys.stdin.readline()
    if not line:
        break
    with open(target, "a", encoding="utf-8") as handle:
        handle.write(line)
    time.sleep(3600)
"#
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    cli
}

async fn create_run_task(database: &Database, spec: &str, skills: Vec<&str>) -> (String, String) {
    database
        .call({
            let spec = spec.to_owned();
            let skills = skills.into_iter().map(str::to_owned).collect::<Vec<_>>();
            move |store| {
                let run = store.create_run(CreateRun {
                    objective: "worker skills".into(),
                    coordinator_session_id: None,
                })?;
                let task = store.create_task(CreateTask {
                    run_id: run.id.clone(),
                    title: "skillful".into(),
                    spec,
                    skills,
                    deps: vec![],
                    parent_id: None,
                })?;
                Ok((run.id, task.id))
            }
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn opencode_worker_requires_chat_completions_profile() {
    let (directory, repo) = init_repo();
    let database = Database::open(directory.path().join("data")).await.unwrap();
    let agents = Agents::new(database.clone());
    let (_run_id, task_id) = create_run_task(&database, "use opencode", vec![]).await;

    let error = start_worker(
        &database,
        &agents,
        StartWorker {
            agent: AgentKind::Opencode,
            kind: None,
            skills: vec![],
            approval_policy: None,
            account_id: None,
            task_id: task_id.clone(),
            cwd: repo.to_string_lossy().into_owned(),
            worktree: "none".into(),
            operation_id: Some("opencode-worker-no-account".into()),
        },
    )
    .await
    .expect_err("OpenCode workers need an API profile account");
    assert!(
        format!("{error}").contains("OpenCode worker 需要"),
        "{error}"
    );
}

#[tokio::test]
async fn worker_expands_bound_skill_into_the_delivered_brief() {
    let (directory, repo) = init_repo();
    let _cli_env = CLI_ENV_LOCK.lock().await;
    let capture = directory.path().join("frames.jsonl");
    let cli = install_capture_cli(directory.path(), &capture);
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
    }

    // Commit a project skill so it is checked out into the new worktree.
    let skill_dir = repo.join(".claude/skills/review");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: review\ndescription: Review the change\n---\n# Review checklist\nRun cargo test before shipping.\n",
    )
    .unwrap();
    git(&repo, &["add", ".claude"]);
    git(&repo, &["commit", "-q", "-m", "skill"]);

    let database = Database::open(directory.path().join("data")).await.unwrap();
    let agents = Agents::new(database.clone());
    let (run_id, task_id) =
        create_run_task(&database, "请按 $review 检查本次改动", vec!["review"]).await;

    let outcome = start_worker(
        &database,
        &agents,
        StartWorker {
            agent: AgentKind::Claude,
            kind: None,
            skills: vec![],
            approval_policy: None,
            account_id: None,
            task_id: task_id.clone(),
            cwd: repo.to_string_lossy().into_owned(),
            worktree: "new".into(),
            operation_id: Some("op-worker-skills-1".into()),
        },
    )
    .await
    .unwrap();
    let asset = outcome.worktree.expect("worktree registered");

    // Wait for the brief frame to reach the fake CLI.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut raw = String::new();
    while deadline > std::time::Instant::now() {
        if let Ok(contents) = std::fs::read_to_string(&capture)
            && contents.contains("显式 Skills")
        {
            raw = contents;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(!raw.is_empty(), "worker brief never reached the CLI");
    let line = raw
        .lines()
        .find(|line| line.contains("显式 Skills"))
        .unwrap();
    let frame: serde_json::Value = serde_json::from_str(line).unwrap();
    let content = frame["message"]["content"].as_str().unwrap();
    assert!(content.contains("显式 Skills: $review"), "{content}");
    // The send path expands the `$review` mention against the worktree cwd.
    assert!(
        content.contains("[Prospero selected Agent Skills]"),
        "{content}"
    );
    assert!(
        content.contains("Run cargo test before shipping."),
        "{content}"
    );
    assert!(content.contains("请按 $review 检查本次改动"), "{content}");

    // Converge the worker and clean the tree like the operator would.
    stop_worker(
        &database,
        &agents,
        StopWorker {
            task_id: task_id.clone(),
            reason: Some("test teardown".into()),
            final_status: None,
        },
    )
    .await
    .unwrap();
    let cleaned = cleanup_worktree(
        &database,
        &asset.id,
        CleanupWorktree {
            target_ref: None,
            confirm: true,
            delete_branch: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(cleaned.asset.state, WorktreeAssetState::Cleaned);
    let _run_id = run_id;
}

#[tokio::test]
async fn worker_rejects_undeclared_skill_mention_and_preserves_the_tree() {
    let (directory, repo) = init_repo();
    let _cli_env = CLI_ENV_LOCK.lock().await;
    let cli = directory.path().join("fake-claude.py");
    std::fs::write(&cli, FAKE_CLI).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
    }

    let database = Database::open(directory.path().join("data")).await.unwrap();
    let agents = Agents::new(database.clone());
    // One bound skill, but the spec reaches for a different one. The check
    // only runs when at least one skill is bound — matching legacy dispatch.
    let (run_id, task_id) =
        create_run_task(&database, "please use $secret for this", vec!["review"]).await;

    let error = start_worker(
        &database,
        &agents,
        StartWorker {
            agent: AgentKind::Claude,
            kind: None,
            skills: vec![],
            approval_policy: None,
            account_id: None,
            task_id: task_id.clone(),
            cwd: repo.to_string_lossy().into_owned(),
            worktree: "new".into(),
            operation_id: Some("op-worker-skills-undeclared".into()),
        },
    )
    .await
    .expect_err("spec $mention without an explicit binding must fail");
    assert!(
        format!("{error}").contains("未显式绑定的 Skill: secret"),
        "{error}"
    );

    let run = run_id.clone();
    let assets = database
        .call(move |store| store.list_worktree_assets(Some(&run)))
        .await
        .unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].state, WorktreeAssetState::Preserved);
    assert!(
        assets[0]
            .last_error
            .as_deref()
            .is_some_and(|note| note.contains("未显式绑定")),
        "{:?}",
        assets[0].last_error
    );
    assert!(
        PathBuf::from(&assets[0].path).exists(),
        "tree must stay on disk"
    );
}

#[tokio::test]
async fn worker_rejects_missing_bound_skill_and_preserves_the_tree() {
    let (directory, repo) = init_repo();
    let _cli_env = CLI_ENV_LOCK.lock().await;
    let cli = directory.path().join("fake-claude.py");
    std::fs::write(&cli, FAKE_CLI).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
    }

    let database = Database::open(directory.path().join("data")).await.unwrap();
    let agents = Agents::new(database.clone());
    let (run_id, task_id) =
        create_run_task(&database, "普通任务，没有 mention", vec!["ghost"]).await;

    let error = start_worker(
        &database,
        &agents,
        StartWorker {
            agent: AgentKind::Claude,
            kind: None,
            skills: vec![],
            approval_policy: None,
            account_id: None,
            task_id: task_id.clone(),
            cwd: repo.to_string_lossy().into_owned(),
            worktree: "new".into(),
            operation_id: Some("op-worker-skills-missing".into()),
        },
    )
    .await
    .expect_err("a bound skill that cannot resolve must fail hard");
    assert!(
        format!("{error}").contains("找不到显式指定的 Skill: ghost"),
        "{error}"
    );

    let run = run_id.clone();
    let assets = database
        .call(move |store| store.list_worktree_assets(Some(&run)))
        .await
        .unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].state, WorktreeAssetState::Preserved);
    assert!(PathBuf::from(&assets[0].path).exists());
}
