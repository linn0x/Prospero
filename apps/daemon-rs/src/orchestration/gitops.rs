//! Read-only git inspection and isolated worktree creation for orchestration
//! workers (Stage 8). Ported from the legacy `esaytree.ts` / `worktree-assets.ts`
//! safety matrix: a worktree may only be removed after a *fresh* read-only
//! inspection proves every patch is contained in the integration target.
//!
//! The CoW/clone-ignored-files machinery of the legacy implementation is
//! intentionally not ported — plain `git worktree add` is the supported Rust
//! mode; assets stay indexed on disk and are only ever deleted explicitly.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use ts_rs::TS;

use crate::error::{Error, Result};
use crate::orchestration::{WorktreeAssetState, WorktreeInspection};

fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|error| Error::Invalid(format!("无法启动 git：{error}")))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(Error::Invalid(detail));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Walk up to the repository top level; returns None when `start` is not in a
/// git work tree.
pub fn repo_root(start: &Path) -> Result<Option<PathBuf>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(start)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|error| Error::Invalid(format!("无法启动 git：{error}")))?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(PathBuf::from(
        String::from_utf8_lossy(&output.stdout).trim(),
    )))
}

/// Legacy convention: `<sibling of repo>/.prospero-worktrees/<repo name>/<name>`.
pub fn worktree_default_path(repo: &Path, name: &str) -> PathBuf {
    let parent = repo.parent().unwrap_or(Path::new("."));
    parent
        .join(".prospero-worktrees")
        .join(repo.file_name().unwrap_or_default())
        .join(name)
}

#[derive(Debug, Clone)]
pub struct WorktreeCreate {
    pub path: PathBuf,
    pub branch: String,
}

/// Create an isolated worktree with a fresh branch. The caller persists the
/// asset registration immediately *before* the worker session is created.
pub fn create_worktree(repo: &Path, request: &WorktreeCreate) -> Result<()> {
    if let Some(parent) = request.path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }
    if request.path.exists() {
        return Err(Error::Invalid(format!(
            "工作树目标已存在：{}",
            request.path.display()
        )));
    }
    let result = git(
        repo,
        &[
            "worktree",
            "add",
            "-b",
            &request.branch,
            "--",
            request.path.to_str().unwrap_or(""),
        ],
    );
    if result.is_err() {
        // Never leave a half-registered directory behind; prune git's record.
        let _ = git(repo, &["worktree", "prune"]);
        if request.path.exists() {
            let _ = std::fs::remove_dir_all(&request.path);
        }
        return result.map(|_| ());
    }
    Ok(())
}

/// Remove the worktree registration (keeping the recovery branch by default).
/// `force=false` is the second safety gate: git itself refuses when the tree
/// has uncommitted changes.
pub fn remove_worktree(repo: &Path, path: &Path, force: bool) -> Result<()> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path.to_str().unwrap_or(""));
    git(repo, &args).map(|_| ())
}

/// Compare-and-delete a local branch: git refuses unless the ref still points
/// at exactly `expected_commit`, so a branch that advanced after the cleanup
/// inspection stays recoverable instead of being force-deleted.
pub fn delete_branch(repo: &Path, branch: &str, expected_commit: &str) -> Result<()> {
    let name = branch.strip_prefix("refs/heads/").unwrap_or(branch).trim();
    if name.is_empty() {
        return Err(Error::Invalid("invalid branch name".into()));
    }
    git(
        repo,
        &[
            "update-ref",
            "-d",
            &format!("refs/heads/{name}"),
            expected_commit,
        ],
    )
    .map(|_| ())
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedInspection {
    pub inspection: WorktreeInspection,
    pub repo: Option<String>,
    pub worktree_path: Option<String>,
    pub source_commit: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn inspection(
    state: WorktreeAssetState,
    target_ref: &str,
    checked_at: i64,
    path_exists: bool,
    registered: Option<bool>,
    dirty: Option<bool>,
    branch: Option<String>,
    ahead: Option<i64>,
    equivalent: Option<i64>,
    message: &str,
) -> WorktreeInspection {
    WorktreeInspection {
        state,
        target_ref: target_ref.to_owned(),
        checked_at,
        path_exists,
        registered,
        dirty,
        branch,
        ahead_commit_count: ahead,
        equivalent_commit_count: equivalent,
        message: Some(message.to_owned()),
    }
}

fn canonical(path: &str) -> String {
    let cleaned = path.trim();
    std::fs::canonicalize(cleaned)
        .ok()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| cleaned.to_owned())
}

struct WorktreeRecord {
    path: String,
    branch: Option<String>,
}

fn list_worktrees(repo: &Path) -> Result<Vec<WorktreeRecord>> {
    let output = git(repo, &["worktree", "list", "--porcelain"])?;
    let mut records = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;
    let mut flush = |path: &mut Option<String>, branch: &mut Option<String>| {
        if let Some(value) = path.take() {
            let raw = branch.take();
            records.push(WorktreeRecord {
                path: value,
                branch: raw.map(|reference| {
                    reference
                        .strip_prefix("refs/heads/")
                        .unwrap_or(&reference)
                        .to_owned()
                }),
            });
        }
    };
    for line in output.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            flush(&mut current_path, &mut current_branch);
            current_path = Some(path.to_owned());
        } else if let Some(branch) = line.strip_prefix("branch ") {
            current_branch = Some(branch.to_owned());
        } else if line.is_empty() {
            flush(&mut current_path, &mut current_branch);
        }
    }
    flush(&mut current_path, &mut current_branch);
    Ok(records)
}

/// Read-only safety check. Never mutates refs, the index or the working tree;
/// the target ref is always resolved in the *source* repository, never in the
/// asset worktree (otherwise a worker-only commit proves itself "contained").
pub fn inspect_asset(
    asset_path: &Path,
    declared_repo: &Path,
    registered_branch: Option<&str>,
    target_ref: &str,
    checked_at: i64,
) -> ResolvedInspection {
    let missing = |message: &str| ResolvedInspection {
        inspection: inspection(
            WorktreeAssetState::Missing,
            target_ref,
            checked_at,
            false,
            None,
            None,
            registered_branch.map(str::to_owned),
            None,
            None,
            message,
        ),
        repo: None,
        worktree_path: None,
        source_commit: None,
    };
    let unknown = |message: &str| ResolvedInspection {
        inspection: inspection(
            WorktreeAssetState::Unknown,
            target_ref,
            checked_at,
            true,
            None,
            None,
            registered_branch.map(str::to_owned),
            None,
            None,
            message,
        ),
        repo: None,
        worktree_path: None,
        source_commit: None,
    };

    if !asset_path.exists() {
        return missing("登记的工作树路径已不存在；未执行任何删除操作");
    }
    if !asset_path.is_dir() {
        return unknown("登记路径存在但不是目录；拒绝清理");
    }

    let run = || -> Result<ResolvedInspection> {
        let top = git(asset_path, &["rev-parse", "--show-toplevel"])?
            .trim()
            .to_owned();
        let worktree_path = canonical(&top);
        let source_root = git(declared_repo, &["rev-parse", "--show-toplevel"])?
            .trim()
            .to_owned();
        let records = list_worktrees(Path::new(&source_root))?;
        let record = records
            .iter()
            .find(|candidate| canonical(&candidate.path) == worktree_path);
        let Some(record) = record else {
            return Ok(unknown(
                "路径存在，但 Git 已不把它登记为此仓库的 worktree；拒绝清理",
            ));
        };
        let repo = if canonical(&source_root) != worktree_path {
            source_root
        } else {
            // Self-referential legacy asset: the primary worktree is the only
            // reliable integration context.
            let Some(primary) = records.first() else {
                return Ok(unknown("没有独立主工作树可解析目标 ref"));
            };
            let primary_root = git(Path::new(&primary.path), &["rev-parse", "--show-toplevel"])?
                .trim()
                .to_owned();
            if canonical(&primary_root) == worktree_path {
                return Ok(unknown("源仓解析上下文与待检查 worktree 相同"));
            }
            primary_root
        };

        let status = git(
            asset_path,
            &["status", "--porcelain=v1", "--untracked-files=all"],
        )?;
        let branch = record.branch.clone().or_else(|| {
            git(asset_path, &["branch", "--show-current"])
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        });
        if !status.trim().is_empty() {
            return Ok(ResolvedInspection {
                inspection: inspection(
                    WorktreeAssetState::Dirty,
                    target_ref,
                    checked_at,
                    true,
                    Some(true),
                    Some(true),
                    branch,
                    None,
                    None,
                    "工作树含 staged、unstaged 或未跟踪文件；请人工处理后再检查",
                ),
                repo: Some(repo),
                worktree_path: Some(worktree_path),
                source_commit: None,
            });
        }

        let target_commit = git(
            Path::new(&repo),
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{target_ref}^{{commit}}"),
            ],
        )?
        .trim()
        .to_owned();
        let source_commit = git(
            asset_path,
            &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        )?
        .trim()
        .to_owned();

        if is_ancestor(Path::new(&repo), &source_commit, &target_commit)? {
            return Ok(ResolvedInspection {
                inspection: inspection(
                    WorktreeAssetState::SafeToClean,
                    target_ref,
                    checked_at,
                    true,
                    Some(true),
                    Some(false),
                    branch,
                    Some(0),
                    Some(0),
                    "工作树分支已被目标分支包含；可显式移除工作树",
                ),
                repo: Some(repo),
                worktree_path: Some(worktree_path),
                source_commit: Some(source_commit),
            });
        }

        let ahead: i64 = git(
            Path::new(&repo),
            &[
                "rev-list",
                "--count",
                &format!("{target_commit}..{source_commit}"),
            ],
        )?
        .trim()
        .parse()
        .unwrap_or(0);
        let cherry = git(
            Path::new(&repo),
            &["cherry", "-v", &target_commit, &source_commit],
        )?;
        let mut equivalent = 0_i64;
        let mut unmerged = false;
        for line in cherry.lines() {
            if line.starts_with('-') {
                equivalent += 1;
            } else if line.starts_with('+') {
                unmerged = true;
            }
        }

        let (state, message) = if ahead > 0 && !unmerged && equivalent > 0 && equivalent == ahead {
            (
                WorktreeAssetState::Equivalent,
                "分支提交的补丁已等价进入目标分支；可显式移除，默认保留分支",
            )
        } else {
            (
                WorktreeAssetState::Unmerged,
                "分支仍有未等价进入目标分支的补丁；已保留，不能安全清理",
            )
        };
        Ok(ResolvedInspection {
            inspection: inspection(
                state,
                target_ref,
                checked_at,
                true,
                Some(true),
                Some(false),
                branch,
                Some(ahead),
                Some(equivalent),
                message,
            ),
            repo: Some(repo),
            worktree_path: Some(worktree_path),
            source_commit: Some(source_commit),
        })
    };

    match run() {
        Ok(value) => value,
        Err(error) => unknown(&format!("无法完成只读 Git 检查；拒绝清理：{error}")),
    }
}

fn is_ancestor(repo: &Path, ancestor: &str, descendant: &str) -> Result<bool> {
    let status = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["merge-base", "--is-ancestor", ancestor, descendant])
        .status()
        .map_err(|error| Error::Invalid(format!("无法启动 git：{error}")))?;
    Ok(status.success())
}
