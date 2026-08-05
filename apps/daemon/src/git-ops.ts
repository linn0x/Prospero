/**
 * 会话仓库的 git 操作:状态 / diff / 暂存 / 提交 / 丢弃。
 *
 * 【为什么值得单独做】文件面板回答"这个文件现在是什么样",git 面板回答
 * "agent 改了什么"—— 后者才是盯着 agent 干活时真正要看的东西。
 *
 * 【安全】只在会话 cwd 里跑,路径全部经 fs-ops 的根约束校验后再传给 git,
 * 且一律走 `--` 分隔,避免以 `-` 开头的路径被当成参数。
 * 不接受客户端传任意 git 参数 —— 那等于开了个命令执行口子。
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { FsError, resolveWithin } from "./fs-ops.js";

const run = promisify(execFile);

/** 单次 git 输出上限:diff 可能很大,手机上也看不完 */
const MAX_OUTPUT = 2 * 1024 * 1024;

export interface GitFile {
  path: string;
  /** 暂存区状态(porcelain 的 X 位) */
  index: string;
  /** 工作区状态(porcelain 的 Y 位) */
  worktree: string;
  /** 未跟踪 */
  untracked: boolean;
}

export interface GitStatus {
  /** 不是 git 仓库时为 null,UI 据此显示空态而不是报错 */
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  /** 是否有内容可提交(暂存区非空) */
  staged: boolean;
}

/**
 * 跑 git 并容忍"有差异"这一种非零退出。
 * `git diff --no-index` 在文件不同时退出码就是 1 —— 那是结果,不是失败,
 * 而 execFile 一律按错误抛。这里把 stdout 取回来。
 */
async function gitTolerant(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch (e) {
    const withOut = e as { stdout?: string };
    if (typeof withOut.stdout === "string" && withOut.stdout.length > 0) {
      return withOut.stdout;
    }
    return "";
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      maxBuffer: MAX_OUTPUT,
      // 不继承用户的 GIT_* 环境,避免会话间串味;LANG 固定以便解析
      env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not a git repository/i.test(msg)) {
      throw new FsError("not a git repository", "not_found");
    }
    // 把 stdout 挂到错误上,gitTolerant 需要它
    const err = new FsError(msg.split("\n").slice(0, 3).join("\n"), "io") as FsError & {
      stdout?: string;
    };
    const raw = e as { stdout?: string };
    if (typeof raw.stdout === "string") err.stdout = raw.stdout;
    throw err;
  }
}

/**
 * 仓库状态。用 porcelain v1 -z:NUL 分隔,路径里的空格/换行/中文都不会歧义,
 * 而 v1 的两位状态码解析起来比 v2 简单得多。
 */
export async function status(cwd: string): Promise<GitStatus> {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;

  try {
    branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch (e) {
    if (e instanceof FsError && e.code === "not_found") {
      return { branch: null, ahead: 0, behind: 0, files: [], staged: false };
    }
    throw e;
  }

  // 有上游才算 ahead/behind;没有上游不是错误(新分支很常见)
  try {
    const counts = await git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    const [b, a] = counts.trim().split(/\s+/).map(Number);
    behind = b ?? 0;
    ahead = a ?? 0;
  } catch {
    // 无上游,保持 0
  }

  const raw = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const files: GitFile[] = [];
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 3) continue;
    const index = entry[0] ?? " ";
    const worktree = entry[1] ?? " ";
    let filePath = entry.slice(3);
    // 重命名 / 复制的记录后面紧跟一个"原路径"字段,要多吃一个
    if (index === "R" || index === "C") i++;
    if (!filePath) continue;
    files.push({
      path: filePath,
      index,
      worktree,
      untracked: index === "?" && worktree === "?",
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    branch,
    ahead,
    behind,
    files,
    staged: files.some((f) => f.index !== " " && f.index !== "?"),
  };
}

/** 单个文件的 diff。staged 为 true 时看暂存区与 HEAD 的差异。 */
export async function diff(cwd: string, rel: string, staged: boolean): Promise<string> {
  await resolveWithin(cwd, rel); // 根约束;越界直接抛
  const args = ["diff", "--no-color", "--no-ext-diff"];
  if (staged) args.push("--cached");
  args.push("--", rel);
  const out = await git(cwd, args);
  if (out.trim().length > 0) return out;

  // 未跟踪文件没有 diff,构造一个"全是新增"的视图,否则点开是空白
  if (!staged) {
    const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", rel]);
    if (untracked.split("\0").some((p) => p === rel)) {
      return await gitTolerant(cwd, ["diff", "--no-index", "--no-color", "--", "/dev/null", rel]);
    }
  }
  return "";
}

export async function stage(cwd: string, rels: string[]): Promise<void> {
  if (rels.length === 0) return;
  for (const r of rels) await resolveWithin(cwd, r);
  await git(cwd, ["add", "--", ...rels]);
}

export async function unstage(cwd: string, rels: string[]): Promise<void> {
  if (rels.length === 0) return;
  for (const r of rels) await resolveWithin(cwd, r);
  await git(cwd, ["restore", "--staged", "--", ...rels]);
}

/**
 * 丢弃工作区改动。
 * 不可撤销且没有回收站,所以只作用于明确指定的文件,绝不支持"全部丢弃"——
 * 手机上一次误触就能抹掉 agent 干了一小时的活。
 */
export async function discard(cwd: string, rel: string): Promise<void> {
  await resolveWithin(cwd, rel);
  await git(cwd, ["restore", "--worktree", "--", rel]);
}

export async function commit(cwd: string, message: string): Promise<string> {
  const msg = message.trim();
  if (msg.length === 0) throw new FsError("commit message is empty", "denied");
  await git(cwd, ["commit", "-m", msg]);
  return (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
}

/** 仓库根相对于会话 cwd 的位置;用于提示"这是子目录" */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    return path.resolve(root) === path.resolve(cwd) ? null : root;
  } catch {
    return null;
  }
}
