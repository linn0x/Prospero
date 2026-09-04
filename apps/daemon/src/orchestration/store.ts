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
  type DispatchSkillBinding,
  type Gate,
  type Message,
  type OperationRecord,
  type OrchestrationState,
  type Run,
  type RunAutomation,
  type Task,
  type TaskStatus,
  type WorktreeAsset,
  type WorktreeAssetCleanup,
  type WorktreeAssetKind,
  type WorktreeInspection,
  TransitionError,
  canTransition,
  emptyState,
  findCycle,
  isReady,
} from "./model.js";

const PERSIST_DEBOUNCE_MS = 200;
const MAX_ORCHESTRATION_EVENTS = 2_048;
const DESKTOP_TASK_SPEC_LIMIT = 320;
const DESKTOP_TASK_RESULT_LIMIT = 400;
export const MAX_TASK_SKILLS = 5;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type OrchestrationEventEntity = "run" | "task" | "dispatch" | "gate";
export type OrchestrationEventOperation = "upsert" | "delete";

export interface OrchestrationRunEvent {
  seq: number;
  runId: string;
  entity: OrchestrationEventEntity;
  entityId: string;
  operation: OrchestrationEventOperation;
  value: Record<string, unknown> | null;
  occurredAt: number;
}

export interface CompactRunSnapshot {
  protocol: "prospero.orchestration.run.v1";
  run: Record<string, unknown>;
  tasks: Record<string, Record<string, unknown>>;
  dispatches: Record<string, Record<string, unknown>>;
  gates: Record<string, Record<string, unknown>>;
  cursor: number;
  eventBaseSeq: number;
}

export interface OrchestrationEventsPage {
  protocol: "prospero.orchestration.events.v1";
  runId: string;
  afterSeq: number;
  nextSeq: number;
  eventBaseSeq: number;
  gap: boolean;
  hasMore: boolean;
  events: OrchestrationRunEvent[];
}

type CompactEntity = Record<string, unknown>;

function compactRun(run: Run): CompactEntity {
  return {
    id: run.id,
    objective: run.objective,
    status: run.status,
    coordinatorSessionId: run.coordinatorSessionId,
    graphRevision: run.graphRevision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function compactTask(task: Task): CompactEntity {
  return {
    id: task.id,
    runId: task.runId,
    title: task.title,
    skills: task.skills ?? [],
    deps: task.deps,
    parentId: task.parentId,
    status: task.status,
    result: task.result,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function compactDispatch(dispatch: Dispatch): CompactEntity {
  return {
    id: dispatch.id,
    runId: dispatch.runId,
    taskId: dispatch.taskId,
    sessionId: dispatch.sessionId,
    state: dispatch.state,
    startedAt: dispatch.startedAt,
    settledAt: dispatch.settledAt,
  };
}

function compactGate(gate: Gate): CompactEntity {
  return {
    id: gate.id,
    runId: gate.runId,
    taskId: gate.taskId,
    question: gate.question,
    options: gate.options,
    status: gate.status,
    decision: gate.decision,
    createdAt: gate.createdAt,
    resolvedAt: gate.resolvedAt,
  };
}

function limitedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function desktopProjection(state: OrchestrationState, revision: number): Record<string, unknown> {
  return {
    version: 1,
    revision,
    runs: Object.values(state.runs).map((run) => ({
      ...compactRun(run),
      automation: run.automation ?? null,
    })),
    tasks: Object.values(state.tasks).map((task) => ({
      ...compactTask(task),
      spec: limitedText(task.spec, DESKTOP_TASK_SPEC_LIMIT),
      specTruncated: task.spec.length > DESKTOP_TASK_SPEC_LIMIT,
      result: task.result === null ? null : limitedText(task.result, DESKTOP_TASK_RESULT_LIMIT),
      resultTruncated: task.result !== null && task.result.length > DESKTOP_TASK_RESULT_LIMIT,
    })),
    dispatches: Object.values(state.dispatches).map((dispatch) => ({
      ...compactDispatch(dispatch),
      worktreePath: dispatch.worktreePath,
    })),
    gates: Object.values(state.gates).map(compactGate),
    worktreeAssets: Object.values(state.worktreeAssets),
  };
}

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
  | "task_not_dispatchable"
  | "graph_invalid"
  | "revision_conflict"
  | "task_not_editable"
  | "run_not_deletable"
  | "run_not_completable"
  | "run_not_abandonable"
  | "run_not_active"
  | "worktree_asset_not_found"
  | "operation_conflict";

export interface GraphNodeInput {
  clientId: string;
  title: string;
  spec: string;
  skills?: string[];
  deps: string[];
  parentId?: string | null;
}

export function normalizeTaskSkills(values: readonly string[] | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of values ?? []) {
    const value = raw.trim();
    if (!SKILL_NAME.test(value)) {
      throw new OrchestrationError(`无效 Skill 名称: ${raw}`, "graph_invalid");
    }
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  if (normalized.length > MAX_TASK_SKILLS) {
    throw new OrchestrationError(
      `每个任务最多显式绑定 ${String(MAX_TASK_SKILLS)} 个 Skill`,
      "graph_invalid",
    );
  }
  return normalized;
}

export interface GraphMutationResult {
  run: Run;
  tasks: Task[];
  idMap: Record<string, string>;
  deletedTaskIds?: string[];
}

export interface RunDeletionResult {
  runId: string;
  deletedTaskCount: number;
  /** 兼容旧客户端；实际资产仍可通过 worktree.list 找到。 */
  preservedWorkspacePath: string | null;
  /** Run 删除后仍保留、且已脱离画布记录的工作树资产。 */
  preservedWorktreeAssetIds: string[];
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class OrchestrationStore {
  private state: OrchestrationState = emptyState();
  private eventSeq = 0;
  private eventBaseSeq = 0;
  private events: OrchestrationRunEvent[] = [];
  private eventShadow: Record<OrchestrationEventEntity, Map<string, CompactEntity>> = {
    run: new Map(),
    task: new Map(),
    dispatch: new Map(),
    gate: new Map(),
  };
  private readonly file: string | null;
  private readonly desktopFile: string | null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly changeListeners = new Set<() => void>();

  /** home 省略时纯内存(测试用) */
  constructor(home?: string) {
    this.file = home ? path.join(home, "orchestration.json") : null;
    this.desktopFile = home ? path.join(home, "orchestration-desktop.json") : null;
    this.load();
    this.resetEventShadow();
    this.persistDesktopProjection();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Omit<Partial<OrchestrationState>, "version"> & {
        version?: number;
        eventSeq?: unknown;
        eventBaseSeq?: unknown;
        events?: unknown;
      };
      if (parsed.version === 1 || parsed.version === 2) {
        const runs = parsed.runs ?? {};
        for (const run of Object.values(runs)) {
          run.graphRevision = Number.isInteger(run.graphRevision) ? run.graphRevision : 0;
          run.automation ??= null;
          run.coordinatorPrompt ??= null;
        }
        let migrated = parsed.version === 1;
        const tasks = parsed.tasks ?? {};
        for (const task of Object.values(tasks)) {
          const legacy = task as Task & { skills?: unknown };
          const before = legacy.skills;
          try {
            legacy.skills = Array.isArray(before)
              ? normalizeTaskSkills(before.filter((value): value is string => typeof value === "string"))
              : [];
          } catch {
            legacy.skills = [];
          }
          if (!Array.isArray(before) || JSON.stringify(before) !== JSON.stringify(legacy.skills)) migrated = true;
        }
        const dispatches = parsed.dispatches ?? {};
        const worktreeAssets = parsed.worktreeAssets ?? {};

        // v1 把 worktree 只挂在 Run automation 或 Dispatch 上；一旦删除 Run，
        // 那些路径就没有任何可发现索引。升级时只保守登记，绝不尝试检查或删除。
        if (parsed.version === 1) {
          for (const run of Object.values(runs)) {
            const automation = run.automation;
            if (automation?.workspace !== "run") continue;
            const asset = this.legacyWorktreeAsset({
              kind: "run",
              runId: run.id,
              repo: automation.cwd,
              path: automation.workspacePath,
              branch: automation.branch,
              createdAt: automation.startedAt,
            });
            worktreeAssets[asset.id] = asset;
          }
          for (const dispatch of Object.values(dispatches)) {
            if (!dispatch.worktreePath) continue;
            const asset = this.legacyWorktreeAsset({
              kind: "worker",
              runId: dispatch.runId,
              taskId: dispatch.taskId,
              dispatchId: dispatch.id,
              // v1 没有 repo/branch；path 是唯一安全的候选，后续 inspect 会复核。
              repo: dispatch.worktreePath,
              path: dispatch.worktreePath,
              branch: null,
              createdAt: dispatch.startedAt,
            });
            worktreeAssets[asset.id] = asset;
          }
        }
        for (const asset of Object.values(worktreeAssets)) {
          if (this.normalizeWorktreeAsset(asset)) migrated = true;
        }
        this.state = {
          version: 2,
          runs,
          tasks,
          dispatches,
          messages: parsed.messages ?? {},
          gates: parsed.gates ?? {},
          operations: parsed.operations ?? {},
          worktreeAssets,
        };
        this.loadEventJournal(parsed.eventSeq, parsed.eventBaseSeq, parsed.events);
        // 迁移只补登记，不会触碰用户磁盘上的任何工作树。立即原子落盘，避免下一次
        // Run 删除发生在迁移结果尚未写入之前。
        if (migrated) this.persistNow();
      }
    } catch {
      // 文件不在或者坏了都当空的开始。编排状态坏掉不该让 daemon 起不来 ——
      // 手机上还有一堆正常会话等着连。
    }
  }

  private legacyWorktreeAsset(input: {
    kind: WorktreeAssetKind;
    runId: string;
    taskId?: string | null;
    dispatchId?: string | null;
    repo: string;
    path: string;
    branch: string | null;
    createdAt: number;
  }): WorktreeAsset {
    const now = Date.now();
    return {
      id: id("wt"),
      kind: input.kind,
      runId: input.runId,
      taskId: input.taskId ?? null,
      dispatchId: input.dispatchId ?? null,
      repo: input.repo,
      path: input.path,
      branch: input.branch,
      state: "preserved",
      createdAt: input.createdAt,
      updatedAt: now,
      runDeletedAt: null,
      lastInspection: null,
      cleanup: null,
      legacy: true,
      lastError: "由 orchestration.json v1 迁移；请先只读检查后再决定是否清理",
    };
  }

  /** 在原对象上补齐 v2 可选字段；返回是否实际做了迁移。 */
  private normalizeWorktreeAsset(asset: WorktreeAsset): boolean {
    let changed = false;
    const fill = <K extends keyof WorktreeAsset>(key: K, value: WorktreeAsset[K]): void => {
      if (asset[key] !== undefined) return;
      asset[key] = value;
      changed = true;
    };
    fill("taskId", null);
    fill("dispatchId", null);
    fill("branch", null);
    fill("state", "preserved");
    fill("createdAt", Date.now());
    fill("updatedAt", asset.createdAt);
    fill("runDeletedAt", null);
    fill("lastInspection", null);
    fill("cleanup", null);
    fill("legacy", false);
    fill("lastError", null);
    return changed;
  }

  private loadEventJournal(rawSeq: unknown, rawBaseSeq: unknown, rawEvents: unknown): void {
    if (!Number.isSafeInteger(rawSeq) || (rawSeq as number) < 0) return;
    if (!Number.isSafeInteger(rawBaseSeq) || (rawBaseSeq as number) < 0) return;
    if (!Array.isArray(rawEvents)) return;
    const events = rawEvents.filter((value): value is OrchestrationRunEvent => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const event = value as Partial<OrchestrationRunEvent>;
      return Number.isSafeInteger(event.seq) && (event.seq ?? -1) > 0 &&
        typeof event.runId === "string" && event.runId !== "" &&
        (event.entity === "run" || event.entity === "task" || event.entity === "dispatch" || event.entity === "gate") &&
        typeof event.entityId === "string" && event.entityId !== "" &&
        (event.operation === "upsert" || event.operation === "delete") &&
        (event.value === null || (typeof event.value === "object" && !Array.isArray(event.value))) &&
        Number.isSafeInteger(event.occurredAt) && (event.occurredAt ?? -1) >= 0;
    }).sort((a, b) => a.seq - b.seq);
    const seq = rawSeq as number;
    const baseSeq = rawBaseSeq as number;
    if (baseSeq > seq || events.some((event) => event.seq <= baseSeq || event.seq > seq)) return;
    this.eventSeq = seq;
    this.eventBaseSeq = baseSeq;
    this.events = events.slice(-MAX_ORCHESTRATION_EVENTS);
    if (events.length > this.events.length) {
      this.eventBaseSeq = events[events.length - this.events.length - 1]!.seq;
    }
  }

  private resetEventShadow(): void {
    this.eventShadow = {
      run: new Map(Object.values(this.state.runs).map((value) => [value.id, compactRun(value)])),
      task: new Map(Object.values(this.state.tasks).map((value) => [value.id, compactTask(value)])),
      dispatch: new Map(Object.values(this.state.dispatches).map((value) => [value.id, compactDispatch(value)])),
      gate: new Map(Object.values(this.state.gates).map((value) => [value.id, compactGate(value)])),
    };
  }

  private appendEvent(
    runId: string,
    entity: OrchestrationEventEntity,
    entityId: string,
    operation: OrchestrationEventOperation,
    value: CompactEntity | null,
  ): void {
    this.eventSeq += 1;
    this.events.push({
      seq: this.eventSeq,
      runId,
      entity,
      entityId,
      operation,
      value: value === null ? null : structuredClone(value),
      occurredAt: Date.now(),
    });
    if (this.events.length > MAX_ORCHESTRATION_EVENTS) {
      const removed = this.events.splice(0, this.events.length - MAX_ORCHESTRATION_EVENTS);
      this.eventBaseSeq = removed.at(-1)?.seq ?? this.eventBaseSeq;
    }
  }

  private recordEntityChanges(): void {
    const groups: Array<{ entity: OrchestrationEventEntity; values: CompactEntity[] }> = [
      { entity: "run", values: Object.values(this.state.runs).map(compactRun) },
      { entity: "task", values: Object.values(this.state.tasks).map(compactTask) },
      { entity: "dispatch", values: Object.values(this.state.dispatches).map(compactDispatch) },
      { entity: "gate", values: Object.values(this.state.gates).map(compactGate) },
    ];
    for (const { entity, values } of groups) {
      const previous = this.eventShadow[entity];
      const current = new Map(values.map((value) => [String(value["id"]), value]));
      for (const [id, value] of current) {
        const old = previous.get(id);
        if (old === undefined || JSON.stringify(old) !== JSON.stringify(value)) {
          const runId = entity === "run" ? id : String(value["runId"]);
          this.appendEvent(runId, entity, id, "upsert", value);
        }
      }
      for (const [id, old] of previous) {
        if (current.has(id)) continue;
        const runId = entity === "run" ? id : String(old["runId"]);
        this.appendEvent(runId, entity, id, "delete", null);
      }
      this.eventShadow[entity] = current;
    }
  }

  private schedulePersist(): void {
    this.recordEntityChanges();
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        // 观察者只负责刷新外部视图；失败不能回滚已经完成的状态变更。
      }
    }
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
    writeFileSync(tmp, JSON.stringify({
      ...this.state,
      eventSeq: this.eventSeq,
      eventBaseSeq: this.eventBaseSeq,
      events: this.events,
    }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.persistDesktopProjection();
  }

  private persistDesktopProjection(): void {
    if (!this.desktopFile) return;
    mkdirSync(path.dirname(this.desktopFile), { recursive: true });
    const tmp = `${this.desktopFile}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(desktopProjection(this.state, this.eventSeq)), { mode: 0o600 });
    renameSync(tmp, this.desktopFile);
  }

  close(): void {
    this.persistNow();
    this.closed = true;
  }

  /** 状态变更通知只表示“快照可能变了”；调用方应自行防抖并读取完整快照。 */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  // ── Run ───────────────────────────────────────────────────────────────

  createRun(input: {
    objective: string;
    coordinatorSessionId?: string | null;
    /** Goal 的协调者首提示在 Run 落盘时一并登记，投递失败才能安全恢复。 */
    coordinatorPrompt?: boolean;
  }): Run {
    const now = Date.now();
    const run: Run = {
      id: id("run"),
      objective: input.objective,
      status: "active",
      coordinatorSessionId: input.coordinatorSessionId ?? null,
      graphRevision: 0,
      automation: null,
      coordinatorPrompt: input.coordinatorPrompt
        ? { state: "pending", attempts: 0, lastError: null, updatedAt: now }
        : null,
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

  private requireActiveRun(runId: string): Run {
    const run = this.getRun(runId);
    if (run.status !== "active") {
      throw new OrchestrationError(
        `Run ${runId} 已经是 ${run.status}，历史编排只读`,
        "run_not_active",
      );
    }
    return run;
  }

  listRuns(): Run[] {
    return Object.values(this.state.runs).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 修改 Run 的非生命周期字段。
   *
   * status 只能由 completeRun/abandonRun 改动；否则调用方很容易绕过完成
   * 时必须校验的 Task、Dispatch、Gate 与自动执行状态。
   */
  updateRun(runId: string, patch: Partial<Pick<Run, "objective" | "coordinatorSessionId">>): Run {
    if ("status" in patch) {
      throw new OrchestrationError("Run 状态只能通过完成或放弃入口转换", "invalid_transition");
    }
    const run = this.requireActiveRun(runId);
    const now = Date.now();
    if (patch.objective !== undefined) run.objective = patch.objective;
    if (patch.coordinatorSessionId !== undefined) run.coordinatorSessionId = patch.coordinatorSessionId;
    run.updatedAt = now;
    this.schedulePersist();
    return run;
  }

  /**
   * 显式结束 Run。Task 的完成仍只认 worker/协调者的显式交付；这里仅在整张图
   * 已经没有未决工作时汇总 Run 生命周期，避免 UI 永远停在 active。
   */
  completeRun(
    runId: string,
    options: { fromAutomation?: boolean; allowFailedTasks?: boolean } = {},
  ): Run {
    const run = this.getRun(runId);
    if (run.status === "completed") return run;
    if (run.status !== "active") {
      throw new OrchestrationError(
        `Run ${runId} 当前是 ${run.status}，不能标记完成`,
        "run_not_completable",
      );
    }

    const tasks = this.listTasks(runId);
    const unfinished = tasks.find((task) =>
      task.status !== "done"
      && task.status !== "cancelled"
      && !(options.allowFailedTasks === true && task.status === "failed")
    );
    if (unfinished) {
      throw new OrchestrationError(
        `任务 ${unfinished.id} 仍是 ${unfinished.status}，Run 不能标记完成`,
        "run_not_completable",
      );
    }
    if (options.fromAutomation) {
      if (options.allowFailedTasks === true) {
        throw new OrchestrationError(
          "自动执行不能把 failed 任务计为已完成",
          "run_not_completable",
        );
      }
      if (tasks.length === 0) {
        throw new OrchestrationError(
          "自动执行没有可交付的任务，Run 不能自动标记完成",
          "run_not_completable",
        );
      }
      const notDelivered = tasks.find((task) => task.status !== "done");
      if (notDelivered) {
        throw new OrchestrationError(
          `自动执行任务 ${notDelivered.id} 仍是 ${notDelivered.status}，Run 不能标记完成`,
          "run_not_completable",
        );
      }
      if (run.automation?.state !== "running") {
        throw new OrchestrationError(
          "自动执行并未处于运行中，不能自动标记 Run 完成",
          "run_not_completable",
        );
      }
    } else if (run.automation?.state === "running") {
      throw new OrchestrationError(
        "自动执行仍在运行，请先暂停或等待它自行收口",
        "run_not_completable",
      );
    }
    const activeDispatch = this.listDispatches(runId).find(
      (dispatch) => dispatch.state === "starting" || dispatch.state === "running",
    );
    if (activeDispatch) {
      throw new OrchestrationError(
        `worker ${activeDispatch.sessionId} 仍在运行，Run 不能标记完成`,
        "run_not_completable",
      );
    }
    const pendingGate = this.listGates(runId, "pending")[0];
    if (pendingGate) {
      throw new OrchestrationError(
        `Gate ${pendingGate.id} 仍待处理，Run 不能标记完成`,
        "run_not_completable",
      );
    }

    const now = Date.now();
    // 完成 Run 同时终结自动执行，不能在历史 Run 上留下 running/paused 的假状态。
    if (run.automation && run.automation.state !== "completed") {
      run.automation = {
        ...run.automation,
        state: "completed",
        updatedAt: now,
        lastError: null,
      };
    }
    run.status = "completed";
    run.updatedAt = now;
    this.preserveWorktreeAssetsForRun(runId, "Run 已完成；工作树默认保留，需显式清理");
    this.schedulePersist();
    return run;
  }

  /**
   * 协调者会话结束后的保守修复路径。空任务图不自动猜完成；有过明确任务且全部
   * 进入终态时，才把遗漏的 Run 完成动作补上。
   */
  completeRunIfSettled(runId: string): Run | null {
    const run = this.getRun(runId);
    if (run.status !== "active") return null;
    if (this.listTasks(runId).length === 0) return null;
    try {
      return this.completeRun(runId);
    } catch (error) {
      if (
        error instanceof OrchestrationError &&
        error.code === "run_not_completable"
      ) return null;
      throw error;
    }
  }

  /** 放弃 Run 会关闭未执行任务和未决 Gate，但绝不替用户强杀仍在工作的 worker。 */
  abandonRun(runId: string, reason = "Run 已放弃"): Run {
    const run = this.getRun(runId);
    if (run.status === "abandoned") return run;
    if (run.status !== "active") {
      throw new OrchestrationError(
        `Run ${runId} 当前是 ${run.status}，不能放弃`,
        "run_not_abandonable",
      );
    }
    const activeDispatch = this.listDispatches(runId).find(
      (dispatch) => dispatch.state === "starting" || dispatch.state === "running",
    );
    if (activeDispatch) {
      throw new OrchestrationError(
        `worker ${activeDispatch.sessionId} 仍在运行，请先停止 worker`,
        "run_not_abandonable",
      );
    }
    if (run.automation?.state === "running") {
      throw new OrchestrationError("自动执行仍在运行，请先暂停", "run_not_abandonable");
    }

    const now = Date.now();
    for (const task of this.listTasks(runId)) {
      if (
        task.status === "pending" ||
        task.status === "blocked" ||
        task.status === "dispatched"
      ) {
        task.status = "cancelled";
        task.result = reason;
        task.updatedAt = now;
      }
    }
    for (const gate of this.listGates(runId, "pending")) {
      gate.status = "cancelled";
      gate.resolvedAt = now;
    }
    run.status = "abandoned";
    run.updatedAt = now;
    this.preserveWorktreeAssetsForRun(runId, "Run 已放弃；工作树默认保留，需显式清理");
    this.schedulePersist();
    return run;
  }

  setRunAutomation(runId: string, automation: RunAutomation | null): Run {
    const run = this.requireActiveRun(runId);
    run.automation = automation;
    run.updatedAt = Date.now();
    this.schedulePersist();
    return run;
  }

  /** 所有尚未成功投递 Goal 首提示的活跃 Run。 */
  pendingCoordinatorPrompts(): Run[] {
    return this.listRuns().filter(
      (run) => run.status === "active" && run.coordinatorPrompt?.state === "pending",
    );
  }

  /** 发送前先把尝试次数落盘；崩在发送确认之间时宁可重投，也不能永久丢提示。 */
  recordCoordinatorPromptAttempt(runId: string): Run {
    const run = this.requireActiveRun(runId);
    const prompt = run.coordinatorPrompt;
    if (!prompt || prompt.state === "delivered") return run;
    run.coordinatorPrompt = {
      ...prompt,
      attempts: prompt.attempts + 1,
      lastError: null,
      updatedAt: Date.now(),
    };
    run.updatedAt = run.coordinatorPrompt.updatedAt;
    this.schedulePersist();
    return run;
  }

  markCoordinatorPromptDelivered(runId: string): Run {
    const run = this.getRun(runId);
    const prompt = run.coordinatorPrompt;
    if (!prompt || prompt.state === "delivered") return run;
    const now = Date.now();
    run.coordinatorPrompt = { ...prompt, state: "delivered", lastError: null, updatedAt: now };
    run.updatedAt = now;
    this.schedulePersist();
    return run;
  }

  markCoordinatorPromptFailed(runId: string, error: string): Run {
    const run = this.getRun(runId);
    const prompt = run.coordinatorPrompt;
    if (!prompt || prompt.state === "delivered") return run;
    const now = Date.now();
    run.coordinatorPrompt = { ...prompt, state: "pending", lastError: error, updatedAt: now };
    run.updatedAt = now;
    this.schedulePersist();
    return run;
  }

  deleteRun(runId: string): RunDeletionResult {
    const run = this.getRun(runId);
    if (run.automation?.state === "running") {
      throw new OrchestrationError("自动执行仍在运行，请先暂停", "run_not_deletable");
    }
    const active = this.listDispatches(runId).find(
      (dispatch) => dispatch.state === "starting" || dispatch.state === "running",
    );
    if (active) {
      throw new OrchestrationError(
        `仍有 worker ${active.sessionId} 在运行，不能删除编排`,
        "run_not_deletable",
      );
    }

    const taskIds = new Set(this.listTasks(runId).map((task) => task.id));
    const preservedWorktreeAssetIds = this.detachWorktreeAssetsForDeletedRun(runId);
    for (const taskId of taskIds) delete this.state.tasks[taskId];
    for (const dispatch of Object.values(this.state.dispatches)) {
      if (dispatch.runId === runId) delete this.state.dispatches[dispatch.id];
    }
    for (const message of Object.values(this.state.messages)) {
      if (message.runId === runId) delete this.state.messages[message.id];
    }
    for (const gate of Object.values(this.state.gates)) {
      if (gate.runId === runId) delete this.state.gates[gate.id];
    }
    delete this.state.runs[runId];
    this.schedulePersist();
    return {
      runId,
      deletedTaskCount: taskIds.size,
      preservedWorkspacePath: run.automation?.workspace === "run"
        ? run.automation.workspacePath
        : null,
      preservedWorktreeAssetIds,
    };
  }

  // ── Worktree assets ──────────────────────────────────────────────────

  /**
   * 在工作树已经成功创建、但尚未创建 worker 会话时立即登记。
   *
   * 这是一个外部资源的所有权边界，所以有 home 时同步落盘；否则 daemon 在紧接着
   * 的 session.create 前崩溃，磁盘目录会再次失去索引。
   */
  registerWorktreeAsset(input: {
    kind: WorktreeAssetKind;
    runId: string;
    taskId?: string | null;
    dispatchId?: string | null;
    repo: string;
    path: string;
    branch: string | null;
  }): WorktreeAsset {
    const now = Date.now();
    const asset: WorktreeAsset = {
      id: id("wt"),
      kind: input.kind,
      runId: input.runId,
      taskId: input.taskId ?? null,
      dispatchId: input.dispatchId ?? null,
      repo: input.repo,
      path: input.path,
      branch: input.branch,
      state: "active",
      createdAt: now,
      updatedAt: now,
      runDeletedAt: null,
      lastInspection: null,
      cleanup: null,
      legacy: false,
      lastError: null,
    };
    this.state.worktreeAssets[asset.id] = asset;
    this.schedulePersist();
    this.persistNow();
    return asset;
  }

  getWorktreeAsset(assetId: string): WorktreeAsset {
    const asset = this.state.worktreeAssets[assetId];
    if (!asset) {
      throw new OrchestrationError(`找不到工作树资产 ${assetId}`, "worktree_asset_not_found");
    }
    return asset;
  }

  listWorktreeAssets(runId?: string): WorktreeAsset[] {
    return Object.values(this.state.worktreeAssets)
      .filter((asset) => (runId ? asset.runId === runId : true))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  linkWorktreeAssetDispatch(assetId: string, dispatchId: string): WorktreeAsset {
    const asset = this.getWorktreeAsset(assetId);
    const dispatch = this.getDispatch(dispatchId);
    if (asset.kind !== "worker" || asset.runId !== dispatch.runId || asset.taskId !== dispatch.taskId) {
      throw new OrchestrationError("工作树资产与派发归属不匹配", "invalid_transition");
    }
    asset.dispatchId = dispatchId;
    asset.updatedAt = Date.now();
    this.schedulePersist();
    this.persistNow();
    return asset;
  }

  recordWorktreeInspection(assetId: string, inspection: WorktreeInspection): WorktreeAsset {
    const asset = this.getWorktreeAsset(assetId);
    // 已显式清理的路径以后仍不存在是预期，不覆盖成“用户丢失了路径”。
    if (asset.cleanup !== null && inspection.state === "missing") {
      asset.state = "cleaned";
    } else {
      asset.state = inspection.state;
    }
    asset.lastInspection = inspection;
    asset.updatedAt = inspection.checkedAt;
    asset.lastError = inspection.state === "unknown" ? inspection.message : null;
    this.schedulePersist();
    return asset;
  }

  preserveWorktreeAsset(assetId: string, reason: string | null = null): WorktreeAsset {
    const asset = this.getWorktreeAsset(assetId);
    if (asset.cleanup !== null || asset.state === "missing") return asset;
    asset.state = "preserved";
    asset.updatedAt = Date.now();
    asset.lastError = reason;
    this.schedulePersist();
    return asset;
  }

  preserveWorktreeAssetsForDispatch(dispatchId: string, reason: string | null = null): void {
    for (const asset of Object.values(this.state.worktreeAssets)) {
      if (asset.dispatchId === dispatchId) this.preserveWorktreeAsset(asset.id, reason);
    }
  }

  preserveWorktreeAssetsForRun(runId: string, reason: string | null = null): void {
    for (const asset of Object.values(this.state.worktreeAssets)) {
      if (asset.runId === runId) this.preserveWorktreeAsset(asset.id, reason);
    }
  }

  private detachWorktreeAssetsForDeletedRun(runId: string): string[] {
    const now = Date.now();
    const ids: string[] = [];
    for (const asset of Object.values(this.state.worktreeAssets)) {
      if (asset.runId !== runId) continue;
      asset.runDeletedAt ??= now;
      if (asset.cleanup === null && asset.state !== "missing") asset.state = "preserved";
      asset.updatedAt = now;
      asset.lastError = "所属 Run 已删除；资产与恢复分支仍保留，需显式检查或清理";
      ids.push(asset.id);
    }
    return ids;
  }

  markWorktreeAssetCleaned(
    assetId: string,
    cleanup: WorktreeAssetCleanup,
  ): WorktreeAsset {
    const asset = this.getWorktreeAsset(assetId);
    asset.state = "cleaned";
    asset.cleanup = cleanup;
    asset.updatedAt = cleanup.removedAt;
    asset.lastError = cleanup.warning;
    this.schedulePersist();
    this.persistNow();
    return asset;
  }

  // ── Task ──────────────────────────────────────────────────────────────

  createTask(input: {
    runId: string;
    title: string;
    spec: string;
    skills?: string[];
    deps?: string[];
    parentId?: string | null;
  }): Task {
    this.requireActiveRun(input.runId);
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
      skills: normalizeTaskSkills(input.skills),
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

    this.bumpGraphRevision(input.runId);
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
    this.requireActiveRun(task.runId);
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

  /** 取消尚未执行的任务；若仍有关联 worker，必须先显式停止，避免留下游离进程。 */
  cancelTask(taskId: string, reason = "由用户取消"): Task {
    const task = this.getTask(taskId);
    this.requireActiveRun(task.runId);
    if (task.status === "cancelled") return task;
    if (this.activeDispatchFor(taskId)) {
      throw new OrchestrationError("任务仍有关联 worker，请先停止 worker 再取消", "task_not_dispatchable");
    }
    if (task.status !== "pending" && task.status !== "blocked") {
      throw new OrchestrationError(
        `任务 ${task.id} 当前是 ${task.status}，只能取消尚未执行的任务`,
        "invalid_transition",
      );
    }
    const now = Date.now();
    task.status = "cancelled";
    task.result = reason;
    task.updatedAt = now;
    for (const gate of Object.values(this.state.gates)) {
      if (gate.taskId === taskId && gate.status === "pending") {
        gate.status = "cancelled";
        gate.resolvedAt = now;
      }
    }
    this.schedulePersist();
    return task;
  }

  /** failed 保留在 Dispatch 历史中，任务本身退回 pending 等待重新派发。 */
  retryTask(taskId: string): Task {
    const task = this.getTask(taskId);
    this.requireActiveRun(task.runId);
    if (task.status !== "failed") {
      throw new OrchestrationError(
        `任务 ${task.id} 当前是 ${task.status}，只有 failed 任务可以重试`,
        "invalid_transition",
      );
    }
    task.status = "pending";
    task.result = null;
    task.updatedAt = Date.now();
    this.schedulePersist();
    return task;
  }

  setTaskDeps(taskId: string, deps: string[]): Task {
    const task = this.getTask(taskId);
    this.requireActiveRun(task.runId);
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
    this.bumpGraphRevision(task.runId);
    this.schedulePersist();
    return task;
  }

  /**
   * 一次提交完整的新 Run 与初始任务图。先在候选状态里解析临时 id、验引用和环，
   * 全部通过后才把 Run 与任务放进真实状态，避免 UI 发布失败时留下半张图。
   */
  createRunGraph(input: {
    objective: string;
    nodes: GraphNodeInput[];
    coordinatorSessionId?: string | null;
  }): GraphMutationResult {
    this.validateGraphInput(input.nodes);
    const objective = input.objective.trim();
    if (objective === "") {
      throw new OrchestrationError("编排目标不能为空", "graph_invalid");
    }

    const now = Date.now();
    const run: Run = {
      id: id("run"),
      objective,
      status: "active",
      coordinatorSessionId: input.coordinatorSessionId ?? null,
      graphRevision: 1,
      automation: null,
      coordinatorPrompt: null,
      createdAt: now,
      updatedAt: now,
    };
    const idMap = Object.fromEntries(input.nodes.map((node) => [node.clientId, id("task")])) as Record<
      string,
      string
    >;
    const candidates = new Map<string, Task>();

    for (const node of input.nodes) {
      const taskId = idMap[node.clientId]!;
      const deps = node.deps.map((dep) => {
        const resolved = idMap[dep];
        if (!resolved) {
          throw new OrchestrationError(`依赖的节点不存在: ${dep}`, "graph_invalid");
        }
        return resolved;
      });
      const parentId = node.parentId == null
        ? null
        : (idMap[node.parentId] ?? null);
      if (node.parentId != null && parentId === null) {
        throw new OrchestrationError(`父节点不存在: ${node.parentId}`, "graph_invalid");
      }
      candidates.set(taskId, {
        id: taskId,
        runId: run.id,
        title: node.title.trim(),
        spec: node.spec.trim(),
        skills: normalizeTaskSkills(node.skills),
        deps,
        parentId,
        status: "pending",
        result: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    this.validateCandidateGraph(run.id, candidates);

    this.state.runs[run.id] = run;
    for (const task of candidates.values()) this.state.tasks[task.id] = task;
    this.schedulePersist();
    return { run, tasks: [...candidates.values()], idMap };
  }

  /**
   * 在调用方看到的 revision 上原子 upsert 一组节点。clientId 若等于本 Run 的
   * 现有 task id 就编辑它，否则创建新节点；依赖既可引用本提交的 clientId，
   * 也可引用未编辑的现有 task id。
   */
  applyTaskGraph(input: {
    runId: string;
    baseRevision: number;
    nodes: GraphNodeInput[];
    deleteTaskIds?: string[];
  }): GraphMutationResult {
    const run = this.requireActiveRun(input.runId);
    if (run.graphRevision !== input.baseRevision) {
      throw new OrchestrationError(
        `任务图已经更新（当前 revision ${run.graphRevision}，提交基于 ${input.baseRevision}）`,
        "revision_conflict",
      );
    }
    const deleteTaskIds = input.deleteTaskIds ?? [];
    if (input.nodes.length === 0 && deleteTaskIds.length === 0) {
      throw new OrchestrationError("图编辑至少要修改或删除一个节点", "graph_invalid");
    }
    if (
      deleteTaskIds.length > 200 ||
      deleteTaskIds.some((taskId) => taskId.trim() === "" || taskId.length > 200)
    ) {
      throw new OrchestrationError("deleteTaskIds 必须包含最多 200 个有效任务 id", "graph_invalid");
    }
    if (new Set(deleteTaskIds).size !== deleteTaskIds.length) {
      throw new OrchestrationError("deleteTaskIds 不能重复", "graph_invalid");
    }
    this.validateGraphInput(input.nodes, true);

    const now = Date.now();
    const idMap: Record<string, string> = {};
    for (const node of input.nodes) {
      if (deleteTaskIds.includes(node.clientId)) {
        throw new OrchestrationError(`节点 ${node.clientId} 不能同时编辑和删除`, "graph_invalid");
      }
      const existing = this.state.tasks[node.clientId];
      if (existing) {
        if (existing.runId !== run.id) {
          throw new OrchestrationError(`节点 ${node.clientId} 属于别的 Run`, "task_wrong_run");
        }
        if (existing.status !== "pending") {
          throw new OrchestrationError(
            `任务 ${existing.id} 已经是 ${existing.status}，只能编辑 pending 任务`,
            "task_not_editable",
          );
        }
        idMap[node.clientId] = existing.id;
      } else {
        idMap[node.clientId] = id("task");
      }
    }

    // 全量复制任务，验证失败时不会触碰真实对象里的 deps/title/spec。
    const candidates = new Map(
      Object.values(this.state.tasks).map((task) => [task.id, { ...task, deps: [...task.deps] }]),
    );
    for (const taskId of deleteTaskIds) {
      const task = this.state.tasks[taskId];
      if (!task || task.runId !== run.id) {
        throw new OrchestrationError(`要删除的任务不存在或属于别的 Run: ${taskId}`, "task_wrong_run");
      }
      if (task.status !== "pending") {
        throw new OrchestrationError(
          `任务 ${task.id} 已经是 ${task.status}，只能删除 pending 任务`,
          "task_not_editable",
        );
      }
      candidates.delete(taskId);
    }
    const resolveReference = (reference: string, label: string): string => {
      const submitted = idMap[reference];
      if (submitted) return submitted;
      const existing = candidates.get(reference);
      if (!existing) {
        throw new OrchestrationError(`${label}不存在: ${reference}`, "graph_invalid");
      }
      if (existing.runId !== run.id) {
        throw new OrchestrationError(`${label} ${reference} 属于别的 Run`, "task_wrong_run");
      }
      return existing.id;
    };

    for (const node of input.nodes) {
      const taskId = idMap[node.clientId]!;
      const existing = this.state.tasks[taskId];
      candidates.set(taskId, {
        id: taskId,
        runId: run.id,
        title: node.title.trim(),
        spec: node.spec.trim(),
        skills: normalizeTaskSkills(node.skills),
        deps: node.deps.map((dep) => resolveReference(dep, "依赖节点")),
        parentId: node.parentId == null
          ? null
          : resolveReference(node.parentId, "父节点"),
        status: existing?.status ?? "pending",
        result: existing?.result ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }

    this.validateCandidateGraph(run.id, candidates);

    const changed: Task[] = [];
    for (const taskId of deleteTaskIds) {
      delete this.state.tasks[taskId];
      for (const dispatch of Object.values(this.state.dispatches)) {
        if (dispatch.taskId === taskId) delete this.state.dispatches[dispatch.id];
      }
      for (const message of Object.values(this.state.messages)) {
        if (message.taskId === taskId) delete this.state.messages[message.id];
      }
      for (const gate of Object.values(this.state.gates)) {
        if (gate.taskId === taskId) delete this.state.gates[gate.id];
      }
    }
    for (const node of input.nodes) {
      const task = candidates.get(idMap[node.clientId]!);
      if (!task) continue;
      this.state.tasks[task.id] = task;
      changed.push(task);
    }
    run.graphRevision += 1;
    run.updatedAt = now;
    this.schedulePersist();
    return { run, tasks: changed, idMap, deletedTaskIds: deleteTaskIds };
  }

  private validateGraphInput(nodes: GraphNodeInput[], allowEmpty = false): void {
    if ((!allowEmpty && nodes.length === 0) || nodes.length > 200) {
      throw new OrchestrationError(
        allowEmpty ? "一次最多编辑 200 个节点" : "任务图必须包含 1 到 200 个节点",
        "graph_invalid",
      );
    }
    const ids = new Set<string>();
    for (const node of nodes) {
      const clientId = node.clientId.trim();
      if (clientId === "" || ids.has(clientId)) {
        throw new OrchestrationError(
          clientId === "" ? "节点 clientId 不能为空" : `节点 clientId 重复: ${clientId}`,
          "graph_invalid",
        );
      }
      ids.add(clientId);
      if (node.title.trim() === "" || node.spec.trim() === "") {
        throw new OrchestrationError(`节点 ${clientId} 的标题和说明不能为空`, "graph_invalid");
      }
      if (new Set(node.deps).size !== node.deps.length) {
        throw new OrchestrationError(`节点 ${clientId} 有重复依赖`, "graph_invalid");
      }
    }
  }

  private validateCandidateGraph(runId: string, candidates: ReadonlyMap<string, Task>): void {
    const runTasks = new Map(
      [...candidates].filter(([, task]) => task.runId === runId),
    );
    for (const task of runTasks.values()) {
      for (const dep of task.deps) {
        const target = candidates.get(dep);
        if (!target || target.runId !== runId) {
          throw new OrchestrationError(`依赖的任务不存在或属于别的 Run: ${dep}`, "graph_invalid");
        }
      }
      if (task.parentId !== null) {
        const parent = candidates.get(task.parentId);
        if (!parent || parent.runId !== runId || parent.id === task.id) {
          throw new OrchestrationError(`父任务无效: ${task.parentId}`, "graph_invalid");
        }
      }
    }
    const cycle = findCycle(runTasks);
    if (cycle) {
      throw new OrchestrationError(`任务依赖成环: ${cycle.join(" → ")}`, "dep_cycle");
    }
  }

  private bumpGraphRevision(runId: string): void {
    const run = this.getRun(runId);
    run.graphRevision += 1;
    run.updatedAt = Date.now();
  }

  private taskMap(): Map<string, Task> {
    return new Map(Object.entries(this.state.tasks));
  }

  // ── 幂等操作 ─────────────────────────────────────────────────────────

  getOperation(operationId: string): OperationRecord | null {
    return this.state.operations[operationId] ?? null;
  }

  rememberOperation(operationId: string, fingerprint: string, result: unknown): OperationRecord {
    const existing = this.state.operations[operationId];
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new OrchestrationError(
          `operationId ${operationId} 已用于另一项操作`,
          "operation_conflict",
        );
      }
      return existing;
    }
    const operation: OperationRecord = {
      id: operationId,
      fingerprint,
      // 业务对象仍会继续变化（例如 Run 的 revision）；幂等结果必须冻结在首次提交时。
      result: structuredClone(result),
      createdAt: Date.now(),
    };
    this.state.operations[operationId] = operation;

    // 操作记录只负责覆盖离线重试窗口，不无限增长；按时间保留最近 1000 条。
    const operations = Object.values(this.state.operations);
    if (operations.length > 1_000) {
      operations
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, operations.length - 1_000)
        .forEach((candidate) => delete this.state.operations[candidate.id]);
    }
    this.schedulePersist();
    return operation;
  }

  // ── Dispatch ──────────────────────────────────────────────────────────

  createDispatch(input: {
    taskId: string;
    sessionId: string;
    hostOwnerIdentity?: string | undefined;
    worktreePath?: string | null;
    skills?: DispatchSkillBinding[];
  }): Dispatch {
    const task = this.getTask(input.taskId);
    this.requireActiveRun(task.runId);
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
      ...(input.hostOwnerIdentity ? { hostOwnerIdentity: input.hostOwnerIdentity } : {}),
      worktreePath: input.worktreePath ?? null,
      ...(input.skills && input.skills.length > 0
        ? { skills: input.skills.map((skill) => ({ ...skill })) }
        : {}),
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

  /**
   * worker 显式交付的持久化提交点。Task、Dispatch 和关联工作树资产先在同一
   * 快照里收敛，再同步原子写入；调用方只有在这里返回后才能终止真实会话。
   */
  settleWorkerDelivery(
    dispatchId: string,
    taskStatus: Extract<TaskStatus, "done" | "failed">,
    dispatchState: Extract<Dispatch["state"], "succeeded" | "failed">,
    outcome: string,
    worktreeReason: string,
  ): Task {
    const dispatch = this.getDispatch(dispatchId);
    if (dispatch.state !== "starting" && dispatch.state !== "running") {
      throw new OrchestrationError(`派发 ${dispatch.id} 已经是 ${dispatch.state}，不能再次交付`, "invalid_transition");
    }
    const task = this.getTask(dispatch.taskId);
    this.requireActiveRun(task.runId);
    if (!canTransition(task.status, taskStatus)) {
      const err = new TransitionError(task.status, taskStatus);
      throw new OrchestrationError(err.message, "invalid_transition");
    }

    const now = Date.now();
    task.status = taskStatus;
    task.result = outcome;
    task.updatedAt = now;
    dispatch.state = dispatchState;
    dispatch.outcome = outcome;
    dispatch.settledAt = now;
    for (const asset of Object.values(this.state.worktreeAssets)) {
      if (asset.dispatchId !== dispatch.id || asset.cleanup !== null || asset.state === "missing") continue;
      asset.state = "preserved";
      asset.updatedAt = now;
      asset.lastError = worktreeReason;
    }
    this.schedulePersist();
    // `kill` 后 session.state 会立即触发回调；这里不能把交付事实留给 debounce。
    this.persistNow();
    return task;
  }

  /**
   * daemon 恢复时发现 worker 会话不存在或已经终态的单次收敛写入。
   *
   * Dispatch 与 Task 共用同一份状态快照；在调用观察者和安排落盘前一起修改，
   * 避免手机或自动编排看见“已 abandoned 但 task 还 dispatched”的中间态。
   * 已有显式 done/failed 的极窄崩溃窗口则保留交付事实，只补齐 Dispatch 历史。
   */
  abandonActiveDispatchForMissingSession(
    dispatchId: string,
    reason: string,
  ): { task: Task; dispatch: Dispatch } | null {
    const dispatch = this.getDispatch(dispatchId);
    if (dispatch.state !== "starting" && dispatch.state !== "running") return null;
    const task = this.getTask(dispatch.taskId);
    const now = Date.now();

    if (task.status === "done") {
      dispatch.state = "succeeded";
      dispatch.outcome = task.result ?? "worker 已显式交付";
    } else if (task.status === "failed") {
      dispatch.state = "failed";
      dispatch.outcome = task.result ?? reason;
    } else {
      dispatch.state = "abandoned";
      dispatch.outcome = reason;
      // 正常不变量下 active Dispatch 一定对应 dispatched；仍用防御性赋值扛住
      // 旧版本在两次写入之间崩溃留下的半截快照。
      if (task.status !== "cancelled") {
        task.status = "failed";
        task.result = reason;
        task.updatedAt = now;
      }
    }
    dispatch.settledAt = now;
    this.schedulePersist();
    return { task, dispatch };
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
    this.requireActiveRun(input.runId);
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
    this.requireActiveRun(gate.runId);
    if (gate.status !== "pending") {
      if (gate.status === "resolved" && gate.decision === decision) return gate;
      throw new OrchestrationError(`决策门 ${gate.id} 已经是 ${gate.status}`, "gate_not_pending");
    }
    gate.status = "resolved";
    gate.decision = decision;
    gate.resolvedAt = Date.now();
    // 已经离开的 worker 不能被 Gate 决策凭空复活，因此退回 pending，重新
    // 调度；但 worker 仍在时必须保留 dispatched。否则会留下
    // pending + running dispatch 的矛盾状态，原 worker 也无法 task done/fail。
    if (gate.taskId) {
      const task = this.state.tasks[gate.taskId];
      const anotherPendingGate = Object.values(this.state.gates).some(
        (candidate) =>
          candidate.id !== gate.id &&
          candidate.taskId === gate.taskId &&
          candidate.status === "pending",
      );
      if (task && task.status === "blocked" && !anotherPendingGate) {
        task.status = this.activeDispatchFor(task.id) ? "dispatched" : "pending";
        task.updatedAt = Date.now();
      }
    }
    this.schedulePersist();
    return gate;
  }

  compactRunSnapshot(runId: string): CompactRunSnapshot {
    const run = this.getRun(runId);
    return {
      protocol: "prospero.orchestration.run.v1",
      run: compactRun(run),
      tasks: Object.fromEntries(
        this.listTasks(runId).map((value) => [value.id, compactTask(value)]),
      ),
      dispatches: Object.fromEntries(
        this.listDispatches(runId).map((value) => [value.id, compactDispatch(value)]),
      ),
      gates: Object.fromEntries(
        this.listGates(runId).map((value) => [value.id, compactGate(value)]),
      ),
      cursor: this.eventSeq,
      eventBaseSeq: this.eventBaseSeq,
    };
  }

  eventsSince(runId: string, afterSeq: number, limit = 128): OrchestrationEventsPage {
    this.getRun(runId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > this.eventSeq) {
      throw new OrchestrationError(`无效事件游标 ${String(afterSeq)}`, "graph_invalid");
    }
    const boundedLimit = Math.min(Math.max(limit, 1), 512);
    if (afterSeq < this.eventBaseSeq) {
      return {
        protocol: "prospero.orchestration.events.v1",
        runId,
        afterSeq,
        nextSeq: this.eventSeq,
        eventBaseSeq: this.eventBaseSeq,
        gap: true,
        hasMore: false,
        events: [],
      };
    }
    const matching = this.events.filter((event) => event.seq > afterSeq && event.runId === runId);
    const events = matching.slice(0, boundedLimit).map((event) => structuredClone(event));
    const hasMore = matching.length > events.length;
    return {
      protocol: "prospero.orchestration.events.v1",
      runId,
      afterSeq,
      nextSeq: hasMore ? events.at(-1)!.seq : this.eventSeq,
      eventBaseSeq: this.eventBaseSeq,
      gap: false,
      hasMore,
      events,
    };
  }

  /** 测试用:直接看一眼内部状态 */
  snapshot(): OrchestrationState {
    return JSON.parse(JSON.stringify(this.state)) as OrchestrationState;
  }
}
