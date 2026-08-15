/** 把一个 ready task 变成实际 worker 会话的唯一入口。 */
import type { AgentKind, SessionInfo, SessionKind } from "@prospero/protocol";
import type { CreateSessionInput, KillSessionOptions } from "../session-manager.js";
import {
  createEsaytree,
  repoRoot,
  type CloneReport,
  type CowBackend,
  type EsaytreeCreateMode,
} from "./esaytree.js";
import { OrchestrationStore } from "./store.js";
import type { Dispatch, Task } from "./model.js";
import { WorktreeAssetService } from "./worktree-assets.js";
import {
  findLiveSessionForRun,
  findLiveWorktreeLease,
  isTerminalSession,
  registeredWorktreeAssetForCwd,
  type WorktreeSessionInspector,
} from "./worktree-leases.js";

export type WorktreeMode = "new" | "none";

/** kill 正在处理自我发起的 control RPC 时，不能让 task.done/fail 永久卡住。 */
export const WORKER_TERMINATION_TIMEOUT_MS = 5_000;

export interface WorkerSessionManager {
  create(input: CreateSessionInput): Promise<SessionInfo>;
  chatSend(sid: string, text: string): Promise<void>;
  requirePty(sid: string): { writeInput(text: string): void };
  kill(sid: string, options?: KillSessionOptions): Promise<void>;
  infoOf(sid: string): SessionInfo;
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
  cowBackend: CowBackend;
  preservedIgnored: string[];
  skippedIgnored: CloneReport[];
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
    readonly code:
      | "task_not_ready"
      | "not_a_repo"
      | "wrong_worker"
      | "worker_not_active"
      | "worktree_busy"
      | "worker_session_live",
  ) {
    super(message);
  }
}

export class DispatchService {
  private readonly worktreeAssets: WorktreeAssetService;
  /** Session 尚未创建完成时也必须占住已登记 worktree，避免并发请求双写。 */
  private readonly startingWorktreeAssetIds = new Set<string>();

  constructor(
    private readonly store: OrchestrationStore,
    private readonly sessions: WorkerSessionManager,
    worktreeAssets?: WorktreeAssetService,
  ) {
    this.worktreeAssets = worktreeAssets ?? new WorktreeAssetService(store, undefined, sessions);
  }

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

  /**
   * PTY/结构化会话真正终止（done/died）却未显式交付时，不能让 Dispatch
   * 永久伪装成 running。结构化的 `completed` 只是本轮结束，绝不可调用这里。
   */
  settleTerminatedSession(sessionId: string, reason: string): StopWorkerResult | null {
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
   * tmux/结构化会话也可能已在 daemon 启动前真正结束。逐条对账让持久状态收口。
   */
  async reconcilePersistedSessions(): Promise<DispatchRecoveryResult> {
    const settled: StopWorkerResult[] = [];
    const resumed: Dispatch[] = [];
    for (const dispatch of this.store.listDispatches()) {
      let session: SessionInfo | null = null;
      try {
        session = this.sessions.infoOf(dispatch.sessionId);
      } catch {
        // SessionManager 用抛错表达不存在；恢复对账必须把它当成正常输入。
      }

      const active = dispatch.state === "starting" || dispatch.state === "running";
      if (!active) {
        // “交付已落盘、kill 尚未来得及调用”是一个独立的 crash window。成功/失败
        // dispatch 的旧结构化会话若仍活着，会在恢复后继续消费已排队 chat；必须
        // 像正常 task.done/fail 一样终止并归档，不可只对账 running 状态。
        if (session && !isTerminalSession(session)) {
          await this.terminateDeliveredWorker(dispatch.sessionId);
        }
        continue;
      }

      if (isTerminalSession(session)) {
        const reason = session
          ? "worker 会话在 daemon 恢复时已结束但未显式交付"
          : "worker 会话在 daemon 恢复后不存在";
        const result = this.store.abandonActiveDispatchForMissingSession(
          dispatch.id,
          reason,
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
    let startingAssetId: string | null = null;
    const result = (resultSession: SessionInfo, resultDispatch: Dispatch): StartWorkerResult => ({
      task: this.store.getTask(task.id),
      dispatch: resultDispatch,
      session: resultSession,
      worktree: worktree
        ? {
            assetId: worktree.assetId,
            path: worktree.path,
            clones: worktree.clones,
            mode: worktree.mode,
            cow: worktree.cow,
            cowBackend: worktree.cowBackend,
            preservedIgnored: worktree.preservedIgnored,
            skippedIgnored: worktree.skippedIgnored,
            ms: worktree.ms,
            fallbackReason: worktree.fallbackReason,
          }
        : null,
    });
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
          cowBackend: created.cowBackend,
          preservedIgnored: created.preservedIgnored,
          skippedIgnored: created.skippedIgnored,
          ms: created.ms,
          fallbackReason: created.fallbackReason ?? null,
        };
      } else {
        const registered = registeredWorktreeAssetForCwd(this.store, workerCwd);
        if (registered && this.startingWorktreeAssetIds.has(registered.id)) {
          throw new DispatchError(
            `工作目录 ${workerCwd} 所在的登记工作树正在创建另一名 worker；请等待该派发落定`,
            "worktree_busy",
          );
        }
        const lease = findLiveWorktreeLease(this.store, this.sessions, workerCwd);
        if (lease) {
          throw new DispatchError(
            `工作目录 ${workerCwd} 属于已登记工作树 ${lease.asset.path}，仍由会话 ${lease.session.id} 写入；请先等待其终态或停止该 worker`,
            "worktree_busy",
          );
        }
        if (registered) {
          this.startingWorktreeAssetIds.add(registered.id);
          startingAssetId = registered.id;
        }
      }

      let coordinator: SessionInfo | null = null;
      if (run.coordinatorSessionId) {
        try {
          coordinator = this.sessions.infoOf(run.coordinatorSessionId);
        } catch {
          // 协调者可能已经结束或不由当前 SessionManager 托管；账号继承只是增强。
        }
      }
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
      // worker.start 的成功响应必须代表可恢复事实，而不只是内存状态。尤其是
      // structured adapter 可能在同一事件循环内极快地产生 turn.end；若此时
      // daemon 遭遇 SIGKILL，不能把已启动 worker 恢复成仍可重复派发的 pending。
      // 先把 starting + task.dispatched（以及 worktree 关联）同步原子落盘，再发送
      // 任何可能让 agent 执行用户代码的前导词。
      this.store.persistNow();

      const prompt = workerPrompt(task, session.id, workerCwd, run.coordinatorSessionId);
      if (session.kind === "structured") {
        await this.sessions.chatSend(session.id, prompt);
      } else {
        // PTY 轨没有 chat API；用一段单行提示直接送进 agent 的终端输入。
        this.sessions.requirePty(session.id).writeInput(`${prompt.replace(/\n/g, " ")}\r`);
      }
      const currentDispatch = this.store.getDispatch(dispatch.id);
      // 极快的 worker 可以在前导词调用尚未返回时显式 task.done/fail。不能用迟到的
      // running 覆盖已经持久交付的终态。
      const running = currentDispatch.state === "starting"
        ? this.store.setDispatchState(dispatch.id, "running")
        : currentDispatch;
      this.store.persistNow();
      return result(session, running);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (dispatch) {
        const currentDispatch = this.store.getDispatch(dispatch.id);
        const currentTask = this.store.getTask(task.id);
        const explicitlyDelivered =
          (currentDispatch.state === "succeeded" && currentTask.status === "done") ||
          (currentDispatch.state === "failed" && currentTask.status === "failed");
        // task.done/fail 会先同步写盘再终止 supervisor；终止动作可能让仍在等待的
        // chatSend 以“连接关闭”拒绝。此时交付事实优先，worker.start 应返回该终态，
        // 不能把成功交付伪装成启动失败，更不能回滚 Task/Dispatch。
        if (explicitlyDelivered && session) return result(session, currentDispatch);
        if (currentDispatch.state === "starting" || currentDispatch.state === "running") {
          this.store.setDispatchState(dispatch.id, "failed", message);
          if (currentTask.status === "dispatched") {
            this.store.setTaskStatus(task.id, "failed", message);
          }
          this.store.persistNow();
        }
      }
      if (session) await this.sessions.kill(session.id).catch(() => {});
      if (worktree) {
        this.store.preserveWorktreeAsset(
          worktree.assetId,
          `worker 派发未完成；已保留工作树和分支：${message}`,
        );
      }
      throw error;
    } finally {
      if (startingAssetId) this.startingWorktreeAssetIds.delete(startingAssetId);
    }
  }

  /** worker 显式交付成功；会话 idle/done 绝不触发这里。 */
  async completeTask(taskId: string, actorSessionId: string | null, body: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.status === "done") {
      // 上次同步写盘可能在 rename/fsync 前失败；内存里的终态不等于可恢复交付。
      // 必须先重试持久化，失败则让 CLI 重试继续报错，绝不能先杀掉唯一 writer。
      this.store.persistNow();
      await this.terminatePreviouslyDeliveredWorker(taskId, "succeeded");
      return task; // CLI 重试可安全重放
    }
    const dispatch = this.store.activeDispatchFor(taskId);
    this.assertWorker(dispatch, actorSessionId, taskId);
    const completed = this.store.settleWorkerDelivery(
      dispatch.id,
      "done",
      "succeeded",
      body,
      "worker 已交付；工作树默认保留，需显式检查或清理",
    );
    await this.terminateDeliveredWorker(dispatch.sessionId);
    return completed;
  }

  /** worker 显式报告失败；failed 之后可由协调者退回 pending 重新派。 */
  async failTask(taskId: string, actorSessionId: string | null, body: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (task.status === "failed") {
      // 与 done 同理：先恢复可重启的持久化事实，再终止旧会话。
      this.store.persistNow();
      await this.terminatePreviouslyDeliveredWorker(taskId, "failed");
      return task;
    }
    const dispatch = this.store.activeDispatchFor(taskId);
    this.assertWorker(dispatch, actorSessionId, taskId);
    const failed = this.store.settleWorkerDelivery(
      dispatch.id,
      "failed",
      "failed",
      body,
      "worker 报告失败；工作树默认保留，需显式检查或清理",
    );
    await this.terminateDeliveredWorker(dispatch.sessionId);
    return failed;
  }

  /** Run 删除前必须把已交付但仍活着的旧 session 当成 writer 保留索引。 */
  assertNoLiveSessionForRun(runId: string): void {
    const live = findLiveSessionForRun(this.store, this.sessions, runId);
    if (live) {
      throw new DispatchError(
        `会话 ${live.id} 仍存活；不能删除 Run，以免后续清理遗失其工作树写入者`,
        "worker_session_live",
      );
    }
  }

  /** 给 WorktreeAssetService 注入同一个 SessionManager 的只读查询面。 */
  sessionInspector(): WorktreeSessionInspector {
    return this.sessions;
  }

  /**
   * 交付事实已由 settleWorkerDelivery 同步落盘；kill 只是防止结构化队列继续
   * 消费，失败也绝不能把已经 done/failed 的任务回滚或伪装成 RPC 失败。若
   * adapter 自杀式关闭卡住，超时后保持已交付状态和 worktree 租约，原 kill
   * promise 仍可在后台自行收尾。
   */
  private async terminateDeliveredWorker(sessionId: string): Promise<void> {
    const kill = Promise.resolve()
      .then(() => this.sessions.kill(sessionId, { preserveHistory: true }))
      .then(() => true, () => true);
    let timer: NodeJS.Timeout | null = null;
    const completed = await Promise.race([
      kill,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), WORKER_TERMINATION_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!completed) {
      console.warn(
        `[prosperod] worker ${sessionId} 的终止超过 ${String(WORKER_TERMINATION_TIMEOUT_MS)}ms；保留交付和工作树租约，等待后台终止收尾`,
      );
    }
  }

  private async terminatePreviouslyDeliveredWorker(
    taskId: string,
    state: "succeeded" | "failed",
  ): Promise<void> {
    const dispatch = this.store.listDispatches()
      .filter((candidate) => candidate.taskId === taskId && candidate.state === state)
      .at(-1);
    if (dispatch) await this.terminateDeliveredWorker(dispatch.sessionId);
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
