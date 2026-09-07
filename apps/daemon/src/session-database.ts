import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { AgentEventBody } from "@prospero/protocol";
import type { QueuedChatPersistent, StructuredSessionPersistentState } from "./structured-session.js";
import { openPrivateSqlite } from "./private-sqlite.js";

const APPLICATION_ID = 0x50535344;
const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_TOOL_CHARS = 200_000;
const DEFAULT_TOOL_BYTES = DEFAULT_TOOL_CHARS * 4;
const HEAD_BATCH = 256;
const TOOL_CHUNK_CHARS = 16 * 1024;
const QUEUE_PREVIEW_CHARS = 1_000;
type SessionMetadata = Omit<StructuredSessionPersistentState, "events" | "toolOutputs" | "messageQueue">;

export class SessionDatabaseError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SessionDatabaseError"; }
}
export interface SessionEventsPageOptions { beforeSeq?: number; limit?: number; maxBytes?: number }
export interface SessionEventsPage {
  events: { seq: number; body: AgentEventBody }[];
  /** Authoritative durable cursor, independent of this page's size. */
  lastSeq: number;
  oldestSeq: number;
  hasMore: boolean;
  /** The next event itself exceeds maxBytes; its body has not been loaded. */
  oversized?: { seq: number; bytes: number };
}
export interface SessionReadOptions {
  events?: boolean; toolOutputs?: boolean; messageQueue?: boolean; limit?: number; maxBytes?: number;
}
export type StoredSessionState = StructuredSessionPersistentState & {
  historyPage?: Omit<SessionEventsPage, "events">;
  toolOutputsPage?: { hasMore: boolean };
};
/** Display-only data: deliberately cannot be passed back as a durable queue. */
export type QueuedChatSummary = Pick<QueuedChatPersistent, "id" | "displayText" | "kind" | "createdAt" | "attachmentCount">;

function queueSummary(item: QueuedChatPersistent): QueuedChatSummary {
  if (typeof item.displayText !== "string" || (item.kind !== "queue" && item.kind !== "guide")
    || !Number.isFinite(item.createdAt) || !Number.isSafeInteger(item.attachmentCount) || item.attachmentCount < 0) {
    fail("invalid_state", "Invalid queued message summary");
  }
  let displayText = item.displayText;
  if (displayText.length > QUEUE_PREVIEW_CHARS) {
    displayText = displayText.slice(0, QUEUE_PREVIEW_CHARS - 1);
    const last = displayText.charCodeAt(displayText.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) displayText = displayText.slice(0, -1);
    displayText += "…";
  }
  return { id: item.id, displayText, kind: item.kind, createdAt: item.createdAt, attachmentCount: item.attachmentCount };
}

function fail(code: string, message: string): never { throw new SessionDatabaseError(code, message); }
function positive(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) fail("invalid_limit", "Invalid session read budget");
  return result;
}
function json(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    if (typeof result !== "string") throw new Error();
    return result;
  } catch { return fail("invalid_state", "Session state is not serializable"); }
}
function parse<T>(value: unknown): T {
  try { if (typeof value !== "string") throw new Error(); return JSON.parse(value) as T; }
  catch { return fail("corrupt", "Session database contains invalid JSON"); }
}
function metadata(state: SessionMetadata): SessionMetadata {
  if (!state || state.version !== 1 || typeof state.id !== "string" || !state.id
    || !Number.isSafeInteger(state.evSeq) || state.evSeq < 0) fail("invalid_state", "Invalid session metadata");
  if (typeof state.agent !== "string" || typeof state.title !== "string" || typeof state.cwd !== "string"
    || !Number.isFinite(state.createdAt) || !["strict", "standard", "yolo"].includes(state.approvalPolicy)
    || typeof state.preview !== "string" || typeof state.previewRaw !== "string" || typeof state.previewMsgId !== "string"
    || !state.totals || ![state.totals.costUsd, state.totals.inputTokens, state.totals.outputTokens].every(Number.isFinite)
    || !state.adapterState || typeof state.adapterState !== "object" || Array.isArray(state.adapterState)) {
    fail("invalid_state", "Invalid session metadata fields");
  }
  // A caller may pass a full state. Never duplicate large row collections in JSON.
  const { events: _events, toolOutputs: _tools, messageQueue: _queue,
    truncatedToolOutputs: _truncated, historyPage: _page, toolOutputsPage: _toolPage, ...rest
  } = state as StoredSessionState;
  return rest;
}

/** One owner writes each session database; readers use short snapshot transactions. */
export class SessionDatabase {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly readOnly: boolean;
  private closed = false;
  private importing: { token: string; id: string; events: number; queue: number } | null = null;

  constructor(file: string, options: { readOnly?: boolean } = {}) {
    this.readOnly = options.readOnly === true;
    this.db = openPrivateSqlite(file, options);
    try {
      const application = Number(this.db.prepare("PRAGMA application_id").get()?.["application_id"]);
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"]);
      if (application === 0 && version === 0 && !this.readOnly
        && !this.db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()) {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE sessions(id TEXT PRIMARY KEY, metadata TEXT NOT NULL, metadata_bytes INTEGER NOT NULL,
            ev_seq INTEGER NOT NULL CHECK(ev_seq >= 0)) STRICT;
          CREATE TABLE session_events(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE ON UPDATE CASCADE,
            seq INTEGER NOT NULL CHECK(seq > 0), body TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0),
            PRIMARY KEY(session_id,seq)) STRICT;
          CREATE TABLE session_tool_outputs(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE ON UPDATE CASCADE,
            call_id TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0),
            truncated INTEGER NOT NULL CHECK(truncated IN (0,1)), PRIMARY KEY(session_id,call_id)) STRICT;
          CREATE TABLE session_tool_output_chunks(session_id TEXT NOT NULL, call_id TEXT NOT NULL, part INTEGER NOT NULL,
            body BLOB NOT NULL CHECK(length(body) BETWEEN 1 AND 65536), PRIMARY KEY(session_id,call_id,part),
            FOREIGN KEY(session_id,call_id) REFERENCES session_tool_outputs(session_id,call_id) ON DELETE CASCADE ON UPDATE CASCADE) STRICT;
          CREATE TABLE session_message_queue(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE ON UPDATE CASCADE,
            position INTEGER NOT NULL, queue_id TEXT NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0),
            summary TEXT NOT NULL CHECK(length(summary) <= 8192),
            PRIMARY KEY(session_id,queue_id), UNIQUE(session_id,position)) STRICT;
          CREATE INDEX session_queue_summaries ON session_message_queue(session_id,position,summary);
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
      } else if (application !== APPLICATION_ID || version !== SCHEMA_VERSION) {
        fail("unsupported_version", "Unrecognized session database format or version");
      }
      // Schema checks are bounded; do not scan all transcript pages at startup.
      const tables = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name LIMIT 6").all();
      if (tables.map((row) => row["name"]).join(",") !== "session_events,session_message_queue,session_tool_output_chunks,session_tool_outputs,sessions"
        || this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('trigger','view') LIMIT 1").get()) {
        fail("corrupt", "Unrecognized session database schema");
      }
      this.db.prepare("SELECT id,metadata,metadata_bytes,ev_seq FROM sessions LIMIT 0");
      this.db.prepare("SELECT session_id,seq,body,bytes FROM session_events LIMIT 0");
      this.db.prepare("SELECT session_id,call_id,bytes,truncated FROM session_tool_outputs LIMIT 0");
      this.db.prepare("SELECT session_id,call_id,part,body FROM session_tool_output_chunks LIMIT 0");
      this.db.prepare("SELECT session_id,position,queue_id,body,bytes,summary FROM session_message_queue LIMIT 0");
    } catch (error) {
      this.db.close();
      if (error instanceof SessionDatabaseError) throw error;
      fail("corrupt", "Session database is unreadable or corrupt");
    }
  }

  private statement(sql: string): StatementSync {
    if (this.closed) fail("closed", "Session database is closed");
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  private transaction<T>(write: boolean, action: () => T): T {
    if (this.closed) fail("closed", "Session database is closed");
    if (this.importing) fail("import_active", "A session import is still active");
    if (write && this.readOnly) fail("read_only", "Session database is read-only");
    this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
      if (error instanceof SessionDatabaseError) throw error;
      fail("operation_failed", "Session database operation failed");
    }
  }

  hasSession(id: string): boolean {
    return !!this.statement("SELECT 1 FROM sessions WHERE id=?").get(id);
  }
  listSessionIds(): string[] {
    // The result grows only with session count, never with event or body size.
    return this.statement("SELECT id FROM sessions ORDER BY id").all().map((row) => String(row["id"]));
  }
  deleteSession(id: string): void {
    this.transaction(true, () => { this.statement("DELETE FROM sessions WHERE id=?").run(id); });
  }

  /** Events append and tools merge. Omitted old suffix rows are never removed. */
  saveSession(state: StructuredSessionPersistentState): void {
    const meta = metadata(state);
    if (!Array.isArray(state.events) || state.events.length > state.evSeq || !Array.isArray(state.toolOutputs)) {
      fail("invalid_state", "Invalid session row collections");
    }
    this.transaction(true, () => {
      const previous = this.statement("SELECT ev_seq FROM sessions WHERE id=?").get(state.id);
      const cursor = previous ? Number(previous["ev_seq"]) : 0;
      if (state.evSeq < cursor) fail("stale_state", "Session cursor cannot move backwards");
      const start = state.evSeq - state.events.length + 1;
      if (previous && state.evSeq > cursor && start > cursor + 1) {
        fail("event_gap", "Session update is missing new events");
      }
      const serialized = json(meta);
      this.statement(`INSERT INTO sessions(id,metadata,metadata_bytes,ev_seq) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,metadata_bytes=excluded.metadata_bytes,ev_seq=excluded.ev_seq
        WHERE sessions.metadata<>excluded.metadata OR sessions.ev_seq<>excluded.ev_seq`).run(
        state.id, serialized, Buffer.byteLength(serialized), state.evSeq,
      );
      for (let index = Math.max(0, cursor - start + 1); index < state.events.length; index++) {
        this.writeEvent(state.id, start + index, state.events[index]!);
      }
      const truncated = new Set(state.truncatedToolOutputs ?? []);
      for (const [callId, output] of state.toolOutputs) this.writeTool(state.id, callId, output, truncated.has(callId));
      if (state.messageQueue !== undefined) this.writeQueue(state.id, state.messageQueue);
    });
  }
  private writeEvent(id: string, seq: number, body: AgentEventBody): void {
    if (!body || typeof body.kind !== "string") fail("invalid_state", "Invalid session event");
    const serialized = json(body);
    this.statement("INSERT INTO session_events(session_id,seq,body,bytes) VALUES(?,?,?,?)")
      .run(id, seq, serialized, Buffer.byteLength(serialized));
  }
  private writeTool(id: string, callId: string, output: string, truncated: boolean): void {
    if (typeof callId !== "string" || !callId || typeof output !== "string") fail("invalid_state", "Invalid tool output");
    this.statement(`INSERT INTO session_tool_outputs(session_id,call_id,bytes,truncated) VALUES(?,?,?,?)
      ON CONFLICT(session_id,call_id) DO UPDATE SET bytes=excluded.bytes,truncated=excluded.truncated`)
      .run(id, callId, Buffer.byteLength(output), truncated ? 1 : 0);
    this.statement("DELETE FROM session_tool_output_chunks WHERE session_id=? AND call_id=?").run(id, callId);
    let part = 0;
    for (let offset = 0; offset < output.length;) {
      let end = Math.min(offset + TOOL_CHUNK_CHARS, output.length);
      // Keep surrogate pairs intact before converting a bounded slice to UTF-8.
      const last = output.charCodeAt(end - 1), next = output.charCodeAt(end);
      if (end < output.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
      const body = Buffer.from(output.slice(offset, end));
      this.statement("INSERT INTO session_tool_output_chunks(session_id,call_id,part,body) VALUES(?,?,?,?)").run(id, callId, part++, body);
      offset = end;
    }
  }
  private writeQueue(id: string, queue: QueuedChatPersistent[]): void {
    if (queue.length > 10_000) fail("invalid_state", "Session queue is too large");
    const keys = new Set(queue.map((item) => item.id));
    if (keys.size !== queue.length) fail("invalid_state", "Duplicate queued message");
    const previous = this.statement("SELECT queue_id,position FROM session_message_queue WHERE session_id=? ORDER BY position LIMIT 10001").all(id);
    if (previous.length > 10_000) fail("corrupt", "Stored session queue is too large");
    const reorder = previous.some((row, index) => row["queue_id"] !== queue[index]?.id);
    if (reorder) {
      // Stage only order values to avoid unique-position collisions. Unchanged
      // queue bodies are not deleted/reinserted on every metadata checkpoint.
      this.statement("UPDATE session_message_queue SET position=-position-1 WHERE session_id=?").run(id);
    }
    for (const row of previous) {
      if (!keys.has(String(row["queue_id"]))) this.statement("DELETE FROM session_message_queue WHERE session_id=? AND queue_id=?").run(id, row["queue_id"]!);
    }
    for (let position = 0; position < queue.length; position++) {
      const item = queue[position]!;
      if (!item || typeof item.id !== "string" || !item.id) fail("invalid_state", "Invalid queued message");
      const serialized = json(item);
      this.statement(`INSERT INTO session_message_queue(session_id,position,queue_id,body,bytes,summary) VALUES(?,?,?,?,?,?)
        ON CONFLICT(session_id,queue_id) DO UPDATE SET position=excluded.position,body=excluded.body,bytes=excluded.bytes,summary=excluded.summary
        WHERE session_message_queue.position<>excluded.position OR session_message_queue.body<>excluded.body`)
        .run(id, position, item.id, serialized, Buffer.byteLength(serialized), json(queueSummary(item)));
    }
  }
  private writeQueueEntry(id: string, position: number, item: QueuedChatPersistent): void {
    if (!item || typeof item.id !== "string" || !item.id) fail("invalid_state", "Invalid queued message");
    const serialized = json(item);
    this.statement("INSERT INTO session_message_queue(session_id,position,queue_id,body,bytes,summary) VALUES(?,?,?,?,?,?)")
      .run(id, position, item.id, serialized, Buffer.byteLength(serialized), json(queueSummary(item)));
  }
  /** No queue body, outgoing text, attachment reference or path is read. */
  readQueueSummary(id: string): QueuedChatSummary[] {
    return this.transaction(false, () => {
      // A covering index ensures SQLite never visits the potentially huge body
      // column, rather than applying json_extract/substr to that column.
      const rows = this.statement(`SELECT summary FROM session_message_queue INDEXED BY session_queue_summaries
        WHERE session_id=? ORDER BY position LIMIT 10001`).all(id);
      if (rows.length > 10_000) fail("queue_too_large", "Session queue exceeds the read budget");
      return rows.map((row) => {
        const item = parse<QueuedChatSummary>(row["summary"]);
        if (!item || typeof item.id !== "string" || typeof item.displayText !== "string"
          || item.displayText.length > QUEUE_PREVIEW_CHARS || !["queue", "guide"].includes(item.kind)
          || !Number.isFinite(item.createdAt) || !Number.isSafeInteger(item.attachmentCount) || item.attachmentCount < 0) {
          fail("corrupt", "Invalid stored queue summary");
        }
        return { id: item.id, displayText: item.displayText, kind: item.kind, createdAt: item.createdAt, attachmentCount: item.attachmentCount };
      });
    });
  }
  saveToolOutput(id: string, callId: string, output: string, truncated = false): void {
    this.transaction(true, () => { this.writeTool(id, callId, output, truncated); });
  }
  toolOutput(id: string, callId: string, options: { maxBytes?: number } = {}): { output: string; truncated: boolean } | null {
    return this.transaction(false, () => {
      const result = this.readTool(id, callId, options);
      if (!result || options.maxBytes !== undefined) return result;
      // Preserve the existing public tool.output limit in UTF-16 code units.
      // The chunk reader first applies a fixed byte ceiling, so compatibility
      // never requires loading the entire durable tool body into memory.
      return {
        output: result.output.slice(0, DEFAULT_TOOL_CHARS),
        truncated: result.truncated || result.output.length > DEFAULT_TOOL_CHARS,
      };
    });
  }
  private readTool(id: string, callId: string, options: { maxBytes?: number }): { output: string; truncated: boolean } | null {
    const maxBytes = positive(options.maxBytes, DEFAULT_TOOL_BYTES);
    const row = this.statement("SELECT bytes,truncated FROM session_tool_outputs WHERE session_id=? AND call_id=?").get(id, callId);
    if (!row) return null;
    const bytes = Number(row["bytes"]);
    if (!Number.isSafeInteger(bytes) || bytes < 0) fail("corrupt", "Invalid stored tool size");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunks: string[] = [];
    let remaining = Math.min(bytes, maxBytes), part = 0;
    while (remaining > 0) {
      const chunk = this.statement("SELECT body FROM session_tool_output_chunks WHERE session_id=? AND call_id=? AND part=?")
        .get(id, callId, part++);
      const body = chunk?.["body"];
      if (!(body instanceof Uint8Array) || body.length === 0 || body.length > TOOL_CHUNK_CHARS * 4) {
        fail("corrupt", "Missing or invalid stored tool chunk");
      }
      if (maxBytes >= bytes && body.length > remaining) fail("corrupt", "Inconsistent stored tool size");
      // Only a bounded chunk enters SQLite or JS memory, even for a huge tool.
      try { chunks.push(decoder.decode(body.subarray(0, remaining), { stream: true })); }
      catch { fail("corrupt", "Invalid stored tool encoding"); }
      remaining -= Math.min(remaining, body.length);
    }
    if (maxBytes >= bytes) {
      try { chunks.push(decoder.decode()); } catch { fail("corrupt", "Invalid stored tool encoding"); }
    }
    return { output: chunks.join(""), truncated: row["truncated"] === 1 || bytes > maxBytes };
  }

  readEventsPage(id: string, options: SessionEventsPageOptions = {}): SessionEventsPage {
    return this.transaction(false, () => this.eventsPage(id, options));
  }
  private eventsPage(id: string, options: SessionEventsPageOptions): SessionEventsPage {
    const limit = positive(options.limit, DEFAULT_LIMIT);
    const maxBytes = positive(options.maxBytes, DEFAULT_MAX_BYTES);
    const beforeSeq = options.beforeSeq === undefined ? Number.MAX_SAFE_INTEGER + 1 : positive(options.beforeSeq, 1);
    const row = this.statement("SELECT ev_seq FROM sessions WHERE id=?").get(id);
    const lastSeq = row ? Number(row["ev_seq"]) : 0;
    const selected: number[] = [];
    let bytes = 0, cursor = beforeSeq, hasMore = false;
    let oversized: SessionEventsPage["oversized"];
    outer: while (selected.length < limit) {
      const batchSize = Math.min(HEAD_BATCH, limit - selected.length + 1);
      const heads = this.statement(`SELECT seq,bytes FROM session_events WHERE session_id=? AND seq<?
        ORDER BY seq DESC LIMIT ?`).all(id, cursor, batchSize);
      if (!heads.length) break;
      for (const head of heads) {
        const seq = Number(head["seq"]), size = Number(head["bytes"]);
        if (!Number.isSafeInteger(size) || size < 0) fail("corrupt", "Invalid stored event size");
        if (selected.length === limit || size > maxBytes - bytes) {
          hasMore = true;
          if (size > maxBytes) oversized = { seq, bytes: size };
          break outer;
        }
        selected.push(seq); bytes += size; cursor = seq;
      }
      if (heads.length < batchSize) break;
    }
    // Handles an exact full batch without reading any additional event body.
    if (!hasMore && selected.length) hasMore = !!this.statement(
      "SELECT 1 FROM session_events WHERE session_id=? AND seq<? LIMIT 1",
    ).get(id, selected[selected.length - 1]!);
    const events = selected.reverse().map((seq) => {
      const event = this.statement("SELECT body FROM session_events WHERE session_id=? AND seq=?").get(id, seq);
      return { seq, body: parse<AgentEventBody>(event?.["body"]) };
    });
    return { events, lastSeq, oldestSeq: selected[0] ?? 0, hasMore, ...(oversized ? { oversized } : {}) };
  }

  readSession(id: string, options: SessionReadOptions = {}): StoredSessionState | null {
    return this.transaction(false, () => {
      const maxBytes = positive(options.maxBytes, DEFAULT_MAX_BYTES);
      const head = this.statement("SELECT metadata_bytes,ev_seq FROM sessions WHERE id=?").get(id);
      if (!head) return null;
      if (Number(head["metadata_bytes"]) > maxBytes) fail("metadata_too_large", "Session metadata exceeds the read budget");
      const row = this.statement("SELECT metadata FROM sessions WHERE id=?").get(id);
      const meta = parse<SessionMetadata>(row?.["metadata"]);
      if (meta.id !== id || meta.evSeq !== Number(head["ev_seq"]) || meta.version !== 1) fail("corrupt", "Inconsistent session metadata");
      try { metadata(meta); } catch { fail("corrupt", "Invalid stored session metadata"); }
      const result: StoredSessionState = { ...meta, events: [], toolOutputs: [], messageQueue: [] };
      if (options.events !== false) {
        const { events, ...page } = this.eventsPage(id, options);
        result.events = events.map((entry) => entry.body); result.historyPage = page;
      }
      if (options.toolOutputs !== false) {
        const limit = positive(options.limit, DEFAULT_LIMIT);
        let remaining = maxBytes, cursor = "", hasMore = false;
        const truncated: string[] = [];
        outer: while (result.toolOutputs.length < limit) {
          const batchSize = Math.min(HEAD_BATCH, limit - result.toolOutputs.length + 1);
          const heads = this.statement(`SELECT call_id,bytes FROM session_tool_outputs WHERE session_id=? AND call_id>?
            ORDER BY call_id LIMIT ?`).all(id, cursor, batchSize);
          for (const tool of heads) {
            if (remaining === 0 || result.toolOutputs.length === limit) { hasMore = true; break outer; }
            const callId = String(tool["call_id"]);
            const value = this.readTool(id, callId, { maxBytes: remaining })!;
            result.toolOutputs.push([callId, value.output]); cursor = callId;
            remaining -= Math.min(remaining, Number(tool["bytes"]));
            if (value.truncated) truncated.push(callId);
          }
          if (heads.length < batchSize) break;
        }
        if (!hasMore && cursor) hasMore = !!this.statement("SELECT 1 FROM session_tool_outputs WHERE session_id=? AND call_id>? LIMIT 1").get(id, cursor);
        if (truncated.length) result.truncatedToolOutputs = truncated;
        result.toolOutputsPage = { hasMore };
      }
      if (options.messageQueue !== false) {
        // A partial queue must never masquerade as the authoritative queue: an
        // owner could otherwise delete its unread entries on the next save.
        const heads = this.statement(`SELECT queue_id,bytes FROM session_message_queue WHERE session_id=?
          ORDER BY position LIMIT 10001`).all(id);
        let remaining = maxBytes;
        if (heads.length > 10_000) fail("queue_too_large", "Session queue exceeds the read budget");
        for (const item of heads) {
          const bytes = Number(item["bytes"]);
          if (bytes > remaining) fail("queue_too_large", "Session queue exceeds the read budget");
          remaining -= bytes;
          const value = this.statement("SELECT body FROM session_message_queue WHERE session_id=? AND queue_id=?").get(id, item["queue_id"]!);
          result.messageQueue!.push(parse<QueuedChatPersistent>(value?.["body"]));
        }
      }
      return result;
    });
  }

  /** Streaming legacy import; transaction is invisible until validated finish. */
  beginSessionImport(): string {
    if (this.closed || this.importing || this.readOnly) fail("import_unavailable", "Session import cannot start");
    const token = `import_${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    this.importing = { token, id: token, events: 0, queue: 0 };
    this.statement("INSERT INTO sessions(id,metadata,metadata_bytes,ev_seq) VALUES(?,?,?,?)").run(token, "{}", 2, 0);
    return token;
  }
  private importContext(token: string): NonNullable<SessionDatabase["importing"]> {
    if (!this.importing || this.importing.token !== token) fail("invalid_import", "Unknown session import");
    return this.importing;
  }
  identifySessionImport(token: string, id: string): void {
    const context = this.importContext(token);
    if (typeof id !== "string" || !id) fail("invalid_state", "Invalid session identity");
    if (context.id === id) return;
    this.statement("UPDATE sessions SET id=? WHERE id=?").run(id, context.id);
    context.id = id;
  }
  appendSessionImportEvent(token: string, body: AgentEventBody): void {
    const context = this.importContext(token);
    this.writeEvent(context.id, context.events + 1, body); context.events++;
  }
  setSessionImportToolOutput(token: string, callId: string, output: string, truncated = false): void {
    this.writeTool(this.importContext(token).id, callId, output, truncated);
  }
  appendSessionImportQueueEntry(token: string, item: QueuedChatPersistent): void {
    const context = this.importContext(token);
    this.writeQueueEntry(context.id, context.queue, item); context.queue++;
  }
  private *finishImportBatches(token: string, state: SessionMetadata): Generator<void> {
    const context = this.importContext(token);
    try {
      const meta = metadata(state);
      if (state.evSeq < context.events) fail("invalid_state", "Legacy event cursor precedes its history");
      const offset = state.evSeq - context.events;
      if (offset) {
        // Descending updates avoid primary-key collisions when a retained suffix
        // starts above 1, keeping memory fixed and CHECK(seq>0) valid.
        const update = this.statement("UPDATE session_events SET seq=? WHERE session_id=? AND seq=?");
        for (let seq = context.events; seq > 0; seq--) {
          update.run(seq + offset, context.id, seq);
          if (seq % 128 === 0) yield;
        }
      }
      for (const callId of state.truncatedToolOutputs ?? []) {
        this.statement("UPDATE session_tool_outputs SET truncated=1 WHERE session_id=? AND call_id=?").run(context.id, callId);
      }
      const serialized = json(meta);
      this.statement("UPDATE sessions SET id=?,metadata=?,metadata_bytes=?,ev_seq=? WHERE id=?")
        .run(state.id, serialized, Buffer.byteLength(serialized), state.evSeq, context.id);
      this.db.exec("COMMIT"); this.importing = null;
    } catch (error) {
      this.abortSessionImport(token);
      if (error instanceof SessionDatabaseError) throw error;
      fail("import_failed", "Session import could not be committed");
    }
  }
  finishSessionImport(token: string, state: SessionMetadata): void {
    for (const _batch of this.finishImportBatches(token, state)) {}
  }
  async finishSessionImportAsync(token: string, state: SessionMetadata): Promise<void> {
    let sliceStarted = performance.now();
    for (const _batch of this.finishImportBatches(token, state)) {
      if (performance.now() - sliceStarted >= 8) {
        await yieldToEventLoop();
        sliceStarted = performance.now();
      }
    }
  }
  abortSessionImport(token: string): void {
    this.importContext(token);
    try { this.db.exec("ROLLBACK"); } finally { this.importing = null; }
  }
  close(): void {
    if (this.closed) return;
    if (this.importing) this.abortSessionImport(this.importing.token);
    this.db.close(); this.statements.clear(); this.closed = true;
  }
}
