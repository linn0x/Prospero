#!/usr/bin/env node
/** 会话内 `prospero` CLI：只做 socket client，不在 agent 进程里保存任何编排状态。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { controlRequest, controlSocketPath, ControlSocketError } from "./control-socket.js";
import { controlRequestTimeoutFor } from "./orchestration-cli-timeouts.js";
import {
  noRunStatus,
  projectRunList,
  projectRunStatus,
  selectRunForSession,
} from "./orchestration/status-projection.js";
import type { OrchestrationState } from "./orchestration/model.js";
import { prosperoHome } from "./pairing.js";

const home = prosperoHome();
const program = new Command();
program
  .name("prospero")
  .description("Prospero 编排控制 CLI（供协调者和 worker 会话调用）")
  .option("--socket <path>", "控制 socket 路径", process.env["PROSPERO_CONTROL_SOCK"] ?? controlSocketPath(home))
  .option("--token-file <path>", "控制 token 文件", process.env["PROSPERO_CONTROL_TOKEN_PATH"] ?? path.join(home, "control.token"))
  .option("--session <id>", "当前 Prospero 会话 ID", process.env["PROSPERO_SESSION_ID"]);

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`缺少 ${name}`);
  return value;
}

function optionalSession(): string | null {
  const session = program.opts<{ session?: string }>().session;
  return session && session.trim() !== "" ? session : null;
}

async function request<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = controlRequestTimeoutFor(method),
): Promise<T> {
  const opts = program.opts<{ socket: string; tokenFile: string }>();
  let token: string;
  try {
    token = readFileSync(opts.tokenFile, "utf8").trim();
  } catch (error) {
    throw new Error(
      `无法读取控制 token 文件 ${opts.tokenFile}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return await controlRequest<T>(
    { socketPath: opts.socket, token, timeoutMs },
    method,
    params,
  );
}

function print(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function invoke(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = controlRequestTimeoutFor(method),
): Promise<void> {
  print(await request(method, params, timeoutMs));
}

function action(method: string, makeParams: (opts: Record<string, unknown>) => Record<string, unknown>) {
  return async (opts: Record<string, unknown>): Promise<void> => {
    await invoke(method, makeParams(opts));
  };
}

function sender(): string {
  return requireText(optionalSession(), "--session（或 PROSPERO_SESSION_ID）");
}

const run = program.command("run").description("Run 管理");
run
  .command("create")
  .requiredOption("--objective <text>", "协调目标")
  .action(action("run.create", (opts) => ({
    objective: requireText(opts["objective"], "--objective"),
    coordinatorSessionId: optionalSession(),
  })));
run.command("list").action(action("run.list", () => ({})));
run
  .command("complete")
  .requiredOption("--id <id>", "Run ID")
  .action(action("run.complete", (opts) => ({
    runId: requireText(opts["id"], "--id"),
    actorSessionId: optionalSession(),
  })));
run
  .command("abandon")
  .requiredOption("--id <id>", "Run ID")
  .action(action("run.abandon", (opts) => ({
    runId: requireText(opts["id"], "--id"),
    actorSessionId: optionalSession(),
  })));

const task = program.command("task").description("Task 管理与交付");
task
  .command("create")
  .requiredOption("--run <id>", "Run ID")
  .requiredOption("--title <text>", "任务标题")
  .requiredOption("--spec <text>", "任务要求")
  .option("--skill <name...>", "显式分配给该任务的 Skill（最多 5 个）")
  .option("--dep <taskId...>", "前置 Task ID，可重复")
  .option("--parent <taskId>", "父任务 ID")
  .action(action("task.create", (opts) => ({
    runId: requireText(opts["run"], "--run"),
    title: requireText(opts["title"], "--title"),
    spec: requireText(opts["spec"], "--spec"),
    skills: Array.isArray(opts["skill"]) ? opts["skill"] : [],
    deps: Array.isArray(opts["dep"]) ? opts["dep"] : [],
    ...(typeof opts["parent"] === "string" ? { parentId: opts["parent"] } : {}),
    actorSessionId: optionalSession(),
  })));
task
  .command("list")
  .option("--run <id>", "按 Run 过滤")
  .action(action("task.list", (opts) => (
    typeof opts["run"] === "string" ? { runId: opts["run"] } : {}
  )));
for (const [name, method] of [["done", "task.done"], ["fail", "task.fail"]] as const) {
  task
    .command(name)
    .requiredOption("--id <id>", "Task ID")
    .requiredOption("--body <text>", "交付摘要或失败原因")
    .action(action(method, (opts) => ({
      taskId: requireText(opts["id"], "--id"),
      body: requireText(opts["body"], "--body"),
      actorSessionId: optionalSession(),
    })));
}
task
  .command("retry")
  .description("仅重试 failed Task；自动编排运行中会先暂停")
  .requiredOption("--id <id>", "failed Task ID")
  .option("--operation-id <id>", "调用方提供时，用于同一 retry 请求的幂等重试")
  .action(action("task.retry", (opts) => ({
    taskId: requireText(opts["id"], "--id"),
    ...(typeof opts["operationId"] === "string" ? { operationId: opts["operationId"] } : {}),
    actorSessionId: optionalSession(),
  })));
task
  .command("cancel")
  .description("仅取消未运行 Task；若自动编排运行中会先暂停，运行中的 worker 请先 stop")
  .requiredOption("--id <id>", "Task ID")
  .option("--reason <text>", "取消原因；省略时使用服务端默认原因")
  .option("--operation-id <id>", "调用方提供时，用于同一 cancel 请求的幂等重试")
  .action(action("task.cancel", (opts) => ({
    taskId: requireText(opts["id"], "--id"),
    ...(typeof opts["reason"] === "string" ? { reason: opts["reason"] } : {}),
    ...(typeof opts["operationId"] === "string" ? { operationId: opts["operationId"] } : {}),
    actorSessionId: optionalSession(),
  })));

const worker = program.command("worker").description("派发和停止 worker");
worker
  .command("start")
  .requiredOption("--task <id>", "Task ID")
  .requiredOption("--agent <kind>", "claude/codex/opencode/grok 等 agent")
  .option("--worktree <mode>", "new（隔离）或 none（当前目录）", "none")
  .option("--cwd <path>", "任务工作目录", process.cwd())
  .option("--kind <kind>", "structured 或 pty")
  .option("--approval-policy <policy>", "strict/standard/yolo")
  .option("--skill <name...>", "覆盖 Task 的显式 Skill（最多 5 个）")
  .option("--operation-id <id>", "调用方提供时，用于同一 worker.start 请求的幂等重试")
  .action(action("worker.start", (opts) => ({
    taskId: requireText(opts["task"], "--task"),
    agent: requireText(opts["agent"], "--agent"),
    worktree: opts["worktree"],
    cwd: requireText(opts["cwd"], "--cwd"),
    ...(Array.isArray(opts["skill"]) ? { skills: opts["skill"] } : {}),
    ...(typeof opts["kind"] === "string" ? { kind: opts["kind"] } : {}),
    ...(typeof opts["approvalPolicy"] === "string"
      ? { approvalPolicy: opts["approvalPolicy"] }
      : {}),
    ...(typeof opts["operationId"] === "string" ? { operationId: opts["operationId"] } : {}),
    actorSessionId: optionalSession(),
  })));
worker
  .command("stop")
  .description("停止运行中的 worker；默认标为 failed，也可显式标为 cancelled")
  .requiredOption("--task <id>", "运行中 worker 所属的 Task ID")
  .option("--reason <text>", "停止原因；省略时使用服务端默认原因")
  .option("--final-status <status>", "停止后的 Task 状态：failed 或 cancelled")
  .option("--operation-id <id>", "调用方提供时，用于同一 stop 请求的幂等重试")
  .action(action("worker.stop", (opts) => ({
    taskId: requireText(opts["task"], "--task"),
    ...(typeof opts["reason"] === "string" ? { reason: opts["reason"] } : {}),
    ...(typeof opts["finalStatus"] === "string" ? { finalStatus: opts["finalStatus"] } : {}),
    ...(typeof opts["operationId"] === "string" ? { operationId: opts["operationId"] } : {}),
    actorSessionId: optionalSession(),
  })));

const worktree = program
  .command("worktree")
  .description("已登记编排工作树的只读检查与显式安全清理");
worktree
  .command("list")
  .option("--run <id>", "只列出指定 Run（worker 会话必须带此项）")
  .action(action("worktree.list", (opts) => ({
    ...(typeof opts["run"] === "string" ? { runId: opts["run"] } : {}),
    actorSessionId: optionalSession(),
  })));
worktree
  .command("inspect")
  .requiredOption("--id <assetId>", "工作树资产 ID")
  .option("--target <ref>", "比较的目标分支或 ref", "HEAD")
  .action(action("worktree.inspect", (opts) => ({
    assetId: requireText(opts["id"], "--id"),
    targetRef: requireText(opts["target"], "--target"),
    actorSessionId: optionalSession(),
  })));
worktree
  .command("cleanup")
  .requiredOption("--id <assetId>", "工作树资产 ID")
  .option("--target <ref>", "比较的目标分支或 ref", "HEAD")
  .option("--delete-branch", "在移除工作树后也删除分支；默认保留分支供恢复", false)
  .option("--confirm", "明确执行删除；省略时 API 会拒绝", false)
  .requiredOption("--operation-id <id>", "幂等删除操作 ID")
  .action(action("worktree.cleanup", (opts) => ({
    assetId: requireText(opts["id"], "--id"),
    targetRef: requireText(opts["target"], "--target"),
    confirm: opts["confirm"] === true,
    deleteBranch: opts["deleteBranch"] === true,
    operationId: requireText(opts["operationId"], "--operation-id"),
    actorSessionId: optionalSession(),
  })));

program
  .command("send")
  .description("投递 note/report 等普通邮箱消息")
  .requiredOption("--run <id>", "Run ID")
  .requiredOption("--to <recipient>", "收件人会话 ID 或 human")
  .requiredOption("--subject <text>", "主题")
  .requiredOption("--body <text>", "正文")
  .option("--type <type>", "note 或 report", "note")
  .option("--thread <id>", "所属问答线程")
  .option("--task <id>", "关联 Task ID")
  .action(action("mail.send", (opts) => ({
    runId: requireText(opts["run"], "--run"),
    from: sender(),
    to: requireText(opts["to"], "--to"),
    type: requireText(opts["type"], "--type"),
    subject: requireText(opts["subject"], "--subject"),
    body: requireText(opts["body"], "--body"),
    ...(typeof opts["thread"] === "string" ? { threadId: opts["thread"] } : {}),
    ...(typeof opts["task"] === "string" ? { taskId: opts["task"] } : {}),
  })));

program
  .command("check")
  .description("读取自己的未读邮箱；--wait 会在 daemon 中阻塞到有新消息")
  .option("--run <id>", "按 Run 过滤")
  .option("--recipient <id>", "收件人；默认当前会话")
  .option("--wait", "没有消息时持续等待")
  .action(async (opts: { run?: string; recipient?: string; wait?: boolean }) => {
    await invoke(
      "mail.check",
      {
        recipient: opts.recipient ?? sender(),
        ...(opts.run ? { runId: opts.run } : {}),
        wait: opts.wait === true,
      },
      opts.wait ? 0 : undefined,
    );
  });

program
  .command("ask")
  .description("发问并默认阻塞到同一线程收到 reply")
  .requiredOption("--run <id>", "Run ID")
  .requiredOption("--to <recipient>", "收件人会话 ID 或 human")
  .requiredOption("--subject <text>", "问题主题")
  .requiredOption("--body <text>", "问题正文")
  .option("--task <id>", "关联 Task ID")
  .option("--no-wait", "只发问，不等待回复")
  .action(async (opts: { run: string; to: string; subject: string; body: string; task?: string; wait: boolean }) => {
    await invoke(
      "mail.ask",
      {
        runId: opts.run,
        from: sender(),
        to: opts.to,
        subject: opts.subject,
        body: opts.body,
        ...(opts.task ? { taskId: opts.task } : {}),
        wait: opts.wait,
      },
      opts.wait ? 0 : undefined,
    );
  });

program
  .command("reply")
  .description("回复 ask 返回的 threadId")
  .requiredOption("--run <id>", "Run ID")
  .requiredOption("--to <recipient>", "原提问者会话 ID")
  .requiredOption("--thread <id>", "ask 的 threadId")
  .requiredOption("--subject <text>", "回复主题")
  .requiredOption("--body <text>", "回复正文")
  .option("--task <id>", "关联 Task ID")
  .action(action("mail.reply", (opts) => ({
    runId: requireText(opts["run"], "--run"),
    from: sender(),
    to: requireText(opts["to"], "--to"),
    threadId: requireText(opts["thread"], "--thread"),
    subject: requireText(opts["subject"], "--subject"),
    body: requireText(opts["body"], "--body"),
    ...(typeof opts["task"] === "string" ? { taskId: opts["task"] } : {}),
  })));

const gate = program.command("gate").description("需要协调者或人决策的任务门");
gate
  .command("create")
  .requiredOption("--run <id>", "Run ID")
  .requiredOption("--question <text>", "需要决定的问题")
  .option("--task <id>", "要阻塞的 Task ID")
  .option("--option <text...>", "可选项")
  .action(action("gate.create", (opts) => ({
    runId: requireText(opts["run"], "--run"),
    question: requireText(opts["question"], "--question"),
    options: Array.isArray(opts["option"]) ? opts["option"] : [],
    ...(typeof opts["task"] === "string" ? { taskId: opts["task"] } : {}),
    actorSessionId: sender(),
  })));
gate
  .command("resolve")
  .requiredOption("--id <id>", "Gate ID")
  .requiredOption("--decision <text>", "决策结果")
  .action(action("gate.resolve", (opts) => ({
    gateId: requireText(opts["id"], "--id"),
    decision: requireText(opts["decision"], "--decision"),
    actorSessionId: sender(),
  })));
gate
  .command("list")
  .option("--run <id>", "按 Run 过滤")
  .option("--status <status>", "pending/resolved/cancelled")
  .action(action("gate.list", (opts) => ({
    ...(typeof opts["run"] === "string" ? { runId: opts["run"] } : {}),
    ...(typeof opts["status"] === "string" ? { status: opts["status"] } : {}),
  })));

program
  .command("status")
  .description("查看当前会话关联 Run 的紧凑状态；--json 输出旧版完整 snapshot")
  .option("--run <id>", "精确选择一个 Run")
  .option("--all", "列出全部 Run 的精简摘要", false)
  .option("--json", "输出原始完整 snapshot（兼容旧版；忽略 --run/--all）", false)
  .action(async (opts: { run?: string; all: boolean; json: boolean }) => {
    const snapshot = await request<OrchestrationState>("orchestration.snapshot", {});
    if (opts.json) {
      print(snapshot);
      return;
    }
    if (opts.all) {
      print(projectRunList(snapshot));
      return;
    }
    const run = opts.run
      ? snapshot.runs[opts.run] ?? null
      : selectRunForSession(snapshot, optionalSession());
    print(run ? projectRunStatus(snapshot, run) : noRunStatus(optionalSession(), opts.run));
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof ControlSocketError ? error.code : "cli_error";
  process.stderr.write(`prospero: ${code}: ${message}\n`);
  process.exitCode = 1;
});
