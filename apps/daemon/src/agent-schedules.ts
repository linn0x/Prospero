import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import type { AgentKind, ApprovalPolicy, Attachment, ChatDelivery, SessionInfo } from "@prospero/protocol";
import { writePrivateFileAtomic } from "./filesystem-store.js";
import type { CreateSessionInput } from "./session-manager.js";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SCHEDULE_AGENTS = new Set<AgentKind>(["claude", "codex", "deepseek", "opencode", "grok"]);
const POLICIES = new Set<ApprovalPolicy>(["strict", "standard", "yolo"]);
const ACTIVE = new Set(["ENABLED", "ACTIVE", "RUNNING"]);
const PAUSED = new Set(["PAUSED", "DISABLED"]);
const DEAD_SESSION_STATUS = new Set(["done", "died"]);
const MAX_PROMPT_CHARS = 200_000;
const MAX_RRULE_CHARS = 500;
const MAX_ERROR_CHARS = 2_000;
const DEFAULT_INTERVAL_MS = 30_000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export type ScheduledAgentTaskStatus = "ENABLED" | "PAUSED";
export type ScheduledAgentTaskKind = "cron" | "heartbeat";

export interface ScheduledAgentTask {
  version: 1;
  id: string;
  kind: ScheduledAgentTaskKind;
  name: string;
  prompt: string;
  status: ScheduledAgentTaskStatus;
  rrule: string;
  agent: AgentKind;
  approvalPolicy: ApprovalPolicy;
  cwd: string;
  cwds: string[];
  accountId?: string;
  model?: string;
  reasoningEffort?: string;
  mode?: "default" | "plan";
  targetThreadId?: string;
  lastSessionId?: string;
  lastRunAt?: number;
  nextRunAt: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  path: string;
}

export interface ScheduledAgentCreateInput {
  id?: string;
  kind?: ScheduledAgentTaskKind;
  name: string;
  prompt: string;
  rrule: string;
  status?: ScheduledAgentTaskStatus;
  agent?: AgentKind;
  approvalPolicy?: ApprovalPolicy;
  cwd?: string;
  cwds?: string[];
  accountId?: string;
  model?: string;
  reasoningEffort?: string;
  mode?: "default" | "plan";
  targetThreadId?: string;
  actorSessionId?: string;
}

export interface ScheduledAgentUpdateInput {
  id: string;
  kind?: ScheduledAgentTaskKind;
  name?: string;
  prompt?: string;
  rrule?: string;
  status?: ScheduledAgentTaskStatus;
  agent?: AgentKind;
  approvalPolicy?: ApprovalPolicy;
  cwd?: string;
  cwds?: string[];
  accountId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  mode?: "default" | "plan" | null;
  targetThreadId?: string | null;
}

export interface ScheduledAgentRunResult {
  task: ScheduledAgentTask;
  session: SessionInfo;
  queued: boolean;
}

export interface ScheduledAgentSessionManager {
  create(input: CreateSessionInput): Promise<SessionInfo>;
  chatSend(sid: string, text: string, attachments?: Attachment[], delivery?: ChatDelivery): Promise<void>;
  infoOf(sid: string): SessionInfo;
}

export class ScheduleError extends Error {
  constructor(message: string, readonly code: "bad_params" | "not_found" | "conflict" | "storage" | "schedule_invalid") {
    super(message);
  }
}

export class ScheduledAgentService extends EventEmitter<{ change: [] }> {
  private timer: NodeJS.Timeout | null = null;
  private readonly inflight = new Set<string>();

  constructor(
    private readonly opts: {
      root: string;
      manager: ScheduledAgentSessionManager;
      now?: () => number;
      intervalMs?: number;
    },
  ) {
    super();
  }

  list(): ScheduledAgentTask[] {
    this.ensureRoot();
    return readdirSync(this.opts.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && TASK_ID.test(entry.name))
      .flatMap((entry) => {
        const task = this.read(entry.name);
        return task ? [task] : [];
      })
      .sort((a, b) => a.nextRunAt - b.nextRunAt || a.name.localeCompare(b.name));
  }

  get(id: string): ScheduledAgentTask {
    const task = this.read(this.requireId(id));
    if (!task) throw new ScheduleError(`定时任务不存在: ${id}`, "not_found");
    return task;
  }

  create(input: ScheduledAgentCreateInput): ScheduledAgentTask {
    const now = this.now();
    const id = this.requireId(input.id ?? slug(input.name));
    if (existsSync(this.fileFor(id))) throw new ScheduleError(`定时任务已存在: ${id}`, "conflict");
    const actor = input.actorSessionId ? this.session(input.actorSessionId) : null;
    const agent = input.agent ?? actor?.agent ?? "codex";
    const task: ScheduledAgentTask = {
      version: 1,
      id,
      kind: input.kind ?? "heartbeat",
      name: input.name,
      prompt: input.prompt,
      status: input.status ?? "ENABLED",
      rrule: input.rrule,
      agent,
      approvalPolicy: input.approvalPolicy ?? policyValue(actor?.approvalPolicy),
      cwd: input.cwd ?? input.cwds?.[0] ?? actor?.cwd ?? os.homedir(),
      cwds: input.cwds ?? (input.cwd ? [input.cwd] : []),
      createdAt: now,
      updatedAt: now,
      path: this.fileFor(id),
      nextRunAt: nextRunAfter(input.rrule, now),
    };
    setOptional(task, "accountId", input.accountId ?? (actor?.agent === agent ? actor.accountId : undefined));
    setOptional(task, "model", input.model ?? (actor?.agent === agent ? actor.agentControls?.currentModel : undefined));
    setOptional(task, "reasoningEffort", input.reasoningEffort ?? (actor?.agent === agent ? actor.agentControls?.currentEffort : undefined));
    setOptional(task, "mode", input.mode ?? (actor?.agent === agent ? modeValue(actor.agentControls?.currentMode) : undefined));
    setOptional(task, "targetThreadId", input.targetThreadId);
    const validated = this.validate(task);
    this.write(validated);
    return validated;
  }

  update(input: ScheduledAgentUpdateInput): ScheduledAgentTask {
    const current = this.get(input.id);
    const now = this.now();
    const merged: ScheduledAgentTask = {
      ...current,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.rrule !== undefined ? { rrule: input.rrule } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.approvalPolicy !== undefined ? { approvalPolicy: input.approvalPolicy } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.cwds !== undefined ? { cwds: input.cwds } : {}),
      updatedAt: now,
      nextRunAt: input.rrule !== undefined ? nextRunAfter(input.rrule, now) : current.nextRunAt,
    };
    if (input.accountId !== undefined) setOptional(merged, "accountId", input.accountId ?? undefined);
    if (input.model !== undefined) setOptional(merged, "model", input.model ?? undefined);
    if (input.reasoningEffort !== undefined) setOptional(merged, "reasoningEffort", input.reasoningEffort ?? undefined);
    if (input.mode !== undefined) setOptional(merged, "mode", input.mode ?? undefined);
    if (input.targetThreadId !== undefined) setOptional(merged, "targetThreadId", input.targetThreadId ?? undefined);
    const validated = this.validate(merged);
    this.write(validated);
    return validated;
  }

  pause(id: string): ScheduledAgentTask {
    return this.update({ id, status: "PAUSED" });
  }

  resume(id: string): ScheduledAgentTask {
    const task = this.get(id);
    return this.update({ id, status: "ENABLED", rrule: task.rrule });
  }

  delete(id: string): { id: string; deleted: boolean } {
    id = this.requireId(id);
    const dir = path.dirname(this.fileFor(id));
    const existed = existsSync(dir);
    rmSync(dir, { recursive: true, force: true });
    this.emit("change");
    return { id, deleted: existed };
  }

  async runNow(id: string): Promise<ScheduledAgentRunResult> {
    return await this.trigger(this.get(id), this.now());
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref?.();
  }

  close(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = this.now()): Promise<ScheduledAgentRunResult[]> {
    const due = this.list().filter((task) => task.status === "ENABLED" && task.nextRunAt <= now);
    const results: ScheduledAgentRunResult[] = [];
    for (const task of due) {
      try {
        results.push(await this.trigger(task, now));
      } catch (error) {
        console.warn(`[prosperod] 定时任务 ${task.id} 触发失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return results;
  }

  private async trigger(task: ScheduledAgentTask, now: number): Promise<ScheduledAgentRunResult> {
    if (this.inflight.has(task.id)) throw new ScheduleError(`定时任务正在触发: ${task.id}`, "conflict");
    this.inflight.add(task.id);
    try {
      let session = this.reusableSession(task);
      if (!session) {
        const input: CreateSessionInput = {
          agent: task.agent,
          kind: "structured",
          approvalPolicy: task.approvalPolicy,
          cwd: task.cwd,
          cols: 120,
          rows: 40,
          allowShell: true,
        };
        setOptional(input, "accountId", task.accountId);
        setOptional(input, "mode", task.mode);
        setOptional(input, "model", task.model);
        setOptional(input, "effort", task.reasoningEffort);
        setOptional(input, "resume", task.targetThreadId && resumableAgent(task.agent) ? { id: task.targetThreadId } : undefined);
        session = await this.opts.manager.create(input);
      }
      const queued = !["idle", "completed"].includes(session.status);
      await this.opts.manager.chatSend(session.id, task.prompt, undefined, "queue");
      const saved = this.markTriggered(task, now, session.id, null);
      return { task: saved, session, queued };
    } catch (error) {
      this.markTriggered(task, now, task.lastSessionId, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.inflight.delete(task.id);
    }
  }

  private reusableSession(task: ScheduledAgentTask): SessionInfo | null {
    if (!task.lastSessionId) return null;
    const session = this.session(task.lastSessionId);
    if (!session || session.kind !== "structured" || session.agent !== task.agent || DEAD_SESSION_STATUS.has(session.status)) return null;
    return session;
  }

  private session(id: string): SessionInfo | null {
    try {
      return this.opts.manager.infoOf(id);
    } catch {
      return null;
    }
  }

  private markTriggered(task: ScheduledAgentTask, now: number, sessionId: string | undefined, error: string | null): ScheduledAgentTask {
    const updated: ScheduledAgentTask = {
      ...task,
      ...(sessionId ? { lastSessionId: sessionId } : {}),
      lastRunAt: now,
      nextRunAt: nextRunAfter(task.rrule, now),
      updatedAt: this.now(),
    };
    if (error) updated.lastError = error.slice(0, MAX_ERROR_CHARS);
    else delete updated.lastError;
    this.write(updated);
    return updated;
  }

  private read(id: string): ScheduledAgentTask | null {
    const file = this.fileFor(id);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) return null;
      const data = TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      return this.fromToml(id, file, data);
    } catch {
      return null;
    }
  }

  private fromToml(id: string, file: string, data: Record<string, unknown>): ScheduledAgentTask {
    const now = this.now();
    const rrule = requiredString(data["rrule"], "rrule", MAX_RRULE_CHARS);
    const createdAt = numberValue(data["created_at"]) ?? now;
    const updatedAt = numberValue(data["updated_at"]) ?? createdAt;
    const lastRunAt = numberValue(data["last_run_at"]);
    const nextRunAt = numberValue(data["next_run_at"]) ?? nextRunFromAnchor(rrule, lastRunAt ?? createdAt, now);
    const statusText = typeof data["status"] === "string" ? data["status"].trim().toUpperCase() : "PAUSED";
    const status: ScheduledAgentTaskStatus = ACTIVE.has(statusText) ? "ENABLED" : PAUSED.has(statusText) ? "PAUSED" : "PAUSED";
    const targetThreadId = optionalString(data["target_thread_id"], 500);
    const cwd = firstDirectory(data["cwd"], data["cwds"], this.cwdForThread(targetThreadId));
    const agent = agentValue(data["agent"], "codex");
    const task: ScheduledAgentTask = {
      version: 1,
      id: this.requireId(typeof data["id"] === "string" ? data["id"] : id),
      kind: data["kind"] === "cron" ? "cron" : "heartbeat",
      name: stringValue(data["name"], id, 500),
      prompt: requiredString(data["prompt"], "prompt", MAX_PROMPT_CHARS),
      status,
      rrule,
      agent,
      approvalPolicy: policyValue(data["approval_policy"]),
      cwd,
      cwds: stringList(data["cwds"]).length > 0 ? stringList(data["cwds"]) : [cwd],
      ...(lastRunAt !== undefined ? { lastRunAt } : {}),
      nextRunAt,
      createdAt,
      updatedAt,
      path: file,
    };
    setOptional(task, "accountId", optionalString(data["account_id"], 100));
    setOptional(task, "model", optionalString(data["model"], 300));
    setOptional(task, "reasoningEffort", optionalString(data["reasoning_effort"], 100));
    setOptional(task, "mode", modeValue(data["mode"]));
    setOptional(task, "targetThreadId", targetThreadId);
    setOptional(task, "lastSessionId", optionalString(data["last_session_id"], 200));
    setOptional(task, "lastError", optionalString(data["last_error"], MAX_ERROR_CHARS));
    return this.validate(task);
  }

  private validate(task: ScheduledAgentTask): ScheduledAgentTask {
    this.requireId(task.id);
    if (task.name.trim() === "" || task.name.length > 500) throw new ScheduleError("name 无效", "bad_params");
    if (task.prompt.trim() === "" || task.prompt.length > MAX_PROMPT_CHARS) throw new ScheduleError("prompt 无效", "bad_params");
    if (task.rrule.trim() === "" || task.rrule.length > MAX_RRULE_CHARS) throw new ScheduleError("rrule 无效", "bad_params");
    if (task.kind !== "cron" && task.kind !== "heartbeat") throw new ScheduleError("kind 必须是 cron 或 heartbeat", "bad_params");
    if (task.status !== "ENABLED" && task.status !== "PAUSED") throw new ScheduleError("status 必须是 ENABLED 或 PAUSED", "bad_params");
    if (!SCHEDULE_AGENTS.has(task.agent)) throw new ScheduleError(`定时任务不支持 agent: ${task.agent}`, "bad_params");
    if (!POLICIES.has(task.approvalPolicy)) throw new ScheduleError("approvalPolicy 必须是 strict、standard 或 yolo", "bad_params");
    if (task.mode !== undefined && task.mode !== "default" && task.mode !== "plan") throw new ScheduleError("mode 必须是 default 或 plan", "bad_params");
    if (task.mode !== undefined && task.agent !== "claude" && task.agent !== "codex") throw new ScheduleError("mode 只支持 Claude/Codex", "bad_params");
    if (task.reasoningEffort !== undefined && !task.model) throw new ScheduleError("reasoningEffort 必须和 model 一起设置", "bad_params");
    if (!path.isAbsolute(task.cwd) || !isDirectory(task.cwd)) throw new ScheduleError(`cwd 不存在或不是目录: ${task.cwd}`, "bad_params");
    parseRrule(task.rrule);
    const cwd = realpath(task.cwd);
    const cwds = [...new Set([cwd, ...task.cwds]
      .filter((item) => path.isAbsolute(item) && isDirectory(item))
      .map(realpath))];
    return { ...task, name: task.name.trim(), prompt: task.prompt.trim(), rrule: task.rrule.trim(), cwd, cwds };
  }

  private write(task: ScheduledAgentTask): void {
    this.ensureRoot();
    const file = this.fileFor(task.id);
    const current = readTomlObject(file);
    const data: Record<string, unknown> = {
      ...current,
      version: 1,
      id: task.id,
      kind: task.kind,
      name: task.name,
      prompt: task.prompt,
      status: task.status,
      rrule: task.rrule,
      agent: task.agent,
      approval_policy: task.approvalPolicy,
      cwds: task.cwds.length > 0 ? task.cwds : [task.cwd],
      cwd: task.cwd,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      next_run_at: task.nextRunAt,
    };
    if (task.accountId) data["account_id"] = task.accountId; else delete data["account_id"];
    if (task.model) data["model"] = task.model; else delete data["model"];
    if (task.reasoningEffort) data["reasoning_effort"] = task.reasoningEffort; else delete data["reasoning_effort"];
    if (task.mode) data["mode"] = task.mode; else delete data["mode"];
    if (task.targetThreadId) data["target_thread_id"] = task.targetThreadId; else delete data["target_thread_id"];
    if (task.lastSessionId) data["last_session_id"] = task.lastSessionId; else delete data["last_session_id"];
    if (task.lastRunAt !== undefined) data["last_run_at"] = task.lastRunAt; else delete data["last_run_at"];
    if (task.lastError) data["last_error"] = task.lastError; else delete data["last_error"];
    writePrivateFileAtomic(file, TOML.stringify(data as Parameters<typeof TOML.stringify>[0]));
    this.emit("change");
  }
  private fileFor(id: string): string {
    const safe = this.requireId(id);
    return path.join(this.opts.root, safe, "automation.toml");
  }
  private ensureRoot(): void {
    mkdirSync(this.opts.root, { recursive: true, mode: 0o700 });
  }
  private requireId(id: string): string {
    if (!TASK_ID.test(id)) throw new ScheduleError("定时任务 ID 只能包含字母、数字、点、下划线和短横线", "bad_params");
    return id;
  }
  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private cwdForThread(threadId: string | undefined): string | undefined {
    if (!threadId) return undefined;
    const root = path.basename(this.opts.root) === "automations" ? path.dirname(this.opts.root) : this.opts.root;
    const state = readJsonObject(path.join(root, ".codex-global-state.json"));
    const roots = state["thread-writable-roots"];
    if (!roots || typeof roots !== "object" || Array.isArray(roots)) return undefined;
    const candidates = stringList((roots as Record<string, unknown>)[threadId]);
    return candidates.find((item) => path.isAbsolute(item) && isDirectory(item));
  }
}

function readJsonObject(file: string): Record<string, unknown> {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return {};
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
function readTomlObject(file: string): Record<string, unknown> {
  try {
    if (!existsSync(file)) return {};
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) return {};
    const parsed = TOML.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
function slug(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72);
  return normalized || `schedule-${randomUUID().slice(0, 8)}`;
}
function setOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}
function stringValue(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" && value.trim() !== "" && value.length <= max ? value.trim() : fallback;
}
function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new ScheduleError(`${name} 无效`, "bad_params");
  return value.trim();
}
function optionalString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= max ? value.trim() : undefined;
}
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];
}
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}
function realpath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}
function firstDirectory(cwd: unknown, cwds: unknown, fallback?: string): string {
  const candidates = [optionalString(cwd, 20_000), ...stringList(cwds), fallback].filter((item): item is string => Boolean(item));
  return candidates.find((item) => path.isAbsolute(item) && isDirectory(item)) ?? os.homedir();
}
function agentValue(value: unknown, fallback: AgentKind): AgentKind {
  return typeof value === "string" && SCHEDULE_AGENTS.has(value as AgentKind) ? value as AgentKind : fallback;
}
function policyValue(value: unknown): ApprovalPolicy {
  return typeof value === "string" && POLICIES.has(value as ApprovalPolicy) ? value as ApprovalPolicy : "standard";
}
function modeValue(value: unknown): "default" | "plan" | undefined {
  return value === "default" || value === "plan" ? value : undefined;
}
function resumableAgent(agent: AgentKind): agent is "claude" | "codex" | "deepseek" {
  return agent === "claude" || agent === "codex" || agent === "deepseek";
}
function parseRrule(rrule: string): { intervalMs: number } {
  const fields = new Map<string, string>();
  for (const part of rrule.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    fields.set(part.slice(0, index).trim().toUpperCase(), part.slice(index + 1).trim().toUpperCase());
  }
  const freq = fields.get("FREQ");
  const interval = Number.parseInt(fields.get("INTERVAL") ?? "1", 10);
  if (!Number.isSafeInteger(interval) || interval < 1) throw new ScheduleError("rrule INTERVAL 无效", "schedule_invalid");
  const unit = freq === "MINUTELY" ? 60_000 : freq === "HOURLY" ? 3_600_000 : freq === "DAILY" ? 86_400_000 : freq === "WEEKLY" ? 604_800_000 : 0;
  if (!unit) throw new ScheduleError("rrule 仅支持 FREQ=MINUTELY/HOURLY/DAILY/WEEKLY", "schedule_invalid");
  const intervalMs = interval * unit;
  if (!Number.isSafeInteger(intervalMs) || intervalMs > 366 * 86_400_000) throw new ScheduleError("rrule 间隔过大", "schedule_invalid");
  return { intervalMs };
}
export function nextRunAfter(rrule: string, now: number): number {
  const { intervalMs } = parseRrule(rrule);
  return Math.min(now + intervalMs, now + MAX_TIMEOUT_MS);
}

export function nextRunFromAnchor(rrule: string, anchor: number, now: number): number {
  const { intervalMs } = parseRrule(rrule);
  if (anchor >= now) return anchor + intervalMs;
  const elapsed = now - anchor;
  const missed = Math.floor(elapsed / intervalMs);
  return anchor + (missed + 1) * intervalMs;
}
