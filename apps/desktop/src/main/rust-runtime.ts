import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, extname, isAbsolute, resolve as resolvePath } from "node:path";
import type { SessionHead, TimelineQuery, TimelineTextQuery, AttachmentInput, ScheduleCreate, ScheduleUpdate } from "@prospero/protocol/rust-daemon";
import type { QueuedMessage, SessionAgentControls } from "@prospero/protocol/rust-daemon";
import type { DesktopSnapshot, JsonObject, QueuedChatMessage, SessionInfo, SessionPage, SessionPageRequest } from "../shared/types";
import type { FilePreview, GitHistoryEntry, GitMutation, ProjectFile, ProjectGitStatus } from "../shared/project-tools";
import { StateStore } from "./state-store";
import { TerminalRecovery } from "./terminal-recovery";
import { RustProcess, type RustConnection } from "./rust-process";
import { orchestrationAction, readOrchestrationWindow, settleDispatchInput } from "./rust-orchestration";

const ATTACHMENT_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;
const PROJECT_IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".bmp": "image/bmp", ".svg": "image/svg+xml" };


function requireRelativePath(raw: unknown, allowRoot = false): string {
  if (typeof raw !== "string" || raw.length > 4096 || raw.includes("\0") || raw.startsWith("/")) throw new Error("路径无效");
  const value = raw.replaceAll("\\", "/");
  if (!allowRoot && (!value || value === ".")) throw new Error("路径无效");
  if (value.split("/").includes("..")) throw new Error("路径无效");
  return value;
}

function requireRequestId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 100) throw new Error("请求 ID 无效");
  return raw;
}

function requireNonNegativeInteger(raw: unknown, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 无效`);
  return value;
}

function requirePluginId(raw: unknown): string {
  if (typeof raw !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(raw)) throw new Error("插件 service ID 无效");
  return raw;
}

function requireScheduleId(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(raw)) throw new Error("定时任务 ID 无效");
  return raw;
}

function optionalScheduleText(raw: unknown, max: number, message: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error(message);
  const value = raw.trim();
  if (!value || value.length > max || /[\0]/.test(value)) throw new Error(message);
  return value;
}

function optionalSchedulePath(raw: unknown): string | undefined {
  const value = optionalScheduleText(raw, 20_000, "工作区路径无效");
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) throw new Error("工作区路径无效");
  return value;
}

function optionalScheduleEnum<T extends string>(raw: unknown, allowed: readonly T[], message: string): T | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !allowed.includes(raw as T)) throw new Error(message);
  return raw as T;
}

function optionalClearableText(raw: unknown, clear: unknown, max: number, message: string): string | null | undefined {
  if (clear === true) return null;
  return optionalScheduleText(raw, max, message);
}

function scheduleCreateInput(input: JsonObject): ScheduleCreate {
  const name = optionalScheduleText(input["name"], 500, "任务名称无效");
  const prompt = optionalScheduleText(input["prompt"], 200_000, "提示无效");
  const rrule = optionalScheduleText(input["rrule"], 500, "RRULE 无效");
  if (!name || !prompt || !rrule) throw new Error("定时任务参数无效");
  const out: ScheduleCreate = { name, prompt, rrule };
  const fields: Array<[keyof ScheduleCreate, unknown]> = [
    ["operationId", optionalScheduleText(input["operationId"], 200, "操作 ID 无效")],
    ["id", input["id"] === undefined ? undefined : requireScheduleId(input["id"])],
    ["kind", optionalScheduleEnum(input["kind"], ["cron", "heartbeat"], "定时任务类型无效")],
    ["status", optionalScheduleEnum(input["status"], ["ENABLED", "PAUSED"], "定时任务状态无效")],
    ["agent", optionalScheduleEnum(input["agent"], ["claude", "codex", "deepseek", "opencode", "grok"], "Agent 无效")],
    ["approvalPolicy", optionalScheduleEnum(input["approvalPolicy"], ["strict", "standard", "yolo"], "审批策略无效")],
    ["cwd", optionalSchedulePath(input["cwd"])],
    ["cwds", Array.isArray(input["cwds"]) ? input["cwds"].map(optionalSchedulePath).filter((value): value is string => typeof value === "string").slice(0, 20) : undefined],
    ["accountId", optionalScheduleText(input["accountId"], 100, "账号 ID 无效")],
    ["model", optionalScheduleText(input["model"], 300, "模型无效")],
    ["reasoningEffort", optionalScheduleText(input["reasoningEffort"], 100, "推理强度无效")],
    ["mode", optionalScheduleEnum(input["mode"], ["default", "plan"], "会话模式无效")],
    ["targetThreadId", optionalScheduleText(input["targetThreadId"], 500, "原生会话 ID 无效")],
    ["actorSessionId", optionalScheduleText(input["actorSessionId"], 100, "会话 ID 无效")],
  ];
  for (const [key, value] of fields) if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  return out;
}

function scheduleUpdateInput(id: string, input: JsonObject): ScheduleUpdate {
  const out: ScheduleUpdate = { id: requireScheduleId(input["id"] ?? id) };
  const fields: Array<[keyof ScheduleUpdate, unknown]> = [
    ["operationId", optionalScheduleText(input["operationId"], 200, "操作 ID 无效")],
    ["kind", optionalScheduleEnum(input["kind"], ["cron", "heartbeat"], "定时任务类型无效")],
    ["name", optionalScheduleText(input["name"], 500, "任务名称无效")],
    ["prompt", optionalScheduleText(input["prompt"], 200_000, "提示无效")],
    ["rrule", optionalScheduleText(input["rrule"], 500, "RRULE 无效")],
    ["status", optionalScheduleEnum(input["status"], ["ENABLED", "PAUSED"], "定时任务状态无效")],
    ["agent", optionalScheduleEnum(input["agent"], ["claude", "codex", "deepseek", "opencode", "grok"], "Agent 无效")],
    ["approvalPolicy", optionalScheduleEnum(input["approvalPolicy"], ["strict", "standard", "yolo"], "审批策略无效")],
    ["cwd", optionalSchedulePath(input["cwd"])],
    ["cwds", Array.isArray(input["cwds"]) ? input["cwds"].map(optionalSchedulePath).filter((value): value is string => typeof value === "string").slice(0, 20) : undefined],
    ["accountId", optionalClearableText(input["accountId"], input["clearAccount"], 100, "账号 ID 无效")],
    ["model", optionalClearableText(input["model"], input["clearModel"], 300, "模型无效")],
    ["reasoningEffort", optionalClearableText(input["reasoningEffort"], input["clearEffort"], 100, "推理强度无效")],
    ["mode", input["clearMode"] === true ? null : optionalScheduleEnum(input["mode"], ["default", "plan"], "会话模式无效")],
    ["targetThreadId", optionalClearableText(input["targetThreadId"], input["clearTargetThread"], 500, "原生会话 ID 无效")],
  ];
  for (const [key, value] of fields) if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  return out;
}

/** Account actions backed by the Rust daemon's managed Claude accounts. */
const NATIVE_CLAUDE_ACCOUNT = "native-claude";
const NATIVE_CODEX_ACCOUNT = "native-codex";
const MANAGED_ACCOUNT_TYPES = new Set([
  "agent.account.create", "agent.account.rename", "agent.account.default",
  "agent.account.login", "agent.account.credential.set", "agent.account.logout",
  "agent.account.delete",
]);
/** Third-party Anthropic-compatible API profile actions. */
const API_PROFILE_TYPES = new Set([
  "agent.account.api.create", "agent.account.api.configure", "agent.account.api.test",
]);
const API_MODELS_TYPE = "agent.account.api.models.get";
const ACCOUNT_CONFIG_TYPES = new Set(["agent.account.config.get", "agent.account.config.set"]);
const ACCOUNT_CONFIG_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Profile connection fields are Anthropic-only in the current Rust slice. */
function requireProfileEndpoint(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("API 地址格式无效");
  const value = raw.trim();
  if (!value || value.length > 2000 || /[\r\n\0]/.test(value)) throw new Error("API 地址格式无效");
  return value;
}

function requireProfileModel(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("模型名称格式无效");
  const value = raw.trim();
  if (!value || value.length > 300 || /[\r\n\0]/.test(value)) throw new Error("模型名称格式无效");
  return value;
}

/** Create requires a real key; configure treats a blank string as "keep". */
function requireProfileKey(raw: unknown, { allowBlank }: { allowBlank: boolean }): string {
  if (typeof raw !== "string" || /[\r\n\0]/.test(raw) || raw.length > 8192) throw new Error("API Key 格式无效");
  if (!allowBlank && !raw.trim()) throw new Error("API Key 格式无效");
  return raw;
}

function profileDefaultsForAgent(agent: unknown): { provider: "anthropic_compatible" | "openai_compatible"; protocol: "anthropic" | "openai_responses" | "openai_chat_completions" } {
  if (agent === "claude") return { provider: "anthropic_compatible", protocol: "anthropic" };
  if (agent === "codex") return { provider: "openai_compatible", protocol: "openai_responses" };
  if (agent === "opencode") return { provider: "openai_compatible", protocol: "openai_chat_completions" };
  throw new Error("Agent 不支持 API Profile");
}

function requireProfileProtocol(agent: unknown, input: Record<string, unknown>, body: Record<string, unknown>): void {
  const defaults = profileDefaultsForAgent(agent);
  const provider = input["provider"] ?? defaults.provider;
  const protocol = input["protocol"] ?? defaults.protocol;
  const valid =
    agent === "claude"
      ? provider === "anthropic_compatible" && protocol === "anthropic"
      : agent === "opencode"
        ? provider === "openai_compatible" && protocol === "openai_chat_completions"
        : provider === "openai_compatible" && (protocol === "openai_responses" || protocol === "openai_chat_completions");
  if (!valid) throw new Error("所选 Agent、Provider 与 API 协议不兼容");
  if (input["provider"] !== undefined) {
    body["provider"] = provider;
  }
  if (input["protocol"] !== undefined) {
    body["protocol"] = protocol;
  }
}

/** Forwards only null (clear) or a plain object whose fields pass a local
 * shape check; the daemon re-validates limits and enum values. */
function normalizeModelCapabilities(raw: unknown): object | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("模型能力配置无效");
  const caps = raw as Record<string, unknown>;
  for (const key of ["contextWindow", "maxOutputTokens"]) {
    const value = caps[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100_000_000)) throw new Error("模型能力配置无效");
  }
  for (const key of ["tools", "vision", "reasoning"]) {
    if (key in caps && typeof caps[key] !== "boolean") throw new Error("模型能力配置无效");
  }
  if ("supportedEfforts" in caps && caps["supportedEfforts"] !== null && (
    !Array.isArray(caps["supportedEfforts"])
    || caps["supportedEfforts"].some(level => typeof level !== "string" || level.length > 20)
    || caps["supportedEfforts"].length > 10
  )) throw new Error("模型能力配置无效");
  return caps;
}

function toQueuedChat(item: QueuedMessage): QueuedChatMessage {
  return { id: item.id, text: item.text, kind: item.kind === "guide" ? "guide" : "queue", createdAt: item.createdAt, attachmentCount: item.attachmentCount ?? 0 };
}

/** Mirror of the daemon's managed-account id charset (uuid-safe path segment). */
function requireManagedAccountId(raw: unknown): string {
  if (typeof raw !== "string" || raw === NATIVE_CLAUDE_ACCOUNT || !/^[A-Za-z0-9_-]{1,100}$/.test(raw)) throw new Error("账号 ID 无效");
  return raw;
}

/** Mirror of the daemon's clean_name: trimmed 1–80 chars, no controls. */
function requireAccountName(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("账号名称应为 1–80 个字符");
  const name = raw.trim();
  if (!name || [...name].length > 80 || [...name].some((char) => /\p{C}/u.test(char))) throw new Error("账号名称应为 1–80 个字符");
  return name;
}

/** Validates the launch dialog's model/effort selection. */
function normalizeLaunchSelection(raw: unknown, maximum: number, message: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error(message);
  if ([...raw].length > maximum || [...raw].some((char) => /\p{C}/u.test(char))) throw new Error(message);
  const value = raw.trim();
  if (!value) throw new Error(message);
  return value;
}

function normalizeClaudeResume(raw: unknown): { id: string; title?: string; fork?: true } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("原生会话 ID 无效");
  const input = raw as Record<string, unknown>;
  const id = normalizeLaunchSelection(input["id"], 256, "原生会话 ID 无效");
  if (id === undefined) throw new Error("原生会话 ID 无效");
  const title = normalizeLaunchSelection(input["title"], 500, "会话标题无效");
  if (input["fork"] !== undefined) {
    if (input["fork"] !== true) throw new Error("接回选项无效");
    throw new Error("不再支持从占用中的 Codex 对话创建副本；请先关闭电脑端任务");
  }
  for (const key of Object.keys(input)) {
    if (key !== "id" && key !== "title" && key !== "fork") throw new Error("接回选项无效");
  }
  return title === undefined ? { id } : { id, title };
}

/** Mirror of the Rust daemon's attachment contract (validate_message). */
function normalizeAttachments(raw: unknown): AttachmentInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("图片附件无效");
  if (raw.length > 6) throw new Error("最多附带 6 张图片");
  let total = 0;
  const attachments: AttachmentInput[] = raw.map((entry) => {
    const item = entry as Record<string, unknown>;
    const mimeType = item?.["mimeType"];
    const dataB64 = item?.["dataB64"];
    if (typeof mimeType !== "string" || !ATTACHMENT_MIME.has(mimeType)) throw new Error("不支持的图片类型");
    if (typeof dataB64 !== "string" || !dataB64 || dataB64.length > 8 * 1024 * 1024 || !BASE64_RE.test(dataB64)) throw new Error("图片数据无效");
    const name = item?.["name"];
    if (name !== undefined && name !== null && (typeof name !== "string" || [...name].length > 200)) throw new Error("图片名称过长");
    total += dataB64.length;
    return { mimeType, dataB64, ...(typeof name === "string" ? { name } : {}) };
  });
  if (total > 15 * 1024 * 1024) throw new Error("图片总大小超出限制");
  return attachments;
}

export function rustSessionInfo(head: SessionHead, messageQueue?: QueuedMessage[], controls?: SessionAgentControls): SessionInfo {
  const queue = messageQueue?.length ? { messageQueue: messageQueue.slice(0, 50).map(toQueuedChat) } : {};
  const agentControls = controls ? {
    compact: controls.compact,
    model: controls.model,
    mode: controls.mode,
    ...(controls.currentModel !== null ? { currentModel: controls.currentModel } : {}),
    ...(controls.currentEffort !== null ? { currentEffort: controls.currentEffort } : {}),
    ...(controls.currentMode !== null ? { currentMode: controls.currentMode } : {}),
  } : undefined;
  return { id: head.id, agent: head.agent, kind: head.kind, ...(head.kind === "pty" ? { terminalMode: "events" as const } : { historyMode: "paged" as const }), title: head.title, cwd: head.workspace, status: head.status === "waiting_permission" ? "waiting_approval" : head.status, createdAt: head.createdAt, ...(typeof head.busySince === "number" ? { busySince: head.busySince } : {}), pendingPermissions: head.status === "waiting_permission" ? 1 : 0, pendingQuestions: head.status === "waiting_input" ? 1 : 0, ...queue, ...(agentControls ? { agentControls } : {}) };
}

type TerminalReader = Pick<RustConnection["client"], "terminalOutput" | "terminalSnapshot">;

export async function rustTerminalView(client: TerminalReader, id: string, cursor: number | undefined, wait: number, signal: AbortSignal, recovery?: TerminalRecovery): Promise<JsonObject | null> {
  await recovery?.load(id);
  if (cursor === undefined) {
    const snapshot = await client.terminalSnapshot(id, signal);
    if (snapshot) { recovery?.snapshot(id, snapshot); return { kind: "pty", mode: "snapshot", seq: snapshot.seq, cols: snapshot.size.cols, rows: snapshot.size.rows, dataB64: snapshot.dataB64 }; }
  }
  const page = await client.terminalOutput(id, { afterSeq: cursor ?? 0, waitMs: Math.min(wait, 5000) }, signal);
  const cached = recovery?.replay(id, cursor, page.floorSeq, page.latestSeq);
  if (cached) return cached;
  if (page.resyncRequired) {
    const snapshot = await client.terminalSnapshot(id, signal);
    if (snapshot) { recovery?.snapshot(id, snapshot); return { kind: "pty", mode: "snapshot", seq: snapshot.seq, cols: snapshot.size.cols, rows: snapshot.size.rows, dataB64: snapshot.dataB64 }; }
    // Retained bytes alone cannot reconstruct cursor, modes or screen contents.
    // Never treat a truncated suffix as a fresh terminal, even after catching up.
    throw new Error("终端历史已裁剪且暂无完整快照，无法可靠恢复画面。请保留已有终端窗口；重新加载不能还原已丢失的屏幕状态。");
  }
  if (recovery && !recovery.append(id, page)) {
    const compact = await client.terminalSnapshot(id, signal);
    if (compact) recovery.snapshot(id, compact);
  }
  if (!page.events.length && cursor !== undefined && !page.exited) return null;
  return { kind: "pty", mode: "events", seq: page.nextSeq, baseSeq: page.baseSeq, cols: page.initialSize.cols, rows: page.initialSize.rows, events: page.events, exited: page.exited, caughtUp: page.nextSeq === page.latestSeq };
}

export class RustRuntime {
  private readonly process: RustProcess;
  private connection: RustConnection | undefined;
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private starting: Promise<{ ok: boolean; error?: string }> | undefined;
  private stopping: Promise<{ ok: boolean; error?: string }> | undefined;
  private refreshing: Promise<void> | undefined;
  private sequence = 0;
  private orchestrationSequence = 0;
  private nextDevicesPollAt = 0;
  private ready = false;
  private readonly terminalRecovery: TerminalRecovery;
  flushTerminalRecovery(): Promise<void> { return this.terminalRecovery.flush(); }
  private terminalWrites = new Map<string, { count: number; bytes: number; failed: boolean; tail: Promise<void> }>();

  constructor(private readonly store: StateStore, binary: string, directory: string, env?: Record<string, string>) {
    this.terminalRecovery = new TerminalRecovery(resolvePath(directory, "desktop-recovery"));
    if (store.backend !== "api") throw new Error("Rust requires API-only desktop state");
    this.process = new RustProcess(binary, directory, () => {
      this.controller.abort(); clearTimeout(this.timer); this.ready = false; this.connection = undefined;
      this.clearState();
      this.store.setManagedState(undefined, false, this.stopping ? undefined : "Rust 服务已退出");
    }, env);
  }

  get managed(): boolean { return this.process.managed; }
  describeRuntime(): string { return this.process.binary; }

  start(): Promise<{ ok: boolean; error?: string }> {
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.ready) return Promise.resolve({ ok: true });
    if (!this.starting) this.starting = this.launch().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async launch(): Promise<{ ok: boolean; error?: string }> {
    this.controller = new AbortController();
    this.store.setStartupProgress(8, "连接 Rust 服务");
    try {
      this.connection = await this.process.attach();
      if (!this.connection) {
        this.store.setStartupProgress(18, "启动 Rust 服务");
        this.connection = await this.process.start();
      }
      if (this.controller.signal.aborted) throw new Error("启动已取消");
      this.store.setStartupProgress(70, "读取会话摘要", this.connection.pid);
      await this.refresh();
      this.ready = true;
      this.store.setManagedState(this.managed ? this.connection.pid : undefined, false);
      this.schedule();
      return { ok: true };
    } catch {
      await this.process.stop();
      this.clearState();
      const error = "Rust 服务启动失败，请检查实验构建和独立数据目录";
      this.store.setManagedState(undefined, false, error);
      return { ok: false, error };
    }
  }

  stop(): Promise<{ ok: boolean; error?: string }> {
    if (!this.stopping) this.stopping = this.terminate().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async terminate(): Promise<{ ok: boolean; error?: string }> {
    this.controller.abort(); clearTimeout(this.timer); this.ready = false;
    try {
      await this.process.stop();
      await this.starting;
      await this.refreshing?.catch(() => {});
      this.connection = undefined; this.clearState(); this.store.setManagedState(undefined, false);
      return { ok: true };
    } catch { return { ok: false, error: "Rust 服务关闭失败" }; }
  }

  async restart(): Promise<{ ok: boolean; error?: string }> {
    const stopped = await this.stop();
    if (!stopped.ok) return stopped;
    await this.starting;
    return this.start();
  }

  private clearState(): void {
    this.nextDevicesPollAt = 0;
    this.store.setApiState({ running: false, config: { bind: "127.0.0.1", port: 0 }, status: {}, devices: {}, orchestration: {}, projects: [] });
  }

  private current(): RustConnection {
    if (!this.connection || this.controller.signal.aborted) throw new Error("Rust 服务尚未就绪");
    return this.connection;
  }

  private refresh(force = false): Promise<void> {
    if (this.refreshing) return force ? this.refreshing.then(() => this.refresh()) : this.refreshing;
    this.refreshing = this.readWindow().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async readWindow(): Promise<void> {
    const { client, pid, baseUrl } = this.current();
    const signal = this.controller.signal;
    const orchCursor = await client.events({ scope: "orchestration", afterSeq: this.orchestrationSequence, limit: 1 }, signal).catch(() => null);
    const [summary, active, recent, workspaces, health, devices, schedules, queues, controls, orchestration] = await Promise.all([
      client.summary(undefined, signal),
      client.sessions({ limit: 100, cursor: null, lifecycle: "active", workspace: null, text: null }, signal),
      client.sessions({ limit: 20, cursor: null, lifecycle: "archived", workspace: null, text: null }, signal),
      client.workspaces({ limit: 100, cursor: null }, signal),
      client.health(signal),
      client.devices(signal).catch((error: unknown) => {
        // Device rows are management UI state; a transient read failure must
        // not blank the existing device list or prevent the daemon from starting.
        this.store.appendLog(`[rust] devices read failed: ${error instanceof Error ? error.message : String(error)}\n`);
        return { items: this.store.snapshot().devices };
      }),
      client.schedules(signal).catch((error: unknown) => {
        this.store.appendLog(`[rust] schedules read failed: ${error instanceof Error ? error.message : String(error)}\n`);
        return [];
      }),
      client.agentQueues(signal).catch((error: unknown) => {
        // The queue projection is additive UI state; a stale daemon or read
        // failure must not blank the session list.
        this.store.appendLog(`[rust] agent queues read failed: ${error instanceof Error ? error.message : String(error)}\n`);
        return { queues: [] };
      }),
      client.agentControls(signal).catch((error: unknown) => {
        // Controls only gate the model/mode widgets; never blank the list.
        this.store.appendLog(`[rust] agent controls read failed: ${error instanceof Error ? error.message : String(error)}\n`);
        return { controls: [] };
      }),
      orchCursor
        ? readOrchestrationWindow(client, signal, orchCursor.latestSeq).catch((error: unknown) => {
          // Orchestration is additive; a failure here must not blank the session list.
          this.store.appendLog(`[rust] orchestration read failed: ${error instanceof Error ? error.message : String(error)}\n`);
          return null;
        })
        : Promise.resolve(null),
    ]);
    signal.throwIfAborted();
    if (orchCursor) this.orchestrationSequence = orchCursor.latestSeq;
    this.nextDevicesPollAt = Date.now() + 2_000;
    const queueById = new Map(queues.queues.map(queue => [queue.sessionId, queue.items]));
    const controlsById = new Map(controls.controls.map(item => [item.sessionId, item]));
    const sessions = [...active.items, ...recent.items].map(head => rustSessionInfo(head, queueById.get(head.id), controlsById.get(head.id)));
    this.sequence = Math.min(summary.latestSeq, active.latestSeq, recent.latestSeq, workspaces.latestSeq);
    this.store.setApiState({ running: true, config: {}, devices: devices as unknown as JsonObject, orchestration: orchestration ?? {}, projects: workspaces.items.map(item => item.workspace), status: {
      pid, port: Number(new URL(baseUrl).port), bind: "127.0.0.1", sessions, capabilities: health.capabilities,
      persistence: health.persistence,
      daemonVersion: health.daemonVersion,
      buildId: health.buildId,
      ...(this.connection?.expectedBuildId ? { expectedBuildId: this.connection.expectedBuildId } : {}),
      updatePending: this.connection?.upgradeDeferred === true,
      ...(health.relay ? { relay: health.relay as unknown as JsonObject } : {}),
      metadataRevision: `${pid}:${this.sequence}`,
      workspaceCounts: Object.fromEntries(workspaces.items.map(({ workspace, summary }) => [workspace, { revision: summary.revision, total: summary.total, active: summary.active, archived: summary.archived, attention: summary.attention }])),
      sessionSummary: { total: summary.total, active: summary.active, terminal: summary.archived, attention: summary.attention, activeLimit: 100, attentionLimit: 0, recentTerminalLimit: 20 },
      schedules: schedules as unknown as JsonObject[],
    } });
  }

  private schedule(delay = 500): void {
    clearTimeout(this.timer);
    if (!this.ready || this.controller.signal.aborted) return;
    this.timer = setTimeout(() => { void this.poll(); }, delay);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    let delay = 500;
    try {
      if (this.process.upgradePending) {
        const connection = await this.process.completeDeferredUpgrade();
        if (connection && !connection.upgradeDeferred) {
          this.connection = connection;
          await this.refresh();
          return;
        }
        if (!connection) {
          this.connection = await this.process.start();
          await this.refresh();
          return;
        }
      }
      const { client } = this.current();
      const now = Date.now();
      const shouldPollDevices = now >= this.nextDevicesPollAt;
      if (shouldPollDevices) this.nextDevicesPollAt = now + 2_000;
      const [sessions, orchestration, devices] = await Promise.all([
        client.events({ scope: "sessions", afterSeq: this.sequence, limit: 100 }, this.controller.signal),
        client.events({ scope: "orchestration", afterSeq: this.orchestrationSequence, limit: 100 }, this.controller.signal),
        shouldPollDevices ? client.devices(this.controller.signal).catch(() => null) : Promise.resolve(null),
      ]);
      if (devices) this.store.setApiDevices(devices as unknown as JsonObject);
      if (sessions.resyncRequired || sessions.latestSeq !== this.sequence
        || orchestration.resyncRequired || orchestration.latestSeq !== this.orchestrationSequence) {
        await this.refresh();
      }
    } catch { delay = 2000; }
    finally { this.schedule(delay); }
  }

  async listSessions(request: SessionPageRequest, cancellation?: AbortSignal): Promise<SessionPage> {
    const { client } = this.current();
    const signal = cancellation ? AbortSignal.any([cancellation, this.controller.signal]) : this.controller.signal;
    if (request.ids) {
      if (request.query || request.workspace) throw new Error("ID 查询不支持叠加筛选");
      const ids = [...new Set(request.ids)];
      const key = createHash("sha256").update(JSON.stringify([ids, request.terminal === true])).digest("hex");
      let start = 0;
      if (request.cursor) {
        let cursor: { key?: unknown; id?: unknown };
        try { cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) as typeof cursor; } catch { throw new Error("会话游标无效"); }
        if (!cursor || cursor.key !== key || typeof cursor.id !== "string" || !ids.includes(cursor.id)) throw new Error("会话游标与筛选不匹配");
        start = ids.indexOf(cursor.id) + 1;
      }
      const result = await client.lookup(ids, signal);
      const heads = result.items.filter(head => !request.terminal || head.lifecycle === "archived");
      const remaining = heads.filter(head => ids.indexOf(head.id) >= start);
      const items = remaining.slice(0, request.limit ?? 100);
      return { items: items.map(head => rustSessionInfo(head)), total: heads.length, active: result.items.filter(head => head.lifecycle === "active").length, terminal: result.items.filter(head => head.lifecycle === "archived").length,
        ...(remaining.length > items.length && items.length ? { nextCursor: Buffer.from(JSON.stringify({ key, id: items.at(-1)!.id })).toString("base64url") } : {}),
      };
    }
    const [page, summary] = await Promise.all([
      client.sessions({ limit: request.limit ?? 100, cursor: request.cursor ?? null, lifecycle: request.terminal ? "archived" : null, text: request.query ?? null, workspace: request.workspace ?? null }, signal),
      client.summary(request.workspace, signal),
    ]);
    return { items: page.items.map(head => rustSessionInfo(head)), total: page.total, active: summary.active, terminal: summary.archived, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), ...(page.previousCursor ? { previousCursor: page.previousCursor } : {}) };
  }

  async rename(id: string, title: string): Promise<DesktopSnapshot> {
    const { client } = this.current();
    const signal = this.controller.signal;
    const head = await client.session(id, signal);
    await client.rename(id, { revision: head.revision, title: title.trim() }, signal);
    await this.refresh(true);
    return this.store.snapshot();
  }

  readTimeline(id: string, query: TimelineQuery, signal: AbortSignal) { return this.current().client.timeline(id, query, AbortSignal.any([signal, this.controller.signal])); }
  readTimelineChanges(id: string, after: number, signal: AbortSignal) { return this.current().client.events({ scope: `timeline:${id}`, afterSeq: after, limit: 100 }, AbortSignal.any([signal, this.controller.signal])); }
  lookupTimeline(id: string, ids: string[], signal: AbortSignal) { return this.current().client.timelineLookup(id, ids, AbortSignal.any([signal, this.controller.signal])); }
  readTimelineText(id: string, record: string, query: TimelineTextQuery, signal: AbortSignal) { return this.current().client.timelineText(id, record, query, AbortSignal.any([signal, this.controller.signal])); }


  sessionIdForRoot(root: string): string | undefined {
    if (!this.ready) return undefined;
    const requested = resolvePath(root);
    for (const session of this.store.snapshot().daemon.sessions) {
      const candidate = resolvePath(session.cwd);
      if (candidate === requested || (process.platform === "win32" && candidate.toLowerCase() === requested.toLowerCase())) return session.id;
      try {
        const real = realpathSync(session.cwd);
        if (real === requested || (process.platform === "win32" && real.toLowerCase() === requested.toLowerCase())) return session.id;
      } catch { /* Session workspace may have been removed; skip Rust delegation. */ }
    }
    return undefined;
  }

  async listProjectFiles(sessionId: string, path: string): Promise<ProjectFile[]> {
    return (await this.current().client.fsList(sessionId, path, this.controller.signal)).entries as ProjectFile[];
  }

  async readProjectFile(sessionId: string, path: string): Promise<FilePreview> {
    const result = await this.current().client.fsRead(sessionId, path, this.controller.signal);
    const content = Buffer.from(result.contentB64, "base64");
    const mime = PROJECT_IMAGE_TYPES[extname(path).toLowerCase()];
    return { path, size: result.size, version: createHash("sha256").update(content).digest("hex"), truncated: result.truncated, kind: mime && !result.truncated ? "image" : result.binary ? "binary" : "text", content: mime && !result.truncated ? `data:${mime};base64,${result.contentB64}` : result.binary ? "" : content.toString("utf8") };
  }

  async writeProjectFile(sessionId: string, input: { path: string; content: string; version?: string; createNew?: boolean }): Promise<void> {
    await this.current().client.fsWrite(sessionId, { path: input.path, contentB64: Buffer.from(input.content, "utf8").toString("base64"), ...(input.version !== undefined ? { expectedVersion: input.version } : {}), ...(input.createNew === true ? { createNew: true } : {}) }, this.controller.signal);
  }

  async makeProjectDirectory(sessionId: string, path: string): Promise<void> {
    await this.current().client.fsMkdir(sessionId, path, this.controller.signal);
  }

  async renameProjectEntry(sessionId: string, path: string, to: string): Promise<void> {
    await this.current().client.fsRename(sessionId, path, to, this.controller.signal);
  }

  async getProjectGitStatus(sessionId: string): Promise<ProjectGitStatus> {
    const result = await this.current().client.gitStatus(sessionId, this.controller.signal);
    return { branch: result.branch, ahead: result.ahead, behind: result.behind, files: result.files.map(file => ({ path: file.path, ...(file.originalPath ? { originalPath: file.originalPath } : {}), index: file.index, worktree: file.worktree, untracked: file.untracked })), staged: result.staged };
  }

  async getProjectDiff(sessionId: string, path: string, staged: boolean): Promise<string> {
    return (await this.current().client.gitDiff(sessionId, path, staged, this.controller.signal)).patch;
  }

  async searchProject(sessionId: string, query: string, options: { caseSensitive: boolean; wholeWord: boolean; pathFilter: string }, cancellation: AbortSignal): Promise<import("../shared/project-tools").SearchResult> {
    const signal = AbortSignal.any([cancellation, this.controller.signal]);
    const result = await this.current().client.projectSearch(sessionId, { query, caseSensitive: options.caseSensitive, wholeWord: options.wholeWord, pathFilter: options.pathFilter }, signal, 15_000);
    return { matches: result.matches, scanned: result.scanned, skipped: result.skipped, truncated: result.truncated };
  }

  async getProjectGitHistory(sessionId: string): Promise<GitHistoryEntry[]> {
    return (await this.current().client.gitHistory(sessionId, this.controller.signal)).entries;
  }

  async mutateProjectGit(sessionId: string, input: GitMutation): Promise<void> {
    if (input.kind === "commit") await this.current().client.gitCommit(sessionId, input.message, this.controller.signal);
    else await this.current().client.gitStage(sessionId, input.paths, input.kind === "unstage", this.controller.signal);
  }

  private async terminalView(id: string, cursor: number | undefined, wait: number, signal: AbortSignal): Promise<JsonObject | null> {
    return rustTerminalView(this.current().client, id, cursor, wait, signal, this.terminalRecovery);
  }

  private async terminalWrite(id: string, data: string, signal: AbortSignal): Promise<void> {
    if (data.length > 1_398_104) throw new Error("终端输入无效或超过 1 MiB");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > 1024 * 1024 || bytes.toString("base64") !== data) throw new Error("终端输入无效或超过 1 MiB");
    const { client } = this.current();
    const queue = this.terminalWrites.get(id) ?? { count: 0, bytes: 0, failed: false, tail: Promise.resolve() };
    if (queue.count >= 32 || queue.bytes + bytes.length > 1024 * 1024) throw new Error("终端输入队列已满");
    this.terminalWrites.set(id, queue); queue.count++; queue.bytes += bytes.length;
    const job = queue.tail.then(async () => {
      if (queue.failed) throw new Error("之前的终端输入未完成，请检查会话状态");
      for (let offset = 0; offset < bytes.length; offset += 8192) await client.terminalInput(id, bytes.subarray(offset, offset + 8192), signal);
    });
    queue.tail = job.catch(() => { queue.failed = true; });
    try { await job; } finally {
      queue.count--; queue.bytes -= bytes.length;
      if (!queue.count) this.terminalWrites.delete(id);
    }
  }

  async request(path: string, init?: { method?: "GET" | "POST"; body?: JsonObject; signal?: AbortSignal; timeoutMs?: number; acceptJsonError?: boolean }): Promise<JsonObject | null> {
    const signal = init?.signal ? AbortSignal.any([init.signal, this.controller.signal]) : this.controller.signal;
    const input = init?.body;
    if (path === "/_prospero/control/accounts" && init?.method === "POST" && input) {
      const type = input["type"];
      if (typeof type !== "string" || typeof input["requestId"] !== "string" || !input["requestId"].trim() || input["requestId"].length > 100) {
        throw new Error("账号请求 ID 无效");
      }
      if (type === "agent.accounts.list") {
        const result = await this.current().client.listAccounts(input["requestId"], signal);
        return result as unknown as JsonObject;
      }
      // Third-party API model catalog: feature errors come back in-body.
      if (type === API_MODELS_TYPE) {
        const modelsBody: Record<string, unknown> = { type, requestId: input["requestId"] };
        const accountId = input["accountId"];
        const hasDraft = input["baseUrl"] !== undefined || input["apiKey"] !== undefined
          || input["protocol"] !== undefined || input["headers"] !== undefined;
        if (accountId !== undefined) {
          if (hasDraft) throw new Error("模型目录请求不能同时指定账号与草稿配置");
          modelsBody["accountId"] = accountId === NATIVE_CLAUDE_ACCOUNT
            ? NATIVE_CLAUDE_ACCOUNT
            : requireManagedAccountId(accountId);
        } else {
          if (input["protocol"] !== undefined) {
            if (!["anthropic", "openai_responses", "openai_chat_completions"].includes(String(input["protocol"]))) throw new Error("模型协议不支持");
            modelsBody["protocol"] = input["protocol"];
          }
          modelsBody["baseUrl"] = requireProfileEndpoint(input["baseUrl"]);
          modelsBody["apiKey"] = requireProfileKey(input["apiKey"], { allowBlank: false });
          if (input["headers"] !== undefined) {
            const headers = input["headers"];
            if (headers !== null && (typeof headers !== "object" || Array.isArray(headers))) throw new Error("自定义 Header 无效");
            modelsBody["headers"] = headers;
          }
        }
        const models = await this.current().client.accountFeature(modelsBody, signal, init.timeoutMs ?? 35_000);
        return models as unknown as JsonObject;
      }
      if (ACCOUNT_CONFIG_TYPES.has(type)) {
        const configBody: Record<string, unknown> = {
          type,
          requestId: input["requestId"],
          accountId: requireManagedAccountId(input["accountId"]),
        };
        if (type === "agent.account.config.set") {
          const documentId = input["documentId"];
          if (typeof documentId !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(documentId)) throw new Error("配置文档 ID 无效");
          const revision = input["revision"];
          if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) throw new Error("配置版本无效");
          configBody["documentId"] = documentId;
          configBody["revision"] = revision;
          if (input["content"] !== undefined) {
            if (typeof input["content"] !== "string" || input["content"].length > 16_384) throw new Error("配置内容过大");
            configBody["content"] = input["content"];
          }
          if ("defaultEffort" in input) {
            const effort = input["defaultEffort"];
            if (effort !== null && (typeof effort !== "string" || !ACCOUNT_CONFIG_EFFORTS.has(effort))) throw new Error("默认推理强度无效");
            configBody["defaultEffort"] = effort;
          }
        }
        const config = await this.current().client.accountFeature(configBody, signal, init.timeoutMs ?? 35_000);
        return config as unknown as JsonObject;
      }
      if (!MANAGED_ACCOUNT_TYPES.has(type) && !API_PROFILE_TYPES.has(type)) throw new Error("不支持的账号操作");
      // Mirror the daemon's field contract; never forward unknown envelopes.
      const body: Record<string, unknown> = { type, requestId: input["requestId"] };
      if (type === "agent.account.api.create") {
        if (input["agent"] !== "claude" && input["agent"] !== "codex" && input["agent"] !== "opencode") throw new Error("Agent 不支持 API Profile");
        body["agent"] = input["agent"];
        body["name"] = requireAccountName(input["name"]);
        requireProfileProtocol(input["agent"], input, body);
        body["baseUrl"] = requireProfileEndpoint(input["baseUrl"]);
        body["model"] = requireProfileModel(input["model"]);
        body["apiKey"] = requireProfileKey(input["apiKey"], { allowBlank: false });
        const caps = normalizeModelCapabilities(input["modelCapabilities"]);
        if (caps !== undefined) body["modelCapabilities"] = caps;
      } else if (type === "agent.account.api.configure") {
        const accountId = requireManagedAccountId(input["accountId"]);
        const accounts = await this.current().client.listAccounts(input["requestId"], signal);
        const account = accounts.accounts?.find((item) => item.id === accountId);
        if (!account) throw new Error("账号不存在");
        const agent =
          input["protocol"] === "anthropic"
            ? "claude"
            : input["protocol"] === "openai_chat_completions"
              ? "opencode"
              : input["protocol"] === "openai_responses"
                ? "codex"
                : account.agent;
        body["accountId"] = accountId;
        if (input["name"] !== undefined) body["name"] = requireAccountName(input["name"]);
        requireProfileProtocol(agent, input, body);
        if (input["baseUrl"] !== undefined) body["baseUrl"] = requireProfileEndpoint(input["baseUrl"]);
        if (input["model"] !== undefined) body["model"] = requireProfileModel(input["model"]);
        if (input["apiKey"] !== undefined) {
          const key = requireProfileKey(input["apiKey"], { allowBlank: true });
          if (key.trim()) body["apiKey"] = key;
        }
        // Distinguish omitted (keep) from explicit null (clear).
        if (input["modelCapabilities"] !== undefined) body["modelCapabilities"] = normalizeModelCapabilities(input["modelCapabilities"]);
      } else if (type === "agent.account.api.test") {
        body["accountId"] = requireManagedAccountId(input["accountId"]);
        if (input["scope"] !== undefined) {
          if (input["scope"] !== "protocol" && input["scope"] !== "engine") throw new Error("连接测试范围无效");
          body["scope"] = input["scope"];
        }
      } else if (type === "agent.account.create") {
        if (input["agent"] !== "claude") throw new Error("Rust 当前仅支持 Claude 托管账号");
        body["agent"] = "claude";
        body["name"] = requireAccountName(input["name"]);
      } else {
        const accountId = requireManagedAccountId(input["accountId"]);
        body["accountId"] = accountId;
        if (type === "agent.account.rename") body["name"] = requireAccountName(input["name"]);
        if (type === "agent.account.login") {
          const cols = Number(input["cols"] ?? 120);
          const rows = Number(input["rows"] ?? 40);
          if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 500 || rows < 5 || rows > 300) throw new Error("终端尺寸无效");
          body["cols"] = cols; body["rows"] = rows;
        }
        if (type === "agent.account.credential.set") {
          const kind = input["credentialKind"];
          if (kind !== "oauth_token" && kind !== "api_key") throw new Error("凭据类型无效");
          const credential = input["credential"];
          if (typeof credential !== "string" || credential.trim().length < 20 || credential.length > 8192 || /[\r\n\0]/.test(credential)) throw new Error("凭据格式无效");
          body["credentialKind"] = kind;
          body["credential"] = credential;
        }
      }
      const result = await this.current().client.accountControl(body, signal, init.timeoutMs ?? (type === "agent.account.api.test" ? (body["scope"] === "engine" ? 90_000 : 45_000) : 30_000));
      if (type === "agent.account.login" && result.sessionId) await this.refresh(true);
      return result as unknown as JsonObject;
    }


    if (path === "/_prospero/control/conversation/search" && init?.method === "POST" && input) {
      const agent = input["agent"];
      if (agent !== "claude" && agent !== "codex" && agent !== "deepseek") throw new Error("Agent 无效");
      const requestId = requireRequestId(input["requestId"]);
      const query = String(input["query"] ?? "");
      if ([...query].length > 300 || /[\r\n\0]/.test(query)) throw new Error("对话搜索词无效");
      const limit = input["limit"] === undefined || input["limit"] === null ? 20 : Number(input["limit"]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("对话搜索数量无效");
      const rawAccountId = input["accountId"];
      let accountId: string | undefined;
      if (rawAccountId !== undefined && rawAccountId !== null && `${rawAccountId}`.trim()) {
        if (agent === "claude") accountId = rawAccountId === NATIVE_CLAUDE_ACCOUNT ? NATIVE_CLAUDE_ACCOUNT : requireManagedAccountId(rawAccountId);
        else throw new Error("Rust daemon 当前仅支持搜索 Claude 本机对话");
      }
      const conversations = await this.current().client.localConversations(agent, query, limit, accountId, signal);
      return { type: "conversation.results", requestId, agent, conversations } as unknown as JsonObject;
    }

    if (path === "/_prospero/control/model-sources" && init?.method === "POST" && input) {
      const type = input["type"];
      const requestId = input["requestId"];
      const rawAction = input["action"];
      if (type !== "model.source.action" || typeof requestId !== "string" || !requestId.trim() || requestId.length > 100 || !rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) throw new Error("模型源请求无效");
      const action = rawAction as Record<string, unknown>;
      const result = await this.current().client.modelSource(input, signal, init.timeoutMs ?? 45_000);
      if (result.ok && result.accounts) this.store.setAccounts(result.accounts as unknown as DesktopSnapshot["accounts"]);
      if (result.ok && action["kind"] !== "list" && action["kind"] !== "models") await this.refresh(true);
      return result as unknown as JsonObject;
    }
    const crossChildRoute = /^\/_prospero\/control\/session\/([A-Za-z0-9_-]{1,128})\/cross-model-children$/.exec(path);
    if (crossChildRoute && init?.method === "POST" && input) {
      const sourceId = requireManagedAccountId(input["sourceId"]);
      const routeId = requireManagedAccountId(input["routeId"]);
      const revision = Number(input["revision"]);
      if (!Number.isInteger(revision) || revision < 1) throw new Error("模型源版本无效");
      const agent = input["agent"];
      if (agent !== "codex" && agent !== "claude" && agent !== "opencode") throw new Error("跨模型子 Agent 无效");
      const task = String(input["task"] ?? "").trim();
      if (!task || task.length > 65_536 || /[\r\0]/.test(task)) throw new Error("子任务内容无效");
      const title = input["title"] === undefined ? undefined : String(input["title"] ?? "").trim();
      if (title !== undefined && (!title || title.length > 512 || /[\r\n\0]/.test(title))) throw new Error("子任务标题无效");
      const result = await this.current().client.createCrossModelChild(crossChildRoute[1]!, { sourceId, routeId, revision, agent, task, ...(title ? { title } : {}) }, signal, init.timeoutMs ?? 180_000);
      await this.refresh(true);
      return result as unknown as JsonObject;
    }
    if (path === "/_prospero/control/plugins" && (!init?.method || init.method === "GET")) {
      return await this.current().client.plugins(signal) as unknown as JsonObject;
    }
    if (path === "/_prospero/control/plugin-services" && (!init?.method || init.method === "GET")) {
      return await this.current().client.pluginServices(signal) as unknown as JsonObject;
    }
    const pluginServiceRoute = /^\/_prospero\/control\/plugin\/([^/]+)\/service\/([^/]+)\/(start|stop|restart|health)$/.exec(path);
    if (pluginServiceRoute && ((pluginServiceRoute[3] === "health" && (!init?.method || init.method === "GET")) || (pluginServiceRoute[3] !== "health" && init?.method === "POST"))) {
      const action = pluginServiceRoute[3] as "start" | "stop" | "restart" | "health";
      const result = await this.current().client.pluginServiceAction(
        requirePluginId(decodeURIComponent(pluginServiceRoute[1]!)),
        requirePluginId(decodeURIComponent(pluginServiceRoute[2]!)),
        action,
        signal,
        init?.timeoutMs ?? 30_000,
      );
      await this.refresh(true);
      return result as unknown as JsonObject;
    }
    const schedulesRoute = /^\/_prospero\/control\/schedules(?:\?(.*))?$/.exec(path);
    if (schedulesRoute && (!init?.method || init.method === "GET")) {
      const schedules = await this.current().client.schedules(signal);
      return { items: schedules } as JsonObject;
    }
    if (schedulesRoute && init?.method === "POST" && input) {
      const result = await this.current().client.createSchedule(scheduleCreateInput(input), signal);
      await this.refresh(true);
      return result as unknown as JsonObject;
    }
    const scheduleRoute = /^\/_prospero\/control\/schedules?\/([A-Za-z0-9._-]{1,100})\/(get|update|pause|resume|delete|run)$/.exec(path);
    if (scheduleRoute) {
      const scheduleId = scheduleRoute[1]!;
      const action = scheduleRoute[2]!;
      if (action === "get" && (!init?.method || init.method === "GET")) return await this.current().client.schedule(scheduleId, signal) as unknown as JsonObject;
      if (action === "update" && init?.method === "POST" && input) {
        const result = await this.current().client.updateSchedule(scheduleId, scheduleUpdateInput(scheduleId, input), signal);
        await this.refresh(true);
        return result as unknown as JsonObject;
      }
      if (action === "pause" && init?.method === "POST") {
        const result = await this.current().client.pauseSchedule(scheduleId, signal);
        await this.refresh(true);
        return result as unknown as JsonObject;
      }
      if (action === "resume" && init?.method === "POST") {
        const result = await this.current().client.resumeSchedule(scheduleId, signal);
        await this.refresh(true);
        return result as unknown as JsonObject;
      }
      if (action === "delete" && init?.method === "POST") {
        const result = await this.current().client.deleteSchedule(scheduleId, signal);
        await this.refresh(true);
        return result as unknown as JsonObject;
      }
      if (action === "run" && init?.method === "POST") {
        const result = await this.current().client.runSchedule(scheduleId, signal, init?.timeoutMs ?? 180_000);
        await this.refresh(true);
        return result as unknown as JsonObject;
      }
    }
    if (path === "/_prospero/control/orchestration/action" && init?.method === "POST" && input) {
      const method = input["method"];
      if (typeof method !== "string") throw new Error("不支持的编排操作");
      if (method.startsWith("schedule.")) {
        const params = input["params"];
        if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("定时任务参数无效");
        const body = params as JsonObject;
        const client = this.current().client;
        let result: unknown;
        switch (method) {
          case "schedule.list": result = await client.schedules(signal); break;
          case "schedule.create": result = await client.createSchedule(scheduleCreateInput(body), signal); break;
          case "schedule.get": result = await client.schedule(requireScheduleId(body["id"]), signal); break;
          case "schedule.update": { const id = requireScheduleId(body["id"]); result = await client.updateSchedule(id, scheduleUpdateInput(id, body), signal); break; }
          case "schedule.pause": result = await client.pauseSchedule(requireScheduleId(body["id"]), signal); break;
          case "schedule.resume": result = await client.resumeSchedule(requireScheduleId(body["id"]), signal); break;
          case "schedule.delete": result = await client.deleteSchedule(requireScheduleId(body["id"]), signal); break;
          case "schedule.run": result = await client.runSchedule(requireScheduleId(body["id"]), signal, init.timeoutMs ?? 180_000); break;
          default: throw new Error("不支持的定时任务操作");
        }
        if (method !== "schedule.list" && method !== "schedule.get") await this.refresh(true);
        return result as JsonObject;
      }
      const result = await orchestrationAction(this.current().client, method, input["params"], signal, init.timeoutMs);
      await this.refresh(true);
      return result;
    }
    const taskRoute = /^\/_prospero\/control\/orchestration\/task\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (taskRoute && (!init?.method || init.method === "GET")) {
      return this.current().client.task(taskRoute[1]!, signal) as Promise<JsonObject>;
    }
    const runTasksRoute = /^\/_prospero\/control\/orchestration\/run\/([A-Za-z0-9_-]{1,128})\/tasks$/.exec(path);
    if (runTasksRoute && (!init?.method || init.method === "GET")) {
      const items = await this.current().client.listTasks(runTasksRoute[1]!, signal);
      return { items } as JsonObject;
    }
    const gateRoute = /^\/_prospero\/control\/orchestration\/gate\/([A-Za-z0-9_-]{1,128})\/resolve$/.exec(path);
    if (gateRoute && init?.method === "POST" && input) {
      const decision = input["decision"];
      if (typeof decision !== "string" || !decision.trim()) throw new Error("决策无效");
      const gate = await this.current().client.resolveGate(gateRoute[1]!, { decision: decision.trim() }, signal);
      await this.refresh(true);
      return gate as unknown as JsonObject;
    }
    const settleRoute = /^\/_prospero\/control\/orchestration\/dispatch\/([A-Za-z0-9_-]{1,128})\/settle$/.exec(path);
    if (settleRoute && init?.method === "POST" && input) {
      const outcome = await this.current().client.settleDispatch(settleRoute[1]!, settleDispatchInput(input), signal);
      await this.refresh(true);
      return outcome as unknown as JsonObject;
    }
    const skillsRoute = /^\/_prospero\/control\/skills(?:\?(.*))?$/.exec(path);
    if (skillsRoute && (!init?.method || init.method === "GET")) {
      const cwd = new URLSearchParams(skillsRoute[1] ?? "").get("cwd") ?? "";
      if (!cwd || !isAbsolute(cwd)) throw new Error("工作区路径无效");
      const items = await this.current().client.listSkills(cwd, signal);
      return { items } as JsonObject;
    }
    const suggestionsRoute = /^\/_prospero\/control\/session\/([A-Za-z0-9_-]{1,128})\/suggestions(?:\?(.*))?$/.exec(path);
    if (suggestionsRoute && (!init?.method || init.method === "GET")) {
      const params = new URLSearchParams(suggestionsRoute[2] ?? "");
      if (params.get("kind") !== "skill") throw new Error("Skill 查询无效");
      const query = params.get("query") ?? "";
      if (query.length > 200) throw new Error("Skill 查询无效");
      const items = await this.current().client.skillSuggestions(suggestionsRoute[1]!, query, signal);
      return { items } as JsonObject;
    }
    const modesRoute = /^\/_prospero\/control\/session\/([A-Za-z0-9_-]{1,128})\/modes$/.exec(path);
    if (modesRoute) {
      const sessionId = modesRoute[1]!;
      if (init?.method === "POST" && input) {
        const mode = input["mode"];
        if (mode !== "default" && mode !== "plan") throw new Error("会话模式无效");
        const result = await this.current().client.setAgentMode(sessionId, String(mode), signal);
        await this.refresh(true);
        return result as unknown as JsonObject;
      }
      if (!init?.method || init.method === "GET") {
        const catalog = await this.current().client.agentModes(sessionId, signal);
        return catalog as unknown as JsonObject;
      }
    }
    const modelsRoute = /^\/_prospero\/control\/session\/([A-Za-z0-9_-]{1,128})\/models$/.exec(path);
    if (modelsRoute) {
      const sessionId = modelsRoute[1]!;
      if (init?.method === "POST" && input) {
        const model = normalizeLaunchSelection(input["model"], 300, "模型无效");
        if (model === undefined) throw new Error("模型无效");
        const effort = normalizeLaunchSelection(input["effort"], 80, "推理强度无效");
        const result = await this.current().client.setAgentModel(sessionId, model, effort, signal, init?.timeoutMs);
        await this.refresh(true);
        return result as unknown as JsonObject;
      }
      if (!init?.method || init.method === "GET") {
        const catalog = await this.current().client.agentModels(sessionId, signal, init?.timeoutMs);
        return catalog as unknown as JsonObject;
      }
    }
    const subagentEventsRoute = /^\/_prospero\/control\/session\/([A-Za-z0-9_-]{1,128})\/subagent\/([A-Za-z0-9_-]{1,128})\/events$/.exec(path);
    if (subagentEventsRoute && (!init?.method || init.method === "GET")) {
      const snapshot = await this.current().client.subagentEvents(subagentEventsRoute[1]!, subagentEventsRoute[2]!, signal);
      return snapshot as unknown as JsonObject;
    }
    const launchModelsRoute = /^\/_prospero\/control\/launch\/models(?:\?(.*))?$/.exec(path);
    if (launchModelsRoute && (!init?.method || init.method === "GET")) {
      const params = new URLSearchParams(launchModelsRoute[1] ?? "");
      const agent = params.get("agent");
      if (agent !== "claude" && agent !== "codex" && agent !== "deepseek" && agent !== "opencode") throw new Error("此 Agent 的模型目录尚未接入 Rust daemon");
      const accountId =
        params.get("accountId") ??
        (agent === "codex"
          ? NATIVE_CODEX_ACCOUNT
          : agent === "claude"
            ? NATIVE_CLAUDE_ACCOUNT
            : undefined);
      const nativeId = agent === "codex" ? NATIVE_CODEX_ACCOUNT : NATIVE_CLAUDE_ACCOUNT;
      if (agent === "deepseek" || agent === "opencode") {
        const catalog = await this.current().client.launchModels(agent, accountId, signal, init?.timeoutMs ?? 30_000);
        return catalog as unknown as JsonObject;
      }
      if (accountId === undefined) throw new Error("账号 ID 无效");
      if (accountId !== nativeId && !/^[A-Za-z0-9_-]{1,100}$/.test(accountId)) throw new Error("账号 ID 无效");
      const catalog = await this.current().client.launchModels(agent, accountId, signal, init?.timeoutMs ?? 30_000);
      return catalog as unknown as JsonObject;
    }
    const usageRoute = /^\/_prospero\/control\/usage(?:\?(.*))?$/.exec(path);
    if (usageRoute && (!init?.method || init.method === "GET")) {
      const params = new URLSearchParams(usageRoute[1]);
      const sid = params.get("sid") ?? undefined;
      return await this.current().client.usage(sid, signal) as unknown as JsonObject;
    }
    const workspaceSummaryRoute = /^\/_prospero\/control\/session\/([A-Za-z0-9_-]{1,128})\/workspace-summary(?:\?(.*))?$/.exec(path);
    if (workspaceSummaryRoute && (!init?.method || init.method === "GET")) {
      const params = new URLSearchParams(workspaceSummaryRoute[2] ?? "");
      return await this.current().client.workspaceSummary(workspaceSummaryRoute[1]!, requireRequestId(params.get("requestId")), signal, init?.timeoutMs ?? 15_000) as unknown as JsonObject;
    }
    const fsRoute = /^\/_prospero\/control\/session\/([A-Za-z0-9_-]{1,128})\/fs\/(list|read|get|write|put|mkdir|remove|rename)(?:\?(.*))?$/.exec(path);
    if (fsRoute) {
      const id = fsRoute[1]!; const op = fsRoute[2]!; const params = new URLSearchParams(fsRoute[3] ?? "");
      const client = this.current().client;
      if (op === "list" && (!init?.method || init.method === "GET")) return await client.fsList(id, requireRelativePath(params.get("path") ?? "", true), signal) as unknown as JsonObject;
      if (op === "read" && (!init?.method || init.method === "GET")) return await client.fsRead(id, requireRelativePath(params.get("path")), signal) as unknown as JsonObject;
      if (op === "get" && (!init?.method || init.method === "GET")) return await client.fsGet(id, requireRelativePath(params.get("path")), requireNonNegativeInteger(params.get("offset"), "偏移"), requireNonNegativeInteger(params.get("length"), "长度"), signal) as unknown as JsonObject;
      if (op === "write" && init?.method === "POST" && input) return await client.fsWrite(id, { path: requireRelativePath(input["path"]), contentB64: String(input["contentB64"] ?? ""), ...(input["createNew"] === true ? { createNew: true } : {}), ...(typeof input["expectedVersion"] === "string" ? { expectedVersion: input["expectedVersion"] } : {}) }, signal) as unknown as JsonObject;
      if (op === "put" && init?.method === "POST" && input) return await client.fsPut(id, { path: requireRelativePath(input["path"]), offset: requireNonNegativeInteger(input["offset"], "偏移"), dataB64: String(input["dataB64"] ?? ""), final: input["final"] === true }, signal) as unknown as JsonObject;
      if (op === "mkdir" && init?.method === "POST" && input) return await client.fsMkdir(id, requireRelativePath(input["path"]), signal) as unknown as JsonObject;
      if (op === "remove" && init?.method === "POST" && input) return await client.fsRemove(id, requireRelativePath(input["path"]), signal) as unknown as JsonObject;
      if (op === "rename" && init?.method === "POST" && input) return await client.fsRename(id, requireRelativePath(input["path"]), requireRelativePath(input["to"]), signal) as unknown as JsonObject;
    }
    const searchRoute = /^\/_prospero\/control\/session\/([A-Za-z0-9_-]{1,128})\/search$/.exec(path);
    if (searchRoute && init?.method === "POST" && input) {
      return await this.current().client.projectSearch(searchRoute[1]!, { query: String(input["query"] ?? ""), caseSensitive: input["caseSensitive"] === true, wholeWord: input["wholeWord"] === true, pathFilter: String(input["pathFilter"] ?? "") }, signal, init.timeoutMs ?? 15_000) as unknown as JsonObject;
    }
    const gitRoute = /^\/_prospero\/control\/session\/([A-Za-z0-9_-]{1,128})\/git\/(status|diff|history|stage|discard|commit)(?:\?(.*))?$/.exec(path);
    if (gitRoute) {
      const id = gitRoute[1]!; const op = gitRoute[2]!; const params = new URLSearchParams(gitRoute[3] ?? "");
      const client = this.current().client;
      if (op === "status" && (!init?.method || init.method === "GET")) return await client.gitStatus(id, signal) as unknown as JsonObject;
      if (op === "diff" && (!init?.method || init.method === "GET")) return await client.gitDiff(id, requireRelativePath(params.get("path")), params.get("staged") === "true", signal) as unknown as JsonObject;
      if (op === "history" && (!init?.method || init.method === "GET")) return await client.gitHistory(id, signal) as unknown as JsonObject;
      if (op === "stage" && init?.method === "POST" && input) {
        const paths = Array.isArray(input["paths"]) ? input["paths"].map((item) => requireRelativePath(item)) : [];
        return await client.gitStage(id, paths, input["unstage"] === true, signal) as unknown as JsonObject;
      }
      if (op === "discard" && init?.method === "POST" && input) return await client.gitDiscard(id, requireRelativePath(input["path"]), signal) as unknown as JsonObject;
      if (op === "commit" && init?.method === "POST" && input) return await client.gitCommit(id, String(input["message"] ?? ""), signal, init.timeoutMs ?? 30_000) as unknown as JsonObject;
    }

    if (path === "/_prospero/control/session/create" && init?.method === "POST" && input) {
      if (input["kind"] === "pty") {
        const agent = input["agent"];
        if (typeof agent !== "string" || !["codex", "claude", "opencode", "grok", "trae", "shell", "custom"].includes(agent)) throw new Error("Agent 无效");
        const command = input["command"];
        if (command !== undefined && (typeof command !== "string" || !command.trim() || command.length > 2_000 || command.includes("\0"))) throw new Error("终端命令无效");
        const model = normalizeLaunchSelection(input["model"], 160, "模型无效");
        const effort = normalizeLaunchSelection(input["effort"], 80, "推理强度无效");
        const rawAccountId = input["accountId"];
        let accountId: string | undefined;
        if (rawAccountId !== undefined && rawAccountId !== null && `${rawAccountId}`.trim()) {
          if (agent === "claude") accountId = rawAccountId === NATIVE_CLAUDE_ACCOUNT ? NATIVE_CLAUDE_ACCOUNT : requireManagedAccountId(rawAccountId);
          else if (agent === "codex") {
            accountId = rawAccountId === NATIVE_CODEX_ACCOUNT ? NATIVE_CODEX_ACCOUNT : requireManagedAccountId(rawAccountId);
          } else throw new Error("此 Agent 的账号选择尚未接入 Rust daemon");
        }
        if ((model || effort) && agent !== "claude" && agent !== "codex") throw new Error("此 Agent 的模型参数尚未接入 Rust daemon");
        const head = await this.current().client.createTerminal({ title: agent === "shell" && !command ? "Terminal" : `${agent} · ${basename(String(input["cwd"]))}`, workspace: String(input["cwd"]), size: { cols: Number(input["cols"] ?? 120), rows: Number(input["rows"] ?? 40) }, agent: agent as never, ...(command ? { command } : {}), ...(accountId ? { accountId } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, signal, init.timeoutMs ?? 180_000);
        await this.refresh(true);
        return rustSessionInfo(head);
      }
      const agent = input["agent"];
      if (agent !== "claude" && agent !== "codex" && agent !== "deepseek" && agent !== "opencode") throw new Error("Rust Agent 当前仅接入 Claude/Codex/DeepSeek/OpenCode");
      if (agent === "opencode" && input["accountId"] === undefined) throw new Error("OpenCode 需要 API Profile");
      const accountId = agent === "deepseek" || input["accountId"] === undefined || input["accountId"] === NATIVE_CLAUDE_ACCOUNT
        ? undefined
        : requireManagedAccountId(input["accountId"]);
      if (input["kind"] !== "structured" || input["command"]) throw new Error("此 Agent 选项尚未接入 Rust daemon");
      const mode = input["mode"] === undefined || input["mode"] === null ? undefined : String(input["mode"]);
      if (mode !== undefined && (agent === "deepseek" || (mode !== "default" && mode !== "plan"))) throw new Error("会话模式无效");
      const resume = normalizeClaudeResume(input["resume"]);
      const model = normalizeLaunchSelection(input["model"], 300, "模型无效");
      const effort = normalizeLaunchSelection(input["effort"], 80, "推理强度无效");
      const agentPreset = normalizeLaunchSelection(input["agentPreset"], 300, "Agent 预设无效");
      if (agentPreset !== undefined && agent !== "deepseek") throw new Error("只有 DeepSeek Harness 支持 Agent 预设");
      const policy = input["approvalPolicy"];
      if (policy !== "strict" && policy !== "standard" && policy !== "yolo") throw new Error("审批策略无效");
      const head = await this.current().client.createAgentSession({
        agent,
        title: resume?.title ?? (agent === "deepseek" ? "DeepSeek" : agent === "opencode" ? "OpenCode" : agent === "codex" ? "Codex" : "Claude"),
        workspace: String(input["cwd"]),
        autoApprove: policy === "yolo",
        ...(mode !== undefined ? { mode } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(agentPreset !== undefined ? { agentPreset } : {}),
        ...(accountId !== undefined ? { accountId } : {}),
        ...(resume !== undefined ? { resume } : {}),
      }, signal, init.timeoutMs ?? 180_000);
      await this.refresh(true);
      return rustSessionInfo(head);
    }

    const attachmentRoute = /^\/_prospero\/control\/session\/([A-Za-z0-9_-]{1,128})\/attachment(?:\?(.*))?$/.exec(path);
    if (attachmentRoute && (!init?.method || init.method === "GET")) {
      const params = new URLSearchParams(attachmentRoute[2] ?? "");
      const msgId = params.get("msgId");
      const attachmentId = params.get("attachmentId");
      const offset = Number(params.get("offset") ?? 0);
      const length = Number(params.get("length") ?? 1024 * 1024);
      if (!msgId || !/^[A-Za-z0-9_-]{1,128}$/.test(msgId)) throw new Error("消息 ID 无效");
      if (!attachmentId || !/^[A-Za-z0-9_-]{1,128}$/.test(attachmentId)) throw new Error("附件 ID 无效");
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > 1024 * 1024) throw new Error("附件读取范围无效");
      return await this.current().client.chatAttachmentChunk(attachmentRoute[1]!, msgId, attachmentId, offset, length, signal) as unknown as JsonObject;
    }

    const toolOutputRoute = /^\/_prospero\/control\/session\/([A-Za-z0-9_-]{1,128})\/tool-output(?:\?(.*))?$/.exec(path);
    if (toolOutputRoute && (!init?.method || init.method === "GET")) {
      const params = new URLSearchParams(toolOutputRoute[2]);
      const callId = params.get("callId");
      if (!callId || !/^[A-Za-z0-9_-]{1,128}$/.test(callId)) throw new Error("工具调用无效");
      return this.current().client.toolOutput(toolOutputRoute[1]!, callId, signal) as Promise<JsonObject>;
    }

    const route = /^\/_prospero\/control\/session\/([A-Za-z0-9_-]{1,128})\/(view|interact|interrupt|kill)(?:\?(.*))?$/.exec(path);
    if (route) {
      const id = route[1]!; const action = route[2]; const { client } = this.current();
      const kind = await this.sessionKind(id, signal);
      if (action === "view" && (!init?.method || init.method === "GET")) {
        if (kind === "structured") return null;
        const params = new URLSearchParams(route[3]);
        return this.terminalView(id, params.has("outputAfterSeq") ? Number(params.get("outputAfterSeq")) : undefined, Number(params.get("waitMs") ?? 0), signal);
      }
      if (init?.method === "POST") {
        if (kind === "structured") {
          if (action === "interact" && (input?.["type"] === "chat.queue.remove" || input?.["type"] === "chat.queue.guide")) {
            const queueId = input["queueId"];
            if (typeof queueId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(queueId)) throw new Error("待发送消息无效");
            if (input["type"] === "chat.queue.remove") await client.agentQueueRemove(id, queueId, signal);
            else await client.agentQueueGuide(id, queueId, signal);
            await this.refresh(true);
            return { ok: true };
          }
          if (action === "interact" && input?.["type"] === "chat.send") {
            const text = input["text"];
            if (typeof text !== "string") throw new Error("消息内容无效");
            const attachments = normalizeAttachments(input["attachments"]);
            if (!text.trim() && attachments.length === 0) throw new Error("消息内容无效");
            const delivery = input["delivery"];
            if (delivery !== undefined && delivery !== "queue" && delivery !== "steer") throw new Error("发送方式无效");
            await client.agentSend(id, { text, delivery: delivery === "steer" ? "steer" : null, attachments }, signal);
            await this.refresh(true);
            return { ok: true };
          }
          if (action === "interact" && input?.["type"] === "permission.respond") {
            const requestId = input["reqId"];
            if (typeof requestId !== "string") throw new Error("审批请求无效");
            const reply = input["reply"];
            if (reply !== "once" && reply !== "always" && reply !== "reject") throw new Error("审批回复无效");
            await client.agentPermission(id, { requestId, allow: reply !== "reject" }, signal);
            return { ok: true };
          }
          if (action === "interact" && input?.["type"] === "question.respond") {
            const requestId = input["reqId"];
            if (typeof requestId !== "string") throw new Error("提问请求无效");
            const raw = Array.isArray(input["answers"]) ? input["answers"] : [];
            const answers = raw.map((entry: unknown) => {
              const item = entry as Record<string, unknown>;
              const questionId = item?.["questionId"];
              const values = Array.isArray(item?.["values"]) ? item!["values"] : [];
              if (typeof questionId !== "string" || !questionId) throw new Error("提问回答无效");
              return { questionId, values: values.map((value: unknown) => String(value)) };
            });
            await client.agentQuestion(id, { requestId, answers, cancelled: input["cancelled"] === true }, signal);
            return { ok: true };
          }
          if (action === "interact" && input?.["type"] === "agent.compact") {
            const requestId = input["requestId"];
            if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 100) throw new Error("压缩请求 ID 无效");
            const result = await client.agentCompact(id, requestId, signal);
            await this.refresh(true);
            return result as unknown as JsonObject;
          }
          if (action === "interact" && input?.["type"] === "approval.policy.set") {
            const policy = input["policy"];
            if (policy !== "strict" && policy !== "standard" && policy !== "yolo") throw new Error("审批策略无效");
            await client.setApprovalPolicy(id, policy, signal);
            await this.refresh(true);
            return { ok: true };
          }
          if (action === "interrupt") { await client.agentInterrupt(id, signal); return { ok: true }; }
          if (action === "kill") { await client.agentClose(id, signal); await this.refresh(true); return { ok: true }; }
          throw new Error("此 Agent 操作尚未接入 Rust daemon");
        }
        if (action === "interact" && input?.["type"] === "term.input" && typeof input["dataB64"] === "string") { await this.terminalWrite(id, input["dataB64"], signal); return { ok: true }; }
        if (action === "interact" && input?.["type"] === "term.resize") return client.terminalResize(id, { cols: Number(input["cols"]), rows: Number(input["rows"]) }, signal);
        if (action === "interrupt") { await this.terminalWrite(id, "Aw==", signal); return { ok: true }; }
        if (action === "kill") return client.terminalClose(id, signal);
      }
    }
    throw new Error("此功能尚未接入 Rust daemon");
  }

  private async sessionKind(id: string, signal: AbortSignal): Promise<"structured" | "pty"> {
    const known = this.store.snapshot().daemon.sessions.find(session => session.id === id);
    if (known?.kind === "structured" || known?.kind === "pty") return known.kind;
    const head = await this.current().client.session(id, signal);
    return head.kind;
  }


  async createPairing(input: { name: string; allowShell: boolean; allowOrchestration: boolean }): Promise<{ output: string; uri?: string }> {
    const result = await this.current().client.createPairing(input, this.controller.signal);
    const current = this.store.snapshot().devices.filter((device) => device.id !== result.device.id);
    this.store.setApiDevices({ items: [...current, result.device] } as unknown as JsonObject);
    await this.refresh(true).catch((error: unknown) => {
      this.store.appendLog(`[rust] refresh after pairing failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    return { output: result.uri, uri: result.uri };
  }

  async revokeDevice(id: string): Promise<{ ok: boolean; output: string }> {
    const result = await this.current().client.revokeDevice(id, this.controller.signal);
    const current = this.store.snapshot().devices.filter((device) => device.id !== id);
    this.store.setApiDevices({ items: current } as unknown as JsonObject);
    await this.refresh(true).catch((error: unknown) => {
      this.store.appendLog(`[rust] refresh after device revoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    return { ok: result.ok, output: result.ok ? `revoked ${result.id}` : "" };
  }

  async runCli(args: string[]): Promise<{ code: number; output: string }> {
    return new Promise((complete) => {
      const child = spawn(this.process.binary, args, {
        env: { ...process.env, PROSPERO_HOME: this.process.directory },
        windowsHide: true,
        stdio: "pipe",
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      child.once("error", (error) => complete({ code: 1, output: error.message }));
      child.once("exit", (code) => complete({ code: code ?? 1, output }));
    });
  }
}
