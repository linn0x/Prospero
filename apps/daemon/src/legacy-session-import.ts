import { createReadStream, existsSync, linkSync, lstatSync, openSync, closeSync, fsyncSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import makeParser from "stream-json";
import type { AgentEventBody } from "@prospero/protocol";
import { SessionDatabase } from "./session-database.js";
import { createStructuredHistorySummaryAccumulator, type QueuedChatPersistent, type StructuredSessionPersistentState } from "./structured-session.js";

export type JsonPath = readonly (string | number)[];
export interface JsonStreamObserver {
  onContainer?: (path: JsonPath, kind: "array" | "object") => void;
  onContainerEnd?: (path: JsonPath, kind: "array" | "object") => void;
  onValue?: (path: JsonPath, kind: "null" | "string" | "number" | "boolean") => void;
}
type Frame = { path: (string | number)[]; kind: "array" | "object"; index: number; key?: string; keys: Set<string>; value?: unknown[] | Record<string, unknown>; selected: boolean };
type Token = { name: string; value?: string | boolean | null };

/**
 * Mature tokenizer owns JSON syntax, escaping, UTF-8 boundaries and strict EOF.
 * Memory is bounded by the selected value, one packed string/key and nesting;
 * select events individually rather than selecting their enclosing history.
 * Duplicate object keys are rejected because incremental imports cannot safely
 * reproduce a later replacement of a previously streamed collection.
 */
export async function* streamJsonValues(
  file: string,
  select: (path: JsonPath) => boolean,
  observer: JsonStreamObserver = {},
): AsyncGenerator<{ path: (string | number)[]; value: unknown }> {
  const source = createReadStream(file, { highWaterMark: 64 * 1024 });
  const parser = makeParser({ packValues: true, streamValues: false, jsonStreaming: false });
  const completed = pipeline(source, parser);
  void completed.catch(() => {});
  const frames: Frame[] = [];
  let capturing = false;
  let roots = 0;
  const nextPath = (): (string | number)[] => {
    const parent = frames.at(-1);
    if (!parent) return [];
    if (parent.kind === "array") return [...parent.path, parent.index];
    if (parent.key === undefined) throw new Error("Missing JSON object key");
    return [...parent.path, parent.key];
  };
  const accept = (value: unknown): void => {
    const parent = frames.at(-1);
    if (!parent) { roots++; return; }
    if (parent.value !== undefined) {
      if (Array.isArray(parent.value)) parent.value.push(value);
      else Object.defineProperty(parent.value, parent.key!, { value, enumerable: true, writable: true, configurable: true });
    }
    if (parent.kind === "array") parent.index++;
    else delete parent.key;
  };
  try {
    for await (const raw of parser) {
      const token = raw as Token;
      if (token.name === "keyValue") {
        const parent = frames.at(-1);
        if (!parent || parent.kind !== "object" || typeof token.value !== "string") throw new Error("Invalid JSON key");
        if (parent.keys.has(token.value)) throw new Error("Duplicate JSON object key");
        parent.keys.add(token.value); parent.key = token.value;
      } else if (token.name === "startObject" || token.name === "startArray") {
        const currentPath = nextPath();
        const kind = token.name === "startArray" ? "array" : "object";
        observer.onContainer?.(currentPath, kind);
        const selected: boolean = !capturing && select(currentPath);
        capturing ||= selected;
        frames.push({ path: currentPath, kind, index: 0, keys: new Set(), selected,
          ...(capturing ? { value: kind === "array" ? [] : Object.create(null) as Record<string, unknown> } : {}) });
      } else if (token.name === "endObject" || token.name === "endArray") {
        const frame = frames.pop();
        if (!frame) throw new Error("Unexpected JSON container end");
        observer.onContainerEnd?.(frame.path, frame.kind);
        accept(frame.value);
        if (frame.selected) { capturing = false; yield { path: frame.path, value: frame.value }; }
      } else if (["stringValue", "numberValue", "trueValue", "falseValue", "nullValue"].includes(token.name)) {
        const currentPath = nextPath();
        const value = token.name === "numberValue" ? Number(token.value)
          : token.name === "trueValue" ? true : token.name === "falseValue" ? false
            : token.name === "nullValue" ? null : token.value;
        observer.onValue?.(currentPath, value === null ? "null" : typeof value as "string" | "number" | "boolean");
        const selected: boolean = !capturing && select(currentPath);
        accept(value);
        if (selected) yield { path: currentPath, value };
      }
    }
    await completed;
    if (roots !== 1 || frames.length) throw new Error("Incomplete JSON document");
  } finally {
    source.destroy(); parser.destroy();
    await completed.catch(() => {});
  }
}

export interface LegacySessionMigrationOptions {
  array: boolean;
  excludeSessionIds?: ReadonlySet<string>;
  isSafeToPublish?: () => boolean;
}
export interface LegacySessionMigrationResult { migrated: boolean; sessionCount: number; eventCount: number }
const collections = new Set(["events", "toolOutputs", "messageQueue"]);
function absentResult(): LegacySessionMigrationResult { return { migrated: false, sessionCount: 0, eventCount: 0 }; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** Import into a private sibling DB; atomically publish without replacing a winner. Original JSON is never removed. */
export async function migrateLegacySessionFile(
  jsonPath: string,
  dbPath: string,
  options: LegacySessionMigrationOptions,
): Promise<LegacySessionMigrationResult> {
  if (existsSync(dbPath) || !existsSync(jsonPath)) return absentResult();
  if (options.isSafeToPublish && !options.isSafeToPublish()) return absentResult();
  const original = lstatSync(jsonPath);
  if (!original.isFile() || original.isSymbolicLink()) throw new Error("Unsafe legacy session source");
  const staging = `${dbPath}.import-${randomUUID()}`;
  let db: SessionDatabase | undefined;
  let sessionCount = 0, eventCount = 0;
  let current: { token: string; metadata: Record<string, unknown>; fields: Set<string>; summary: ReturnType<typeof createStructuredHistorySummaryAccumulator>; events: number } | undefined;
  const base = options.array ? 1 : 0;
  let rootSeen = false;
  const finish = (): void => {
    if (!current || !db) throw new Error("Missing legacy session object");
    if (!current.fields.has("events") || !current.fields.has("toolOutputs")) throw new Error("Missing legacy session collections");
    const metadata = current.metadata;
    if (typeof metadata.id !== "string") throw new Error("Missing legacy session identity");
    if (metadata.historySummary === undefined) metadata.historySummary = current.summary.snapshot();
    if (options.excludeSessionIds?.has(metadata.id)) db.abortSessionImport(current.token);
    else {
      db.finishSessionImport(current.token, metadata as unknown as Omit<StructuredSessionPersistentState, "events" | "toolOutputs" | "messageQueue">);
      sessionCount++; eventCount += current.events;
    }
    current = undefined;
  };
  const validateShape = (p: JsonPath, kind: string): void => {
    if (p.length === 0) {
      if (kind !== (options.array ? "array" : "object")) throw new Error("Invalid legacy session root");
      rootSeen = true;
    }
    if (p.length === base && (!options.array || typeof p[0] === "number")) {
      if (kind !== "object" || current) throw new Error("Invalid legacy session entry");
      current = { token: db!.beginSessionImport(), metadata: Object.create(null) as Record<string, unknown>, fields: new Set(), summary: createStructuredHistorySummaryAccumulator(), events: 0 };
    }
    if (p.length === base + 1 && collections.has(String(p[base]))) {
      if (kind !== "array" || !current) throw new Error("Invalid legacy session collection");
      current.fields.add(String(p[base]));
    }
  };
  try {
    db = new SessionDatabase(staging);
    for await (const entry of streamJsonValues(jsonPath, (p) =>
      p.length === base + 1 ? !collections.has(String(p[base]))
        : p.length === base + 2 && collections.has(String(p[base])), {
      onContainer: validateShape,
      onValue: validateShape,
      onContainerEnd: (p) => { if (p.length === base) finish(); },
    })) {
      if (!current) throw new Error("Legacy value outside a session");
      const field = String(entry.path[base]);
      if (entry.path.length === base + 1) {
        Object.defineProperty(current.metadata, field, { value: entry.value, enumerable: true, writable: true, configurable: true });
      } else if (field === "events") {
        if (!record(entry.value) || typeof entry.value.kind !== "string") throw new Error("Invalid legacy event");
        const body = entry.value as unknown as AgentEventBody;
        db.appendSessionImportEvent(current.token, body); current.summary.push(body); current.events++;
      } else if (field === "toolOutputs") {
        if (!Array.isArray(entry.value) || entry.value.length !== 2 || typeof entry.value[0] !== "string" || typeof entry.value[1] !== "string") throw new Error("Invalid legacy tool output");
        db.setSessionImportToolOutput(current.token, entry.value[0], entry.value[1]);
      } else {
        if (!record(entry.value)) throw new Error("Invalid legacy queued message");
        db.appendSessionImportQueueEntry(current.token, entry.value as unknown as QueuedChatPersistent);
      }
    }
    if (!rootSeen || current) throw new Error("Incomplete legacy session file");
    db.close(); db = undefined;
    const after = lstatSync(jsonPath);
    if (original.dev !== after.dev || original.ino !== after.ino || original.size !== after.size || original.mtimeMs !== after.mtimeMs || original.ctimeMs !== after.ctimeMs) throw new Error("Legacy session source changed during import");
    if (options.isSafeToPublish && !options.isSafeToPublish()) return absentResult();
    const fd = openSync(staging, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(staging, dbPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return absentResult(); throw error; }
    unlinkSync(staging);
    if (process.platform !== "win32") {
      const directory = openSync(path.dirname(dbPath), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    return { migrated: true, sessionCount, eventCount };
  } finally {
    db?.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try { unlinkSync(staging + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
