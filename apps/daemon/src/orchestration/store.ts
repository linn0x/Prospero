/**
 * 编排状态的落盘。
 *
 * 单个 JSON 文件 + 原子写 + 防抖,跟 session-manager 里 pty-sessions.json /
 * structured-sessions.json 一个路子。不上 SQLite:数据量是几十个任务、
 * 几百条消息,查询全是按 runId 过滤,为它引一个原生依赖不划算。
 *
 * 内存里是真相,盘上是快照 —— 每次变更同步改内存、异步落盘,
 * 读操作永远不碰磁盘。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type Dispatch,
  type Gate,
  type Message,
  type OrchestrationState,
  type Run,
  type Task,
  type TaskStatus,
  TransitionError,
  canTransition,
  emptyState,
  findCycle,
  isReady,
} from "./model.js";

const PERSIST_DEBOUNCE_MS = 200;

export class OrchestrationError extends Error {
  constructor(message: string, readonly code: OrchestrationErrorCode) {
    super(message);
    this.name = "OrchestrationError";
  }
}

export type OrchestrationErrorCode =
  | "run_not_found"
  | "task_not_found"
  | "dispatch_not_found"
  | "gate_not_found"
  | "gate_not_pending"
  | "message_not_found"
  | "dep_not_found"
  | "task_wrong_run"
  | "dep_cycle"
  | "invalid_transition"
  | "task_not_dispatchable";

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class OrchestrationStore {
  private state: OrchestrationState = emptyState();
  private readonly file: string | null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  /** home 省略时纯内存(测试用) */
  constructor(home?: string) {
    this.file = home ? path.join(home, "orchestration.json") : null;
    this.load();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<OrchestrationState>;
      if (parsed.version === 1) {
        this.state = {
          version: 1,
          runs: parsed.runs ?? {},
          tasks: parsed.tasks ?? {},
          dispatches: parsed.dispatches ?? {},
          messages: parsed.messages ?? {},
          gates: parsed.gates ?? {},
        };
      }
    } catch {
      // 文件不在或者坏了都当空的开始。编排状态坏掉不该让 daemon 起不来 ——
      // 手机上还有一堆正常会话等着连。
    }
  }

  private schedulePersist(): void {
    if (!this.file || this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  persistNow(): void {
    if (!this.file) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  close(): void {
    this.persistNow();
    this.closed = true;
  }

  // ── Run ───────────────────────────────────────────────────────────────

  createRun(input: { objective: string; coordinatorSessionId?: string | null }): Run {
    const now = Date.now();
    const run: Run = {
      id: id("run"),
      objective: input.objective,
      status: "active",
      coordinatorSessionId: input.coordinatorSessionId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.runs[run.id] = run;
    this.schedulePersist();
    return run;
  }

  getRun(runId: string): Run {
    const run = this.state.runs[runId];
    if (!run) throw new OrchestrationError(`找不到 Run ${runId}`, "run_not_found");
    return run;
  }

  listRuns(): Run[] {
    return Object.values(this.state.runs).sort((a, b) => b.createdAt - a.createdAt);
  }

  updateRun(runId: string, patch: Partial<Pick<Run, "status" | "objective" | "coordinatorSessionId">>): Run {
    const run = this.getRun(runId);
    Object.assign(run, patch, { updatedAt: Date.now() });
    this.schedulePersist();
    return run;
  }

  // ── Task ──────────────────────────────────────────────────────────────

  createTask(input: {
    runId: string;
    title: string;
    spec: string;
    deps?: string[];
    parentId?: string | null;
  }): Task {
    this.getRun(input.runId);
    const deps = input.deps ?? [];
    for (const dep of deps) {
      const task = this.state.tasks[dep];
      if (!task) throw new OrchestrationError(`依赖的任务不存在: ${dep}`, "dep_not_found");
      if (task.runId !== input.runId) {
        throw new OrchestrationError(`依赖 ${dep} 属于别的 Run`, "dep_not_found");
      }
    }
    const now = Date.now();
    const task: Task = {
      id: id("task"),
      runId: input.runId,
      title: input.title,
      spec: input.spec,
      deps,
      parentId: input.parentId ?? null,
      status: "pending",
      result: null,
      createdAt: now,
      updatedAt: now,
    };

    // 先放进去再查环,查出来就撤 —— 新任务本身可能就是环的一环。
    this.state.tasks[task.id] = task;
    const cycle = findCycle(this.taskMap());
    if (cycle) {
      delete this.state.tasks[task.id];
      throw new OrchestrationError(`任务依赖成环: ${cycle.join(" → ")}`, "dep_cycle");
    }

    this.schedulePersist();
    return task;
  }

  getTask(taskId: string): Task {
    const task = this.state.tasks[taskId];
    if (!task) throw new OrchestrationError(`找不到任务 ${taskId}`, "task_not_found");
    return task;
  }

  listTasks(runId?: string): Task[] {
    const all = Object.values(this.state.tasks);
    const scoped = runId ? all.filter((t) => t.runId === runId) : all;
    return scoped.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 依赖都满足、可以派了的任务。ready 是派生值,不落盘。 */
  listReadyTasks(runId: string): Task[] {
    const map = this.taskMap();
    return this.listTasks(runId).filter((task) => isReady(task, map));
  }

  setTaskStatus(taskId: string, status: TaskStatus, result?: string | null): Task {
    const task = this.getTask(taskId);
    if (!canTransition(task.status, status)) {
      const err = new TransitionError(task.status, status);
      throw new OrchestrationError(err.message, "invalid_transition");
    }
    task.status = status;
    if (result !== undefined) task.result = result;
    task.updatedAt = Date.now();
    this.schedulePersist();
    return task;
  }

  setTaskDeps(taskId: string, deps: string[]): Task {
    const task = this.getTask(taskId);
    for (const dep of deps) {
      const target = this.state.tasks[dep];
      if (!target) throw new OrchestrationError(`依赖的任务不存在: ${dep}`, "dep_not_found");
      if (target.runId !== task.runId) {
        throw new OrchestrationError(`依赖 ${dep} 属于别的 Run`, "dep_not_found");
      }
    }
    const previous = task.deps;
    task.deps = deps;
    const cycle = findCycle(this.taskMap());
    if (cycle) {
      task.deps = previous;
      throw new OrchestrationError(`任务依赖成环: ${cycle.join(" → ")}`, "dep_cycle");
    }
    task.updatedAt = Date.now();
    this.schedulePersist();
    return task;
  }

  private taskMap(): Map<string, Task> {
    return new Map(Object.entries(this.state.tasks));
  }

  // ── Dispatch ──────────────────────────────────────────────────────────

  createDispatch(input: {
    taskId: string;
    sessionId: string;
    worktreePath?: string | null;
  }): Dispatch {
    const task = this.getTask(input.taskId);
    // 先挡重复派发,再看状态转移。
    // 不能只靠状态机:canTransition 允许同状态自转(为了让重试命令幂等),
    // 于是 dispatched → dispatched 是合法的,同一个任务会被派给两个 worker,
    // 两个 agent 在同一份代码上互相覆盖。这里必须显式拦。
    const active = this.activeDispatchFor(task.id);
    if (active) {
      throw new OrchestrationError(
        `任务 ${task.id} 已经派给会话 ${active.sessionId}(${active.id});要改派先把它落定`,
        "task_not_dispatchable",
      );
    }
    // `pending → dispatched` 在状态机里是允许的，但不代表依赖已完成。
    // ready 是派生值，所以真正派发的写入边界也必须再验一次，不能只把
    // listReadyTasks 当成给 UI 看的提示。
    if (!isReady(task, this.taskMap())) {
      throw new OrchestrationError(
        `任务 ${task.id} 的依赖尚未全部完成，不能派发`,
        "task_not_dispatchable",
      );
    }
    if (!canTransition(task.status, "dispatched")) {
      throw new OrchestrationError(
        `任务 ${task.id} 当前是 ${task.status},不能派发`,
        "task_not_dispatchable",
      );
    }
    const dispatch: Dispatch = {
      id: id("disp"),
      runId: task.runId,
      taskId: task.id,
      sessionId: input.sessionId,
      worktreePath: input.worktreePath ?? null,
      state: "starting",
      startedAt: Date.now(),
      settledAt: null,
      outcome: null,
    };
    this.state.dispatches[dispatch.id] = dispatch;
    task.status = "dispatched";
    task.updatedAt = Date.now();
    this.schedulePersist();
    return dispatch;
  }

  getDispatch(dispatchId: string): Dispatch {
    const dispatch = this.state.dispatches[dispatchId];
    if (!dispatch) throw new OrchestrationError(`找不到派发 ${dispatchId}`, "dispatch_not_found");
    return dispatch;
  }

  listDispatches(runId?: string): Dispatch[] {
    const all = Object.values(this.state.dispatches);
    const scoped = runId ? all.filter((d) => d.runId === runId) : all;
    return scoped.sort((a, b) => a.startedAt - b.startedAt);
  }

  /** 某任务当前那次派发(最新的、还没落定的) */
  activeDispatchFor(taskId: string): Dispatch | null {
    const live = this.listDispatches()
      .filter((d) => d.taskId === taskId && (d.state === "starting" || d.state === "running"));
    return live.length === 0 ? null : (live[live.length - 1] as Dispatch);
  }

  setDispatchState(dispatchId: string, state: Dispatch["state"], outcome?: string | null): Dispatch {
    const dispatch = this.getDispatch(dispatchId);
    dispatch.state = state;
    if (outcome !== undefined) dispatch.outcome = outcome;
    if (state === "succeeded" || state === "failed" || state === "abandoned") {
      dispatch.settledAt = Date.now();
    }
    this.schedulePersist();
    return dispatch;
  }

  // ── Message ───────────────────────────────────────────────────────────

  postMessage(input: {
    runId: string;
    from: string;
    to: string;
    type: Message["type"];
    subject: string;
    body: string;
    threadId?: string | null;
    taskId?: string | null;
  }): Message {
    this.getRun(input.runId);
    const message: Message = {
      id: id("msg"),
      runId: input.runId,
      from: input.from,
      to: input.to,
      type: input.type,
      subject: input.subject,
      body: input.body,
      threadId: input.threadId ?? null,
      taskId: input.taskId ?? null,
      createdAt: Date.now(),
      readAt: null,
      answeredAt: null,
    };
    this.state.messages[message.id] = message;
    this.schedulePersist();
    return message;
  }

  getMessage(messageId: string): Message {
    const message = this.state.messages[messageId];
    if (!message) throw new OrchestrationError(`找不到消息 ${messageId}`, "message_not_found");
    return message;
  }

  /** Run 内消息按时间正序；ask 的阻塞等待需要查到即使已读的 reply。 */
  listMessages(runId?: string): Message[] {
    return Object.values(this.state.messages)
      .filter((message) => (runId ? message.runId === runId : true))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 某个收件人的未读。协调者的 check --wait 就是等这个非空。 */
  unreadFor(recipient: string, runId?: string): Message[] {
    return Object.values(this.state.messages)
      .filter((m) => m.to === recipient && m.readAt === null)
      .filter((m) => (runId ? m.runId === runId : true))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  markRead(messageIds: string[]): void {
    const now = Date.now();
    for (const messageId of messageIds) {
      const message = this.state.messages[messageId];
      if (message && message.readAt === null) message.readAt = now;
    }
    this.schedulePersist();
  }

  markAnswered(messageId: string): Message {
    const message = this.getMessage(messageId);
    if (message.answeredAt === null) {
      message.answeredAt = Date.now();
      this.schedulePersist();
    }
    return message;
  }

  // ── Gate ──────────────────────────────────────────────────────────────

  createGate(input: {
    runId: string;
    taskId?: string | null;
    question: string;
    options?: string[];
  }): Gate {
    this.getRun(input.runId);
    if (input.taskId) {
      const task = this.getTask(input.taskId);
      if (task.runId !== input.runId) {
        throw new OrchestrationError(
          `任务 ${task.id} 不属于 Run ${input.runId}`,
          "task_wrong_run",
        );
      }
    }
    const gate: Gate = {
      id: id("gate"),
      runId: input.runId,
      taskId: input.taskId ?? null,
      question: input.question,
      options: input.options ?? [],
      status: "pending",
      decision: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.state.gates[gate.id] = gate;
    // 门是用来挡的:挂着任务就把它挪出可派发队列,免得协调者一边等决策
    // 一边把同一个任务又派了一遍。
    if (gate.taskId) {
      const task = this.state.tasks[gate.taskId];
      if (task && canTransition(task.status, "blocked")) {
        task.status = "blocked";
        task.updatedAt = Date.now();
      }
    }
    this.schedulePersist();
    return gate;
  }

  getGate(gateId: string): Gate {
    const gate = this.state.gates[gateId];
    if (!gate) throw new OrchestrationError(`找不到决策门 ${gateId}`, "gate_not_found");
    return gate;
  }

  listGates(runId?: string, status?: Gate["status"]): Gate[] {
    return Object.values(this.state.gates)
      .filter((g) => (runId ? g.runId === runId : true))
      .filter((g) => (status ? g.status === status : true))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  resolveGate(gateId: string, decision: string): Gate {
    const gate = this.getGate(gateId);
    if (gate.status !== "pending") {
      if (gate.status === "resolved" && gate.decision === decision) return gate;
      throw new OrchestrationError(`决策门 ${gate.id} 已经是 ${gate.status}`, "gate_not_pending");
    }
    gate.status = "resolved";
    gate.decision = decision;
    gate.resolvedAt = Date.now();
    // 退回 pending 而不是直接 dispatched:挡着的这段时间里依赖和 worker
    // 都可能已经变了,得重新过一遍调度。
    if (gate.taskId) {
      const task = this.state.tasks[gate.taskId];
      const anotherPendingGate = Object.values(this.state.gates).some(
        (candidate) =>
          candidate.id !== gate.id &&
          candidate.taskId === gate.taskId &&
          candidate.status === "pending",
      );
      if (task && task.status === "blocked" && !anotherPendingGate) {
        task.status = "pending";
        task.updatedAt = Date.now();
      }
    }
    this.schedulePersist();
    return gate;
  }

  /** 测试用:直接看一眼内部状态 */
  snapshot(): OrchestrationState {
    return JSON.parse(JSON.stringify(this.state)) as OrchestrationState;
  }
}
