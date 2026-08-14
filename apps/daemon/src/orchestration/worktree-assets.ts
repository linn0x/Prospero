/**
 * 已登记编排 worktree 的只读核验与显式清理。
 *
 * 这里不尝试“聪明地自动回收”：检查只读取 Git 状态，清理必须带 confirm 并在
 * 删除前重新检查。默认只移除 worktree，保留分支作为可恢复锚点。
 */
import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { WorktreeAsset, WorktreeInspection } from "./model.js";
import { removeWorktree } from "./esaytree.js";
import { OrchestrationStore } from "./store.js";

const exec = promisify(execFile);
const MAX_GIT_BUFFER = 8 * 1024 * 1024;

export class WorktreeAssetError extends Error {
  constructor(
    message: string,
    readonly code: "worktree_not_cleanable" | "cleanup_confirmation_required" | "cleanup_failed",
  ) {
    super(message);
    this.name = "WorktreeAssetError";
  }
}

export interface CleanupWorktreeAssetInput {
  assetId: string;
  targetRef?: string;
  /** 这是删除目录的明确授权；没有它绝不调用 git worktree remove。 */
  confirm: boolean;
  /** 默认 false，worktree 移除后保留本地分支和 reflog 供恢复。 */
  deleteBranch?: boolean;
}

export interface CleanupWorktreeAssetResult {
  asset: WorktreeAsset;
  inspection: WorktreeInspection;
  branchDeleted: boolean;
  warning: string | null;
}

interface GitWorktreeRecord {
  path: string;
  branch: string | null;
}

/**
 * Git 生命周期专门放在 service，而不是 Store：Store 保持同步、内存真相模型，
 * 这里的 shell 调用全部可替换为纯只读检查，因而测试能直接覆核每种安全结论。
 */
export class WorktreeAssetService {
  constructor(private readonly store: OrchestrationStore) {}

  registerRun(input: {
    runId: string;
    repo: string;
    path: string;
    branch: string | null;
  }): WorktreeAsset {
    return this.store.registerWorktreeAsset({ kind: "run", ...input });
  }

  registerWorker(input: {
    runId: string;
    taskId: string;
    repo: string;
    path: string;
    branch: string | null;
  }): WorktreeAsset {
    return this.store.registerWorktreeAsset({ kind: "worker", ...input });
  }

  list(runId?: string): WorktreeAsset[] {
    return this.store.listWorktreeAssets(runId);
  }

  async inspect(assetId: string, targetRef = "HEAD"): Promise<WorktreeInspection> {
    const asset = this.store.getWorktreeAsset(assetId);
    const inspection = await inspectWorktreeAsset(asset, targetRef);
    this.store.recordWorktreeInspection(asset.id, inspection);
    return inspection;
  }

  /**
   * 删除入口会无条件再次 inspect，绝不相信前一次 UI/CLI 显示的安全状态。
   * dirty、未合并补丁、路径丢失和 Git 元数据异常都只能保留，不能强制删除。
   */
  async cleanup(input: CleanupWorktreeAssetInput): Promise<CleanupWorktreeAssetResult> {
    if (!input.confirm) {
      throw new WorktreeAssetError(
        "清理工作树必须显式传 confirm: true；默认始终保留目录和分支",
        "cleanup_confirmation_required",
      );
    }
    const asset = this.store.getWorktreeAsset(input.assetId);
    const inspection = await this.inspect(asset.id, input.targetRef ?? "HEAD");
    if (inspection.state !== "safe_to_clean" && inspection.state !== "equivalent") {
      throw new WorktreeAssetError(
        `工作树当前为 ${inspection.state}，不能安全清理：${inspection.message ?? "请先处理或显式保留"}`,
        "worktree_not_cleanable",
      );
    }

    try {
      // force:false 是第二道门：即使检查和删除之间又出现改动，Git 也会拒绝移除。
      // 分支分两步删，保证“删分支失败”不会否认已经安全完成的 worktree 移除。
      await removeWorktree(asset.repo, asset.path, { force: false, deleteBranch: false });
    } catch (error) {
      throw new WorktreeAssetError(
        `Git 拒绝清理工作树；已保留目录和分支：${errorMessage(error)}`,
        "cleanup_failed",
      );
    }

    if (pathExists(asset.path)) {
      throw new WorktreeAssetError(
        "Git 返回成功但工作树路径仍存在；为避免误报，资产保持未清理状态",
        "cleanup_failed",
      );
    }

    let branchDeleted = false;
    let warning: string | null = null;
    if (input.deleteBranch && inspection.branch) {
      try {
        await deleteLocalBranch(asset.repo, inspection.branch);
        branchDeleted = true;
      } catch (error) {
        // 默认恢复策略就是保留分支；显式删分支失败也要把这条可恢复信息写下来。
        warning = `工作树已移除，但分支 ${inspection.branch} 已保留：${errorMessage(error)}`;
      }
    }

    const cleaned = this.store.markWorktreeAssetCleaned(asset.id, {
      removedAt: Date.now(),
      branchDeleted,
      warning,
    });
    return { asset: cleaned, inspection, branchDeleted, warning };
  }
}

/** 可单测的纯只读 Git 检查；不会写 refs、工作区或索引。 */
export async function inspectWorktreeAsset(
  asset: WorktreeAsset,
  targetRef = "HEAD",
): Promise<WorktreeInspection> {
  const checkedAt = Date.now();
  if (!pathExists(asset.path)) {
    return inspection({
      state: "missing",
      targetRef,
      checkedAt,
      pathExists: false,
      registered: null,
      dirty: null,
      branch: asset.branch,
      aheadCommitCount: null,
      equivalentCommitCount: null,
      message: "登记的工作树路径已不存在；未执行任何删除操作",
    });
  }

  if (!isDirectory(asset.path)) {
    return inspection({
      state: "unknown",
      targetRef,
      checkedAt,
      pathExists: true,
      registered: null,
      dirty: null,
      branch: asset.branch,
      aheadCommitCount: null,
      equivalentCommitCount: null,
      message: "登记路径存在但不是目录；拒绝清理",
    });
  }

  try {
    const records = await listGitWorktrees(asset.repo);
    const canonicalAssetPath = canonicalPath(asset.path);
    const registered = records.find((record) => canonicalPath(record.path) === canonicalAssetPath) ?? null;
    if (!registered) {
      return inspection({
        state: "unknown",
        targetRef,
        checkedAt,
        pathExists: true,
        registered: false,
        dirty: null,
        branch: asset.branch,
        aheadCommitCount: null,
        equivalentCommitCount: null,
        message: "路径存在，但 Git 已不把它登记为此仓库的 worktree；拒绝清理",
      });
    }

    const status = await git(asset.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const dirty = status.length > 0;
    // asset.branch 是创建时的恢复锚点，不能在 detached 后拿它替代实际 HEAD。
    // 否则 worker 在 detached HEAD 上新增的提交会被错误地按旧分支判为安全。
    const current = shortBranch(registered.branch) ?? await currentBranch(asset.path);
    const branch = current;
    if (dirty) {
      return inspection({
        state: "dirty",
        targetRef,
        checkedAt,
        pathExists: true,
        registered: true,
        dirty: true,
        branch,
        aheadCommitCount: null,
        equivalentCommitCount: null,
        message: "工作树含 staged、unstaged 或未跟踪文件；请人工处理后再检查",
      });
    }

    // targetRef 必须在登记的源仓解析。若在待检查 worktree 内解析默认 HEAD，
    // 它会退化成该工作树自己的 HEAD，进而把任意分支误判为“已进入目标”。
    const targetCommit = (await git(asset.repo, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${targetRef}^{commit}`,
    ])).trim();
    // 即便 detached 也用 HEAD 做源 ref：只有 HEAD 已进入目标或补丁等价，才允许移除。
    const sourceRef = current ?? "HEAD";
    await git(asset.path, ["rev-parse", "--verify", "--quiet", `${sourceRef}^{commit}`]);
    if (await isAncestor(asset.path, sourceRef, targetCommit)) {
      return inspection({
        state: "safe_to_clean",
        targetRef,
        checkedAt,
        pathExists: true,
        registered: true,
        dirty: false,
        branch,
        aheadCommitCount: 0,
        equivalentCommitCount: 0,
        message: "工作树分支已被目标分支包含；可显式移除工作树",
      });
    }

    const aheadCommitCount = Number.parseInt(
      (await git(asset.path, ["rev-list", "--count", `${targetCommit}..${sourceRef}`])).trim(),
      10,
    );
    const cherry = (await git(asset.path, ["cherry", "-v", targetCommit, sourceRef]))
      .split("\n")
      .filter((line) => line !== "");
    const equivalentCommitCount = cherry.filter((line) => line.startsWith("-")).length;
    const hasUnmergedPatch = cherry.some((line) => line.startsWith("+"));
    // git cherry 不报告 merge commit；无法逐补丁证明等价时宁可归为 unmerged。
    if (
      aheadCommitCount > 0 &&
      !hasUnmergedPatch &&
      equivalentCommitCount > 0 &&
      equivalentCommitCount === aheadCommitCount
    ) {
      return inspection({
        state: "equivalent",
        targetRef,
        checkedAt,
        pathExists: true,
        registered: true,
        dirty: false,
        branch,
        aheadCommitCount,
        equivalentCommitCount,
        message: "分支提交的补丁已等价进入目标分支；可显式移除，默认保留分支",
      });
    }
    return inspection({
      state: "unmerged",
      targetRef,
      checkedAt,
      pathExists: true,
      registered: true,
      dirty: false,
      branch,
      aheadCommitCount: Number.isFinite(aheadCommitCount) ? aheadCommitCount : null,
      equivalentCommitCount,
      message: "分支仍有未等价进入目标分支的补丁；已保留，不能安全清理",
    });
  } catch (error) {
    return inspection({
      state: "unknown",
      targetRef,
      checkedAt,
      pathExists: true,
      registered: null,
      dirty: null,
      branch: asset.branch,
      aheadCommitCount: null,
      equivalentCommitCount: null,
      message: `无法完成只读 Git 检查；拒绝清理：${errorMessage(error)}`,
    });
  }
}

function inspection(value: WorktreeInspection): WorktreeInspection {
  return value;
}

async function listGitWorktrees(repo: string): Promise<GitWorktreeRecord[]> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  const records: GitWorktreeRecord[] = [];
  let current: Partial<GitWorktreeRecord> = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) records.push({ path: current.path, branch: current.branch ?? null });
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "" && current.path) {
      records.push({ path: current.path, branch: current.branch ?? null });
      current = {};
    }
  }
  if (current.path) records.push({ path: current.path, branch: current.branch ?? null });
  return records;
}

async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const value = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    return value || null;
  } catch {
    return null;
  }
}

async function isAncestor(cwd: string, source: string, target: string): Promise<boolean> {
  try {
    await exec("git", ["merge-base", "--is-ancestor", source, target], {
      cwd,
      maxBuffer: MAX_GIT_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

async function deleteLocalBranch(repo: string, branch: string): Promise<void> {
  const name = shortBranch(branch);
  if (!name) return;
  await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
  await git(repo, ["branch", "-D", "--", name]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: MAX_GIT_BUFFER });
    return stdout;
  } catch (error) {
    throw new Error(`git ${args.slice(0, 2).join(" ")} failed: ${errorMessage(error)}`);
  }
}

function pathExists(value: string): boolean {
  try {
    statSync(value);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function shortBranch(branch: string | null): string | null {
  if (!branch) return null;
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
