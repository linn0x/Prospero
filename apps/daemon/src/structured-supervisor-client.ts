/** Daemon-side launcher and reconnectable facade for one structured session. */
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ApprovalPolicy,
  AgentEventBody,
  AgentKind,
  AgentQuestionAnswer,
  Attachment,
  ChatDelivery,
  ChatSuggestion,
  ChatSuggestionKind,
  PermissionReply,
  SessionInfo,
  SubagentInfo,
} from "@prospero/protocol";
import { completeComposer } from "./composer-context.js";
import { compactAgentSnapshotEvents, type StructuredSessionPersistentState } from "./structured-session.js";
import type {
  AdapterResumeState,
  AgentModeCatalog,
  AgentModeSelection,
  AgentModelCatalog,
  AgentModelSelection,
  UsageReport,
} from "./adapters/types.js";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorEvent,
} from "./structured-supervisor.js";
/** Kept in sync with the runner without importing its executable module. */
export const SUPERVISOR_MANIFEST_VERSION = 1;

export interface StructuredSupervisorManifest {
  version: 1;
  protocolVersion: number;
  implementation: "supervisor";
  sessionId: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  createdAt: number;
  approvalPolicy: ApprovalPolicy;
  socket: string;
  tokenFile: string;
  /** Private owner directory; may differ from a short runtime socket path. */
  sessionDir?: string;
  supervisorPid?: number;
  lifecycleEpoch: string;
  status?: string;
  updatedAt?: number;
  accountId?: string;
  accountName?: string;
}

const MAX_EVENTS = 4_000;
const INFO_REFRESH_MS = 250;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SUPERVISOR_STARTUP_TIMEOUT_MS = 8_000;
const SUPERVISOR_ATTACH_ATTEMPT_TIMEOUT_MS = 250;
const SUPERVISOR_TERM_GRACE_MS = 500;
const SUPERVISOR_KILL_GRACE_MS = 2_000;

export type StructuredHosting = "supervisor" | "in_process" | "unavailable";

export class RemoteSupervisorError extends Error {
  constructor(message: string, readonly code = "supervisor_unavailable") {
    super(message);
  }
}

interface RpcReply {
  version?: number;
  id?: number;
  method?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
  params?: unknown;
}

class SupervisorRpc {
  private socket: Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timeout: NodeJS.Timeout | undefined;
  }>();

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly onEvent: (event: SupervisorEvent) => void,
    private readonly onDisconnect: () => void,
  ) {}

  async connect(timeoutMs?: number): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    const socket = createConnection(this.socketPath);
    try {
      await withTimeout(
        once(socket, "connect").then(() => undefined),
        timeoutMs,
        "supervisor socket connection timed out",
      );
    } catch (error) {
      socket.destroy();
      throw error;
    }
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (error) => {
      this.rejectAll(error);
      this.onDisconnect();
    });
    socket.on("close", () => {
      this.rejectAll(new RemoteSupervisorError("supervisor socket closed"));
      this.onDisconnect();
    });
  }

  async request<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const startedAt = Date.now();
    await this.connect(timeoutMs);
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) throw new RemoteSupervisorError("supervisor socket unavailable");
    const id = this.nextId++;
    const remaining = timeoutMs === undefined ? undefined : Math.max(1, timeoutMs - (Date.now() - startedAt));
    const result = new Promise<T>((resolve, reject) => {
      const timeout = remaining === undefined ? undefined : setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(new RemoteSupervisorError("supervisor request timed out", "startup_timeout"));
        // A timed-out startup handshake must not retain a live client socket.
        // The caller will either retry or tear down the newly spawned owner.
        this.socket?.destroy();
      }, remaining);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
    });
    try {
      socket.write(`${JSON.stringify({
        version: SUPERVISOR_PROTOCOL_VERSION, id, method, params, token: this.token,
      })}\n`);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return result;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: RpcReply;
      try { message = JSON.parse(line) as RpcReply; } catch { continue; }
      if (message.version !== SUPERVISOR_PROTOCOL_VERSION) {
        const error = new RemoteSupervisorError("supervisor protocol version mismatch", "unsupported_version");
        this.rejectAll(error);
        this.socket?.destroy();
        return;
      }
      if (message.method === "session.event" && message.params) {
        this.onEvent(message.params as SupervisorEvent);
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new RemoteSupervisorError(message.error?.message ?? "supervisor request failed", message.error?.code));
    }
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timeout) clearTimeout(entry.timeout);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, message: string): Promise<T> {
  if (timeoutMs === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new RemoteSupervisorError(message, "startup_timeout")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
}

function privateWrite(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

function privateMode(file: string): boolean {
  try { return (statSync(file).mode & 0o777) === 0o600; } catch { return false; }
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function readSupervisorManifest(file: string): StructuredSupervisorManifest | null {
  if (!privateMode(file)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const v = raw as Partial<StructuredSupervisorManifest>;
    if (
      v.version !== SUPERVISOR_MANIFEST_VERSION || v.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION ||
      v.implementation !== "supervisor" || typeof v.sessionId !== "string" || !SESSION_ID.test(v.sessionId) ||
      typeof v.agent !== "string" || typeof v.title !== "string" || typeof v.cwd !== "string" ||
      typeof v.createdAt !== "number" || typeof v.approvalPolicy !== "string" ||
      typeof v.socket !== "string" || v.tokenFile !== "token" || typeof v.lifecycleEpoch !== "string" ||
      (v.sessionDir !== undefined && (typeof v.sessionDir !== "string" || !path.isAbsolute(v.sessionDir)))
    ) return null;
    return v as StructuredSupervisorManifest;
  } catch {
    return null;
  }
}

function initialInfo(manifest: StructuredSupervisorManifest, hosting: StructuredHosting): SessionInfo {
  return {
    id: manifest.sessionId,
    agent: manifest.agent,
    kind: "structured",
    title: manifest.title,
    cwd: manifest.cwd,
    status: hosting === "unavailable" ? (manifest.status === "done" ? "done" : "died") : "starting",
    createdAt: manifest.createdAt,
    cols: 80,
    rows: 24,
    approvalPolicy: manifest.approvalPolicy,
    ...(manifest.accountId ? { accountId: manifest.accountId } : {}),
    ...(manifest.accountName ? { accountName: manifest.accountName } : {}),
  };
}

/**
 * A deliberately compatible subset/surface of StructuredSession.  All agent
 * work remains in the child; this object only keeps a replay cache for the WS
 * server and forwards normalized controls over authenticated local IPC.
 */
export class RemoteStructuredSession extends EventEmitter {
  readonly id: string;
  readonly agent: AgentKind;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly accountId: string | undefined;
  readonly accountName: string | undefined;
  readonly hosting: StructuredHosting;
  private rpc: SupervisorRpc | null = null;
  private infoValue: SessionInfo;
  private readonly log: AgentEventBody[] = [];
  private readonly pendingPermissions = new Set<string>();
  private readonly pendingQuestions = new Set<string>();
  private evSeq = 0;
  private disconnected = false;
  private infoRefreshTimer: NodeJS.Timeout | null = null;

  private constructor(private readonly manifest: StructuredSupervisorManifest, hosting: StructuredHosting) {
    super();
    this.id = manifest.sessionId;
    this.agent = manifest.agent;
    this.title = manifest.title;
    this.cwd = manifest.cwd;
    this.createdAt = manifest.createdAt;
    this.accountId = manifest.accountId;
    this.accountName = manifest.accountName;
    this.hosting = hosting;
    this.infoValue = initialInfo(manifest, hosting);
    if (hosting === "unavailable") this.loadReadonlyCache();
  }

  private loadReadonlyCache(): void {
    const file = path.join(this.ownerDir(), "session.json");
    if (!privateMode(file)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const state = raw as Partial<StructuredSessionPersistentState>;
      if (!Array.isArray(state.events) || typeof state.evSeq !== "number") return;
      this.log.push(...state.events.slice(-MAX_EVENTS));
      this.evSeq = Math.max(0, state.evSeq);
      this.rebuildPending();
      this.infoValue = {
        ...this.infoValue,
        ...(this.infoValue.status === "done" ? {} : { status: "died" }),
        ...(typeof state.preview === "string" && state.preview ? { preview: state.preview } : {}),
        ...(state.totals ? { totals: state.totals } : {}),
        ...(Array.isArray(state.messageQueue) ? {
          messageQueue: state.messageQueue.map((item) => ({
            id: item.id, text: item.displayText, kind: item.kind,
            createdAt: item.createdAt, attachmentCount: item.attachmentCount,
          })),
        } : {}),
      };
    } catch {
      // A damaged cache remains unavailable/read-only; do not overwrite it.
    }
  }

  static async attach(manifest: StructuredSupervisorManifest, timeoutMs?: number): Promise<RemoteStructuredSession> {
    const session = new RemoteStructuredSession(manifest, "supervisor");
    try {
      await session.reconnect(timeoutMs);
      return session;
    } catch (error) {
      // A launch retry must not leave an unauthenticated or timed-out facade
      // socket attached to the child supervisor.
      await session.dispose();
      throw error;
    }
  }

  static unavailable(manifest: StructuredSupervisorManifest): RemoteStructuredSession {
    return new RemoteStructuredSession(manifest, "unavailable");
  }

  private token(): string {
    const file = path.join(this.ownerDir(), this.manifest.tokenFile);
    if (!privateMode(file)) throw new RemoteSupervisorError("supervisor token file is missing or has unsafe mode");
    const token = readFileSync(file, "utf8").trim();
    if (!token) throw new RemoteSupervisorError("supervisor token is empty");
    return token;
  }

  /** The socket can be in /tmp while state/token remain in the 0700 owner directory. */
  private ownerDir(): string {
    return this.manifest.sessionDir ?? path.dirname(this.manifest.socket);
  }

  async reconnect(timeoutMs?: number): Promise<void> {
    if (this.hosting === "unavailable") throw new RemoteSupervisorError("supervisor is unavailable");
    this.rpc?.close();
    this.disconnected = false;
    let rpc: SupervisorRpc;
    rpc = new SupervisorRpc(
      this.manifest.socket,
      this.token(),
      (event) => this.acceptEvent(event),
      () => {
        // Ignore close notifications from the deliberately replaced client.
        if (this.rpc === rpc) this.disconnected = true;
      },
    );
    this.rpc = rpc;
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    const remaining = (): number | undefined => deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
    try {
      const replay = await this.rpc.request<{ events: SupervisorEvent[]; lastSeq: number; gap: boolean }>(
        "session.subscribe", { sessionId: this.id, afterSeq: this.evSeq }, remaining(),
      );
      if (replay.gap) {
        // A restart with compacted history must never claim a partial exact
        // replay.  The runner's full snapshot is the authoritative recovery.
        const snap = await this.call<{ events: AgentEventBody[]; evSeq: number }>("snapshot", {}, remaining());
        this.log.splice(0, this.log.length, ...snap.events.slice(-MAX_EVENTS));
        this.evSeq = snap.evSeq;
        this.rebuildPending();
      } else {
        for (const event of replay.events) this.acceptEvent(event);
      }
      await this.refreshInfo(remaining());
    } catch (error) {
      // reconnect() may be called after a temporary transport failure too;
      // leave it retryable, but never retain the failed socket or pending RPC.
      if (this.rpc === rpc) {
        this.rpc = null;
        this.disconnected = true;
        rpc.close();
      }
      throw error;
    }
  }

  private acceptEvent(event: SupervisorEvent): void {
    if (event.sessionId !== this.id || event.seq <= this.evSeq) return;
    // Sequences are durable and should be consecutive. A hole is repaired by
    // the next explicit reconnect/snapshot rather than inventing an event.
    if (event.seq !== this.evSeq + 1) {
      void this.reconnect().catch(() => { this.disconnected = true; });
      return;
    }
    this.evSeq = event.seq;
    this.log.push(event.body);
    if (this.log.length > MAX_EVENTS) this.log.shift();
    this.applyEventToInfo(event.body);
    this.emit("event", event.body, this.evSeq);
    this.scheduleInfoRefresh(
      event.body.kind !== "text.delta" && event.body.kind !== "reasoning.delta",
    );
  }

  private applyEventToInfo(body: AgentEventBody): void {
    const current = this.infoValue;
    let status = current.status;
    if (body.kind === "permission.request") {
      this.pendingPermissions.add(body.reqId);
      status = "waiting_approval";
    } else if (body.kind === "permission.resolved") {
      this.pendingPermissions.delete(body.reqId);
      if (this.pendingPermissions.size === 0 && status === "waiting_approval") {
        status = this.pendingQuestions.size > 0 ? "waiting_input" : "running";
      }
    } else if (body.kind === "question.request") {
      this.pendingQuestions.add(body.reqId);
      // A permission remains the stronger visible blocker, exactly as in the
      // runner-side StructuredSession reducer.
      if (this.pendingPermissions.size === 0) status = "waiting_input";
    } else if (body.kind === "question.resolved") {
      this.pendingQuestions.delete(body.reqId);
      if (this.pendingQuestions.size === 0 && status === "waiting_input") {
        status = this.pendingPermissions.size > 0 ? "waiting_approval" : "running";
      }
    } else if (
      (body.kind === "turn.end" || body.kind === "agent.error") &&
      body.agentId === undefined && this.pendingPermissions.size === 0 && this.pendingQuestions.size === 0
    ) {
      // A main-agent error is a recoverable completed turn, not a dead
      // session. Only explicit kill/orphan reconciliation reaches done/died.
      status = "completed";
    } else if (
      body.kind !== "tool.end" && body.kind !== "subagent.started" && body.kind !== "subagent.updated" &&
      body.agentId === undefined && (status === "idle" || status === "completed" || status === "starting")
    ) {
      status = "running";
    }
    const waiting = status === "running" || status === "waiting_approval" || status === "waiting_input";
    this.infoValue = {
      ...current,
      status,
      pendingPermissions: this.pendingPermissions.size,
      pendingQuestions: this.pendingQuestions.size,
      ...(waiting ? { busySince: current.busySince ?? Date.now() } : { busySince: undefined }),
    };
    this.emit("state", this.info());
  }

  private rebuildPending(): void {
    this.pendingPermissions.clear();
    this.pendingQuestions.clear();
    for (const body of this.log) {
      if (body.kind === "permission.request") this.pendingPermissions.add(body.reqId);
      else if (body.kind === "permission.resolved") this.pendingPermissions.delete(body.reqId);
      else if (body.kind === "question.request") this.pendingQuestions.add(body.reqId);
      else if (body.kind === "question.resolved") this.pendingQuestions.delete(body.reqId);
    }
  }

  private async call<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (!this.rpc || this.disconnected) throw new RemoteSupervisorError("supervisor client is disconnected");
    try {
      return await this.rpc.request<T>("session.call", { sessionId: this.id, method, params }, timeoutMs);
    } catch (error) { throw error; }
  }

  private async refreshInfo(timeoutMs?: number): Promise<void> {
    const info = await this.call<SessionInfo>("info", {}, timeoutMs);
    this.infoValue = info;
    this.emit("state", this.info());
  }

  /**
   * Runner state includes derived preview/totals/queue/subagent information
   * that cannot be reconstructed losslessly by the daemon facade. Streamed
   * deltas coalesce into one RPC; interaction and turn boundaries refresh at
   * once so UI state never claims completion while an approval is pending.
   */
  private scheduleInfoRefresh(immediate: boolean): void {
    if (!this.rpc || this.disconnected) return;
    if (immediate) {
      if (this.infoRefreshTimer) {
        clearTimeout(this.infoRefreshTimer);
        this.infoRefreshTimer = null;
      }
      void this.refreshInfo().catch(() => { /* normal daemon reconnect path */ });
      return;
    }
    if (this.infoRefreshTimer) return;
    this.infoRefreshTimer = setTimeout(() => {
      this.infoRefreshTimer = null;
      void this.refreshInfo().catch(() => { /* normal daemon reconnect path */ });
    }, INFO_REFRESH_MS);
    this.infoRefreshTimer.unref?.();
  }

  info(): SessionInfo { return { ...this.infoValue }; }
  get approvalPolicy(): ApprovalPolicy { return this.infoValue.approvalPolicy ?? this.manifest.approvalPolicy; }
  get resumeState(): AdapterResumeState { return {}; }

  snapshot(): { events: AgentEventBody[]; evSeq: number } {
    return { events: [...this.log], evSeq: this.evSeq };
  }
  transportSnapshot(): { events: AgentEventBody[]; evSeq: number } {
    return { events: compactAgentSnapshotEvents(this.log), evSeq: this.evSeq };
  }
  since(afterSeq: number): AgentEventBody[] | null {
    if (afterSeq > this.evSeq) return null;
    const oldest = this.evSeq - this.log.length + 1;
    if (afterSeq + 1 < oldest && afterSeq < this.evSeq) return null;
    return this.log.slice(Math.max(0, this.log.length - (this.evSeq - afterSeq)));
  }
  persistentState(): StructuredSessionPersistentState {
    return {
      version: 1, id: this.id, agent: this.agent, title: this.title, cwd: this.cwd,
      ...(this.accountId ? { accountId: this.accountId } : {}),
      ...(this.accountName ? { accountName: this.accountName } : {}),
      createdAt: this.createdAt, approvalPolicy: this.approvalPolicy, events: [...this.log], evSeq: this.evSeq,
      preview: this.infoValue.preview ?? "", previewRaw: "", previewMsgId: "", totals: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      toolOutputs: [], adapterState: {}, messageQueue: [],
      ...(this.hosting === "unavailable" ? { terminal: true as const } : {}),
    };
  }

  async start(): Promise<void> { await this.reconnect(); }
  async send(text: string, attachments?: Attachment[], delivery?: ChatDelivery): Promise<void> {
    const result = await this.call<{ info?: SessionInfo }>("send", { text, ...(attachments ? { attachments } : {}), ...(delivery ? { delivery } : {}) });
    if (result.info) this.infoValue = result.info;
    this.scheduleInfoRefresh(true);
  }
  async setApprovalPolicy(policy: ApprovalPolicy): Promise<void> {
    const result = await this.call<{ info?: SessionInfo }>("setApprovalPolicy", { policy });
    if (result.info) this.infoValue = result.info;
    this.emit("state", this.info());
    this.scheduleInfoRefresh(true);
  }
  complete(kind: ChatSuggestionKind, query: string): Promise<ChatSuggestion[]> { return completeComposer(this.cwd, kind, query); }
  models(): Promise<AgentModelCatalog> { return this.call("models", {}); }
  async setModel(model: string, effort?: string): Promise<AgentModelSelection> {
    const selection = await this.call<AgentModelSelection>("setModel", { model, ...(effort ? { effort } : {}) });
    this.scheduleInfoRefresh(true);
    return selection;
  }
  modes(): Promise<AgentModeCatalog> { return this.call("modes", {}); }
  async setMode(mode: string): Promise<AgentModeSelection> {
    const selection = await this.call<AgentModeSelection>("setMode", { mode });
    this.scheduleInfoRefresh(true);
    return selection;
  }
  async compact(): Promise<void> { await this.call("compact", {}); this.scheduleInfoRefresh(true); }
  toolOutput(callId: string): { output: string; truncated: boolean } | null {
    // Tool output is deliberately read from the supervisor-owned, 0600 state
    // file. WS needs this synchronous method and the file is a bounded cache
    // written by StructuredSession itself; never read daemon-provided paths.
    const file = path.join(this.ownerDir(), "session.json");
    if (!privateMode(file)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const values = (parsed as { toolOutputs?: unknown }).toolOutputs;
      if (!Array.isArray(values)) return null;
      const match = values.find((entry): entry is [string, string] =>
        Array.isArray(entry) && entry[0] === callId && typeof entry[1] === "string",
      );
      if (!match) return null;
      const output = match[1];
      const max = 200_000;
      return output.length > max ? { output: output.slice(0, max), truncated: true } : { output, truncated: false };
    } catch { return null; }
  }
  async attachmentChunk(msgId: string, attachmentId: string, offset: number, length: number): Promise<{ data: Buffer; total: number; eof: boolean; mimeType: Attachment["mimeType"] } | null> {
    const result = await this.call<{ dataB64: string; total: number; eof: boolean; mimeType: Attachment["mimeType"] } | null>("attachmentChunk", { msgId, attachmentId, offset, length });
    return result ? { ...result, data: Buffer.from(result.dataB64, "base64") } : null;
  }
  async usage(): Promise<UsageReport | null> { return this.call("usage", {}); }
  async respondPermission(reqId: string, reply: PermissionReply): Promise<void> { await this.call("respondPermission", { reqId, reply }); this.scheduleInfoRefresh(true); }
  async respondQuestion(reqId: string, answers: AgentQuestionAnswer[], cancelled = false): Promise<void> { await this.call("respondQuestion", { reqId, answers, cancelled }); this.scheduleInfoRefresh(true); }
  async sendToSubagent(subagentId: string, text: string): Promise<void> { await this.call("sendToSubagent", { subagentId, text }); this.scheduleInfoRefresh(true); }
  subagentSnapshot(subagentId: string): Promise<{ subagent: SubagentInfo; events: AgentEventBody[]; evSeq: number }> { return this.call("subagentSnapshot", { subagentId }); }
  async removeQueued(queueId: string): Promise<boolean> {
    const removed = await this.call<boolean>("removeQueued", { queueId });
    this.scheduleInfoRefresh(true);
    return removed;
  }
  async guideQueued(queueId: string): Promise<boolean> {
    const guided = await this.call<boolean>("guideQueued", { queueId });
    this.scheduleInfoRefresh(true);
    return guided;
  }
  async interrupt(): Promise<void> {
    if (!this.rpc) throw new RemoteSupervisorError("supervisor client is disconnected");
    await this.rpc.request("session.interrupt", { sessionId: this.id });
  }
  /** Explicit user kill; unlike dispose(), this ends the native adapter and runner. */
  async kill(): Promise<void> {
    if (!this.rpc) throw new RemoteSupervisorError("supervisor client is disconnected");
    await this.rpc.request("session.kill", { sessionId: this.id });
    if (this.infoRefreshTimer) clearTimeout(this.infoRefreshTimer);
    this.infoRefreshTimer = null;
    this.infoValue = { ...this.infoValue, status: "done" };
    this.emit("state", this.info());
    this.rpc.close();
    this.disconnected = true;
  }
  /** Daemon shutdown only drops this client connection. */
  async dispose(): Promise<void> {
    if (this.infoRefreshTimer) clearTimeout(this.infoRefreshTimer);
    this.infoRefreshTimer = null;
    this.rpc?.close();
    this.disconnected = true;
  }
}

export interface LaunchStructuredSupervisorInput {
  root: string;
  sessionId: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  createdAt: number;
  approvalPolicy?: ApprovalPolicy;
  environment: Record<string, string>;
  codexAppServerArgs?: string[];
  accountId?: string;
  accountName?: string;
  initialAdapterState?: AdapterResumeState;
  /** Test seam for a bounded startup failure; production uses eight seconds. */
  startupTimeoutMs?: number;
}

function runnerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sameDir = path.join(here, "structured-supervisor-runner.js");
  if (existsSync(sameDir)) return sameDir;
  return path.resolve(here, "../dist/structured-supervisor-runner.js");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A negative PID addresses exactly the detached process group created by spawn(). */
function processGroupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalProcessGroup(groupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-groupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(groupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(groupId) && Date.now() < deadline) await delay(20);
  return !processGroupAlive(groupId);
}

/**
 * Rollback has one authority boundary: the process group whose leader was
 * returned by this exact detached spawn. It never consults manifests or scans
 * PIDs, so an already-running/reconnected supervisor cannot be selected here.
 */
interface SupervisorGroupTermination {
  /** Whether the launcher has positively established that its own group is gone. */
  exited: boolean;
  errors: Error[];
}

function cleanupError(stage: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new RemoteSupervisorError(`${stage}: ${detail}`, "cleanup_failed");
}

/**
 * Attempt every escalation step against only the exact process group returned
 * by this launch.  A failure to signal or wait is diagnostic, not permission
 * to abandon the remaining rollback work.
 */
async function terminateNewSupervisorGroup(
  groupId: number | undefined,
  spawnAttempted: boolean,
): Promise<SupervisorGroupTermination> {
  // When spawn threw before returning a ChildProcess, there is no owner that
  // could have bound the launch-owned endpoint.  If spawn did return but no
  // safe PID was available, retain the endpoint: guessing a PID would violate
  // the rollback authority boundary.
  if (!spawnAttempted) return { exited: true, errors: [] };
  if (!groupId || !Number.isSafeInteger(groupId) || groupId <= 1) {
    return {
      exited: false,
      errors: [new RemoteSupervisorError("new supervisor process group was not identified during launch rollback", "cleanup_failed")],
    };
  }
  if (!processGroupAlive(groupId)) return { exited: true, errors: [] };

  const errors: Error[] = [];
  try {
    signalProcessGroup(groupId, "SIGTERM");
  } catch (error) {
    errors.push(cleanupError("failed to SIGTERM new supervisor process group", error));
  }
  try {
    if (await waitForProcessGroupExit(groupId, SUPERVISOR_TERM_GRACE_MS)) return { exited: true, errors };
  } catch (error) {
    errors.push(cleanupError("failed while waiting for new supervisor process group after SIGTERM", error));
  }

  // Still address the same negative PID even if TERM or its wait failed.
  try {
    signalProcessGroup(groupId, "SIGKILL");
  } catch (error) {
    errors.push(cleanupError("failed to SIGKILL new supervisor process group", error));
  }
  try {
    if (await waitForProcessGroupExit(groupId, SUPERVISOR_KILL_GRACE_MS)) return { exited: true, errors };
  } catch (error) {
    errors.push(cleanupError("failed while waiting for new supervisor process group after SIGKILL", error));
  }

  if (!processGroupAlive(groupId)) return { exited: true, errors };
  errors.push(new RemoteSupervisorError("new supervisor process group did not exit during launch rollback", "cleanup_failed"));
  return { exited: false, errors };
}

/** Only the launcher's exact random endpoint is considered; ordinary files are never unlinked. */
function removeNewSupervisorSocket(socketPath: string, socketDir: string): void {
  // socketDir was atomically allocated by mkdtempSync for this launch. Do not
  // unlink a socket merely because its pathname happens to look familiar.
  if (path.dirname(socketPath) !== socketDir) return;
  try {
    if (lstatSync(socketPath).isSocket()) rmSync(socketPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const metadata = lstatSync(socketDir);
    if (metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o700) {
      rmdirSync(socketDir);
    }
  } catch (error) {
    // A non-empty/changed private directory is retained rather than deleted.
    // Its one exact socket has already been removed above.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const spawned = () => {
      child.off("error", failed);
      resolve();
    };
    const failed = (error: Error) => {
      child.off("spawn", spawned);
      reject(error);
    };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
}

export interface FailedStructuredSupervisorLaunch {
  groupId: number | undefined;
  /** True once detached spawn returned; an absent PID is then unsafe to guess. */
  spawnAttempted: boolean;
  bootstrap: string | undefined;
  socketPath: string;
  socketDir: string;
  manifestFile: string;
  manifest: StructuredSupervisorManifest;
}

export interface FailedStructuredSupervisorLaunchRollback {
  groupExited: boolean;
  /** Every failed cleanup step, retained without replacing the launch error. */
  errors: Error[];
}

/** Test-only dependency seam for exceptional rollback branches. */
export interface FailedStructuredSupervisorLaunchRollbackOperations {
  terminateGroup(input: Pick<FailedStructuredSupervisorLaunch, "groupId" | "spawnAttempted">): Promise<SupervisorGroupTermination>;
  removeBootstrap(bootstrap: string): void;
  removeSocket(socketPath: string, socketDir: string): void;
  readManifest(manifestFile: string): StructuredSupervisorManifest | null;
  writeManifest(manifestFile: string, manifest: StructuredSupervisorManifest): void;
}

const rollbackOperations: FailedStructuredSupervisorLaunchRollbackOperations = {
  terminateGroup: ({ groupId, spawnAttempted }) => terminateNewSupervisorGroup(groupId, spawnAttempted),
  removeBootstrap: (bootstrap) => rmSync(bootstrap, { force: true }),
  removeSocket: removeNewSupervisorSocket,
  readManifest: readSupervisorManifest,
  writeManifest: privateWrite,
};

/**
 * Run every independently-safe rollback action.  The transient bootstrap is
 * always attempted because it can contain account credentials.  In contrast,
 * the socket/runtime directory is left alone until the exact launch group is
 * known to be gone, so a failed rollback cannot affect a live owner.
 */
export async function rollbackFailedStructuredSupervisorLaunch(
  failedLaunch: FailedStructuredSupervisorLaunch,
  overrides: Partial<FailedStructuredSupervisorLaunchRollbackOperations> = {},
): Promise<FailedStructuredSupervisorLaunchRollback> {
  const operations = { ...rollbackOperations, ...overrides };
  const errors: Error[] = [];
  let groupExited = false;

  try {
    const termination = await operations.terminateGroup(failedLaunch);
    groupExited = termination.exited;
    errors.push(...termination.errors);
  } catch (error) {
    errors.push(cleanupError("failed to terminate new supervisor process group", error));
  }

  // Do this even when signaling, waiting, or manifest preservation failed.
  if (failedLaunch.bootstrap) {
    try {
      operations.removeBootstrap(failedLaunch.bootstrap);
    } catch (error) {
      errors.push(cleanupError("failed to remove launch bootstrap", error));
    }
  }

  if (groupExited) {
    try {
      operations.removeSocket(failedLaunch.socketPath, failedLaunch.socketDir);
    } catch (error) {
      errors.push(cleanupError("failed to remove launch socket/runtime directory", error));
    }
  } else {
    errors.push(new RemoteSupervisorError(
      "new supervisor process group was not confirmed exited; retained launch socket/runtime directory",
      "cleanup_failed",
    ));
  }

  // Keep the private directory and manifest as a read-only audit record. A
  // later daemon restart exposes it as died history and never relaunches it.
  try {
    const latest = operations.readManifest(failedLaunch.manifestFile) ?? failedLaunch.manifest;
    operations.writeManifest(failedLaunch.manifestFile, { ...latest, status: "died", updatedAt: Date.now() });
  } catch (error) {
    errors.push(cleanupError("failed to preserve failed launch manifest", error));
  }

  return { groupExited, errors };
}

function addRollbackDiagnostics(original: unknown, rollback: FailedStructuredSupervisorLaunchRollback): Error {
  const primary = original instanceof Error ? original : new Error(String(original));
  if (rollback.errors.length === 0) return primary;
  // Preserve the original error (and RemoteSupervisorError.code) as the
  // rejection.  Cleanup diagnostics are aggregate metadata for logs/tests,
  // rather than a replacement error which would hide the real launch failure.
  Object.defineProperty(primary, "rollbackErrors", {
    configurable: true,
    value: new AggregateError(rollback.errors, "supervisor launch rollback encountered cleanup failures"),
  });
  return primary;
}

export async function launchStructuredSupervisor(input: LaunchStructuredSupervisorInput): Promise<RemoteStructuredSession> {
  if (process.platform === "win32") throw new RemoteSupervisorError("structured supervisor requires Unix", "unsupported_platform");
  if (!SESSION_ID.test(input.sessionId)) throw new RemoteSupervisorError("invalid session id", "bad_request");
  const startupTimeoutMs = input.startupTimeoutMs ?? SUPERVISOR_STARTUP_TIMEOUT_MS;
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) {
    throw new RemoteSupervisorError("invalid supervisor startup timeout", "bad_request");
  }
  mkdirSync(input.root, { recursive: true, mode: 0o700 });
  chmodSync(input.root, 0o700);
  const sessionDir = path.join(input.root, input.sessionId);
  if (existsSync(sessionDir)) throw new RemoteSupervisorError("supervisor session directory already exists", "session_exists");
  mkdirSync(sessionDir, { mode: 0o700 });
  chmodSync(sessionDir, 0o700);
  const token = randomBytes(32).toString("base64url");
  const tokenPath = path.join(sessionDir, "token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  // macOS has a short Unix-domain socket path limit. A compact leaf inside a
  // long `~/.prospero/.../<uuid>` directory is still too long *to reconnect*
  // from the daemon: binding after runner chdir works, but the manifest's
  // absolute endpoint later fails with EINVAL.  Use a random 0700 directory
  // and a 0600 socket in sticky /tmp instead. The atomically-created parent
  // proves this launch owns the exact endpoint even in the vanishingly rare
  // nonce-collision case; the socket itself is chmod 0600 by the transport.
  // `/tmp` is intentionally literal rather than os.tmpdir(), which is often
  // another long per-user path on macOS.
  const socketDir = mkdtempSync("/tmp/prospero-supervisor-");
  chmodSync(socketDir, 0o700);
  const socketPath = path.join(socketDir, "s.sock");
  const manifest: StructuredSupervisorManifest = {
    version: SUPERVISOR_MANIFEST_VERSION, protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    implementation: "supervisor", sessionId: input.sessionId, agent: input.agent, title: input.title,
    cwd: input.cwd, createdAt: input.createdAt, approvalPolicy: input.approvalPolicy ?? "standard",
    socket: socketPath, tokenFile: "token", sessionDir, lifecycleEpoch: randomUUID(), status: "starting",
    ...(input.accountId ? { accountId: input.accountId } : {}), ...(input.accountName ? { accountName: input.accountName } : {}),
  };
  const manifestFile = path.join(sessionDir, "manifest.json");
  let bootstrap: string | undefined;
  let groupId: number | undefined;
  let spawnAttempted = false;
  try {
    privateWrite(manifestFile, manifest);
    const bootstrapFile = path.join(sessionDir, `.bootstrap-${randomBytes(8).toString("hex")}.json`);
    bootstrap = bootstrapFile;
    privateWrite(bootstrapFile, {
      version: 1, sessionId: input.sessionId, agent: input.agent, title: input.title, cwd: input.cwd,
      createdAt: input.createdAt, approvalPolicy: input.approvalPolicy, sessionDir,
      attachmentRoot: path.join(sessionDir, "attachments"), socketPath, socketDir, environment: input.environment,
      ...(input.codexAppServerArgs ? { codexAppServerArgs: input.codexAppServerArgs } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}), ...(input.accountName ? { accountName: input.accountName } : {}),
      ...(input.initialAdapterState ? { initialAdapterState: input.initialAdapterState } : {}),
    });
    const child = spawn(process.execPath, [runnerPath()], {
      detached: true, stdio: "ignore", cwd: sessionDir,
      // Do not inherit the daemon environment: account credentials travel only
      // in the 0600 bootstrap file and never through argv or daemon logs.
      env: {
        PATH: process.env["PATH"] ?? "",
        // Native CLIs/SDKs use these operational values before their adapter
        // context is applied. Credentials are intentionally absent here.
        HOME: process.env["HOME"] ?? "",
        TMPDIR: process.env["TMPDIR"] ?? "/tmp",
        LANG: process.env["LANG"] ?? "en_US.UTF-8",
        LC_ALL: process.env["LC_ALL"] ?? "",
        SHELL: process.env["SHELL"] ?? "/bin/sh",
        USER: process.env["USER"] ?? "",
        TERM: process.env["TERM"] ?? "xterm-256color",
        COLORTERM: process.env["COLORTERM"] ?? "truecolor",
        ...(process.env["XDG_RUNTIME_DIR"] ? { XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"] } : {}),
        ...(process.env["XDG_CONFIG_HOME"] ? { XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] } : {}),
        ...(process.env["XDG_CACHE_HOME"] ? { XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"] } : {}),
        ...(process.env["SSH_AUTH_SOCK"] ? { SSH_AUTH_SOCK: process.env["SSH_AUTH_SOCK"] } : {}),
        PROSPERO_STRUCTURED_SUPERVISOR_CONFIG: bootstrapFile,
      },
    });
    spawnAttempted = true;
    // If Node fails before the runner consumes it, do not leave account
    // environment data in a bootstrap file. Normal startup removes it itself.
    child.once("exit", () => {
      try { rmSync(bootstrapFile, { force: true }); }
      // Launch rollback will make another best-effort exact-path attempt and
      // retain its error diagnostics; an exit-event callback must not throw.
      catch { /* handled by the rollback path when launch did not succeed */ }
    });
    await waitForSpawn(child);
    if (!child.pid || !Number.isSafeInteger(child.pid) || child.pid <= 1) {
      throw new RemoteSupervisorError("supervisor spawn returned no process id", "spawn_failed");
    }
    groupId = child.pid;
    child.unref();
    // The runner may become ready unusually fast; preserve any status update it
    // wrote instead of racing it back to "starting" from the launch template.
    const latestManifest = readSupervisorManifest(manifestFile) ?? manifest;
    privateWrite(manifestFile, { ...latestManifest, supervisorPid: groupId, updatedAt: Date.now() });
    const readyManifest = readSupervisorManifest(manifestFile);
    if (!readyManifest) throw new RemoteSupervisorError("failed to write supervisor manifest");
    const deadline = Date.now() + startupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      try {
        return await RemoteStructuredSession.attach(
          readyManifest,
          Math.min(SUPERVISOR_ATTACH_ATTEMPT_TIMEOUT_MS, remaining),
        );
      } catch (error) {
        lastError = error;
        if (Date.now() < deadline) await delay(Math.min(40, Math.max(1, deadline - Date.now())));
      }
    }
    throw new RemoteSupervisorError(`supervisor did not become ready: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
  } catch (error) {
    const rollback = await rollbackFailedStructuredSupervisorLaunch({
      groupId, spawnAttempted, bootstrap, socketPath, socketDir, manifestFile, manifest,
    });
    throw addRollbackDiagnostics(error, rollback);
  }
}

/** Scan only private per-session directories; never launch a replacement here. */
export async function reconnectStructuredSupervisors(root: string): Promise<RemoteStructuredSession[]> {
  if (process.platform === "win32" || !existsSync(root)) return [];
  const sessions: RemoteStructuredSession[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      if ((lstatSync(dir).mode & 0o777) !== 0o700) continue;
    } catch { continue; }
    const manifest = readSupervisorManifest(path.join(dir, "manifest.json"));
    if (!manifest || manifest.sessionId !== entry.name) continue;
    // A dead PID, stale socket or protocol mismatch is historical/read-only.
    // Crucially this path does not call the launcher, preventing duplicate turns.
    const withOwnerDir = { ...manifest, sessionDir: dir };
    // A failed-launch/explicitly-ended audit is permanently read-only.  Even
    // if rollback could not confirm process exit, a later daemon must never
    // attach the owner of a create() call that already returned failure.
    if (
      manifest.status === "died" || manifest.status === "done" ||
      !processAlive(manifest.supervisorPid) ||
      !privateMode(path.join(dir, "token")) ||
      !privateMode(manifest.socket)
    ) {
      sessions.push(RemoteStructuredSession.unavailable(withOwnerDir));
      continue;
    }
    try { sessions.push(await RemoteStructuredSession.attach(withOwnerDir)); }
    catch { sessions.push(RemoteStructuredSession.unavailable(withOwnerDir)); }
  }
  return sessions;
}
