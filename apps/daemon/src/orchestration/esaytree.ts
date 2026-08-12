/**
 * esaytree: 为 coding agent 创建快速、隔离、可回收的 Git 工作区。
 *
 * 快速路径不是先让 Git 把每个文件重新写一遍，而是：
 *   1. 建立 `--no-checkout` linked worktree；
 *   2. 用文件系统 CoW 克隆源工作区（不复制根 `.git`）；
 *   3. 清掉源工作区的本地改动，只保留目标 ref 的提交快照；
 *   4. 按需把完全被 Git 忽略的目录移回去，以复用依赖和构建缓存。
 *
 * 这样 clean tracked 文件和依赖目录都共享物理块，任一工作区第一次写入时才分裂，
 * 同时 staged / unstaged / untracked 状态不会泄漏给 worker。
 */
import { execFile } from "node:child_process";
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_GIT_BUFFER = 32 * 1024 * 1024;
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const ESAYTREE_SCHEMA = "esaytree.dev/cli/v1";
export const ESAYTREE_SCHEMA_VERSION = 1;

export type EsaytreeErrorCode =
  | "invalid_name"
  | "not_a_repo"
  | "worktree_exists"
  | "worktree_missing"
  | "unsafe_path"
  | "cow_unavailable"
  | "copy_failed"
  | "git_failed";

export class EsaytreeError extends Error {
  constructor(message: string, readonly code: EsaytreeErrorCode) {
    super(message);
    this.name = "EsaytreeError";
  }
}

// 兼容旧模块的公开类型名；新代码应使用 EsaytreeError。
export { EsaytreeError as WorktreeError };
export type WorktreeErrorCode = EsaytreeErrorCode;

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface ManagedWorktreeInfo extends WorktreeInfo {
  name: string;
}

export interface CloneReport {
  dir: string;
  /** true 表示文件系统确认使用 CoW；false 表示发生了真实复制。 */
  cow: boolean;
  ms: number;
  error?: string;
}

export type EsaytreeCreateMode = "copy-on-write" | "git-checkout";

export interface CreateWorktreeInput {
  repo: string;
  /** 工作区目录名，也用于默认存储路径。 */
  name: string;
  /** 目标路径；默认位于 defaultWorktreeRoot(repo)/name。 */
  at?: string;
  /** 起点 ref；默认当前 HEAD。 */
  baseRef?: string;
  /** 要新建的分支；省略时创建 detached worktree。 */
  branch?: string;
  /** 是否保留完全被 Git 忽略的目录（依赖、缓存等）；默认保留。 */
  cloneIgnored?: boolean;
  /** CoW 不可用时是否退回普通 Git checkout；默认退回。 */
  fallbackToCheckout?: boolean;
  /** fallback 时是否允许真实复制 ignored 目录；默认允许，以兼容既有行为。 */
  fallbackCopyIgnored?: boolean;
}

export interface CreateWorktreeResult {
  path: string;
  branch: string | null;
  mode: EsaytreeCreateMode;
  cow: boolean;
  clones: CloneReport[];
  preservedIgnored: string[];
  ms: number;
  fallbackReason?: string;
}

export interface EsaytreeDoctorReport {
  repo: string;
  root: string;
  gitVersion: string;
  cow: boolean;
  cowError?: string;
}

class CowCloneFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CowCloneFailure";
  }
}

/**
 * 用源仓 Git 元数据中的小文件做跨源/目标卷的强制 clonefile 探针。
 * 不能用空仓库“没有文件可复制”来推断 CoW 可用，也不能只在目标卷内部自拷贝，
 * 否则跨卷存储会被误报为可用。
 */
function assertCowAvailable(fromRepo: string, toDir: string): void {
  const dotGit = path.join(fromRepo, ".git");
  const source = lstatSync(dotGit).isFile() ? dotGit : path.join(dotGit, "HEAD");
  const probe = path.join(
    toDir,
    `.esaytree-cow-probe-${String(process.pid)}-${Date.now().toString(36)}`,
  );
  try {
    copyFileSync(source, probe, constants.COPYFILE_FICLONE_FORCE);
  } catch (error) {
    throw new CowCloneFailure(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(probe, { force: true });
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      maxBuffer: MAX_GIT_BUFFER,
    });
    return stdout;
  } catch (error) {
    const failure = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const detail = String(failure.stderr ?? failure.stdout ?? failure.message ?? error).trim();
    throw new EsaytreeError(
      `git ${args.slice(0, 2).join(" ")} 失败${detail ? `：${detail}` : ""}`,
      "git_failed",
    );
  }
}

async function tryGit(cwd: string, args: string[]): Promise<boolean> {
  try {
    await exec("git", args, { cwd, maxBuffer: MAX_GIT_BUFFER });
    return true;
  } catch {
    return false;
  }
}

/** 当前工作区的仓库根目录；不在仓库中时返回 null。 */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function validateEsaytreeName(name: string): void {
  if (!TASK_NAME.test(name)) {
    throw new EsaytreeError(
      `无效的 esaytree 名称“${name}”；仅允许字母、数字、点、下划线和短横线，且必须以字母或数字开头`,
      "invalid_name",
    );
  }
}

export async function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  const result: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) result.push(finishWorktree(current));
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
    } else if (line === "" && current.path) {
      result.push(finishWorktree(current));
      current = {};
    }
  }
  if (current.path) result.push(finishWorktree(current));
  return result;
}

function finishWorktree(partial: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    path: partial.path ?? "",
    branch: partial.branch ?? null,
    head: partial.head ?? "",
    detached: partial.detached ?? partial.branch === undefined,
    locked: partial.locked ?? false,
    prunable: partial.prunable ?? false,
  };
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    // 目标尚不存在时也要解析最近的既存祖先。macOS 的 /var → /private/var
    // 会让单纯 path.resolve 得到两个不同字符串，进而漏掉“目标在源目录内”。
    const suffix: string[] = [];
    let cursor = resolved;
    while (!pathExists(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
    try {
      return path.join(realpathSync(cursor), ...suffix);
    } catch {
      return resolved;
    }
  }
}

function pathExists(value: string): boolean {
  try {
    lstatSync(value);
    return true;
  } catch {
    return false;
  }
}

function isSameOrInside(root: string, candidate: string): boolean {
  const rel = path.relative(canonicalPath(root), canonicalPath(candidate));
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

function isStrictlyInside(root: string, candidate: string): boolean {
  const rel = path.relative(canonicalPath(root), canonicalPath(candidate));
  return rel !== "" && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * 返回完全被 Git 忽略的目录。`--directory` 会折叠整棵 ignored 子树，避免遍历
 * node_modules 等巨型目录；`-z` 让空格和换行文件名也能被无损解析。
 */
export async function ignoredDirs(repo: string): Promise<string[]> {
  const out = await git(repo, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--directory",
    "--exclude-standard",
  ]);
  return out
    .split("\0")
    .map((line) => line.endsWith("/") ? line.slice(0, -1) : line)
    .filter((line) => line !== "")
    .filter((rel) => {
      if (!isStrictlyInside(repo, path.join(repo, rel))) return false;
      try {
        return statSync(path.join(repo, rel)).isDirectory();
      } catch {
        return false;
      }
    });
}

/** 单独克隆 ignored 目录；普通 checkout fallback 使用这一兼容路径。 */
export function cloneIgnoredDirs(
  from: string,
  to: string,
  dirs: string[],
  opts: { allowPhysicalCopy?: boolean } = {},
): CloneReport[] {
  const reports: CloneReport[] = [];
  for (const rel of dirs) {
    const src = path.join(from, rel);
    const dst = path.join(to, rel);
    if (!existsSync(src)) continue;
    const started = Date.now();
    mkdirSync(path.dirname(dst), { recursive: true });
    try {
      cpSync(src, dst, { recursive: true, mode: constants.COPYFILE_FICLONE_FORCE });
      reports.push({ dir: rel, cow: true, ms: Date.now() - started });
      continue;
    } catch (cowError) {
      if (opts.allowPhysicalCopy === false) {
        // recursive clone 可能已经写出了一部分；不能把残缺依赖伪装成可用缓存。
        rmSync(dst, { recursive: true, force: true });
        reports.push({
          dir: rel,
          cow: false,
          ms: Date.now() - started,
          error: cowError instanceof Error ? cowError.message : String(cowError),
        });
        continue;
      }
      try {
        rmSync(dst, { recursive: true, force: true });
        cpSync(src, dst, { recursive: true });
        reports.push({ dir: rel, cow: false, ms: Date.now() - started });
      } catch (copyError) {
        reports.push({
          dir: rel,
          cow: false,
          ms: Date.now() - started,
          error: copyError instanceof Error ? copyError.message : String(copyError),
        });
      }
    }
  }
  return reports;
}

function cloneRepositoryCow(from: string, to: string): CloneReport {
  const started = Date.now();
  try {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const src = path.join(from, entry.name);
      // 兼容显式把 worktree 放在源仓内部的旧调用，避免把目标递归复制进自己。
      if (isSameOrInside(src, to)) continue;
      cpSync(src, path.join(to, entry.name), {
        recursive: true,
        mode: constants.COPYFILE_FICLONE_FORCE,
      });
    }
    return { dir: ".", cow: true, ms: Date.now() - started };
  } catch (error) {
    throw new CowCloneFailure(error instanceof Error ? error.message : String(error));
  }
}

interface PreservedDirs {
  staging: string;
  dirs: string[];
}

function stageIgnoredDirs(target: string, dirs: string[]): PreservedDirs | null {
  let staging: string | null = null;
  const moved: string[] = [];
  for (const rel of dirs) {
    const source = path.join(target, rel);
    if (!pathExists(source) || !isStrictlyInside(target, source)) continue;
    staging ??= mkdtempSync(path.join(path.dirname(target), ".esaytree-preserve-"));
    const destination = path.join(staging, rel);
    mkdirSync(path.dirname(destination), { recursive: true });
    renameSync(source, destination);
    moved.push(rel);
  }
  return staging ? { staging, dirs: moved } : null;
}

function restoreIgnoredDirs(target: string, preserved: PreservedDirs | null): void {
  if (!preserved) return;
  for (const rel of preserved.dirs) {
    const source = path.join(preserved.staging, rel);
    if (!pathExists(source)) continue;
    const destination = path.join(target, rel);
    mkdirSync(path.dirname(destination), { recursive: true });
    renameSync(source, destination);
  }
}

function pathChunks(paths: string[], maxBytes = 32 * 1024): string[][] {
  const result: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const value of paths) {
    const size = Buffer.byteLength(value) + 1;
    if (current.length > 0 && bytes + size > maxBytes) {
      result.push(current);
      current = [];
      bytes = 0;
    }
    current.push(value);
    bytes += size;
  }
  if (current.length > 0) result.push(current);
  return result;
}

/** 把 CoW 克隆出来的源工作区还原成目标 HEAD 的干净提交快照。 */
async function restoreCommittedSnapshot(
  target: string,
  preservedIgnored: string[],
): Promise<string[]> {
  const preserved = stageIgnoredDirs(target, preservedIgnored);
  try {
    await git(target, ["reset", "--quiet", "--mixed", "HEAD"]);
    // 先删掉目标 ref 不认识的文件，避免“源是目录、目标是文件”等形态冲突。
    await git(target, ["clean", "-ffdx", "-q"]);
    const changed = (await git(target, ["diff", "--no-renames", "--name-only", "-z"]))
      .split("\0")
      .filter((value) => value !== "");
    for (const chunk of pathChunks(changed)) {
      await git(target, ["checkout", "-q", "--", ...chunk]);
    }
    restoreIgnoredDirs(target, preserved);
    const status = await git(target, ["status", "--porcelain"]);
    if (status.trim() !== "") {
      throw new EsaytreeError(`创建后的工作区不是干净快照：${status.trim()}`, "git_failed");
    }
    return preserved?.dirs ?? [];
  } finally {
    if (preserved) rmSync(preserved.staging, { recursive: true, force: true });
  }
}

function addArgs(
  target: string,
  baseRef: string,
  branch: string | undefined,
  noCheckout: boolean,
): string[] {
  const args = ["worktree", "add"];
  if (noCheckout) args.push("--no-checkout");
  if (branch) args.push("-b", branch);
  else args.push("--detach");
  args.push(target, baseRef);
  return args;
}

async function rollbackCreatedWorktree(
  repo: string,
  target: string,
  branch: string | undefined,
): Promise<void> {
  await tryGit(repo, ["worktree", "remove", "--force", target]);
  // 目标在调用前已确认不存在，因此这里只会清理由本次 create 留下的残片。
  if (pathExists(target)) rmSync(target, { recursive: true, force: true });
  await tryGit(repo, ["worktree", "prune"]);
  if (branch) await tryGit(repo, ["branch", "-D", "--", branch]);
}

export function defaultWorktreeRoot(repo: string): string {
  const configured = process.env["ESAYTREE_ROOT"]?.trim();
  const normalizedRepo = canonicalPath(repo);
  if (configured) return path.join(canonicalPath(configured), path.basename(normalizedRepo));
  return path.join(
    path.dirname(normalizedRepo),
    ".prospero-worktrees",
    path.basename(normalizedRepo),
  );
}

export async function createWorktree(input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
  const started = Date.now();
  validateEsaytreeName(input.name);
  const root = await repoRoot(input.repo);
  if (!root) throw new EsaytreeError(`${input.repo} 不在 Git 仓库中`, "not_a_repo");

  const target = path.resolve(input.at ?? path.join(defaultWorktreeRoot(root), input.name));
  if (canonicalPath(target) === canonicalPath(root) || isSameOrInside(path.join(root, ".git"), target)) {
    throw new EsaytreeError(`拒绝把 esaytree 建在源仓或 .git 内：${target}`, "unsafe_path");
  }
  if (pathExists(target)) {
    throw new EsaytreeError(`目标已存在：${target}`, "worktree_exists");
  }

  const branch = input.branch;
  const baseRef = input.baseRef?.trim() || "HEAD";
  const keepIgnored = input.cloneIgnored !== false;
  const dirs = keepIgnored ? await ignoredDirs(root) : [];
  mkdirSync(path.dirname(target), { recursive: true });

  let added = false;
  try {
    await git(root, addArgs(target, baseRef, branch, true));
    added = true;
    assertCowAvailable(root, target);
    const clone = cloneRepositoryCow(root, target);
    const preservedIgnored = await restoreCommittedSnapshot(target, dirs);
    return {
      path: target,
      branch: branch ?? null,
      mode: "copy-on-write",
      cow: true,
      clones: [clone],
      preservedIgnored,
      ms: Date.now() - started,
    };
  } catch (error) {
    if (added) await rollbackCreatedWorktree(root, target, branch);
    if (!(error instanceof CowCloneFailure)) throw error;
    if (input.fallbackToCheckout === false) {
      throw new EsaytreeError(`当前文件系统无法完成 CoW 克隆：${error.message}`, "cow_unavailable");
    }

    let fallbackAdded = false;
    try {
      await git(root, addArgs(target, baseRef, branch, false));
      fallbackAdded = true;
      const clones = keepIgnored
        ? cloneIgnoredDirs(root, target, dirs, {
            allowPhysicalCopy: input.fallbackCopyIgnored !== false,
          })
        : [];
      return {
        path: target,
        branch: branch ?? null,
        mode: "git-checkout",
        cow: false,
        clones,
        preservedIgnored: clones.filter((item) => !item.error).map((item) => item.dir),
        ms: Date.now() - started,
        fallbackReason: error.message,
      };
    } catch (fallbackError) {
      if (fallbackAdded) await rollbackCreatedWorktree(root, target, branch);
      throw fallbackError;
    }
  }
}

/** esaytree 的品牌化入口；createWorktree 保留给已有编排调用方兼容。 */
export const createEsaytree = createWorktree;

export async function listManagedWorktrees(repo: string): Promise<ManagedWorktreeInfo[]> {
  const root = await repoRoot(repo);
  if (!root) throw new EsaytreeError(`${repo} 不在 Git 仓库中`, "not_a_repo");
  const managedRoot = defaultWorktreeRoot(root);
  const result: ManagedWorktreeInfo[] = [];
  for (const worktree of await listWorktrees(root)) {
    if (!isStrictlyInside(managedRoot, worktree.path)) continue;
    const name = path.relative(canonicalPath(managedRoot), canonicalPath(worktree.path));
    if (name.includes(path.sep) || !TASK_NAME.test(name)) continue;
    result.push({ ...worktree, name });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveManagedWorktree(repo: string, name: string): Promise<ManagedWorktreeInfo> {
  validateEsaytreeName(name);
  const root = await repoRoot(repo);
  if (!root) throw new EsaytreeError(`${repo} 不在 Git 仓库中`, "not_a_repo");
  const managedRoot = defaultWorktreeRoot(root);
  const target = path.join(managedRoot, name);
  if (!pathExists(target) || !isStrictlyInside(managedRoot, target)) {
    throw new EsaytreeError(`esaytree 不存在：${name}`, "worktree_missing");
  }
  const canonicalTarget = canonicalPath(target);
  const worktree = (await listWorktrees(root)).find(
    (candidate) => canonicalPath(candidate.path) === canonicalTarget,
  );
  if (!worktree) throw new EsaytreeError(`esaytree 未登记或已损坏：${name}`, "worktree_missing");
  return { ...worktree, name };
}

/**
 * 移除一个已登记 worktree。默认保留分支；显式 deleteBranch 才丢弃分支历史。
 */
export async function removeWorktree(
  repo: string,
  target: string,
  opts: { force?: boolean; deleteBranch?: boolean } = {},
): Promise<void> {
  const root = await repoRoot(repo);
  if (!root) throw new EsaytreeError(`${repo} 不在 Git 仓库中`, "not_a_repo");
  const canonicalTarget = canonicalPath(target);
  const known = (await listWorktrees(root)).find(
    (worktree) => canonicalPath(worktree.path) === canonicalTarget,
  );
  if (!known) throw new EsaytreeError(`不是本仓已登记的 worktree：${target}`, "worktree_missing");

  const args = ["worktree", "remove"];
  if (opts.force !== false) args.push("--force");
  args.push(target);
  await git(root, args);
  await git(root, ["worktree", "prune"]);
  if (opts.deleteBranch && known.branch?.startsWith("refs/heads/")) {
    await git(root, ["branch", "-D", "--", known.branch.slice("refs/heads/".length)]);
  }
}

export async function removeManagedWorktree(
  repo: string,
  name: string,
  opts: { force?: boolean; deleteBranch?: boolean } = {},
): Promise<void> {
  const task = await resolveManagedWorktree(repo, name);
  await removeWorktree(repo, task.path, opts);
}

/** 检查 Git 仓库和目标文件系统是否支持强制 CoW。 */
export async function diagnoseEsaytree(repo: string): Promise<EsaytreeDoctorReport> {
  const root = await repoRoot(repo);
  if (!root) throw new EsaytreeError(`${repo} 不在 Git 仓库中`, "not_a_repo");
  const gitVersion = (await git(root, ["--version"])).trim();
  const storageRoot = defaultWorktreeRoot(root);
  mkdirSync(path.dirname(storageRoot), { recursive: true });
  const probe = mkdtempSync(path.join(path.dirname(storageRoot), ".esaytree-doctor-"));
  let cow = false;
  let cowError: string | undefined;
  try {
    try {
      assertCowAvailable(root, probe);
      cow = true;
    } catch (error) {
      cowError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  return {
    repo: root,
    root: storageRoot,
    gitVersion,
    cow,
    ...(cowError ? { cowError } : {}),
  };
}
