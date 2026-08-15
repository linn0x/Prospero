/**
 * Common durable transport contract for Windows session hosts.
 *
 * This layer deliberately contains no provider/PTY vocabulary.  A later
 * vertical owns the command handler, while this file owns the things that
 * must stay identical for every hosted session: authenticated attach,
 * mutation fencing, durable cursors, and fail-closed recovery.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { NATIVE_WINDOWS_ABI_VERSION, type FileTime100ns, type ProcessIdentity } from "@prospero/windows-native";

export const WINDOWS_SESSION_HOST_PROTOCOL_VERSION = 2;
export const WINDOWS_SESSION_HOST_MANIFEST_SCHEMA = 2;
export const PSJ2_MAGIC = "PSJ2";
export const PSJ2_MAX_RECORD_BYTES = 4 * 1024 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const EPOCH = /^[A-Za-z0-9._:-]{16,256}$/;
const COMMAND_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type WindowsSessionHostAvailabilityCode =
  | "unknown_schema"
  | "invalid_manifest"
  | "identity_mismatch"
  | "acl_unverified"
  | "native_unavailable"
  | "native_abi_mismatch"
  | "native_capability_missing"
  | "journal_corrupt"
  | "snapshot_corrupt"
  | "terminal_fence";

/** A recovery error is intentionally not recoverable by spawning a new host. */
export class WindowsSessionHostUnavailable extends Error {
  constructor(readonly code: WindowsSessionHostAvailabilityCode, message: string) {
    super(message);
    this.name = "WindowsSessionHostUnavailable";
  }
}

export interface WindowsSessionHostManifest {
  readonly schemaVersion: 2;
  readonly protocolVersion: 2;
  readonly implementation: "windows-session-host";
  readonly sessionId: string;
  readonly epoch: string;
  /** Full \\.\pipe\ endpoint; ACL validation is done by the native host. */
  readonly pipeName: string;
  readonly stateDirectory: string;
  /** Fixed profile; the native process token, not this manifest, selects SID. */
  readonly aclProfile: "current-logon-token-v1";
  /** Identity of the detached owner, never a PID on its own. */
  readonly owner: ProcessIdentity;
  readonly nativeAbiVersion: number;
  readonly credentialFile: "credential.dpapi";
  readonly journalFile: "journal.psj2";
  readonly snapshotFile: "snapshot.psj2.json";
  readonly status: "active" | "terminal" | "failed";
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SessionHostHello {
  readonly version: 2;
  readonly type: "hello";
  readonly sessionId: string;
  readonly epoch: string;
  readonly daemon: ProcessIdentity;
  readonly nonce: string;
  readonly proof: string;
}

export interface SessionHostWelcome {
  readonly version: 2;
  readonly type: "welcome";
  readonly sessionId: string;
  readonly epoch: string;
  readonly host: ProcessIdentity;
  readonly proof: string;
  readonly terminal: boolean;
  readonly lastSeq: number;
}

export interface SessionHostCommand {
  readonly version: 2;
  readonly type: "command";
  readonly sessionId: string;
  readonly epoch: string;
  readonly commandId: string;
  readonly leaseId?: string;
  readonly mutation: boolean;
  readonly method: string;
  readonly params: unknown;
}

export interface SessionHostReply {
  readonly version: 2;
  readonly type: "reply";
  readonly commandId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly seq: number;
}

export interface SessionHostReplayRequest {
  readonly version: 2;
  readonly type: "replay";
  readonly sessionId: string;
  readonly epoch: string;
  readonly afterSeq: number;
}

export interface SessionHostReplayReply {
  readonly version: 2;
  readonly type: "replay";
  readonly sessionId: string;
  readonly epoch: string;
  readonly afterSeq: number;
  readonly lastSeq: number;
  readonly gap: boolean;
  readonly terminal: boolean;
  readonly snapshot: WindowsSessionHostSnapshot | null;
  readonly events: readonly WindowsSessionHostJournalEvent[];
}

export type SessionHostWireMessage =
  | SessionHostHello
  | SessionHostWelcome
  | SessionHostCommand
  | SessionHostReply
  | SessionHostReplayRequest
  | SessionHostReplayReply;

export interface WindowsSessionHostEvent {
  readonly kind: "event" | "command" | "terminal";
  readonly payload: unknown;
  readonly commandId?: string;
}

export interface WindowsSessionHostJournalEvent extends WindowsSessionHostEvent {
  readonly schemaVersion: 2;
  readonly sessionId: string;
  readonly epoch: string;
  readonly seq: number;
}

interface Psj2BaseRecord {
  readonly schemaVersion: 2;
  readonly kind: "base";
  readonly sessionId: string;
  readonly epoch: string;
  readonly baseSeq: number;
}

type Psj2Record = Psj2BaseRecord | WindowsSessionHostJournalEvent;

export interface WindowsSessionHostSnapshot {
  readonly schemaVersion: 2;
  readonly sessionId: string;
  readonly epoch: string;
  readonly lastSeq: number;
  readonly terminal: boolean;
  /** Completed mutating commands are the durable idempotency ledger. */
  readonly commands: readonly Readonly<{ commandId: string; reply: SessionHostReply }> [];
  /** Provider-neutral reducer state supplied by a vertical. */
  readonly state: unknown;
}

export interface DecodedPsj2Journal {
  readonly baseSeq: number;
  readonly events: readonly WindowsSessionHostJournalEvent[];
  /** A partial final frame is the only tolerated crash artifact. */
  readonly crashTail: boolean;
}

export interface SessionHostReplayState {
  readonly snapshot: WindowsSessionHostSnapshot | null;
  readonly events: readonly WindowsSessionHostJournalEvent[];
  readonly lastSeq: number;
  readonly terminal: boolean;
  readonly crashTail: boolean;
}

export interface WindowsSessionHostStateStore {
  /** `null` means a validated state entry does not exist. */
  read(fileName: string): Promise<Uint8Array | null>;
  /** Must be an ACL/reparse-safe atomic replacement supplied by native code. */
  writeAtomic(fileName: string, bytes: Uint8Array): Promise<void>;
}

function unavailable(code: WindowsSessionHostAvailabilityCode, message: string): never {
  throw new WindowsSessionHostUnavailable(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isReplyLedgerEntry(value: unknown, commandId: string, lastSeq: number): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "type", "commandId", "ok", "result", "error", "seq"]) ||
    value.version !== 2 || value.type !== "reply" || value.commandId !== commandId || typeof value.ok !== "boolean" ||
    !safeInteger(value.seq) || value.seq > lastSeq) return false;
  if (value.ok) return value.error === undefined;
  return value.result === undefined && isRecord(value.error) && hasOnlyKeys(value.error, ["code", "message"]) &&
    typeof value.error.code === "string" && typeof value.error.message === "string";
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

export function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!isRecord(value) || !hasOnlyKeys(value, ["pid", "creationTime100ns"])) return false;
  return (
    safeInteger(value.pid, 2) && value.pid <= 0x7fffffff &&
    typeof value.creationTime100ns === "string" && /^[1-9][0-9]{0,19}$/.test(value.creationTime100ns)
  );
}

export function processIdentityEquals(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.creationTime100ns === right.creationTime100ns;
}

export function assertSessionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SESSION_ID.test(value)) unavailable("invalid_manifest", "Windows session host sessionId is invalid");
}

export function assertEpoch(value: unknown): asserts value is string {
  if (typeof value !== "string" || !EPOCH.test(value)) unavailable("invalid_manifest", "Windows session host epoch is invalid");
}

/** Mirrors the native 256 UTF-16 suffix and local-character policy exactly. */
export function assertSecureWindowsPipeName(value: unknown): asserts value is string {
  const prefix = "\\\\.\\pipe\\";
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length <= prefix.length || value.length > prefix.length + 256) {
    unavailable("invalid_manifest", "Windows session host pipe name is invalid");
  }
  for (const character of value.slice(prefix.length)) {
    if (character < " " || character === "\\" || character === "/" || character === ":") {
      unavailable("invalid_manifest", "Windows session host pipe name violates the native local-pipe policy");
    }
  }
}

export function sessionEpochEntropy(sessionId: string, epoch: string): Uint8Array {
  assertSessionId(sessionId);
  assertEpoch(epoch);
  // This is public, non-empty binding data, not a capability or a password.
  return textEncoder.encode(`prospero/windows-session-host/v2\0${sessionId}\0${epoch}`);
}

/**
 * A manifest is an attachment record only. In particular it must never carry
 * a raw bearer secret, an encrypted blob, a token filename chosen by input, or
 * a free-form endpoint that can silently select a non-native transport.
 */
export function parseWindowsSessionHostManifest(value: unknown): WindowsSessionHostManifest {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "schemaVersion", "protocolVersion", "implementation", "sessionId", "epoch", "pipeName", "stateDirectory",
    "aclProfile", "owner", "nativeAbiVersion", "credentialFile", "journalFile", "snapshotFile", "status",
    "createdAt", "updatedAt",
  ])) unavailable("unknown_schema", "Windows session host manifest has an unknown schema or field");
  if (
    value.schemaVersion !== WINDOWS_SESSION_HOST_MANIFEST_SCHEMA ||
    value.protocolVersion !== WINDOWS_SESSION_HOST_PROTOCOL_VERSION ||
    value.implementation !== "windows-session-host" ||
    typeof value.sessionId !== "string" || !SESSION_ID.test(value.sessionId) ||
    typeof value.epoch !== "string" || !EPOCH.test(value.epoch) ||
    typeof value.pipeName !== "string" ||
    typeof value.stateDirectory !== "string" || value.stateDirectory.length === 0 ||
    value.aclProfile !== "current-logon-token-v1" ||
    !isProcessIdentity(value.owner) ||
    value.nativeAbiVersion !== NATIVE_WINDOWS_ABI_VERSION ||
    value.credentialFile !== "credential.dpapi" || value.journalFile !== "journal.psj2" || value.snapshotFile !== "snapshot.psj2.json" ||
    (value.status !== "active" && value.status !== "terminal" && value.status !== "failed") ||
    !safeInteger(value.createdAt) || !safeInteger(value.updatedAt)
  ) unavailable("invalid_manifest", "Windows session host manifest fails strict validation");
  assertSecureWindowsPipeName(value.pipeName);
  return value as unknown as WindowsSessionHostManifest;
}

export function encodeWireMessage(value: SessionHostWireMessage): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(value)}\n`);
}

export function decodeWireMessage(bytes: Uint8Array): SessionHostWireMessage {
  let decoded: unknown;
  try { decoded = JSON.parse(textDecoder.decode(bytes)); } catch {
    unavailable("invalid_manifest", "Windows session host received invalid JSON");
  }
  if (!isRecord(decoded) || decoded.version !== WINDOWS_SESSION_HOST_PROTOCOL_VERSION || typeof decoded.type !== "string") {
    unavailable("unknown_schema", "Windows session host received an unknown protocol frame");
  }
  return decoded as unknown as SessionHostWireMessage;
}

export function splitWireFrames(buffer: Uint8Array): { readonly frames: readonly Uint8Array[]; readonly remainder: Uint8Array } {
  const frames: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < buffer.byteLength; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    if (index === start) unavailable("invalid_manifest", "Windows session host received an empty frame");
    frames.push(buffer.slice(start, index));
    start = index + 1;
  }
  if (buffer.byteLength - start > PSJ2_MAX_RECORD_BYTES) unavailable("invalid_manifest", "Windows session host frame is too large");
  return { frames, remainder: buffer.slice(start) };
}

function canonicalIdentity(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.creationTime100ns}`;
}

export function helloProofMaterial(hello: Omit<SessionHostHello, "proof" | "version" | "type">): Uint8Array {
  return textEncoder.encode(`hello\0${hello.sessionId}\0${hello.epoch}\0${canonicalIdentity(hello.daemon)}\0${hello.nonce}`);
}

export function welcomeProofMaterial(welcome: Omit<SessionHostWelcome, "proof" | "version" | "type">, nonce: string): Uint8Array {
  return textEncoder.encode(`welcome\0${welcome.sessionId}\0${welcome.epoch}\0${canonicalIdentity(welcome.host)}\0${welcome.terminal ? "terminal" : "active"}\0${welcome.lastSeq}\0${nonce}`);
}

export function hmacProof(secret: Uint8Array, material: Uint8Array): string {
  return createHmac("sha256", secret).update(material).digest("base64");
}

export function proofEquals(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== "string" || !BASE64.test(supplied)) return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

// CRC-32C (Castagnoli), not IEEE CRC-32. The table is computed once without
// platform code so mock/native tests exercise the exact on-disk format.
const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0x82f63b78 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32C_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function encodePsj2Record(record: Psj2Record): Uint8Array {
  const payload = textEncoder.encode(JSON.stringify(record));
  if (payload.byteLength === 0 || payload.byteLength > PSJ2_MAX_RECORD_BYTES) {
    unavailable("journal_corrupt", "PSJ2 record exceeds the durable maximum");
  }
  const frame = new Uint8Array(12 + payload.byteLength);
  frame.set(textEncoder.encode(PSJ2_MAGIC), 0);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(4, payload.byteLength, true);
  view.setUint32(8, crc32c(payload), true);
  frame.set(payload, 12);
  return frame;
}

export function createPsj2Journal(sessionId: string, epoch: string, baseSeq = 0): Uint8Array {
  assertSessionId(sessionId);
  assertEpoch(epoch);
  if (!safeInteger(baseSeq)) unavailable("journal_corrupt", "PSJ2 base sequence is invalid");
  return encodePsj2Record({ schemaVersion: 2, kind: "base", sessionId, epoch, baseSeq });
}

export function appendPsj2Event(journal: Uint8Array, event: WindowsSessionHostJournalEvent): Uint8Array {
  const checked = decodePsj2Journal(journal, event.sessionId, event.epoch);
  const expected = checked.events.length === 0 ? checked.baseSeq + 1 : checked.events.at(-1)!.seq + 1;
  if (checked.crashTail || event.seq !== expected) unavailable("journal_corrupt", "PSJ2 append sequence is not contiguous");
  const appended = encodePsj2Record(event);
  const result = new Uint8Array(journal.byteLength + appended.byteLength);
  result.set(journal);
  result.set(appended, journal.byteLength);
  return result;
}

function parseJournalRecord(bytes: Uint8Array): Psj2Record {
  try {
    const record: unknown = JSON.parse(textDecoder.decode(bytes));
    if (!isRecord(record) || record.schemaVersion !== 2 || typeof record.kind !== "string") {
      unavailable("journal_corrupt", "PSJ2 record schema is invalid");
    }
    return record as unknown as Psj2Record;
  } catch (error) {
    if (error instanceof WindowsSessionHostUnavailable) throw error;
    unavailable("journal_corrupt", "PSJ2 record JSON is invalid");
  }
}

function validatePsj2Record(record: Psj2Record, sessionId: string, epoch: string, expectedSeq: number | null): number | null {
  if (record.sessionId !== sessionId || record.epoch !== epoch) unavailable("journal_corrupt", "PSJ2 session or epoch mismatches manifest");
  if (record.kind === "base") {
    if (!hasOnlyKeys(record as unknown as Record<string, unknown>, ["schemaVersion", "kind", "sessionId", "epoch", "baseSeq"]) || !safeInteger(record.baseSeq)) {
      unavailable("journal_corrupt", "PSJ2 base record is invalid");
    }
    if (expectedSeq !== null) unavailable("journal_corrupt", "PSJ2 journal contains more than one base record");
    return record.baseSeq + 1;
  }
  if (
    !hasOnlyKeys(record as unknown as Record<string, unknown>, ["schemaVersion", "kind", "sessionId", "epoch", "seq", "payload", "commandId"]) ||
    (record.kind !== "event" && record.kind !== "command" && record.kind !== "terminal") ||
    !safeInteger(record.seq, 1) || record.seq !== expectedSeq ||
    (record.commandId !== undefined && (typeof record.commandId !== "string" || !COMMAND_ID.test(record.commandId)))
  ) unavailable("journal_corrupt", "PSJ2 event is not strictly sequenced");
  return record.seq + 1;
}

/** Parse all complete frames, accepting only a cut-off *final* frame as crash tail. */
export function decodePsj2Journal(bytes: Uint8Array, sessionId: string, epoch: string): DecodedPsj2Journal {
  assertSessionId(sessionId);
  assertEpoch(epoch);
  const events: WindowsSessionHostJournalEvent[] = [];
  let offset = 0;
  let expectedSeq: number | null = null;
  let baseSeq = 0;
  let crashTail = false;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) { crashTail = true; break; }
    if (textDecoder.decode(bytes.slice(offset, offset + 4)) !== PSJ2_MAGIC) unavailable("journal_corrupt", "PSJ2 magic is invalid");
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 12);
    const length = view.getUint32(4, true);
    const expectedCrc = view.getUint32(8, true);
    if (length === 0 || length > PSJ2_MAX_RECORD_BYTES) unavailable("journal_corrupt", "PSJ2 record length is invalid");
    if (bytes.byteLength - offset - 12 < length) { crashTail = true; break; }
    const payload = bytes.slice(offset + 12, offset + 12 + length);
    if (crc32c(payload) !== expectedCrc) unavailable("journal_corrupt", "PSJ2 CRC32C mismatch");
    const record = parseJournalRecord(payload);
    const next = validatePsj2Record(record, sessionId, epoch, expectedSeq);
    if (record.kind === "base") baseSeq = record.baseSeq;
    else events.push(record);
    expectedSeq = next;
    offset += 12 + length;
  }
  if (expectedSeq === null) unavailable("journal_corrupt", "PSJ2 journal is missing its base record");
  return { baseSeq, events, crashTail };
}

export function encodeSnapshot(snapshot: WindowsSessionHostSnapshot): Uint8Array {
  validateSnapshot(snapshot);
  return textEncoder.encode(JSON.stringify(snapshot));
}

export function decodeSnapshot(bytes: Uint8Array, sessionId: string, epoch: string): WindowsSessionHostSnapshot {
  let snapshot: unknown;
  try { snapshot = JSON.parse(textDecoder.decode(bytes)); } catch { unavailable("snapshot_corrupt", "Windows session host snapshot JSON is invalid"); }
  if (!isRecord(snapshot)) unavailable("snapshot_corrupt", "Windows session host snapshot is not an object");
  validateSnapshot(snapshot);
  if (snapshot.sessionId !== sessionId || snapshot.epoch !== epoch) unavailable("snapshot_corrupt", "Windows session host snapshot session or epoch mismatches");
  return snapshot;
}

function validateSnapshot(snapshot: unknown): asserts snapshot is WindowsSessionHostSnapshot {
  if (!isRecord(snapshot) || !hasOnlyKeys(snapshot, ["schemaVersion", "sessionId", "epoch", "lastSeq", "terminal", "commands", "state"]) ||
    snapshot.schemaVersion !== 2 || typeof snapshot.sessionId !== "string" || !SESSION_ID.test(snapshot.sessionId) ||
    typeof snapshot.epoch !== "string" || !EPOCH.test(snapshot.epoch) || !safeInteger(snapshot.lastSeq) ||
    typeof snapshot.terminal !== "boolean" || !Array.isArray(snapshot.commands)
  ) unavailable("snapshot_corrupt", "Windows session host snapshot schema is invalid");
  const seen = new Set<string>();
  for (const command of snapshot.commands) {
    if (!isRecord(command) || !hasOnlyKeys(command, ["commandId", "reply"]) || typeof command.commandId !== "string" || !COMMAND_ID.test(command.commandId) || seen.has(command.commandId) ||
      !isReplyLedgerEntry(command.reply, command.commandId, snapshot.lastSeq)) {
      unavailable("snapshot_corrupt", "Windows session host command ledger is invalid");
    }
    seen.add(command.commandId);
  }
}

/**
 * Applies snapshot and journal only if every retained record is contiguous.
 * A newer snapshot may coexist with the old journal during compaction; that
 * journal is replayed for integrity and its already-compacted prefix ignored.
 */
export function replayPsj2(
  sessionId: string,
  epoch: string,
  snapshot: WindowsSessionHostSnapshot | null,
  journal: Uint8Array,
): SessionHostReplayState {
  const decoded = decodePsj2Journal(journal, sessionId, epoch);
  const snapshotSeq = snapshot?.lastSeq ?? 0;
  if (decoded.baseSeq > snapshotSeq) unavailable("snapshot_corrupt", "PSJ2 journal starts after its snapshot");
  const events = decoded.events.filter((event) => event.seq > snapshotSeq);
  if (events.length > 0 && events[0]!.seq !== snapshotSeq + 1) {
    unavailable("journal_corrupt", "PSJ2 journal has a gap after snapshot");
  }
  const lastSeq = events.at(-1)?.seq ?? snapshotSeq;
  const terminal = events.some((event) => event.kind === "terminal") || snapshot?.terminal === true;
  return { snapshot, events, lastSeq, terminal, crashTail: decoded.crashTail };
}

/** Small serial journal used by the common runner; native writes enforce ACLs. */
export class WindowsSessionHostJournal {
  private state: SessionHostReplayState | null = null;

  constructor(
    private readonly store: WindowsSessionHostStateStore,
    private readonly sessionId: string,
    private readonly epoch: string,
    private readonly journalFile = "journal.psj2",
    private readonly snapshotFile = "snapshot.psj2.json",
  ) {}

  async load(): Promise<SessionHostReplayState> {
    if (this.state) return this.state;
    const [snapshotBytes, journalBytes] = await Promise.all([this.store.read(this.snapshotFile), this.store.read(this.journalFile)]);
    const snapshot = snapshotBytes === null ? null : decodeSnapshot(snapshotBytes, this.sessionId, this.epoch);
    const journal = journalBytes ?? createPsj2Journal(this.sessionId, this.epoch, snapshot?.lastSeq ?? 0);
    this.state = replayPsj2(this.sessionId, this.epoch, snapshot, journal);
    return this.state;
  }

  async append(event: WindowsSessionHostEvent): Promise<WindowsSessionHostJournalEvent> {
    const current = await this.load();
    if (current.crashTail) unavailable("journal_corrupt", "PSJ2 crash tail must be compacted before mutation");
    const record: WindowsSessionHostJournalEvent = {
      schemaVersion: 2, sessionId: this.sessionId, epoch: this.epoch, seq: current.lastSeq + 1, ...event,
    };
    const existing = await this.store.read(this.journalFile) ?? createPsj2Journal(this.sessionId, this.epoch, current.snapshot?.lastSeq ?? 0);
    await this.store.writeAtomic(this.journalFile, appendPsj2Event(existing, record));
    this.state = {
      ...current,
      events: [...current.events, record],
      lastSeq: record.seq,
      terminal: current.terminal || record.kind === "terminal",
    };
    return record;
  }

  /** Snapshot first, then reset journal: either crash point replays safely. */
  async compact(snapshotState: unknown, commands: readonly Readonly<{ commandId: string; reply: SessionHostReply }>[]): Promise<WindowsSessionHostSnapshot> {
    const current = await this.load();
    const snapshot: WindowsSessionHostSnapshot = {
      schemaVersion: 2, sessionId: this.sessionId, epoch: this.epoch, lastSeq: current.lastSeq,
      terminal: current.terminal, commands, state: snapshotState,
    };
    await this.store.writeAtomic(this.snapshotFile, encodeSnapshot(snapshot));
    await this.store.writeAtomic(this.journalFile, createPsj2Journal(this.sessionId, this.epoch, snapshot.lastSeq));
    this.state = { snapshot, events: [], lastSeq: snapshot.lastSeq, terminal: snapshot.terminal, crashTail: false };
    return snapshot;
  }
}

export function toFileTime(value: string): FileTime100ns {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) unavailable("identity_mismatch", "FILETIME is invalid");
  return value as FileTime100ns;
}
