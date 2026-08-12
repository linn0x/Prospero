#!/usr/bin/env node
/** esaytree 的人类与自动化 CLI。 */
import { Command, CommanderError } from "commander";
import {
  ESAYTREE_SCHEMA,
  ESAYTREE_SCHEMA_VERSION,
  EsaytreeError,
  createEsaytree,
  diagnoseEsaytree,
  listManagedWorktrees,
  removeManagedWorktree,
  resolveManagedWorktree,
  type ManagedWorktreeInfo,
} from "./orchestration/esaytree.js";
import { DAEMON_VERSION } from "./version.js";

interface OutputOptions {
  json?: boolean;
  format?: string;
}

const program = new Command();
program
  .name("esaytree")
  .description("为 coding agent 创建快速、隔离、可回收的 Git 工作区")
  .version(DAEMON_VERSION)
  .exitOverride()
  .showHelpAfterError();

function addOutputOptions(command: Command): Command {
  return command
    .option("--json", "输出单个 JSON 文档")
    .option("--format <format>", "输出格式：human 或 json", "human");
}

function isJSON(opts: OutputOptions): boolean {
  if (opts.format !== undefined && opts.format !== "human" && opts.format !== "json") {
    throw new EsaytreeError(`未知输出格式：${opts.format}`, "invalid_name");
  }
  return opts.json === true || opts.format === "json";
}

function envelope(kind: string, data: unknown): Record<string, unknown> {
  return {
    schema: ESAYTREE_SCHEMA,
    schema_version: ESAYTREE_SCHEMA_VERSION,
    kind,
    data,
  };
}

function emitJSON(kind: string, data: unknown): void {
  process.stdout.write(`${JSON.stringify(envelope(kind, data))}\n`);
}

function shortBranch(branch: string | null): string | null {
  return branch?.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
}

function taskJSON(task: ManagedWorktreeInfo): Record<string, unknown> {
  return {
    name: task.name,
    path: task.path,
    branch: shortBranch(task.branch),
    head: task.head,
    detached: task.detached,
    locked: task.locked,
    prunable: task.prunable,
  };
}

function exitFor(error: EsaytreeError): number {
  switch (error.code) {
    case "invalid_name":
      return 2;
    case "not_a_repo":
    case "worktree_missing":
      return 3;
    case "worktree_exists":
      return 4;
    case "cow_unavailable":
      return 5;
    case "unsafe_path":
    case "copy_failed":
    case "git_failed":
      return 6;
  }
}

async function run(opts: OutputOptions, action: (json: boolean) => Promise<void>): Promise<void> {
  let json = false;
  try {
    json = isJSON(opts);
    await action(json);
  } catch (error) {
    const failure = error instanceof EsaytreeError
      ? error
      : new EsaytreeError(error instanceof Error ? error.message : String(error), "git_failed");
    if (json) {
      process.stdout.write(`${JSON.stringify({
        schema: ESAYTREE_SCHEMA,
        schema_version: ESAYTREE_SCHEMA_VERSION,
        kind: "esaytree.error",
        error: { code: failure.code, message: failure.message, details: {} },
      })}\n`);
    }
    process.stderr.write(`esaytree: ${failure.message}\n`);
    process.exitCode = exitFor(failure);
  }
}

addOutputOptions(
  program
    .command("new")
    .description("创建一个隔离工作区")
    .argument("<name>", "工作区名称")
    .option("-C, --repo <path>", "源 Git 仓库或其子目录", process.cwd())
    .option("--at <path>", "显式目标路径")
    .option("--base <ref>", "起点 ref", "HEAD")
    .option("--branch <branch>", "新分支名；默认 esaytree/<name>")
    .option("--detach", "创建 detached worktree")
    .option("--no-ignored", "不复用 ignored 依赖和缓存")
    .option("--require-cow", "CoW 不可用时直接失败")
    .option("--copy-fallback", "fallback 时允许真实复制 ignored 目录"),
).action(async (name: string, opts: {
  repo: string;
  at?: string;
  base: string;
  branch?: string;
  detach?: boolean;
  ignored: boolean;
  requireCow?: boolean;
  copyFallback?: boolean;
  json?: boolean;
  format?: string;
}) => {
  await run(opts, async (json) => {
    if (opts.detach && opts.branch) {
      throw new EsaytreeError("--detach 与 --branch 不能同时使用", "invalid_name");
    }
    const branch = opts.detach ? undefined : (opts.branch ?? `esaytree/${name}`);
    const created = await createEsaytree({
      repo: opts.repo,
      name,
      ...(opts.at ? { at: opts.at } : {}),
      baseRef: opts.base,
      ...(branch ? { branch } : {}),
      cloneIgnored: opts.ignored,
      fallbackToCheckout: opts.requireCow !== true,
      fallbackCopyIgnored: opts.copyFallback === true,
    });
    const task = {
      name,
      path: created.path,
      branch: created.branch,
      mode: created.mode,
      cow: created.cow,
      preserved_ignored: created.preservedIgnored,
      elapsed_ms: created.ms,
      ...(created.fallbackReason ? { fallback_reason: created.fallbackReason } : {}),
    };
    if (json) {
      emitJSON("esaytree.task-new", { task });
      return;
    }
    process.stdout.write(`created: ${created.path}\n`);
    process.stdout.write(`branch: ${created.branch ?? "detached"}\n`);
    process.stdout.write(`mode: ${created.mode} (${String(created.ms)} ms)\n`);
    process.stdout.write(`preserved ignored dirs: ${String(created.preservedIgnored.length)}\n`);
    if (created.fallbackReason) {
      process.stderr.write(`esaytree: CoW 不可用，已退回 Git checkout：${created.fallbackReason}\n`);
    }
  });
});

addOutputOptions(
  program
    .command("list")
    .alias("ls")
    .description("列出当前仓库由 esaytree 管理的工作区")
    .option("-C, --repo <path>", "Git 仓库或其子目录", process.cwd()),
).action(async (opts: { repo: string; json?: boolean; format?: string }) => {
  await run(opts, async (json) => {
    const tasks = await listManagedWorktrees(opts.repo);
    if (json) {
      emitJSON("esaytree.task-list", { tasks: tasks.map(taskJSON) });
      return;
    }
    process.stdout.write("Task\tBranch\tHEAD\tPath\n");
    for (const task of tasks) {
      process.stdout.write(
        `${task.name}\t${shortBranch(task.branch) ?? "detached"}\t${task.head.slice(0, 12)}\t${task.path}\n`,
      );
    }
  });
});

addOutputOptions(
  program
    .command("switch")
    .description("输出工作区绝对路径；shell 可使用 cd \"$(esaytree switch <name>)\"")
    .argument("<name>", "工作区名称")
    .option("-C, --repo <path>", "Git 仓库或其子目录", process.cwd()),
).action(async (name: string, opts: { repo: string; json?: boolean; format?: string }) => {
  await run(opts, async (json) => {
    const task = await resolveManagedWorktree(opts.repo, name);
    if (json) emitJSON("esaytree.task-switch", { task: taskJSON(task) });
    else process.stdout.write(`${task.path}\n`);
  });
});

addOutputOptions(
  program
    .command("rm")
    .description("永久移除工作区及其中未保存的改动")
    .argument("<name>", "工作区名称")
    .option("-C, --repo <path>", "Git 仓库或其子目录", process.cwd())
    .option("--keep-branch", "移除工作区但保留本地分支"),
).action(async (name: string, opts: {
  repo: string;
  keepBranch?: boolean;
  json?: boolean;
  format?: string;
}) => {
  await run(opts, async (json) => {
    await removeManagedWorktree(opts.repo, name, { deleteBranch: opts.keepBranch !== true });
    if (json) emitJSON("esaytree.task-remove", { task: { name } });
    else process.stdout.write(`removed: ${name}\n`);
  });
});

addOutputOptions(
  program
    .command("doctor")
    .description("检查 Git 仓库和目标文件系统的 CoW 能力")
    .option("-C, --repo <path>", "Git 仓库或其子目录", process.cwd()),
).action(async (opts: { repo: string; json?: boolean; format?: string }) => {
  await run(opts, async (json) => {
    const report = await diagnoseEsaytree(opts.repo);
    if (json) {
      emitJSON("esaytree.doctor", report);
    } else {
      process.stdout.write(`repo: ${report.repo}\n`);
      process.stdout.write(`root: ${report.root}\n`);
      process.stdout.write(`git: ${report.gitVersion}\n`);
      process.stdout.write(`copy-on-write: ${report.cow ? "available" : "unavailable"}\n`);
      if (report.cowError) process.stderr.write(`esaytree: ${report.cowError}\n`);
    }
    if (!report.cow) process.exitCode = 5;
  });
});

program.parseAsync().catch((error: unknown) => {
  if (error instanceof CommanderError) {
    if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
      process.exitCode = 0;
      return;
    }
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`esaytree: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 70;
});
