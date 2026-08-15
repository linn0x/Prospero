/** Daemon-side durable facade for structured Windows Session Hosts. */
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { EventEmitter } from "node:events";
import { SessionInfoSchema } from "@prospero/protocol";
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
  WindowsSessionHostClientError,
  attachWindowsSessionHost,
} from "./windows-session-host-client.js";
import {
  parseWindowsSessionHostManifest,
  processIdentityEquals,
  WindowsSessionHostJournal,
  WindowsSessionHostUnavailable,
  type SessionHostReply,
  type SessionHostReplayReply,
  type WindowsSessionHostManifest,
} from "./windows-session-host-protocol.js";
import {
  launchDetachedWindowsSessionHost,
  type LaunchDetachedWindowsSessionHostOptions,
} from "./windows-session-host-runner.js";
import { WindowsSessionHostNativeWorker } from "./windows-session-host-native.js";
import { WINDOWS_STRUCTURED_READ_ONLY_METHODS, type WindowsStructuredHostBootstrap } from "./windows-structured-session-host.js";

const REGISTRY_RECORD_PREFIX = "structured-session-";
const REGISTRY_RECORD_SUFFIX = ".json";
const LEGACY_REGISTRY_FILE = "windows-structured-hosts.json";
const MAX_EVENTS = 4_000;
const MAX_TOOL_OUTPUT = 200_000;
const MAX_TOOL_ENTRIES = 200;
const MAX_MESSAGE_QUEUE = 50;
const MAX_MESSAGE_QUEUE_BYTES = 512 * 1024;
const MAX_ADAPTER_STATE_BYTES = 256 * 1024;
const MAX_PERSISTENT_STATE_BYTES = 4 * 1024 * 1024;
const POLL_MS = 250;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

export interface WindowsStructuredSessionManifest {
  readonly schemaVersion: 1;
  readonly implementation: "windows-structured-session-host";
  readonly sessionId: string;
  readonly agent: AgentKind;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly approvalPolicy: ApprovalPolicy;
  readonly registryDirectory: string;
  readonly host: WindowsSessionHostManifest;
  readonly accountId?: string;
  readonly accountName?: string;
  readonly status: "active" | "terminal" | "unavailable";
}

/**
 * A launch intent is published before a detached host is started.  It is a
 * per-session file, so concurrent launches cannot lose unrelated sessions in
 * a global read-modify-write registry.  An interrupted intent is deliberately
 * never a license to launch a replacement owner.
 */
interface PendingWindowsStructuredSessionRecord {
  readonly schemaVersion: 1;
  readonly implementation: "windows-structured-session-host-pending";
  readonly sessionId: string;
  readonly epoch: string;
  readonly agent: AgentKind;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly approvalPolicy: ApprovalPolicy;
  readonly registryDirectory: string;
  readonly stateDirectory: string;
  readonly accountId?: string;
  readonly accountName?: string;
  readonly status: "launching";
}

type WindowsStructuredSessionRecord = WindowsStructuredSessionManifest | PendingWindowsStructuredSessionRecord;

export interface LaunchWindowsStructuredSessionInput {
  readonly root: string;
  readonly sessionId: string;
  readonly agent: AgentKind;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly environment: Record<string, string>;
  readonly codexAppServerArgs?: readonly string[];
  readonly accountId?: string;
  readonly accountName?: string;
  readonly initialAdapterState?: AdapterResumeState;
  /** Tests can use a fake detached runner without weakening production IPC. */
  readonly runnerEntryPath?: string;
}

interface SessionHostFacade {
  acquireMutationLease(): Promise<string>;
  command(method: string, params: unknown, mutation: boolean, commandId?: string): Promise<unknown>;
  replay(afterSeq?: number): Promise<SessionHostReplayReply>;
  dispose(): Promise<void>;
}

type AttachHost = (manifest: WindowsSessionHostManifest) => Promise<SessionHostFacade>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAgent(value: unknown): value is AgentKind {
  return value === "claude" || value === "codex" || value === "opencode" || value === "grok";
}

function isPolicy(value: unknown): value is ApprovalPolicy {
  return value === "strict" || value === "standard" || value === "yolo";
}

function parseManifest(value: unknown): WindowsStructuredSessionManifest | null {
  const keys = ["schemaVersion", "implementation", "sessionId", "agent", "title", "cwd", "createdAt", "approvalPolicy", "registryDirectory", "host", "accountId", "accountName", "status"];
  if (!isRecord(value) || !Object.keys(value).every((key) => keys.includes(key)) || value["schemaVersion"] !== 1 || value["implementation"] !== "windows-structured-session-host" ||
    typeof value["sessionId"] !== "string" || !SESSION_ID.test(value["sessionId"]) || !isAgent(value["agent"]) ||
    typeof value["title"] !== "string" || typeof value["cwd"] !== "string" ||
    typeof value["createdAt"] !== "number" || !Number.isFinite(value["createdAt"]) || !isPolicy(value["approvalPolicy"]) ||
    typeof value["registryDirectory"] !== "string" || !isRecord(value["host"]) ||
    (value["accountId"] !== undefined && typeof value["accountId"] !== "string") ||
    (value["accountName"] !== undefined && typeof value["accountName"] !== "string") ||
    (value["status"] !== "active" && value["status"] !== "terminal" && value["status"] !== "unavailable")) return null;
  try {
    // The common manifest parser is intentionally the authority for native
    // ABI, owner PID+FILETIME, and pipe-name validation.
    const host = parseWindowsSessionHostManifest(value["host"]);
    if (host.sessionId !== value["sessionId"]) return null;
    return { ...value, host } as unknown as WindowsStructuredSessionManifest;
  } catch { return null; }
}

function parsePendingRecord(value: unknown): PendingWindowsStructuredSessionRecord | null {
  const keys = ["schemaVersion", "implementation", "sessionId", "epoch", "agent", "title", "cwd", "createdAt", "approvalPolicy", "registryDirectory", "stateDirectory", "accountId", "accountName", "status"];
  if (!isRecord(value) || !Object.keys(value).every((key) => keys.includes(key)) ||
    value["schemaVersion"] !== 1 || value["implementation"] !== "windows-structured-session-host-pending" ||
    typeof value["sessionId"] !== "string" || !SESSION_ID.test(value["sessionId"]) || typeof value["epoch"] !== "string" ||
    !isAgent(value["agent"]) || typeof value["title"] !== "string" || typeof value["cwd"] !== "string" ||
    typeof value["createdAt"] !== "number" || !Number.isFinite(value["createdAt"]) || !isPolicy(value["approvalPolicy"]) ||
    typeof value["registryDirectory"] !== "string" || typeof value["stateDirectory"] !== "string" || value["status"] !== "launching" ||
    (value["accountId"] !== undefined && typeof value["accountId"] !== "string") ||
    (value["accountName"] !== undefined && typeof value["accountName"] !== "string")) return null;
  return value as unknown as PendingWindowsStructuredSessionRecord;
}

function registryDirectory(root: string): string {
  return path.join(root, "windows-structured-session-registry");
}

function hostDirectory(root: string, sessionId: string): string {
  return path.join(root, `windows-structured-session-${sessionId}`);
}

function registryRecordName(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows structured Session Host session id is invalid");
  return `${REGISTRY_RECORD_PREFIX}${sessionId}${REGISTRY_RECORD_SUFFIX}`;
}

async function readRegistryRecords(root: string): Promise<WindowsStructuredSessionRecord[]> {
  const native = await WindowsSessionHostNativeWorker.create();
  try {
    await native.openState(registryDirectory(root));
    const names = await native.list();
    const records: WindowsStructuredSessionRecord[] = [];
    const seen = new Set<string>();
    for (const name of names.filter((entry) => entry.startsWith(REGISTRY_RECORD_PREFIX) && entry.endsWith(REGISTRY_RECORD_SUFFIX))) {
      const bytes = await native.read(name);
      if (bytes === null) continue; // concurrent deletion/rotation; never invent a replacement.
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows structured Session Host record JSON is invalid"); }
      const record = parseManifest(raw) ?? parsePendingRecord(raw);
      if (!record) throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows structured Session Host record is invalid");
      if (registryRecordName(record.sessionId) !== name) {
        throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows structured Session Host record name does not match its session");
      }
      if (record.registryDirectory !== registryDirectory(root) ||
        (record.status === "launching" ? record.stateDirectory : record.host.stateDirectory) !== hostDirectory(root, record.sessionId)) {
        throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows structured Session Host record escaped its secure owner path");
      }
      if (seen.has(record.sessionId)) throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows structured Session Host records are duplicated");
      seen.add(record.sessionId);
      records.push(record);
    }
    // Upgrade compatibility only: old owners remain discoverable, but this
    // code never updates the legacy aggregate file (the RMW lost-entry bug).
    const legacyBytes = await native.read(LEGACY_REGISTRY_FILE);
    if (legacyBytes !== null) {
      let legacy: unknown;
      try { legacy = JSON.parse(new TextDecoder().decode(legacyBytes)); }
      catch { throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows legacy structured Session Host registry JSON is invalid"); }
      if (!isRecord(legacy) || legacy["schemaVersion"] !== 1 || legacy["implementation"] !== "windows-structured-session-host-registry" || !Array.isArray(legacy["sessions"])) {
        throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows legacy structured Session Host registry is invalid");
      }
      for (const raw of legacy["sessions"]) {
        const record = parseManifest(raw);
        if (!record) throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows legacy structured Session Host record is invalid");
        if (record.registryDirectory !== registryDirectory(root) || record.host.stateDirectory !== hostDirectory(root, record.sessionId)) {
          throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows legacy structured Session Host record escaped its secure owner path");
        }
        if (!seen.has(record.sessionId)) {
          seen.add(record.sessionId);
          records.push(record);
        }
      }
    }
    return records;
  } finally { await native.close(); }
}

async function writeRegistryRecord(root: string, record: WindowsStructuredSessionRecord): Promise<void> {
  const native = await WindowsSessionHostNativeWorker.create();
  try {
    await native.openState(registryDirectory(root));
    await native.writeAtomic(registryRecordName(record.sessionId), new TextEncoder().encode(JSON.stringify(record)));
  } finally { await native.close(); }
}

async function recoverPendingRecord(root: string, pending: PendingWindowsStructuredSessionRecord): Promise<WindowsStructuredSessionManifest | null> {
  const native = await WindowsSessionHostNativeWorker.create();
  try {
    // This opens the deterministic per-session owner directory only through
    // the native ACL/reparse boundary.  A stale intent is inspected read-only;
    // it can never cause a replacement launch.
    await native.openState(hostDirectory(root, pending.sessionId));
    const bytes = await native.read("manifest.json");
    if (bytes === null) return null;
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows pending Session Host manifest JSON is invalid"); }
    const host = parseWindowsSessionHostManifest(raw);
    if (host.sessionId !== pending.sessionId || host.epoch !== pending.epoch) {
      throw new WindowsSessionHostUnavailable("identity_mismatch", "Windows pending Session Host owner does not match its launch intent");
    }
    return {
      schemaVersion: 1, implementation: "windows-structured-session-host", sessionId: pending.sessionId,
      agent: pending.agent, title: pending.title, cwd: pending.cwd, createdAt: pending.createdAt,
      approvalPolicy: pending.approvalPolicy, registryDirectory: pending.registryDirectory, host,
      ...(pending.accountId ? { accountId: pending.accountId } : {}), ...(pending.accountName ? { accountName: pending.accountName } : {}),
      status: host.status === "terminal" ? "terminal" : "active",
    };
  } finally { await native.close(); }
}

function initialInfo(manifest: WindowsStructuredSessionManifest): SessionInfo {
  return {
    id: manifest.sessionId,
    agent: manifest.agent,
    kind: "structured",
    title: manifest.title,
    cwd: manifest.cwd,
    status: manifest.status === "terminal" ? "done" : manifest.status === "unavailable" ? "died" : "starting",
    createdAt: manifest.createdAt,
    cols: 80,
    rows: 24,
    approvalPolicy: manifest.approvalPolicy,
    ...(manifest.accountId ? { accountId: manifest.accountId } : {}),
    ...(manifest.accountName ? { accountName: manifest.accountName } : {}),
  };
}

export interface WindowsStructuredOfflineTerminalState {
  readonly host: WindowsSessionHostManifest;
  readonly persistent: StructuredSessionPersistentState;
  readonly info: SessionInfo;
  readonly commands: ReadonlyMap<string, SessionHostReply>;
}

function terminalInfo(value: unknown, manifest: WindowsStructuredSessionManifest): SessionInfo | null {
  const keys = [
    "id", "agent", "kind", "title", "cwd", "status", "createdAt", "cols", "rows", "accountId", "accountName",
    "pendingPermissions", "pendingQuestions", "approvalPolicy", "preview", "busySince", "messageQueue", "agentControls", "subagents", "totals",
  ];
  if (!isRecord(value) || !Object.keys(value).every((key) => keys.includes(key)) || !boundedJson(value, 256 * 1024)) return null;
  const parsed = SessionInfoSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== manifest.sessionId || parsed.data.agent !== manifest.agent || parsed.data.kind !== "structured") return null;
  return { ...parsed.data, status: "done", busySince: undefined };
}

function terminalSnapshotState(value: unknown, manifest: WindowsStructuredSessionManifest): Pick<WindowsStructuredOfflineTerminalState, "persistent" | "info"> | null {
  if (!isRecord(value) || !Object.keys(value).every((key) => key === "structured" || key === "info")) return null;
  const persistent = value["structured"];
  const info = terminalInfo(value["info"], manifest);
  if (!isPersistentState(persistent) || persistent.id !== manifest.sessionId || persistent.agent !== manifest.agent || persistent.terminal !== true || !info) {
    return null;
  }
  return { persistent: clonePersistentState(persistent), info };
}

/**
 * A terminal owner may have deliberately killed itself with its provider
 * tree. Recover its read-only facade from the host's own ACL-safe state, not
 * from the daemon registry or a newly spawned replacement.
 */
export interface WindowsStructuredOfflineTerminalNative {
  openState(path: string): Promise<void>;
  read(fileName: string): Promise<Uint8Array | null>;
  writeAtomic(fileName: string, bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface WindowsStructuredOfflineTerminalNativeFactory {
  create(): Promise<WindowsStructuredOfflineTerminalNative>;
}

export async function readWindowsStructuredOfflineTerminalState(
  manifest: WindowsStructuredSessionManifest,
  nativeFactory: WindowsStructuredOfflineTerminalNativeFactory = WindowsSessionHostNativeWorker,
): Promise<WindowsStructuredOfflineTerminalState | null> {
  const native = await nativeFactory.create();
  try {
    await native.openState(manifest.host.stateDirectory);
    const manifestBytes = await native.read("manifest.json");
    if (manifestBytes === null) return null;
    let rawManifest: unknown;
    try { rawManifest = JSON.parse(new TextDecoder().decode(manifestBytes)); }
    catch { throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows terminal Session Host manifest JSON is invalid"); }
    const host = parseWindowsSessionHostManifest(rawManifest);
    if (host.status !== "terminal" || host.sessionId !== manifest.sessionId || host.epoch !== manifest.host.epoch ||
      !processIdentityEquals(host.owner, manifest.host.owner)) {
      return null;
    }
    const recovered = await new WindowsSessionHostJournal(native, host.sessionId, host.epoch).load();
    if (!recovered.terminal || !recovered.snapshot?.terminal) return null;
    const state = terminalSnapshotState(recovered.snapshot.state, manifest);
    if (!state) return null;
    const commands = new Map<string, SessionHostReply>();
    for (const entry of recovered.snapshot.commands) commands.set(entry.commandId, entry.reply);
    return { host, ...state, commands };
  } finally { await native.close(); }
}

async function readOfflineTerminalState(manifest: WindowsStructuredSessionManifest): Promise<WindowsStructuredOfflineTerminalState | null> {
  return readWindowsStructuredOfflineTerminalState(manifest);
}

function hostErrorIsRetryable(error: unknown): boolean {
  return error instanceof WindowsSessionHostClientError &&
    (error.code === "session_host_unavailable" || error.code === "timeout" || error.code === "connection_busy");
}

function isPersistentState(value: unknown): value is StructuredSessionPersistentState {
  if (!isRecord(value) || value["version"] !== 1 || typeof value["id"] !== "string" || !SESSION_ID.test(value["id"]) ||
    !isAgent(value["agent"]) || typeof value["title"] !== "string" || typeof value["cwd"] !== "string" ||
    typeof value["createdAt"] !== "number" || !Number.isFinite(value["createdAt"]) || !isPolicy(value["approvalPolicy"]) ||
    !Array.isArray(value["events"]) || value["events"].length > MAX_EVENTS || !Number.isSafeInteger(value["evSeq"]) || (value["evSeq"] as number) < 0 ||
    typeof value["preview"] !== "string" || typeof value["previewRaw"] !== "string" || typeof value["previewMsgId"] !== "string" ||
    !isRecord(value["totals"]) || typeof value["totals"]["costUsd"] !== "number" || typeof value["totals"]["inputTokens"] !== "number" || typeof value["totals"]["outputTokens"] !== "number" ||
    !Array.isArray(value["toolOutputs"]) || value["toolOutputs"].length > MAX_TOOL_ENTRIES || !value["toolOutputs"].every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].length <= MAX_TOOL_OUTPUT) ||
    !isRecord(value["adapterState"]) || !boundedJson(value["adapterState"], MAX_ADAPTER_STATE_BYTES) ||
    (value["messageQueue"] !== undefined && (!Array.isArray(value["messageQueue"]) || value["messageQueue"].length > MAX_MESSAGE_QUEUE || !boundedJson(value["messageQueue"], MAX_MESSAGE_QUEUE_BYTES))) ||
    (value["terminal"] !== undefined && value["terminal"] !== true) ||
    !boundedJson(value, MAX_PERSISTENT_STATE_BYTES)) return false;
  return true;
}

function boundedJson(value: unknown, maxBytes: number): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes; }
  catch { return false; }
}

function clonePersistentState(state: StructuredSessionPersistentState): StructuredSessionPersistentState {
  return {
    ...state,
    events: [...state.events],
    totals: { ...state.totals },
    toolOutputs: state.toolOutputs.map(([id, output]) => [id, output]),
    adapterState: { ...state.adapterState },
    ...(state.messageQueue === undefined ? {} : { messageQueue: state.messageQueue.map((item) => ({ ...item, attachments: item.attachments.map((attachment) => ({ ...attachment })) })) }),
  };
}

/**
 * Same public surface as the Unix RemoteStructuredSession, backed by the
 * common Session Host pipe.  Its only durable cursor is the host journal seq;
 * the StructuredSession event sequence is preserved inside each record.
 */
export class WindowsRemoteStructuredSession extends EventEmitter {
  readonly id: string;
  readonly agent: AgentKind;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly accountId: string | undefined;
  readonly accountName: string | undefined;
  get hosting(): "windows-session-host" | "unavailable" {
    return this.manifest.status === "unavailable" || this.infoValue.status === "died"
      ? "unavailable"
      : "windows-session-host";
  }
  private client: SessionHostFacade | null = null;
  private readonly log: AgentEventBody[] = [];
  private readonly pendingPermissions = new Set<string>();
  private readonly pendingQuestions = new Set<string>();
  private evSeq = 0;
  private hostSeq = 0;
  private infoValue: SessionInfo;
  private poll: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;
  private commandInFlight = false;
  private disconnected = false;
  private reconciliationRequired = false;
  /** Full host reducer state; never synthesize an empty cache after detach. */
  private persistent: StructuredSessionPersistentState | null = null;
  private leaseClient: SessionHostFacade | null = null;
  private leasePromise: Promise<void> | null = null;
  private persistentRefreshPending = false;

  private constructor(
    readonly manifest: WindowsStructuredSessionManifest,
    private readonly attachHost: AttachHost,
    unavailable = false,
    terminalState?: WindowsStructuredOfflineTerminalState,
  ) {
    super();
    this.id = manifest.sessionId;
    this.agent = manifest.agent;
    this.title = manifest.title;
    this.cwd = manifest.cwd;
    this.createdAt = manifest.createdAt;
    this.accountId = manifest.accountId;
    this.accountName = manifest.accountName;
    this.infoValue = initialInfo({ ...manifest, status: unavailable ? "unavailable" : manifest.status });
    if (terminalState) {
      this.persistent = clonePersistentState(terminalState.persistent);
      this.log.push(...terminalState.persistent.events.slice(-MAX_EVENTS));
      this.evSeq = terminalState.persistent.evSeq;
      this.infoValue = { ...terminalState.info, status: "done", busySince: undefined };
      this.rebuildPending();
    }
  }

  static async attach(manifest: WindowsStructuredSessionManifest, attachHost: AttachHost = async (host) =>
    attachWindowsSessionHost(host, { readOnlyMethods: WINDOWS_STRUCTURED_READ_ONLY_METHODS }),
  ): Promise<WindowsRemoteStructuredSession> {
    const session = new WindowsRemoteStructuredSession(manifest, attachHost);
    try {
      await session.reconnect();
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  static unavailable(manifest: WindowsStructuredSessionManifest): WindowsRemoteStructuredSession {
    return new WindowsRemoteStructuredSession(manifest, async () => { throw new Error("Windows Session Host is unavailable"); }, true);
  }

  static offlineTerminal(manifest: WindowsStructuredSessionManifest, terminalState: WindowsStructuredOfflineTerminalState): WindowsRemoteStructuredSession {
    return new WindowsRemoteStructuredSession(
      { ...manifest, host: terminalState.host, status: "terminal" },
      async () => { throw new WindowsSessionHostUnavailable("terminal_fence", "Windows Session Host is terminal and offline"); },
      false,
      terminalState,
    );
  }

  async reconnect(): Promise<void> {
    if (this.manifest.status === "unavailable") throw new WindowsSessionHostUnavailable("native_unavailable", "Windows Session Host is unavailable");
    await this.client?.dispose().catch(() => {});
    const client = await this.attachHost(this.manifest.host);
    this.client = client;
    this.leaseClient = null;
    this.disconnected = false;
    // Recovery first replays only. A terminal owner must remain readable
    // without renewing/acquiring a mutation lease after daemon restart.
    await this.sync();
    await this.refreshPersistentState();
    if (!this.poll) {
      this.poll = setInterval(() => { void this.sync().catch(() => { this.disconnected = true; }); }, POLL_MS);
      this.poll.unref?.();
    }
  }

  private async sync(): Promise<void> {
    if (this.commandInFlight) return;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      if (!this.client || this.disconnected) return;
      const replay = await this.client.replay(this.hostSeq);
      this.applyReplay(replay);
      if (this.persistentRefreshPending) {
        this.persistentRefreshPending = false;
        await this.refreshPersistentState();
      }
    })();
    try { await this.syncing; }
    finally { this.syncing = null; }
  }

  private async refreshPersistentState(): Promise<void> {
    if (!this.client || this.disconnected) return;
    const state = await this.client.command("structured.persistentState", {}, false, randomUUID());
    if (!isPersistentState(state) || state.id !== this.id || state.agent !== this.agent) {
      throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows structured Session Host returned an invalid durable state");
    }
    this.persistent = clonePersistentState(state);
  }

  private applyReplay(replay: SessionHostReplayReply): void {
    if (replay.gap && replay.snapshot) this.applySnapshot(replay.snapshot.state);
    for (const event of replay.events) {
      const payload = event.payload;
      if (!isRecord(payload)) continue;
      if (payload["type"] === "structured.event" && typeof payload["evSeq"] === "number") {
        const seq = payload["evSeq"];
        if (!Number.isSafeInteger(seq) || seq <= this.evSeq || !isRecord(payload["body"])) continue;
        if (seq !== this.evSeq + 1) {
          this.reconciliationRequired = true;
          continue;
        }
        const body = payload["body"] as AgentEventBody;
        this.evSeq = seq;
        this.log.push(body);
        if (this.log.length > MAX_EVENTS) this.log.shift();
        this.applyEventToInfo(body);
        this.emit("event", body, this.evSeq);
      } else if (payload["type"] === "structured.state" && isRecord(payload["info"])) {
        this.infoValue = payload["info"] as SessionInfo;
        this.emit("state", this.info());
      } else if (payload["type"] === "structured.started" && isRecord(payload["info"])) {
        this.infoValue = payload["info"] as SessionInfo;
        this.emit("state", this.info());
      } else if (payload["type"] === "structured.persist") {
        // Tool output, adapter resume state, and queued-message updates are
        // not reconstructible from the event log. Pull the host reducer once
        // the replay request has released the single pipe connection.
        this.persistentRefreshPending = true;
      }
    }
    this.hostSeq = replay.lastSeq;
    if (replay.terminal) {
      this.infoValue = { ...this.infoValue, status: "done" };
      if (this.persistent) this.persistent = { ...this.persistent, terminal: true };
    }
  }

  private applySnapshot(value: unknown): void {
    if (!isRecord(value) || !isRecord(value["structured"])) return;
    const structured = value["structured"];
    if (!isPersistentState(structured) || structured.id !== this.id || structured.agent !== this.agent) return;
    this.persistent = clonePersistentState(structured);
    this.log.splice(0, this.log.length, ...structured.events.slice(-MAX_EVENTS));
    this.evSeq = Math.max(0, structured.evSeq);
    if (isRecord(value["info"])) this.infoValue = value["info"] as SessionInfo;
    this.rebuildPending();
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

  private applyEventToInfo(body: AgentEventBody): void {
    let status = this.infoValue.status;
    if (body.kind === "permission.request") {
      this.pendingPermissions.add(body.reqId);
      status = "waiting_approval";
    } else if (body.kind === "permission.resolved") {
      this.pendingPermissions.delete(body.reqId);
      if (this.pendingPermissions.size === 0 && status === "waiting_approval") status = this.pendingQuestions.size ? "waiting_input" : "running";
    } else if (body.kind === "question.request") {
      this.pendingQuestions.add(body.reqId);
      if (this.pendingPermissions.size === 0) status = "waiting_input";
    } else if (body.kind === "question.resolved") {
      this.pendingQuestions.delete(body.reqId);
      if (this.pendingQuestions.size === 0 && status === "waiting_input") status = this.pendingPermissions.size ? "waiting_approval" : "running";
    } else if ((body.kind === "turn.end" || body.kind === "agent.error") && (body as { agentId?: string }).agentId === undefined && !this.pendingPermissions.size && !this.pendingQuestions.size) {
      status = "completed";
    } else if ((body as { agentId?: string }).agentId === undefined && (status === "idle" || status === "completed" || status === "starting")) {
      status = "running";
    }
    this.infoValue = {
      ...this.infoValue,
      status,
      pendingPermissions: this.pendingPermissions.size,
      pendingQuestions: this.pendingQuestions.size,
      ...(status === "running" || status === "waiting_approval" || status === "waiting_input"
        ? { busySince: this.infoValue.busySince ?? Date.now() }
        : { busySince: undefined }),
    };
    this.emit("state", this.info());
  }

  private async invoke<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const commandId = randomUUID();
    const mutation = !WINDOWS_STRUCTURED_READ_ONLY_METHODS.includes(method);
    const execute = async (): Promise<T> => {
      if (!this.client || this.disconnected) throw new WindowsSessionHostClientError("Windows structured Session Host is disconnected");
      if (mutation) await this.ensureMutationLease();
      return this.client.command(method, params, mutation, commandId) as Promise<T>;
    };
    this.commandInFlight = true;
    try {
      // An already-running replay owns the one-request pipe connection. Let
      // it finish instead of treating normal polling as a transport failure.
      await this.syncing;
      const value = await execute();
      this.commandInFlight = false;
      if (method === "structured.kill") {
        // A successful terminal reply is itself the exact durable command
        // outcome. Do not issue a follow-up replay that races the host's
        // deliberate self-termination and turns that expected disconnect into
        // a false client failure.
        this.infoValue = { ...this.infoValue, status: "done", busySince: undefined };
        if (this.persistent) this.persistent = { ...this.persistent, terminal: true };
        return value;
      }
      await this.sync();
      return value;
    } catch (error) {
      this.commandInFlight = false;
      if (method === "structured.kill" && hostErrorIsRetryable(error)) {
        const terminal = await readOfflineTerminalState(this.manifest);
        const exact = terminal?.commands.get(commandId);
        // A socket failure is successful only when the secure terminal
        // snapshot contains this exact idempotency ledger entry and outcome.
        if (terminal && exact?.ok) {
          this.installOfflineTerminal(terminal);
          return exact.result as T;
        }
      }
      if (error instanceof WindowsSessionHostClientError && error.code === "unknown_command_outcome") {
        this.reconciliationRequired = true;
        this.infoValue = { ...this.infoValue, status: "died" };
        throw new WindowsSessionHostClientError("Windows provider outcome is unknown; reconciliation is required", "reconciliation_required");
      }
      if (!hostErrorIsRetryable(error)) throw error;
      this.disconnected = true;
      await this.reconnect();
      // Exact same commandId makes a post-disconnect retry idempotent.
      this.commandInFlight = true;
      const value = await execute();
      this.commandInFlight = false;
      await this.sync();
      return value;
    } finally {
      this.commandInFlight = false;
    }
  }

  private async ensureMutationLease(): Promise<void> {
    if (this.infoValue.status === "done" || this.reconciliationRequired) {
      throw new WindowsSessionHostClientError("Windows structured Session Host is terminal and read-only", "terminal_fence");
    }
    const client = this.client;
    if (!client || this.disconnected) throw new WindowsSessionHostClientError("Windows structured Session Host is disconnected");
    if (this.leaseClient === client) return;
    this.leasePromise ??= client.acquireMutationLease().then(() => { this.leaseClient = client; });
    try { await this.leasePromise; }
    finally { this.leasePromise = null; }
  }

  private installOfflineTerminal(terminalState: WindowsStructuredOfflineTerminalState): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    const client = this.client;
    this.client = null;
    this.leaseClient = null;
    this.disconnected = true;
    this.persistent = clonePersistentState(terminalState.persistent);
    this.log.splice(0, this.log.length, ...terminalState.persistent.events.slice(-MAX_EVENTS));
    this.evSeq = terminalState.persistent.evSeq;
    this.infoValue = { ...terminalState.info, status: "done", busySince: undefined };
    this.rebuildPending();
    void client?.dispose().catch(() => {});
  }

  info(): SessionInfo {
    return this.reconciliationRequired ? { ...this.infoValue, status: "died" } : { ...this.infoValue };
  }
  get approvalPolicy(): ApprovalPolicy { return this.infoValue.approvalPolicy ?? this.manifest.approvalPolicy; }
  get resumeState(): AdapterResumeState { return this.persistent ? { ...this.persistent.adapterState } : {}; }
  snapshot(): { events: AgentEventBody[]; evSeq: number } { return { events: [...this.log], evSeq: this.evSeq }; }
  transportSnapshot(): { events: AgentEventBody[]; evSeq: number } { return { events: compactAgentSnapshotEvents(this.log), evSeq: this.evSeq }; }
  since(afterSeq: number): AgentEventBody[] | null {
    if (afterSeq > this.evSeq) return null;
    const oldest = this.evSeq - this.log.length + 1;
    if (afterSeq + 1 < oldest && afterSeq < this.evSeq) return null;
    return this.log.slice(Math.max(0, this.log.length - (this.evSeq - afterSeq)));
  }
  persistentState(): StructuredSessionPersistentState {
    if (!this.persistent) {
      // Returning an empty map here would turn an unavailable host into a
      // fabricated `tool.output.get` miss. Callers must retain the last
      // persisted facade instead of accepting invented state.
      throw new WindowsSessionHostUnavailable("native_unavailable", "Windows structured Session Host durable state is not hydrated");
    }
    const state = clonePersistentState(this.persistent);
    state.events = [...this.log];
    state.evSeq = this.evSeq;
    state.approvalPolicy = this.approvalPolicy;
    if (this.infoValue.preview !== undefined) state.preview = this.infoValue.preview;
    if (this.infoValue.totals !== undefined) state.totals = { ...this.infoValue.totals };
    if (this.reconciliationRequired || this.infoValue.status === "done" || this.manifest.status !== "active") state.terminal = true;
    return state;
  }

  async start(): Promise<void> { await this.reconnect(); }
  async send(text: string, attachments?: Attachment[], delivery?: ChatDelivery): Promise<void> {
    await this.invoke("structured.send", { text, ...(attachments ? { attachments } : {}), ...(delivery ? { delivery } : {}) });
  }
  async setApprovalPolicy(policy: ApprovalPolicy): Promise<void> { await this.invoke("structured.setApprovalPolicy", { policy }); }
  complete(kind: ChatSuggestionKind, query: string): Promise<ChatSuggestion[]> { return completeComposer(this.cwd, kind, query); }
  models(): Promise<AgentModelCatalog> { return this.invoke("structured.models", {}); }
  setModel(model: string, effort?: string): Promise<AgentModelSelection> { return this.invoke("structured.setModel", { model, ...(effort ? { effort } : {}) }); }
  modes(): Promise<AgentModeCatalog> { return this.invoke("structured.modes", {}); }
  setMode(mode: string): Promise<AgentModeSelection> { return this.invoke("structured.setMode", { mode }); }
  async compact(): Promise<void> { await this.invoke("structured.compact", {}); }
  toolOutput(callId: string): { output: string; truncated: boolean } | null {
    if (!this.persistent) throw new WindowsSessionHostUnavailable("native_unavailable", "Windows structured Session Host durable state is not hydrated");
    const entry = this.persistent.toolOutputs.find(([id]) => id === callId);
    if (!entry) return null;
    const output = entry[1];
    return output.length > MAX_TOOL_OUTPUT
      ? { output: output.slice(0, MAX_TOOL_OUTPUT), truncated: true }
      : { output, truncated: false };
  }
  async attachmentChunk(msgId: string, attachmentId: string, offset: number, length: number): Promise<{ data: Buffer; total: number; eof: boolean; mimeType: Attachment["mimeType"] } | null> {
    const value = await this.invoke<{ dataB64: string; total: number; eof: boolean; mimeType: Attachment["mimeType"] } | null>("structured.attachmentChunk", { msgId, attachmentId, offset, length });
    return value ? { ...value, data: Buffer.from(value.dataB64, "base64") } : null;
  }
  usage(): Promise<UsageReport | null> { return this.invoke("structured.usage", {}); }
  async respondPermission(reqId: string, reply: PermissionReply): Promise<void> { await this.invoke("structured.respondPermission", { reqId, reply }); }
  async respondQuestion(reqId: string, answers: AgentQuestionAnswer[], cancelled = false): Promise<void> { await this.invoke("structured.respondQuestion", { reqId, answers, cancelled }); }
  async sendToSubagent(subagentId: string, text: string): Promise<void> { await this.invoke("structured.sendToSubagent", { subagentId, text }); }
  subagentSnapshot(subagentId: string): Promise<{ subagent: SubagentInfo; events: AgentEventBody[]; evSeq: number }> { return this.invoke("structured.subagentSnapshot", { subagentId }); }
  removeQueued(queueId: string): Promise<boolean> { return this.invoke("structured.removeQueued", { queueId }); }
  guideQueued(queueId: string): Promise<boolean> { return this.invoke("structured.guideQueued", { queueId }); }
  async interrupt(): Promise<void> { await this.invoke("structured.interrupt", {}); }
  async kill(): Promise<void> {
    await this.invoke("structured.kill", {});
    this.infoValue = { ...this.infoValue, status: "done" };
    await this.dispose();
  }
  async dispose(): Promise<void> {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    const client = this.client;
    this.client = null;
    this.disconnected = true;
    await client?.dispose();
  }
}

function handlerModuleUrl(): string {
  return pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "windows-structured-session-host.js")).href;
}

const launchLocks = new Map<string, Promise<void>>();

async function serializeLaunch<T>(root: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
  const key = `${root}\0${sessionId}`;
  const previous = launchLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  launchLocks.set(key, gate);
  await previous.catch(() => {});
  try { return await operation(); }
  finally {
    release();
    if (launchLocks.get(key) === gate) launchLocks.delete(key);
  }
}

async function launchWindowsStructuredSessionUnlocked(input: LaunchWindowsStructuredSessionInput): Promise<WindowsRemoteStructuredSession> {
  if (!SESSION_ID.test(input.sessionId)) throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows structured Session Host session id is invalid");
  const records = await readRegistryRecords(input.root);
  if (records.some((session) => session.sessionId === input.sessionId)) {
    throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows structured Session Host session already exists");
  }
  const epoch = randomUUID();
  const stateDirectory = hostDirectory(input.root, input.sessionId);
  const pending: PendingWindowsStructuredSessionRecord = {
    schemaVersion: 1, implementation: "windows-structured-session-host-pending", sessionId: input.sessionId, epoch,
    agent: input.agent, title: input.title, cwd: input.cwd, createdAt: input.createdAt,
    approvalPolicy: input.approvalPolicy ?? "standard", registryDirectory: registryDirectory(input.root), stateDirectory,
    ...(input.accountId ? { accountId: input.accountId } : {}), ...(input.accountName ? { accountName: input.accountName } : {}), status: "launching",
  };
  // Publish the immutable intent before the host exists. If the process dies
  // between native launch and the active record, recovery scans this record
  // and inspects that exact owner directory; it never starts a replacement.
  await writeRegistryRecord(input.root, pending);
  const pipeName = `\\\\.\\pipe\\prospero.structured.${input.sessionId}.${epoch}`;
  const bootstrap: WindowsStructuredHostBootstrap = {
    version: 1, agent: input.agent, title: input.title, cwd: input.cwd, createdAt: input.createdAt,
    ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}), environment: input.environment,
    ...(input.codexAppServerArgs ? { codexAppServerArgs: input.codexAppServerArgs } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}), ...(input.accountName ? { accountName: input.accountName } : {}),
    ...(input.initialAdapterState ? { initialAdapterState: input.initialAdapterState } : {}),
  };
  let host: WindowsSessionHostManifest;
  try {
    host = await launchDetachedWindowsSessionHost({
      sessionId: input.sessionId, epoch, pipeName, stateDirectory, handlerModule: handlerModuleUrl(),
      createdAt: input.createdAt, readOnlyMethods: WINDOWS_STRUCTURED_READ_ONLY_METHODS, handlerOptions: bootstrap,
      ...(input.runnerEntryPath ? { runnerEntryPath: input.runnerEntryPath } : {}),
    } satisfies LaunchDetachedWindowsSessionHostOptions);
  } catch (error) { throw error; }
  const manifest: WindowsStructuredSessionManifest = {
    schemaVersion: 1, implementation: "windows-structured-session-host", sessionId: input.sessionId,
    agent: input.agent, title: input.title, cwd: input.cwd, createdAt: input.createdAt,
    approvalPolicy: input.approvalPolicy ?? "standard", registryDirectory: registryDirectory(input.root), host,
    ...(input.accountId ? { accountId: input.accountId } : {}), ...(input.accountName ? { accountName: input.accountName } : {}), status: "active",
  };
  // This replaces only this session's secure record. It cannot delete a
  // concurrently published session, unlike a global registry RMW.
  await writeRegistryRecord(input.root, manifest);
  return WindowsRemoteStructuredSession.attach(manifest);
}

export async function launchWindowsStructuredSession(input: LaunchWindowsStructuredSessionInput): Promise<WindowsRemoteStructuredSession> {
  return serializeLaunch(input.root, input.sessionId, () => launchWindowsStructuredSessionUnlocked(input));
}

/** Recovery only attaches published owners; it never launches replacements. */
export async function reconnectWindowsStructuredSessions(root: string): Promise<WindowsRemoteStructuredSession[]> {
  const records = await readRegistryRecords(root);
  const sessions: WindowsRemoteStructuredSession[] = [];
  for (const record of records) {
    const manifest = record.status === "launching" ? await recoverPendingRecord(root, record) : record;
    if (!manifest) continue;
    // The per-session registry is only a discovery index. Its active copy can
    // lag the terminal host that intentionally killed itself after committing
    // state, so the secure host manifest + terminal snapshot correct it. A
    // failed index publication never authorizes a second owner.
    const terminal = await readOfflineTerminalState(manifest);
    if (terminal) {
      const corrected: WindowsStructuredSessionManifest = {
        ...manifest, host: terminal.host, status: "terminal",
      };
      await writeRegistryRecord(root, corrected).catch(() => {});
      sessions.push(WindowsRemoteStructuredSession.offlineTerminal(corrected, terminal));
      continue;
    }
    if (manifest.status !== "active") {
      sessions.push(WindowsRemoteStructuredSession.unavailable(manifest));
      continue;
    }
    try { sessions.push(await WindowsRemoteStructuredSession.attach(manifest)); }
    catch { sessions.push(WindowsRemoteStructuredSession.unavailable({ ...manifest, status: "unavailable" })); }
  }
  return sessions;
}

/** Native inability is a supported non-durable fallback; Job policy is not. */
export function canFallbackToInProcessStructured(error: unknown): boolean {
  return error instanceof WindowsSessionHostUnavailable &&
    (error.code === "native_unavailable" || error.code === "native_abi_mismatch" || error.code === "native_capability_missing");
}
