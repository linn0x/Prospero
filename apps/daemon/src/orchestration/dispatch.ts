/** 把一个 ready task 变成实际 worker 会话的唯一入口。 */
import type { AgentKind, SessionInfo, SessionKind } from "@prospero/protocol";
import type { CreateSessionInput } from "../session-manager.js";
import {
  createEsaytree,
  repoRoot,
  type CloneReport,
  type EsaytreeCreateMode,
} from "./esaytree.js";
import { OrchestrationStore } from "./store.js";
import type { Dispatch, Task } from "./model.js";
import { WorktreeAssetService } from "./worktree-assets.js";

export type WorktreeMode = "new" | "none";

export interface WorkerSessionManager {
  create(input: CreateSessionInput): Promise<SessionInfo>;
  chatSend(sid: string, text: string): Promise<void>;
  requirePty(sid: string): { writeInput(text: string): void };
  kill(sid: string): Promise<void>;
  infoOf?(sid: string): SessionInfo;
}

export interface StartWorkerInput {
  taskId: string;
  agent: AgentKind;
  accountId?: string | undefined;
  /** 新 worktree 才能与其他 worker 并行改代码；none 用协调者当前 cwd。 */
  worktree: WorktreeMode;
  /** 仅在 worktree:new 时用作仓库定位；none 时就是 worker 的 cwd。 */
  cwd: string;
  kind?: SessionKind | undefined;
  approvalPolicy?: CreateSessionInput["approvalPolicy"];
  cols?: number;
  rows?: number;
}

export interface StartWorkerResult {
  task: Task;
  dispatch: Dispatch;
  session: SessionInfo;
  worktree: WorkerWorktree | null;
}

export interface WorkerWorktree {
  assetId: string;
  path: string;
  clones: CloneReport[];
  mode: EsaytreeCreateMode;
  cow: boolean;
  ms: number;
  fallbackReason: string | null;
}

export interface StopWorkerResult {
  task: Task;
  dispatch: Dispatch;
}

export interface DispatchRecoveryResult {
  /** 会话已丢失/终态而被收敛的 worker；Task 仍须由显式 done/fail 才能成功。 */
  settled: StopWorkerResult[];
  /** 找回的存活 worker；crash 前残留的 starting 已可安全恢复为 running。 */
  resumed: Dispatch[];
}

export class DispatchError extends Error {
  constructor(
    message: string,
    readonly code: "task_not_ready" | "not_a_repo" | "wrong_worker" | "worker_not_active",
  ) {
    super(message);
  }
}

export class DispatchService {
  constructor(
    private readonly store: OrchestrationStore,
    private readonly sessions: WorkerSessionManager,
    private readonly worktreeAssets = new WorktreeAssetService(store),
  ) {}

  /**
   * 人类显式停止 worker。先终止真实会话，再把这次派发落为 abandoned；若 worker
   * 在 kill 之前已经显式交付，则尊重 done/failed，不用停止动作覆盖真实结果。
   */
  async stopWorker(taskId: string, reason = "由用户停止 worker"): Promise<StopWorkerResult> {
    const active = this.store.activeDispatchFor(taskId);
    if (!active) {
      throw new DispatchError(`任务 ${taskId} 没有运行中的 worker`, "worker_not_active");
    }
    await this.sessions.kill(active.sessionId);

    let currentDispatch = this.store.getDispatch(active.id);
    let currentTask = this.store.getTask(taskId);
    if (currentDispatch.state === "starting" || currentDispatch.state === "running") {
      currentDispatch = this.store.setDispatchState(active.id, "abandoned", reason);
    } else if (currentDispatch.state === "abandoned") {
      // SessionManager 的终态事件可能已先一步收尾；显式用户原因比泛化退出原因更有用。
      currentDispatch = this.store.setDispatchState(active.id, "abandoned", reason);
    }
    if (currentTask.status === "dispatched") {
      currentTask = this.store.setTaskStatus(taskId, "failed", reason);
    } else if (currentTask.status === "failed" && currentDispatch.state === "abandoned") {
      currentTask = this.store.setTaskStatus(taskId, "failed", reason);
    }
    this.store.preserveWorktreeAssetsForDispatch(
      currentDispatch.id,
      "worker 已停止；工作树默认保留，需显式检查或清理",
    );
    return { task: currentTask, dispatch: currentDispatch };
  }

  /** PTY/结构化会话未显式交付就退出时，不能让 Dispatch 永久伪装成 running。 */
  settleEndedSession(sessionId: string, reason: string): StopWorkerResult | null {
    const active = this.store.listDispatches().find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        (candidate.state === "starting" || candidate.state === "running"),
    );
    if (!active) return null;
    const settled = this.store.abandonActiveDispatchForMissingSession(active.id, reason);
    if (settled) this.store.preserveWorktreeAssetsForDispatch(active.id, reason);
    return settled;
  }

  /**
   * 恢复 daemon 后不能只等后续 state 事件：直接托管的会话已不在内存，
   * tmux/结构化会话也可能已在 daemon 启动前结束。逐条对账让持久状态收口。
   */
  reconcilePersistedSessions(): DispatchRecoveryResult {
    const settled: StopWorkerResult[] = [];
    const resumed: Dispatch[] = [];
    for (const dispatch of this.store.listDispatches()) {
      if (dispatch.state !== "starting" && dispatch.state !== "running") continue;

      let session: SessionInfo | null = null;
      try {
        session = this.sessions.infoOf?.(dispatch.sessionId) ?? null;
      } catch {
        // SessionManager 用抛错表达不存在；恢复对账必须把它当成正常输入。
      }

      if (!session) {
        const result = this.store.abandonActiveDispatchForMissingSession(
          dispatch.id,
          "worker 会话在 daemon 恢复后不存在",
        );
        if (result) settled.push(result);
        if (result) this.store.preserveWorktreeAssetsForDispatch(dispatch.id, result.dispatch.outcome);
        continue;
      }
      if (session.status === "completed" || session.status === "done" || session.status === "died") {
        const result = this.store.abandonActiveDispatchForMissingSession(
          dispatch.id,
          "worker 会话在 daemon 恢复时已结束但未显式交付",
        );
        if (result) settled.push(result);
        if (result) this.store.preserveWorktreeAssetsForDispatch(dispatch.id, result.dispatch.outcome);
        continue;
      }

      // `starting` 仅表示创建/前导词路径尚未全部返回。进程已被 SessionManager
      // 找回时不存在那条 in-flight promise；恢复后把“有活 worker”的事实标为 running。
      if (dispatch.state === "starting") {
        resumed.push(this.store.setDispatchState(dispatch.id, "running"));
      } else {
        resumed.push(dispatch);
      }
    }
    return { settled, resumed };
  }

  /**
   * 先建好隔离目录和会话，再把 Dispatch 落盘，最后才把任务前导词送给 agent。
   * Dispatch 必须先于前导词可见：结构化后端可能极快地开始执行，worker 的
   * `task done` 绝不能抢在自己的归属记录之前到达。
   */
  async startWorker(input: StartWorkerInput): Promise<StartWorkerResult> {
    const task = this.store.getTask(input.taskId);
    const run = this.store.getRun(task.runId);
    if (!this.store.listReadyTasks(task.runId).some((candidate) => candidate.id === task.id)) {
      throw new DispatchError(`任务 ${task.id} 还没 ready，不能派发`, "task_not_ready");
    }

    let worktree: ({ repo: string } & WorkerWorktree) | null = null;
    let session: SessionInfo | null = null;
    let dispatch: Dispatch | null = null;
    try {
      let workerCwd = input.cwd;
      if (input.worktree === "new") {
        const repo = await repoRoot(input.cwd);
        if (!repo) {
          throw new DispatchError(`${input.cwd} 不在 git 仓库中，不能创建 worktree`, "not_a_repo");
        }
        const stamp = Date.now().toString(36);
        const name = `worker-${task.id}-${stamp}`;
        const created = await createEsaytree({
          repo,
          name,
          branch: `prospero/${task.runId}/${task.id}/${stamp}`,
        });
        workerCwd = created.path;
        // 目录一旦创建就立即持久登记，发生在 session.create 之前。创建后任一步
        // 失败也保留它和分支，必须由用户走显式 cleanup 才能删除。
        const asset = this.worktreeAssets.registerWorker({
          runId: task.runId,
          taskId: task.id,
          repo,
          path: created.path,
          branch: created.branch,
        });
        worktree = {
          repo,
          assetId: asset.id,
          path: created.path,
          clones: created.clones,
          mode: created.mode,
          cow: created.cow,
          ms: created.ms,
          fallbackReason: created.fallbackReason ?? null,
        };
      }

      const coordinator = run.coordinatorSessionId && this.sessions.infoOf
        ? this.sessions.infoOf(run.coordinatorSessionId)
        : null;
      const inheritedAccountId =
        input.accountId ??
        (coordinator?.agent === input.agent ? coordinator.accountId : undefined);
      session = await this.sessions.create({
        agent: input.agent,
        ...(inheritedAccountId ? { accountId: inheritedAccountId } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
        cwd: workerCwd,
        cols: input.cols ?? 120,
        rows: input.rows ?? 40,
        // worker 是 daemon 自己创建的本地进程，不沿用某一台手机的 allowShell。
        allowShell: true,
      });
      dispatch = this.store.createDispatch({
        taskId: task.id,
        sessionId: session.id,
        worktreePath: worktree?.path ?? null,
      });
      if (worktree) this.store.linkWorktreeAssetDispatch(worktree.assetId, dispatch.id);

      const prompt = workerPrompt(task, session.id, workerCwd, run.coordinatorSessionId);
      if (session.kind === "structured") {
        await this.sessions.chatSend(session.id, prompt);
      } else {
        // PTY 轨没有 chat API；用一段单行提示直接送进 agent 的终端输入。
        this.sessions.requirePty(session.id).writeInput(`${prompt.replace(/\n/g, " ")}\r`);
      }
      const running = this.store.setDispatchState(dispatch.id, "running");
      return {
        task: this.store.getTask(task.id),
        dispatch: running,
        session,
        worktree: worktree
          ? {
              assetId: worktree.assetId,
              path: worktree.path,
              clones: worktree.clones,
              mode: worktree.mode,
              cow: worktree.cow,
              ms: worktree.ms,
              fallbackReason: worktree.fallbackReason,
            }
          : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (dispatch) {
        this.store.setDispatchState(dispatch.id, "failed", message);
        this.store.setTaskStatus(task.id, "failed", message);
      }
      if (session) await this.sessions.kill(session.id).catch(() => {});
      if (worktree) {
        this.store.preserveWorktreeAsset(
          worktree.assetId,
          `worker 派发未完成；已保留工作树和分支：${message}`,
        );
      }
      throw error;
    }
  }

  /** worker 显式交付成功；会话 idle/done 绝不触发这里。 */
  completeTask(taskId: string, actorSessionId: string | null, body: string): Task {
    const task = this.store.getTask(taskId);
    if (task.status === "done") return task; // CLI 重试可安全重放
    const dispatch = this.store.activeDispatchFor(taskId);
    this.assertWorker(dispatch, actorSessionId, taskId);
    const completed = this.store.setTaskStatus(taskId, "done", body);
    this.store.setDispatchState(dispatch.id, "succeeded", body);
    this.store.preserveWorktreeAssetsForDispatch(
      dispatch.id,
      "worker 已交付；工作树默认保留，需显式检查或清理",
    );
    return completed;
  }

  /** worker 显式报告失败；failed 之后可由协调者退回 pending 重新派。 */
  failTask(taskId: string, actorSessionId: string | null, body: string): Task {
    const task = this.store.getTask(taskId);
    if (task.status === "failed") return task;
    const dispatch = this.store.activeDispatchFor(taskId);
    this.assertWorker(dispatch, actorSessionId, taskId);
    const failed = this.store.setTaskStatus(taskId, "failed", body);
    this.store.setDispatchState(dispatch.id, "failed", body);
    this.store.preserveWorktreeAssetsForDispatch(
      dispatch.id,
      "worker 报告失败；工作树默认保留，需显式检查或清理",
    );
    return failed;
  }

  private assertWorker(dispatch: Dispatch | null, actorSessionId: string | null, taskId: string): asserts dispatch is Dispatch {
    if (!dispatch) {
      throw new DispatchError(`任务 ${taskId} 没有进行中的派发`, "wrong_worker");
    }
    if (actorSessionId !== null && dispatch.sessionId !== actorSessionId) {
      throw new DispatchError(`任务 ${taskId} 属于另一个 worker，不能由当前会话交付`, "wrong_worker");
    }
  }
}

function workerPrompt(
  task: Task,
  sessionId: string,
  cwd: string,
  coordinatorSessionId: string | null,
): string {
  return [
    "你是 Prospero 编排中的 worker。只处理下面这一个任务，不要自行创建或派发其他 worker。",
    `任务 ID: ${task.id}`,
    `会话 ID: ${sessionId}`,
    `协调者会话: ${coordinatorSessionId ?? "未指定"}`,
    `工作目录: ${cwd}`,
    `任务: ${task.title}`,
    `要求:\n${task.spec}`,
    "完成并自行验证后，必须执行：",
    `prospero --session ${sessionId} task done --id ${task.id} --body \"简短交付摘要\"`,
    "如果无法完成，执行：",
    `prospero --session ${sessionId} task fail --id ${task.id} --body \"原因与下一步\"`,
    coordinatorSessionId
      ? "task done/fail 会自动报告协调者；需中途沟通可用 prospero send / prospero ask。"
      : "未指定协调者；请在交付摘要中写清验证结果。",
    "仅停止、空闲或退出不会把任务标记为完成。",
  ].join("\n");
}
