/** Daemon-side launcher and reconnectable facade for one structured session. */
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
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
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly onEvent: (event: SupervisorEvent) => void,
    private readonly onDisconnect: () => void,
  ) {}

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    const socket = createConnection(this.socketPath);
    try {
      await once(socket, "connect");
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

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) throw new RemoteSupervisorError("supervisor socket unavailable");
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject }));
    socket.write(`${JSON.stringify({
      version: SUPERVISOR_PROTOCOL_VERSION, id, method, params, token: this.token,
    })}\n`);
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
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new RemoteSupervisorError(message.error?.message ?? "supervisor request failed", message.error?.code));
    }
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
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

  static async attach(manifest: StructuredSupervisorManifest): Promise<RemoteStructuredSession> {
    const session = new RemoteStructuredSession(manifest, "supervisor");
    await session.reconnect();
    return session;
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

  async reconnect(): Promise<void> {
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
    const replay = await this.rpc.request<{ events: SupervisorEvent[]; lastSeq: number; gap: boolean }>(
      "session.subscribe", { sessionId: this.id, afterSeq: this.evSeq },
    );
    if (replay.gap) {
      // A restart with compacted history must never claim a partial exact
      // replay.  The runner's full snapshot is the authoritative recovery.
      const snap = await this.call<{ events: AgentEventBody[]; evSeq: number }>("snapshot", {});
      this.log.splice(0, this.log.length, ...snap.events.slice(-MAX_EVENTS));
      this.evSeq = snap.evSeq;
      this.rebuildPending();
    } else {
      for (const event of replay.events) this.acceptEvent(event);
    }
    await this.refreshInfo();
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

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.rpc || this.disconnected) throw new RemoteSupervisorError("supervisor client is disconnected");
    try {
      return await this.rpc.request<T>("session.call", { sessionId: this.id, method, params });
    } catch (error) { throw error; }
  }

  private async refreshInfo(): Promise<void> {
    const info = await this.call<SessionInfo>("info", {});
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
}

function runnerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sameDir = path.join(here, "structured-supervisor-runner.js");
  if (existsSync(sameDir)) return sameDir;
  return path.resolve(here, "../dist/structured-supervisor-runner.js");
}

export async function launchStructuredSupervisor(input: LaunchStructuredSupervisorInput): Promise<RemoteStructuredSession> {
  if (process.platform === "win32") throw new RemoteSupervisorError("structured supervisor requires Unix", "unsupported_platform");
  if (!SESSION_ID.test(input.sessionId)) throw new RemoteSupervisorError("invalid session id", "bad_request");
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
  // absolute endpoint later fails with EINVAL.  Use a random, 0600 socket in
  // sticky /tmp instead. Its unguessable name remains private through the
  // 0600 manifest/token; the socket itself is chmod 0600 by the transport.
  // `/tmp` is intentionally literal rather than os.tmpdir(), which is often
  // another long per-user path on macOS.
  const socketPath = path.join("/tmp", `prospero-supervisor-${randomBytes(12).toString("hex")}.sock`);
  const manifest: StructuredSupervisorManifest = {
    version: SUPERVISOR_MANIFEST_VERSION, protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    implementation: "supervisor", sessionId: input.sessionId, agent: input.agent, title: input.title,
    cwd: input.cwd, createdAt: input.createdAt, approvalPolicy: input.approvalPolicy ?? "standard",
    socket: socketPath, tokenFile: "token", sessionDir, lifecycleEpoch: randomUUID(), status: "starting",
    ...(input.accountId ? { accountId: input.accountId } : {}), ...(input.accountName ? { accountName: input.accountName } : {}),
  };
  privateWrite(path.join(sessionDir, "manifest.json"), manifest);
  const bootstrap = path.join(sessionDir, `.bootstrap-${randomBytes(8).toString("hex")}.json`);
  privateWrite(bootstrap, {
    version: 1, sessionId: input.sessionId, agent: input.agent, title: input.title, cwd: input.cwd,
    createdAt: input.createdAt, approvalPolicy: input.approvalPolicy, sessionDir,
    attachmentRoot: path.join(sessionDir, "attachments"), socketPath, environment: input.environment,
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
      PROSPERO_STRUCTURED_SUPERVISOR_CONFIG: bootstrap,
    },
  });
  // If Node fails before the runner consumes it, do not leave account
  // environment data in a bootstrap file. Normal startup removes it itself.
  child.once("exit", () => rmSync(bootstrap, { force: true }));
  child.unref();
  // The runner may become ready unusually fast; preserve any status update it
  // wrote instead of racing it back to "starting" from the launch template.
  const latestManifest = readSupervisorManifest(path.join(sessionDir, "manifest.json")) ?? manifest;
  privateWrite(path.join(sessionDir, "manifest.json"), { ...latestManifest, supervisorPid: child.pid, updatedAt: Date.now() });
  const readyManifest = readSupervisorManifest(path.join(sessionDir, "manifest.json"));
  if (!readyManifest) throw new RemoteSupervisorError("failed to write supervisor manifest");
  const deadline = Date.now() + 8_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { return await RemoteStructuredSession.attach(readyManifest); }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 40)); }
  }
  rmSync(bootstrap, { force: true });
  throw new RemoteSupervisorError(`supervisor did not become ready: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
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
    if (!processAlive(manifest.supervisorPid) || !privateMode(path.join(dir, "token")) || !privateMode(manifest.socket)) {
      sessions.push(RemoteStructuredSession.unavailable(withOwnerDir));
      continue;
    }
    try { sessions.push(await RemoteStructuredSession.attach(withOwnerDir)); }
    catch { sessions.push(RemoteStructuredSession.unavailable(withOwnerDir)); }
  }
  return sessions;
}
