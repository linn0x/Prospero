/**
 * 已登记编排 worktree 的只读核验、显式清理与保守自动回收。
 *
 * inspect/cleanup 保持只读+显式确认:检查只读取 Git 状态,清理必须带 confirm 并在
 * 删除前重新检查。gc() 是 daemon 周期性自动回收,只处理"已确认可安全清理"的资产:
 * 所属 Run 非 active、无存活 SessionManager writer、分支已并入目标、且目录下无
 * 存活进程;dirty/unmerged/unknown/leased 一律保留。默认只移除 worktree,保留分支。
 */
import { execFile, spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { WorktreeAsset, WorktreeInspection } from "./model.js";
import { removeWorktree } from "./esaytree.js";
import { OrchestrationStore } from "./store.js";
import { findLiveLeaseForAsset, type WorktreeSessionInspector } from "./worktree-leases.js";

const exec = promisify(execFile);
const MAX_GIT_BUFFER = 8 * 1024 * 1024;

/** gc() 默认只回收创建超过此时间的资产;太新可能仍在派发/人工使用中。 */
const DEFAULT_GC_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** gc() 单轮实际删除上限,防止长时间占用事件循环。 */
const DEFAULT_GC_MAX_CLEANUPS = 20;
/** gc() 单轮只读检查预算;未来大量 unmerged/unknown 时避免全量 inspect。 */
const DEFAULT_GC_MAX_INSPECTED = 200;

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

/** 周期性自动回收的策略;所有字段可选,有保守默认值。 */
export interface WorktreeGcPolicy {
  /** 只回收创建超过此时长的资产;默认 24h。 */
  minAgeMs?: number;
  /** 单轮实际删除上限;默认 20。 */
  maxCleanups?: number;
  /** 单轮只读检查预算,防止未来堆积时全量 inspect 阻塞事件循环;默认 200。 */
  maxInspected?: number;
  /** 只读检查的集成目标 ref;默认 "HEAD"。 */
  targetRef?: string;
  /** 删除前的存活进程守卫;默认 lsof +D。测试可注入假实现。 */
  liveProcessGuard?: (worktreePath: string) => Promise<boolean>;
}

export interface WorktreeGcResult {
  checkedAt: number;
  /** 执行了只读检查的资产数(受 maxInspected 约束)。 */
  scanned: number;
  /** 实际移除的工作树。 */
  cleaned: number;
  /** 仍有存活 SessionManager writer,跳过。 */
  leased: number;
  /** 创建不足 minAgeMs,跳过。 */
  recent: number;
  /** 目录已不存在,仅记录检查,不删除。 */
  alreadyGone: number;
  /** 检查后仍不可安全清理(dirty/unmerged/unknown/守卫失败)。 */
  notCleanable: number;
  /** 所属 Run 仍 active,跳过。 */
  deferredActiveRun: number;
  /** 目录下有存活进程持有文件或 cwd,跳过。 */
  liveProcess: number;
  errors: { assetId: string; message: string }[];
}

interface GitWorktreeRecord {
  path: string;
  branch: string | null;
}

/** 与待检查资产不同的可靠源仓上下文。 */
interface ReliableRepoContext {
  repo: string;
  records: GitWorktreeRecord[];
  /** asset.path 可能是旧 Run worktree 里的 monorepo 子目录。 */
  worktreePath: string;
}

/** cleanup 删分支前必须保留的内部检查元数据。 */
interface ResolvedInspection {
  inspection: WorktreeInspection;
  repo: string | null;
  worktreePath: string | null;
  sourceCommit: string | null;
}

/** 测试 remove → 删分支竞争窗口的 seam；生产环境使用 removeWorktree。 */
interface WorktreeAssetOperations {
  remove(repo: string, target: string, opts: { force?: boolean; deleteBranch?: boolean }): Promise<void>;
}

const defaultWorktreeAssetOperations: WorktreeAssetOperations = {
  remove: removeWorktree,
};

/**
 * Git 生命周期专门放在 service，而不是 Store：Store 保持同步、内存真相模型，
 * 这里的 shell 调用全部可替换为纯只读检查，因而测试能直接覆核每种安全结论。
 */
export class WorktreeAssetService {
  constructor(
    private readonly store: OrchestrationStore,
    private readonly operations: WorktreeAssetOperations = defaultWorktreeAssetOperations,
    private readonly sessions?: WorktreeSessionInspector,
  ) {}

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
    const { inspection } = await inspectWorktreeAssetResolved(asset, targetRef);
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
    const resolved = await inspectWorktreeAssetResolved(asset, input.targetRef ?? "HEAD");
    const { inspection } = resolved;
    this.store.recordWorktreeInspection(asset.id, inspection);
    if (inspection.state !== "safe_to_clean" && inspection.state !== "equivalent") {
      throw new WorktreeAssetError(
        `工作树当前为 ${inspection.state}，不能安全清理：${inspection.message ?? "请先处理或显式保留"}`,
        "worktree_not_cleanable",
      );
    }
    if (!resolved.repo || !resolved.sourceCommit) {
      throw new WorktreeAssetError(
        "缺少可靠的源仓或待删分支提交；已保留工作树和分支",
        "cleanup_failed",
      );
    }

    // 已交付的 dispatch 不代表其结构化 session 已停止；若仍在消费旧队列，
    // 删除目录会把它变成继续写向已移除工作树的孤儿。删除前使用同一
    // SessionManager 的实时状态再核验一次，并把需后续处理的原因留在资产上。
    const lease = this.sessions ? findLiveLeaseForAsset(this.store, this.sessions, asset) : null;
    if (lease) {
      const message = `会话 ${lease.session.id} 仍在使用此工作树；已保留目录，待其终态后再清理`;
      this.store.preserveWorktreeAsset(asset.id, message);
      this.store.persistNow();
      throw new WorktreeAssetError(message, "worktree_not_cleanable");
    }

    try {
      // force:false 是第二道门：即使检查和删除之间又出现改动，Git 也会拒绝移除。
      // 分支分两步删，保证“删分支失败”不会否认已经安全完成的 worktree 移除。
      if (!resolved.worktreePath) {
        throw new Error("缺少可靠的 worktree 根目录");
      }
      await this.operations.remove(resolved.repo, resolved.worktreePath, {
        force: false,
        deleteBranch: false,
      });
    } catch (error) {
      throw new WorktreeAssetError(
        `Git 拒绝清理工作树；已保留目录和分支：${errorMessage(error)}`,
        "cleanup_failed",
      );
    }

    if (resolved.worktreePath && pathExists(resolved.worktreePath)) {
      throw new WorktreeAssetError(
        "Git 返回成功但工作树路径仍存在；为避免误报，资产保持未清理状态",
        "cleanup_failed",
      );
    }

    let branchDeleted = false;
    let warning: string | null = null;
    if (input.deleteBranch && inspection.branch) {
      try {
        await deleteLocalBranch(resolved.repo, inspection.branch, resolved.sourceCommit);
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

  /**
   * 周期性自动回收。只处理"已确认可安全清理"的资产,任何删除前都再次复核。
   *
   * 不变式(顺序即优先级):
   * 1. 已清理过(cleanup 已写)的跳过;
   * 2. 创建不足 minAgeMs 的跳过(recent);
   * 3. 所属 Run 仍 active 的跳过(deferredActiveRun)——run-mode 自动编排多
   *    worker 顺序共享同一个 run worktree,切换空档没有 live session,不能删;
   * 4. 仍有存活 SessionManager writer 的跳过(leased);
   * 5. 只读检查后仅 safe_to_clean/equivalent 可删;missing 只记账不标记 cleaned;
   * 6. 删除前再查一次 run 与 lease,并做存活进程守卫(lsof +D),缩窄竞态窗口。
   */
  async gc(policy: WorktreeGcPolicy = {}): Promise<WorktreeGcResult> {
    const now = Date.now();
    const minAgeMs = policy.minAgeMs ?? DEFAULT_GC_MIN_AGE_MS;
    const maxCleanups = policy.maxCleanups ?? DEFAULT_GC_MAX_CLEANUPS;
    const maxInspected = policy.maxInspected ?? DEFAULT_GC_MAX_INSPECTED;
    const targetRef = policy.targetRef ?? "HEAD";
    const liveProcessGuard = policy.liveProcessGuard ?? hasLiveProcessUnder;
    const result: WorktreeGcResult = {
      checkedAt: now,
      scanned: 0,
      cleaned: 0,
      leased: 0,
      recent: 0,
      alreadyGone: 0,
      notCleanable: 0,
      deferredActiveRun: 0,
      liveProcess: 0,
      errors: [],
    };
    // 先清最旧的;listWorktreeAssets 按 createdAt 降序,这里反转。
    const assets = this.store.listWorktreeAssets().sort((a, b) => a.createdAt - b.createdAt);
    for (const asset of assets) {
      if (result.cleaned >= maxCleanups || result.scanned >= maxInspected) break;
      if (asset.cleanup !== null) continue;
      if (now - asset.createdAt < minAgeMs) {
        result.recent += 1;
        continue;
      }
      if (this.isRunActive(asset.runId)) {
        result.deferredActiveRun += 1;
        continue;
      }
      if (this.sessions && findLiveLeaseForAsset(this.store, this.sessions, asset)) {
        result.leased += 1;
        continue;
      }

      const resolved = await inspectWorktreeAssetResolved(asset, targetRef);
      this.store.recordWorktreeInspection(asset.id, resolved.inspection);
      result.scanned += 1;

      if (resolved.inspection.state === "missing") {
        result.alreadyGone += 1;
        continue;
      }
      if (resolved.inspection.state !== "safe_to_clean" && resolved.inspection.state !== "equivalent") {
        result.notCleanable += 1;
        continue;
      }
      if (!resolved.repo || !resolved.worktreePath || !resolved.sourceCommit) {
        result.notCleanable += 1;
        result.errors.push({ assetId: asset.id, message: "缺少可靠的源仓或待删提交上下文;已保留" });
        continue;
      }

      // 删除前收窄 TOCTOU:Run 可能刚被派发、session 可能刚复活。
      if (this.isRunActive(asset.runId)) {
        result.deferredActiveRun += 1;
        continue;
      }
      if (this.sessions && findLiveLeaseForAsset(this.store, this.sessions, asset)) {
        result.leased += 1;
        continue;
      }
      try {
        if (await liveProcessGuard(resolved.worktreePath)) {
          result.liveProcess += 1;
          result.errors.push({
            assetId: asset.id,
            message: "目录下有存活进程持有文件或 cwd;已跳过自动回收",
          });
          continue;
        }
      } catch (error) {
        // 守卫不可靠时保守不删,而不是赌目录是空的。
        result.notCleanable += 1;
        result.errors.push({ assetId: asset.id, message: `存活进程守卫失败: ${errorMessage(error)}` });
        continue;
      }

      try {
        // force:false 是第二道门:检查后若出现新改动,Git 也会拒绝移除。
        await this.operations.remove(resolved.repo, resolved.worktreePath, {
          force: false,
          deleteBranch: false,
        });
        if (pathExists(resolved.worktreePath)) {
          throw new Error("Git 返回成功但工作树路径仍存在;资产保持未清理状态");
        }
        this.store.markWorktreeAssetCleaned(asset.id, {
          removedAt: Date.now(),
          branchDeleted: false,
          warning: null,
        });
        result.cleaned += 1;
      } catch (error) {
        result.errors.push({ assetId: asset.id, message: errorMessage(error) });
      }
    }
    return result;
  }

  private isRunActive(runId: string): boolean {
    try {
      return this.store.getRun(runId).status === "active";
    } catch {
      // Run 已删除:不视为 active;safe_to_clean/equivalent 门仍兜住未合并的 work。
      return false;
    }
  }
}

/** 可单测的纯只读 Git 检查；不会写 refs、工作区或索引。 */
export async function inspectWorktreeAsset(
  asset: WorktreeAsset,
  targetRef = "HEAD",
): Promise<WorktreeInspection> {
  return (await inspectWorktreeAssetResolved(asset, targetRef)).inspection;
}

async function inspectWorktreeAssetResolved(
  asset: WorktreeAsset,
  targetRef: string,
): Promise<ResolvedInspection> {
  const checkedAt = Date.now();
  if (!pathExists(asset.path)) {
    return unresolvedInspection({
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
    return unresolvedInspection({
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
    const context = await resolveReliableRepoContext(asset);
    const { repo, records, worktreePath } = context;
    const registered = records.find((record) => canonicalPath(record.path) === worktreePath) ?? null;
    if (!registered) {
      return unresolvedInspection({
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
      return resolvedInspection({
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
      }, repo, worktreePath);
    }

    // targetRef 绝不能在资产 worktree 中解析。v1 worker 的 repo === path，
    // 否则默认 HEAD 会把自己的独有提交误证为可安全清理。
    const targetCommit = (await git(repo, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${targetRef}^{commit}`,
    ])).trim();
    // branch 仅用于展示和待删分支；固定 worker 的真实 HEAD，避免 detached
    // worktree 被旧分支替代而误判。
    const sourceCommit = (await git(asset.path, [
      "rev-parse", "--verify", "--quiet", "HEAD^{commit}",
    ])).trim();
    if (await isAncestor(repo, sourceCommit, targetCommit)) {
      return resolvedInspection({
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
      }, repo, worktreePath, sourceCommit);
    }

    const aheadCommitCount = Number.parseInt(
      (await git(repo, ["rev-list", "--count", `${targetCommit}..${sourceCommit}`])).trim(),
      10,
    );
    const cherry = (await git(repo, ["cherry", "-v", targetCommit, sourceCommit]))
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
      return resolvedInspection({
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
      }, repo, worktreePath, sourceCommit);
    }
    return resolvedInspection({
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
    }, repo, worktreePath, sourceCommit);
  } catch (error) {
    return unresolvedInspection({
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

function unresolvedInspection(inspection: WorktreeInspection): ResolvedInspection {
  return { inspection, repo: null, worktreePath: null, sourceCommit: null };
}

function resolvedInspection(
  inspection: WorktreeInspection,
  repo: string,
  worktreePath: string,
  sourceCommit: string | null = null,
): ResolvedInspection {
  return { inspection, repo, worktreePath, sourceCommit };
}

/**
 * 新资产已记录源仓。v1 worker 迁移时只有 path，repo===path 必须改从同一 common
 * repository 的主 worktree 解析；没有独立上下文只能 unknown。
 */
async function resolveReliableRepoContext(asset: WorktreeAsset): Promise<ReliableRepoContext> {
  const worktreePath = canonicalPath(
    (await git(asset.path, ["rev-parse", "--show-toplevel"])).trim(),
  );
  const declaredRoot = canonicalPath((await git(asset.repo, ["rev-parse", "--show-toplevel"])).trim());
  const records = await listGitWorktrees(declaredRoot);
  if (!records.some((record) => canonicalPath(record.path) === worktreePath)) {
    throw new Error("登记路径不是候选源仓已登记的 worktree");
  }
  if (declaredRoot !== worktreePath) return { repo: declaredRoot, records, worktreePath };

  // `git worktree list` 的首项是主 worktree。它是 legacy 自指时唯一可靠的
  // 回退上下文，且必须和资产路径不同。
  const primary = records[0];
  if (!primary || canonicalPath(primary.path) === worktreePath) {
    throw new Error("legacy worker 没有独立主工作树可解析目标 ref");
  }
  const primaryRoot = canonicalPath(
    (await git(primary.path, ["rev-parse", "--show-toplevel"])).trim(),
  );
  if (primaryRoot === worktreePath) {
    throw new Error("legacy worker 的源仓解析上下文与待检查 worktree 相同");
  }
  return { repo: primaryRoot, records, worktreePath };
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

async function deleteLocalBranch(repo: string, branch: string, expectedCommit: string): Promise<void> {
  const name = shortBranch(branch);
  if (!name) return;
  // compare-and-delete 让检查后推进的提交成为可恢复 warning，而非被无条件
  // `branch -D` 丢失。
  await git(repo, ["update-ref", "-d", `refs/heads/${name}`, expectedCommit]);
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

/**
 * 目录下是否有存活进程持有文件或 cwd。lsof 把 cwd 当作一个打开的文件引用,
 * `+D` 递归列出该路径下所有被进程持有的文件,因此能同时覆盖"里面跑着进程"
 * 的两种情况。这是 gc() 自动回收新增的安全面:`git worktree remove` 对仅含
 * gitignored 文件(node_modules/dist)的 worktree 并不拒绝,而这类目录里可能
 * 还留着 SessionManager 之外的进程(如残留在 worktree 里的 --dev daemon)。
 */
export async function hasLiveProcessUnder(target: string): Promise<boolean> {
  // 注意:macOS 的 lsof 对 +D 无论是否找到匹配都以退出码 1 结束(实测确认),
  // 退出码完全不可信 —— 只能看 stdout 是否有内容,也因此不能用会按退出码
  // reject 的 execFile。异常(找不到 lsof、超时)仍向上抛,由 gc 保守跳过。
  return new Promise((resolve, reject) => {
    const child = spawn("lsof", ["+D", target], { stdio: ["ignore", "pipe", "pipe"] });
    let done = false;
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    // 排空 stderr,避免管道写满阻塞子进程。
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (done) return;
      out += chunk;
      if (out.length > 0) {
        // 只要有一个进程命中即可收工,不必等大目录搜完。
        done = true;
        clearTimeout(timer);
        child.kill();
        resolve(true);
      }
    });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === null) {
        reject(new Error("lsof 守卫超时或进程被终止;按保守原则交给调用方跳过"));
        return;
      }
      resolve(out.trim().length > 0);
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
