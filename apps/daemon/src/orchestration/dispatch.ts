/** 把一个 ready task 变成实际 worker 会话的唯一入口。 */
import type { AgentKind, SessionInfo, SessionKind } from "@prospero/protocol";
import type { CreateSessionInput } from "../session-manager.js";
import {
  createWorktree,
  removeWorktree,
  repoRoot,
  type CloneReport,
} from "./worktree.js";
import { OrchestrationStore } from "./store.js";
import type { Dispatch, Task } from "./model.js";

export type WorktreeMode = "new" | "none";

export interface WorkerSessionManager {
  create(input: CreateSessionInput): Promise<SessionInfo>;
  chatSend(sid: string, text: string): Promise<void>;
  requirePty(sid: string): { writeInput(text: string): void };
  kill(sid: string): Promise<void>;
}

export interface StartWorkerInput {
  taskId: string;
  agent: AgentKind;
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
  worktree: { path: string; clones: CloneReport[] } | null;
}

export class DispatchError extends Error {
  constructor(message: string, readonly code: "task_not_ready" | "not_a_repo" | "wrong_worker") {
    super(message);
  }
}

export class DispatchService {
  constructor(
    private readonly store: OrchestrationStore,
    private readonly sessions: WorkerSessionManager,
  ) {}

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

    let worktree: { repo: string; path: string; clones: CloneReport[] } | null = null;
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
        const created = await createWorktree({
          repo,
          name,
          branch: `prospero/${task.runId}/${task.id}/${stamp}`,
        });
        workerCwd = created.path;
        worktree = { repo, path: created.path, clones: created.clones };
      }

      session = await this.sessions.create({
        agent: input.agent,
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
        worktree: worktree ? { path: worktree.path, clones: worktree.clones } : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (dispatch) {
        this.store.setDispatchState(dispatch.id, "failed", message);
        this.store.setTaskStatus(task.id, "failed", message);
      }
      if (session) await this.sessions.kill(session.id).catch(() => {});
      if (worktree) await removeWorktree(worktree.repo, worktree.path).catch(() => {});
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
