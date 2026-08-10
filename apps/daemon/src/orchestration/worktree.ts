/**
 * 任务隔离用的 git worktree。
 *
 * 常见误解先破掉:`git worktree add` **不复制仓库**。新 worktree 里的 .git
 * 只是一行 `gitdir:` 指针,对象库跟主仓共享。本仓实测 —— .git 4.2MB(共享)、
 * 检出 4.1MB / 0.08s,而 gitignored 的 node_modules 有 4.3GB 且 git 压根不碰。
 *
 * 所以贵的从来不是仓库,是**依赖**:新 worktree 里没有 node_modules,
 * 重装一次几分钟起步。解法是 APFS 的写时复制(clonefile),Node 原生支持。
 * 实测克隆 4.3GB 依赖:11 秒,磁盘增量约等于 0,且是真 CoW 不是硬链接
 * (inode 不同,改克隆不污染源目录)。
 */
import { execFile } from "node:child_process";
import { constants, cpSync, existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class WorktreeError extends Error {
  constructor(message: string, readonly code: WorktreeErrorCode) {
    super(message);
    this.name = "WorktreeError";
  }
}

export type WorktreeErrorCode =
  | "not_a_repo"
  | "worktree_exists"
  | "worktree_missing"
  | "git_failed";

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err);
    throw new WorktreeError(`git ${args[0]} 失败: ${stderr.trim()}`, "git_failed");
  }
}

/** 主仓根目录;不在仓库里就是 null。 */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
    return out.trim() || null;
  } catch {
    return null;
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
    } else if (line.trim() === "" && current.path) {
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
  };
}

/** 比较真实路径，避免 macOS 的 /var → /private/var 软链接让已登记 worktree 失配。 */
function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    // 路径不存在时仍给出对 . / .. 稳定的比较值；调用方会再由 git 给出具体错误。
    return path.resolve(value);
  }
}

/**
 * git 认为被忽略的目录。
 *
 * 不靠"node_modules / target / .venv"这种猜名单 —— 直接问 git:
 * `--directory` 会把**完全被忽略的目录整个折叠**成一条,于是 monorepo 里
 * 嵌套的 apps/*​/node_modules、packages/*​/node_modules 都会列出来,
 * 而不会展开成几十万个文件。
 */
export async function ignoredDirs(repo: string): Promise<string[]> {
  const out = await git(repo, [
    "ls-files", "--others", "--ignored", "--directory", "--exclude-standard",
  ]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("/"))
    .map((line) => line.slice(0, -1))
    .filter((rel) => {
      // 只要目录,且必须真实存在(git 也会列出已删除的忽略项)
      const abs = path.join(repo, rel);
      try {
        return statSync(abs).isDirectory();
      } catch {
        return false;
      }
    });
}

export interface CloneReport {
  dir: string;
  /** true = 写时复制(几乎不占盘);false = 真实复制,占的是完整体积 */
  cow: boolean;
  ms: number;
  error?: string;
}

/**
 * 把忽略目录克隆进新 worktree。
 *
 * 先试 FICLONE_FORCE:它在不支持 CoW 的文件系统上会**抛错**而不是悄悄降级成
 * 真实复制。这个区别很重要 —— 4.3GB 的依赖是 0 秒 0 空间还是 11 分钟 4.3GB,
 * 上层必须知道,才好提示用户。抛错后再退回真实复制,并把 cow:false 报上去。
 */
export function cloneIgnoredDirs(from: string, to: string, dirs: string[]): CloneReport[] {
  const reports: CloneReport[] = [];
  for (const rel of dirs) {
    const src = path.join(from, rel);
    const dst = path.join(to, rel);
    if (!existsSync(src)) continue;
    const started = Date.now();
    try {
      cpSync(src, dst, { recursive: true, mode: constants.COPYFILE_FICLONE_FORCE });
      reports.push({ dir: rel, cow: true, ms: Date.now() - started });
    } catch {
      try {
        cpSync(src, dst, { recursive: true });
        reports.push({ dir: rel, cow: false, ms: Date.now() - started });
      } catch (err) {
        reports.push({
          dir: rel,
          cow: false,
          ms: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return reports;
}

export interface CreateWorktreeInput {
  repo: string;
  /** worktree 目录名,也用作分支名的一部分 */
  name: string;
  /** 落盘位置;省略时放在 <repo>/../.prospero-worktrees/<repo名>/<name> */
  at?: string;
  /** 从哪个 ref 开出来,默认当前 HEAD */
  baseRef?: string;
  /** 新分支名;省略则 detached */
  branch?: string;
  /** 是否把 gitignored 目录(依赖、构建产物)克隆过去 */
  cloneIgnored?: boolean;
}

export interface CreateWorktreeResult {
  path: string;
  branch: string | null;
  clones: CloneReport[];
}

export function defaultWorktreeRoot(repo: string): string {
  return path.join(path.dirname(repo), ".prospero-worktrees", path.basename(repo));
}

export async function createWorktree(input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
  const root = await repoRoot(input.repo);
  if (!root) throw new WorktreeError(`${input.repo} 不在 git 仓库里`, "not_a_repo");

  const target = input.at ?? path.join(defaultWorktreeRoot(root), input.name);
  if (existsSync(target)) {
    throw new WorktreeError(`目标已存在: ${target}`, "worktree_exists");
  }

  const args = ["worktree", "add"];
  if (input.branch) {
    args.push("-b", input.branch);
  } else {
    args.push("--detach");
  }
  args.push(target);
  if (input.baseRef) args.push(input.baseRef);
  await git(root, args);

  const clones = input.cloneIgnored === false
    ? []
    : cloneIgnoredDirs(root, target, await ignoredDirs(root));

  return { path: target, branch: input.branch ?? null, clones };
}

/**
 * 拆掉一个 worktree。
 *
 * 用 `git worktree remove` 而不是 rm -rf:后者会留下 .git/worktrees 里的悬挂
 * 元数据,下次同名 add 会因为"already registered"失败。
 */
export async function removeWorktree(
  repo: string,
  target: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const root = await repoRoot(repo);
  if (!root) throw new WorktreeError(`${repo} 不在 git 仓库里`, "not_a_repo");
  const canonicalTarget = canonicalPath(target);
  const known = (await listWorktrees(root)).some(
    (worktree) => canonicalPath(worktree.path) === canonicalTarget,
  );
  if (!known) throw new WorktreeError(`不是本仓的 worktree: ${target}`, "worktree_missing");
  const args = ["worktree", "remove"];
  // 克隆进去的依赖对 git 是"未跟踪文件",不加 --force 它会拒绝删。
  if (opts.force !== false) args.push("--force");
  args.push(target);
  await git(root, args);
  await git(root, ["worktree", "prune"]);
}
