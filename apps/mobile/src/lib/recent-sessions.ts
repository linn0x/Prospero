import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SessionInfo } from "@prospero/protocol";

export const RECENT_SESSION_LIMIT = 200;
export const RECENT_SESSION_HOST_LIMIT = 100;
export const RECENT_SUMMARY_LIMIT = 160;
const STORAGE_KEY = "prospero.recentSessions.v1";
const MAX_STORED_CHARS = 256 * 1024;
const ACTIVITY_PUBLISH_MS = 250;
const EMPTY: Readonly<Record<string, RecentSession>> = Object.freeze({});

export interface RecentSession {
  hostId: string;
  sessionId: string;
  openedAt: number;
  activityAt: number;
  summaryAt: number;
  summary: string;
}

/** Bound work before normalizing: a multi-megabyte prompt never enters this index. */
export function recentSessionSummary(text: string | undefined): string {
  const clean = (text ?? "").slice(0, 1024)
    .replace(/[\u0000-\u001f\u007f\s]+/gu, " ")
    .replace(/^[#>`*\s]+/u, "").trim();
  if (clean.length <= RECENT_SUMMARY_LIMIT) return clean;
  return `${clean.slice(0, RECENT_SUMMARY_LIMIT - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}

export function recentSessionTime(session: SessionInfo, recent?: RecentSession): number {
  return Math.max(session.createdAt, session.busySince ?? 0, recent?.openedAt ?? 0, recent?.activityAt ?? 0);
}

/** A snapshot/reconnect is a baseline, not activity. Only compare live, known sessions. */
export function sessionActivityChanged(previous: SessionInfo | undefined, next: SessionInfo): boolean {
  if (!previous) return false;
  const preview = recentSessionSummary(next.preview);
  return (next.busySince ?? 0) > (previous.busySince ?? 0)
    || (next.totals?.inputTokens ?? 0) > (previous.totals?.inputTokens ?? 0)
    || (next.totals?.outputTokens ?? 0) > (previous.totals?.outputTokens ?? 0)
    || (Boolean(preview) && preview !== recentSessionSummary(previous.preview));
}

interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

function identity(record: Pick<RecentSession, "hostId" | "sessionId">): string {
  return JSON.stringify([record.hostId, record.sessionId]);
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parse(raw: string | null): RecentSession[] {
  if (!raw || raw.length > MAX_STORED_CHARS) return [];
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.slice(0, RECENT_SESSION_LIMIT).flatMap((value: unknown) => {
      if (!value || typeof value !== "object") return [];
      const entry = value as Partial<RecentSession>;
      if (typeof entry.hostId !== "string" || !entry.hostId || entry.hostId.length > 200
        || typeof entry.sessionId !== "string" || !entry.sessionId || entry.sessionId.length > 200
        || !validTime(entry.openedAt) || !validTime(entry.activityAt) || !validTime(entry.summaryAt)
        || typeof entry.summary !== "string") return [];
      return [{ ...entry, summary: recentSessionSummary(entry.summary) } as RecentSession];
    });
  } catch { return []; }
}

function merge(a: RecentSession | undefined, b: RecentSession): RecentSession {
  if (!a) return b;
  return {
    ...a,
    openedAt: Math.max(a.openedAt, b.openedAt),
    activityAt: Math.max(a.activityAt, b.activityAt),
    ...(b.summaryAt >= a.summaryAt && b.summary
      ? { summary: b.summary, summaryAt: b.summaryAt } : {}),
  };
}

/** Tiny bounded index; hydration merges newer local opens and slow writes coalesce dirty state. */
export function createRecentSessionStore(storage: Storage, now: () => number = Date.now) {
  let entries = new Map<string, RecentSession>();
  const snapshots = new Map<string, Readonly<Record<string, RecentSession>>>();
  const listeners = new Set<() => void>();
  let loading: Promise<void> | undefined;
  let loaded = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingPublish = false;
  let writing: Promise<void> | undefined;

  const retain = () => {
    const hostCounts = new Map<string, number>();
    let storedChars = 32;
    const ordered = [...entries.values()].sort((a, b) =>
      Math.max(b.openedAt, b.activityAt) - Math.max(a.openedAt, a.activityAt)
      || identity(a).localeCompare(identity(b)));
    entries = new Map(ordered.filter((entry) => {
      const count = (hostCounts.get(entry.hostId) ?? 0) + 1;
      const chars = JSON.stringify(entry).length + 1;
      if (count > RECENT_SESSION_HOST_LIMIT || storedChars + chars > MAX_STORED_CHARS) return false;
      hostCounts.set(entry.hostId, count);
      storedChars += chars;
      return true;
    }).slice(0, RECENT_SESSION_LIMIT).map((entry) => [identity(entry), entry]));
  };

  const trimOnInsert = (hostId: string) => {
    // More active sessions than the recent-list capacity must not put full JSON
    // serialization back on every event. Evict at most one row per insertion.
    const oldest = (host?: string): string | undefined => {
      let key: string | undefined;
      let time = Infinity;
      for (const [candidate, entry] of entries) {
        if (host !== undefined && entry.hostId !== host) continue;
        const usedAt = Math.max(entry.openedAt, entry.activityAt);
        if (usedAt < time || (usedAt === time && key !== undefined && candidate.localeCompare(key) > 0)) {
          key = candidate;
          time = usedAt;
        }
      }
      return key;
    };
    let hostCount = 0;
    for (const entry of entries.values()) if (entry.hostId === hostId) hostCount++;
    if (hostCount > RECENT_SESSION_HOST_LIMIT) {
      const key = oldest(hostId);
      if (key !== undefined) entries.delete(key);
    }
    if (entries.size > RECENT_SESSION_LIMIT) {
      const key = oldest();
      if (key !== undefined) entries.delete(key);
    }
  };

  const publish = () => {
    if (publishTimer !== undefined) clearTimeout(publishTimer);
    publishTimer = undefined;
    pendingPublish = false;
    retain();
    // useSyncExternalStore compares snapshot identity. Another host's activity must
    // not invalidate the current home's snapshot; eviction still invalidates its owner.
    const retainedCounts = new Map<string, number>();
    for (const entry of entries.values()) retainedCounts.set(entry.hostId, (retainedCounts.get(entry.hostId) ?? 0) + 1);
    for (const [hostId, snapshot] of snapshots) {
      const previous = Object.values(snapshot);
      if (previous.length !== (retainedCounts.get(hostId) ?? 0)
        || previous.some((entry) => entries.get(identity(entry)) !== entry)) snapshots.delete(hostId);
    }
    for (const listener of listeners) listener();
  };

  const flush = async (): Promise<void> => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    await load();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (pendingPublish) publish();
    if (writing) return writing;
    if (!dirty) return;
    let failed = false;
    writing = (async () => {
      // Retain one in-flight payload only. Changes during that write stay in the
      // bounded index and become one latest payload after it completes.
      while (dirty) {
        dirty = false;
        try {
          if (pendingPublish) retain();
          await storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries: [...entries.values()] }));
        } catch {
          // Keep dirty state for the next activity/explicit flush; do not spin on failure.
          dirty = true;
          failed = true;
          return;
        }
      }
    })().finally(() => {
      writing = undefined;
      // A mutation can arrive between the drain's last check and this finalizer.
      if (dirty && !failed) schedule();
    });
    return writing;
  };

  const schedule = () => {
    if (!writing && timer === undefined) timer = setTimeout(() => { void flush(); }, 500);
  };

  const load = (): Promise<void> => {
    loading ??= (async () => {
      let stored: RecentSession[] = [];
      try { stored = parse(await storage.getItem(STORAGE_KEY)); } catch { /* best effort */ }
      for (const entry of stored) entries.set(identity(entry), merge(entry, entries.get(identity(entry)) ?? entry));
      loaded = true;
      publish();
      if (dirty) schedule();
    })();
    return loading;
  };

  const record = (hostId: string, sessionId: string, kind: "open" | "activity", text?: string) => {
    if (!hostId || !sessionId || hostId.length > 200 || sessionId.length > 200) return;
    const time = now();
    const key = identity({ hostId, sessionId });
    const current = entries.get(key);
    const summary = recentSessionSummary(text);
    entries.set(key, merge(current, {
      hostId, sessionId, openedAt: kind === "open" ? time : 0,
      activityAt: kind === "activity" ? time : 0,
      summaryAt: summary ? time : 0, summary,
    }));
    dirty = true;
    if (kind === "open") {
      // Explicit navigation should reorder immediately. Streaming metadata only
      // replaces one bounded row here; sorting/serialization/notification is batched.
      publish();
    } else {
      if (!current) trimOnInsert(hostId);
      pendingPublish = true;
      if (publishTimer === undefined) publishTimer = setTimeout(publish, ACTIVITY_PUBLISH_MS);
    }
    if (loaded) schedule();
    else void load();
  };

  return {
    load, flush,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getHost: (hostId: string | undefined): Readonly<Record<string, RecentSession>> => {
      if (!hostId) return EMPTY;
      let snapshot = snapshots.get(hostId);
      if (!snapshot) {
        const matching = [...entries.values()].filter((entry) => entry.hostId === hostId);
        if (!matching.length) return EMPTY;
        snapshot = Object.fromEntries(matching.map((entry) => [entry.sessionId, entry]));
        snapshots.set(hostId, snapshot);
      }
      return snapshot;
    },
    opened: (hostId: string, sessionId: string) => record(hostId, sessionId, "open"),
    activity: (hostId: string, sessionId: string, text?: string) => record(hostId, sessionId, "activity", text),
  };
}

export const recentSessions = createRecentSessionStore(AsyncStorage);
