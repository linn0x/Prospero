/**
 * 人工 DAG 的安全自动推进器。
 *
 * v1 采用整张 Run 共用一个工作区、一次只运行一个 worker。这样下游天然看到
 * 上游写入，又不会把多个写代码 agent 塞进同一目录互相覆盖。等自动 merge 和
 * 冲突处理具备后，才能诚实地开放“每任务 worktree + 并行”。
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentKind, ApprovalPolicy } from "@prospero/protocol";
import { DispatchService } from "./dispatch.js";
import type { AutomationWorkspace, Run } from "./model.js";
import { OrchestrationError, OrchestrationStore } from "./store.js";
import { createEsaytree, repoRoot } from "./esaytree.js";
import { WorktreeAssetService } from "./worktree-assets.js";

export interface StartAutomationInput {
  runId: string;
  agent: AgentKind;
  accountId?: string;
  approvalPolicy: ApprovalPolicy;
  workspace: AutomationWorkspace;
  cwd: string;
}

export class AutomationError extends Error {
  constructor(
    message: string,
    readonly code: "automation_invalid" | "not_a_repo",
  ) {
    super(message);
    this.name = "AutomationError";
  }
}

export class AutomationService {
  /**
   * 同一 Run 的 tick 串成 promise 链，防止 task.done 与手机操作同时派发两个 worker；
   * key 是 runId，因此不同 Run 没有全局队列，可同时推进独立编排流。
   */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly store: OrchestrationStore,
    private readonly dispatch: DispatchService,
    private readonly worktreeAssets = new WorktreeAssetService(store),
  ) {}

  async start(input: StartAutomationInput): Promise<Run> {
    const run = this.store.getRun(input.runId);
    if (run.coordinatorSessionId !== null) {
      throw new AutomationError("协调者 Run 已由协调 agent 调度，不能再启用静态自动执行", "automation_invalid");
    }
    if (run.status !== "active") {
      throw new AutomationError(`Run 当前是 ${run.status}，不能启动自动执行`, "automation_invalid");
    }
    if (this.store.listTasks(run.id).length === 0) {
      throw new AutomationError("任务图为空，至少添加一个任务后再运行", "automation_invalid");
    }

    const requestedCwd = path.resolve(input.cwd.trim());
    const cwd = canonicalDirectory(requestedCwd);
    if (!cwd) {
      throw new AutomationError(`项目目录不存在或不是目录: ${requestedCwd}`, "automation_invalid");
    }

    let workspacePath = cwd;
    let branch: string | null = null;
    const existing = run.automation;
    if (input.workspace === "run") {
      // daemon 在建完 worktree、记下 operationId 之前崩溃时，重试要复用已有目录，
      // 不能悄悄再建一份新的集成分支。
      if (
        existing?.workspace === "run" &&
        existing.cwd === cwd &&
        isDirectory(existing.workspacePath)
      ) {
        workspacePath = existing.workspacePath;
        branch = existing.branch;
      } else {
        const repo = await repoRoot(cwd);
        if (!repo) {
          throw new AutomationError(`${cwd} 不在 git 仓库中，不能创建 Run worktree`, "not_a_repo");
        }
        const stamp = Date.now().toString(36);
        const name = `auto-${run.id}-${stamp}`;
        branch = `prospero/${run.id}/auto-${stamp}`;
        const created = await createEsaytree({ repo, name, branch });
        // 创建成功即登记；随后 setRunAutomation 或派发失败时仍能从资产清单找到它。
        this.worktreeAssets.registerRun({
          runId: run.id,
          repo,
          path: created.path,
          branch: created.branch,
        });
        // 用户可能选的是 monorepo 子目录；新 worktree 仍应从对应子目录启动 agent。
        workspacePath = path.join(created.path, path.relative(repo, cwd));
      }
    }

    const now = Date.now();
    this.store.setRunAutomation(run.id, {
      state: "running",
      agent: input.agent,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      approvalPolicy: input.approvalPolicy,
      workspace: input.workspace,
      cwd,
      workspacePath,
      branch,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      lastError: null,
    });
    await this.wake(run.id);
    return this.store.getRun(run.id);
  }

  pause(runId: string): Run {
    const run = this.store.getRun(runId);
    const automation = run.automation;
    if (!automation) {
      throw new AutomationError("这个 Run 尚未启用自动执行", "automation_invalid");
    }
    if (automation.state === "completed") return run;
    return this.store.setRunAutomation(runId, {
      ...automation,
      state: "paused",
      updatedAt: Date.now(),
      lastError: null,
    });
  }

  /** worker 交付、图变更或 daemon 恢复后触发；调用方无需等待下一 worker 建完。 */
  kick(runId: string): void {
    void this.wake(runId).catch((error) => {
      console.warn(
        `[prosperod] 自动编排 ${runId} 推进失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** 测试与显式控制路径可等待本轮推进完成。 */
  async advance(runId: string): Promise<void> {
    await this.wake(runId);
  }

  /** daemon 启动后续跑之前处于 running 的静态 Run。 */
  resumePersisted(): void {
    for (const run of this.store.listRuns()) {
      if (run.automation?.state === "running") this.kick(run.id);
    }
  }

  private async wake(runId: string): Promise<void> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.tick(runId));
    this.queues.set(runId, next);
    try {
      await next;
    } finally {
      if (this.queues.get(runId) === next) this.queues.delete(runId);
    }
  }

  private async tick(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    const automation = run.automation;
    if (!automation || automation.state !== "running" || run.status !== "active") return;

    const tasks = this.store.listTasks(runId);
    if (tasks.length === 0) {
      this.pauseWithError(runId, "任务图为空，自动执行已暂停");
      return;
    }

    const active = this.store.listDispatches(runId).some(
      (candidate) => candidate.state === "starting" || candidate.state === "running",
    );
    if (active) return;

    if (tasks.every((task) => task.status === "done")) {
      try {
        // 只能经由 Run 的唯一完成入口收口。它会再次验证 Gate、Dispatch 与
        // automation 状态，并在成功时原子地将 automation 标成 completed。
        this.store.completeRun(runId, { fromAutomation: true });
      } catch (error) {
        // run-level Gate 不会改变 task 状态；它被解决时会 kick 本 Run，届时
        // 再尝试完成即可。这里不是自动执行故障，也不能把它提前标成 completed。
        if (error instanceof OrchestrationError && error.code === "run_not_completable") return;
        throw error;
      }
      return;
    }

    const stopped = tasks.find(
      (task) => task.status === "failed" || task.status === "blocked" || task.status === "cancelled",
    );
    if (stopped) {
      this.pauseWithError(runId, `任务“${stopped.title}”处于 ${stopped.status}，请处理后继续`);
      return;
    }

    const next = this.store.listReadyTasks(runId)[0];
    if (!next) {
      this.pauseWithError(runId, "当前没有可运行任务；请检查依赖或任务状态");
      return;
    }

    try {
      await this.dispatch.startWorker({
        taskId: next.id,
        agent: automation.agent,
        ...(automation.accountId ? { accountId: automation.accountId } : {}),
        worktree: "none",
        cwd: automation.workspacePath,
        approvalPolicy: automation.approvalPolicy,
      });
    } catch (error) {
      this.pauseWithError(
        runId,
        `派发“${next.title}”失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private pauseWithError(runId: string, message: string): void {
    const run = this.store.getRun(runId);
    const automation = run.automation;
    if (!automation) return;
    this.store.setRunAutomation(runId, {
      ...automation,
      state: "paused",
      updatedAt: Date.now(),
      lastError: message,
    });
  }
}

function isDirectory(value: string): boolean {
  if (!existsSync(value)) return false;
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function canonicalDirectory(value: string): string | null {
  if (!isDirectory(value)) return null;
  try {
    return realpathSync.native(value);
  } catch {
    return null;
  }
}
