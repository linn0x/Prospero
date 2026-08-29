/** 把一个 ready task 变成实际 worker 会话的唯一入口。 */
import { createHash } from "node:crypto";
import type { AgentKind, SessionInfo, SessionKind } from "@prospero/protocol";
import { resolveExplicitSkills } from "../composer-context.js";
import type { CreateSessionInput, KillSessionOptions, SessionHosting } from "../session-manager.js";
import type { PtyStartupReadinessOptions } from "../pty-startup-readiness.js";
import {
  createEsaytree,
  repoRoot,
  type CloneReport,
  type CowBackend,
  type EsaytreeCreateMode,
} from "./esaytree.js";
import { OrchestrationStore } from "./store.js";
import type { Dispatch, DispatchSkillBinding, Task } from "./model.js";
import { WorktreeAssetService } from "./worktree-assets.js";
import {
  findLiveSessionForRun,
  findLiveWorktreeLease,
  isTerminalSession,
  registeredWorktreeAssetForCwd,
  type WorktreeSessionInspector,
} from "./worktree-leases.js";

export type WorktreeMode = "new" | "none";
export type WorkerStopFinalStatus = "failed" | "cancelled";

/** kill 正在处理自我发起的 control RPC 时，不能让 task.done/fail 永久卡住。 */
export const WORKER_TERMINATION_TIMEOUT_MS = 5_000;

export interface WorkerSessionManager {
  create(input: CreateSessionInput): Promise<SessionInfo>;
  chatSend(sid: string, text: string): Promise<void>;
  requirePty(sid: string): { writeInput(text: string): void | Promise<void> };
  /** 仅 PTY 实现的、可取消且有界的 TUI 启动稳定等待。 */
  waitForPtyReady?(sid: string, options?: PtyStartupReadinessOptions): Promise<void>;
  kill(sid: string, options?: KillSessionOptions): Promise<void>;
  infoOf(sid: string): SessionInfo;
  /** Exact host provenance is optional so existing direct-session adapters remain compatible. */
  sessionHostingOf?(sid: string): SessionHosting;
  /** Windows owner identity includes manifest epoch + PID + process FILETIME. */
  hostOwnerIdentityOf?(sid: string): string | null;
}

export interface StartWorkerInput {
  taskId: string;
  agent: AgentKind;
  accountId?: string | undefined;
  /** 省略则使用 Task 上冻结的 skills；显式传入可为本次派发覆盖。 */
  skills?: string[] | undefined;
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
      | "worker_stop_failed"
      | "worktree_busy"
      | "worker_session_live"
      | "skills_invalid",
  ) {
    super(message);
  }
}

export class DispatchService {
  private readonly worktreeAssets: WorktreeAssetService;
  /** Session 尚未创建完成时也必须占住已登记 worktree，避免并发请求双写。 */
  private readonly startingWorktreeAssetIds = new Set<string>();
  /**
   * stop 必须先等真实 session 终止，才能把未显式交付的派发落为 abandoned。
   * 在这段 await 期间，启动路径收到 PTY 的终态事件也不能抢先把它记成普通启动
   * 失败；同一 dispatch 的并发 stop 还应共享同一次 kill。
   */
  private readonly stoppingDispatches = new Map<string, Promise<StopWorkerResult>>();

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
  async stopWorker(
    taskId: string,
    reason = "由用户停止 worker",
    finalStatus: WorkerStopFinalStatus = "failed",
  ): Promise<StopWorkerResult> {
    const active = this.store.activeDispatchFor(taskId);
    if (!active) {
      throw new DispatchError(`任务 ${taskId} 没有运行中的 worker`, "worker_not_active");
    }
    const alreadyStopping = this.stoppingDispatches.get(active.id);
    if (alreadyStopping) return alreadyStopping;

    const stopping = this.stopActiveWorker(active, taskId, reason, finalStatus);
    this.stoppingDispatches.set(active.id, stopping);
    try {
      return await stopping;
    } finally {
      if (this.stoppingDispatches.get(active.id) === stopping) {
        this.stoppingDispatches.delete(active.id);
      }
    }
  }

  private async stopActiveWorker(
    active: Dispatch,
    taskId: string,
    reason: string,
    finalStatus: WorkerStopFinalStatus,
  ): Promise<StopWorkerResult> {
    try {
      await this.sessions.kill(active.sessionId);
    } catch (error) {
      // Session termination races with an agent's explicit task.done/fail and
      // with adapter-side terminal projection. If either durable orchestration
      // state or the session registry already says the worker is terminal, the
      // stop request has converged and must not become an opaque control_error.
      let sessionTerminal = false;
      try {
        sessionTerminal = isTerminalSession(this.sessions.infoOf(active.sessionId));
      } catch {
        // Missing session information is not enough to claim convergence; the
        // durable Task/Dispatch pair below remains the authority.
      }
      const durableDispatch = this.store.getDispatch(active.id);
      const durableTask = this.store.getTask(taskId);
      const durableTerminal =
        (durableDispatch.state !== "starting" && durableDispatch.state !== "running")
        || durableTask.status !== "dispatched";
      if (!sessionTerminal && !durableTerminal) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DispatchError(`停止 worker 会话失败: ${message}`, "worker_stop_failed");
      }
    }
    let currentDispatch = this.store.getDispatch(active.id);
    let currentTask = this.store.getTask(taskId);
    if (currentDispatch.state === "starting" || currentDispatch.state === "running") {
      currentDispatch = this.store.setDispatchState(active.id, "abandoned", reason);
    } else if (currentDispatch.state === "abandoned") {
      // SessionManager 的终态事件可能已先一步收尾；显式用户原因比泛化退出原因更有用。
      currentDispatch = this.store.setDispatchState(active.id, "abandoned", reason);
    }
    if (currentTask.status === "dispatched") {
      currentTask = this.store.setTaskStatus(taskId, finalStatus, reason);
    } else if (currentTask.status === "failed" && currentDispatch.state === "abandoned") {
      // SessionManager may project the kill event as failed before this stop
      // request regains the actor. An abandoned dispatch proves there was no
      // explicit task.fail delivery (that path settles the dispatch as failed),
      // so an intentional supersede may safely converge the Task to cancelled.
      currentTask = this.store.setTaskStatus(taskId, finalStatus, reason);
    }
    this.store.preserveWorktreeAssetsForDispatch(
      currentDispatch.id,
      "worker 已停止；工作树默认保留，需显式检查或清理",
    );
    // worker.start 可能仍在 readiness/prompt await 中；停止结果必须先成为恢复后
    // 的事实，才能让它返回这个终态而不是旧 create() 快照或重新标记 running。
    this.store.persistNow();
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

      let hosting: SessionHosting | undefined = session ? undefined : "unavailable";
      if (session && this.sessions.sessionHostingOf) {
        try {
          hosting = this.sessions.sessionHostingOf(dispatch.sessionId);
        } catch {
          hosting = "unavailable";
        }
      }
      let ownerIdentity: string | null | undefined;
      if (session && dispatch.hostOwnerIdentity && this.sessions.hostOwnerIdentityOf) {
        try {
          ownerIdentity = this.sessions.hostOwnerIdentityOf(dispatch.sessionId);
        } catch {
          ownerIdentity = null;
        }
      }
      const ownerChanged = ownerIdentity !== undefined && ownerIdentity !== dispatch.hostOwnerIdentity;
      // Old dispatches have no host provenance. Retain their generic missing
      // session outcome rather than falsely labelling every historical direct
      // session as a Windows host failure.
      const hostUnavailable = hosting === "unavailable" && dispatch.hostOwnerIdentity !== undefined;
      if (hostUnavailable || ownerChanged || isTerminalSession(session)) {
        const reason = hostUnavailable || ownerChanged
          ? "Windows Session Host owner 不可用或身份验证不匹配；worker 未显式交付"
          : session
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
    let skillBindings: DispatchSkillBinding[] = [];
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
    const refreshedSession = (fallback: SessionInfo, currentDispatch: Dispatch): SessionInfo => {
      // create() 的结果只是创建瞬间的快照。PTY readiness 和 prompt 写入之间可能
      // 已把 SessionManager 的状态推进到 running；控制 API 的成功响应必须读同一
      // sid 的当前事实，而不是把这个旧 starting 带回调用方。
      try {
        const current = this.sessions.infoOf(fallback.id);
        // 显式 task.done/fail 已同步落盘后，kill 的后台收尾可能仍留下一个旧的
        // live facade。交付终态比那份过渡中的内存状态更权威。
        if (isSettledDispatch(currentDispatch)) return { ...current, status: "done" };
        // quiet PTY 可以在 readiness 总超时后成功接收完整 prompt，却仍未产生首帧，
        // 因而 SessionManager 暂时保留 starting。worker.start 已把 prompt 写入并将
        // Dispatch 原子推进为 running 后，成功响应不能再回传 create() 的过期状态。
        if (currentDispatch.state === "running" && current.status === "starting") {
          return { ...current, status: "running" };
        }
        return current;
      } catch {
        // PTY kill 会从 SessionManager 删除会话。若 Dispatch 已落定，不能回传
        // create() 时的 starting/idle 误导调用方；其余错误保留唯一可用的快照。
        return isSettledDispatch(currentDispatch)
          ? { ...fallback, status: "done" }
          : fallback;
      }
    };
    const currentResult = (fallback: SessionInfo, currentDispatch: Dispatch): StartWorkerResult =>
      result(refreshedSession(fallback, currentDispatch), currentDispatch);
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

      const requestedSkills = input.skills ?? task.skills ?? [];
      if (requestedSkills.length > 0 && input.kind === "pty") {
        throw new DispatchError("显式 Skill 绑定只支持 structured worker", "skills_invalid");
      }
      if (requestedSkills.length > 0) {
        const allowed = new Set(requestedSkills.map((skill) => skill.trim().toLocaleLowerCase()));
        const mentioned = [...task.spec.matchAll(/(?:^|\s)\$([A-Za-z0-9][A-Za-z0-9._:-]*)/g)]
          .map((match) => match[1]!.toLocaleLowerCase());
        const undeclared = [...new Set(mentioned.filter((skill) => !allowed.has(skill)))];
        if (undeclared.length > 0) {
          throw new DispatchError(
            `任务 spec 引用了未显式绑定的 Skill: ${undeclared.join(", ")}`,
            "skills_invalid",
          );
        }
      }
      try {
        const resolvedSkills = await resolveExplicitSkills(workerCwd, requestedSkills);
        skillBindings = resolvedSkills.map((skill) => ({
          name: skill.name,
          path: skill.path,
          sha256: createHash("sha256").update(skill.contents).digest("hex"),
        }));
      } catch (error) {
        throw new DispatchError(
          `Skill 解析失败: ${error instanceof Error ? error.message : String(error)}`,
          "skills_invalid",
        );
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
      if (skillBindings.length > 0 && session.kind !== "structured") {
        throw new DispatchError("显式 Skill 绑定只支持 structured worker", "skills_invalid");
      }
      let hostOwnerIdentity: string | null | undefined;
      try {
        hostOwnerIdentity = this.sessions.hostOwnerIdentityOf?.(session.id);
      } catch {
        // A newly created session with unreadable provenance is still handled
        // by the normal create failure path if its first command cannot run.
      }
      dispatch = this.store.createDispatch({
        taskId: task.id,
        sessionId: session.id,
        ...(hostOwnerIdentity ? { hostOwnerIdentity } : {}),
        worktreePath: worktree?.path ?? null,
        skills: skillBindings,
      });
      if (worktree) this.store.linkWorktreeAssetDispatch(worktree.assetId, dispatch.id);
      // worker.start 的成功响应必须代表可恢复事实，而不只是内存状态。尤其是
      // structured adapter 可能在同一事件循环内极快地产生 turn.end；若此时
      // daemon 遭遇 SIGKILL，不能把已启动 worker 恢复成仍可重复派发的 pending。
      // 先把 starting + task.dispatched（以及 worktree 关联）同步原子落盘，再发送
      // 任何可能让 agent 执行用户代码的前导词。
      this.store.persistNow();

      const prompt = workerPrompt(
        task, session.id, workerCwd, run.coordinatorSessionId,
        skillBindings.map((skill) => skill.name),
      );
      if (session.kind === "structured") {
        await this.sessions.chatSend(session.id, prompt);
      } else {
        // PTY 轨没有 chat API；TUI 可能在 create() 返回后仍清空输入行。真实
        // SessionManager 会等首帧/非 starting 状态后的短稳定窗口；旧测试 double
        // 没有这个可选能力时保持同步 fallback，不影响 structured 或其它后端。
        await this.sessions.waitForPtyReady?.(session.id);
        const beforePrompt = this.store.getDispatch(dispatch.id);
        if (beforePrompt.state !== "starting" && beforePrompt.state !== "running") {
          // 等待期间 worker 可能已显式 task.done/fail；绝不能再把前导词写入
          // 已关闭的 PTY，也不能用后续 running 覆盖那个真实交付。
          this.store.persistNow();
          return currentResult(session, beforePrompt);
        }
        // 用一段单行提示直接送进已经稳定的 agent 终端输入。
        await this.sessions.requirePty(session.id).writeInput(`${prompt.replace(/\n/g, " ")}\r`);
      }
      const currentDispatch = this.store.getDispatch(dispatch.id);
      // 极快的 worker 可以在前导词调用尚未返回时显式 task.done/fail。不能用迟到的
      // running 覆盖已经持久交付的终态。
      const running = currentDispatch.state === "starting"
        ? this.store.setDispatchState(dispatch.id, "running")
        : currentDispatch;
      this.store.persistNow();
      // structured 路径没有 readiness timer；这里仅做一次同步 infoOf 刷新，不会
      // 给 chat worker 增加人为延迟。
      return currentResult(session, running);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (dispatch) {
        const stopping = this.stoppingDispatches.get(dispatch.id);
        if (stopping && session) {
          // stop 已先占有这个 dispatch。等待它把 abandoned/显式交付结果持久化，
          // 不能把 readiness 的“会话已结束”当作另一条启动失败路径。
          const stopped = await stopping;
          return currentResult(session, stopped.dispatch);
        }
        const currentDispatch = this.store.getDispatch(dispatch.id);
        const currentTask = this.store.getTask(task.id);
        const settled = isSettledDispatch(currentDispatch) && isSettledTask(currentTask);
        // task.done/fail 会先同步写盘再终止 supervisor；终止动作可能让仍在等待的
        // chatSend 以“连接关闭”拒绝。任何已持久的终态（包括并发 stop）优先，
        // worker.start 应返回该事实，不能把成功交付伪装成启动失败，更不能回滚
        // Task/Dispatch。
        if (settled && session) return currentResult(session, currentDispatch);
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

function isSettledDispatch(dispatch: Dispatch): boolean {
  return dispatch.state === "succeeded" || dispatch.state === "failed" || dispatch.state === "abandoned";
}

function isSettledTask(task: Task): boolean {
  return task.status === "done" || task.status === "failed" || task.status === "cancelled";
}

function workerPrompt(
  task: Task,
  sessionId: string,
  cwd: string,
  coordinatorSessionId: string | null,
  skills: string[],
): string {
  return [
    "你是 Prospero 编排中的 worker。只处理下面这一个任务，不要自行创建或派发其他 worker。",
    `任务 ID: ${task.id}`,
    `会话 ID: ${sessionId}`,
    `协调者会话: ${coordinatorSessionId ?? "未指定"}`,
    `工作目录: ${cwd}`,
    `任务: ${task.title}`,
    ...(skills.length > 0
      ? [`显式 Skills: ${skills.map((skill) => `$${skill}`).join(" ")}`]
      : []),
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
