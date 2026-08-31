/**
 * Bounded session views for the local desktop control plane.
 *
 * SessionManager intentionally retains terminal sessions so recoverable
 * orchestration history is available after a daemon restart.  That is the
 * wrong shape for the once-per-second desktop status snapshot, however: a
 * workstation with thousands of completed workers must not stringify and
 * render every historical session just to show the three that are running.
 */
import type { SessionInfo } from "@prospero/protocol";

export const STATUS_ATTENTION_LIMIT = 100;
export const STATUS_ACTIVE_LIMIT = 200;
export const STATUS_RECENT_TERMINAL_LIMIT = 50;

export type SessionStatusSummary = {
  total: number;
  /** Non-terminal sessions, including sessions awaiting user attention. */
  active: number;
  /** A subset of active sessions that require a decision or input. */
  attention: number;
  terminal: number;
  included: number;
  omitted: number;
  activeLimit: number;
  attentionLimit: number;
  recentTerminalLimit: number;
  truncated: boolean;
};

export type StatusSessionSelection = {
  sessions: SessionInfo[];
  summary: SessionStatusSummary;
};

export type SessionListPage = {
  items: SessionInfo[];
  /** Opaque cursor for the next older page, omitted at the end. */
  nextCursor?: string;
  /** Number of records after the requested terminal/search filters. */
  total: number;
  /** Counts over every locally retained session, not only this page. */
  active: number;
  terminal: number;
};

type Cursor = { createdAt: number; id: string };

export function isTerminalSession(session: Pick<SessionInfo, "status">): boolean {
  return session.status === "completed" || session.status === "done" || session.status === "died";
}

export function needsAttention(session: Pick<SessionInfo, "status" | "pendingPermissions" | "pendingQuestions">): boolean {
  return session.status === "waiting_approval"
    || session.status === "waiting_input"
    || (session.pendingPermissions ?? 0) > 0
    || (session.pendingQuestions ?? 0) > 0;
}

/** Newer first, with the id providing a deterministic ordering tie-breaker. */
function newestFirst(a: SessionInfo, b: SessionInfo): number {
  return b.createdAt - a.createdAt || b.id.localeCompare(a.id);
}

/** Keep the legacy chronological status-file presentation once candidates are selected. */
function oldestFirst(a: SessionInfo, b: SessionInfo): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

function matchesQuery(session: SessionInfo, rawQuery: string): boolean {
  if (!rawQuery) return true;
  const query = rawQuery.toLocaleLowerCase();
  return [session.id, session.title, session.cwd, session.agent, session.kind]
    .some((value) => value.toLocaleLowerCase().includes(query));
}

function encodeCursor(session: SessionInfo): string {
  return Buffer.from(JSON.stringify({ createdAt: session.createdAt, id: session.id }), "utf8")
    .toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid session cursor");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid session cursor");
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(candidate["createdAt"])
    || (candidate["createdAt"] as number) < 0
    || typeof candidate["id"] !== "string"
    || candidate["id"].length < 1
    || candidate["id"].length > 500
  ) {
    throw new Error("invalid session cursor");
  }
  return { createdAt: candidate["createdAt"] as number, id: candidate["id"] as string };
}

function isOlderThanCursor(session: SessionInfo, cursor: Cursor): boolean {
  return session.createdAt < cursor.createdAt
    || (session.createdAt === cursor.createdAt && session.id.localeCompare(cursor.id) < 0);
}

/**
 * Select the compact status-file view.  Attention is considered before normal
 * active sessions so a very busy daemon cannot hide a permission prompt behind
 * a large pool of ordinary workers.  Terminal history is deliberately bounded
 * and available through the authenticated paged control endpoint instead.
 */
export function selectStatusSessions(sessions: readonly SessionInfo[]): StatusSessionSelection {
  const terminal = sessions.filter(isTerminalSession);
  const active = sessions.filter((session) => !isTerminalSession(session));
  const attention = active.filter(needsAttention);

  const selected = new Map<string, SessionInfo>();
  for (const session of attention.sort(newestFirst).slice(0, STATUS_ATTENTION_LIMIT)) {
    selected.set(session.id, session);
  }
  for (const session of active.sort(newestFirst).slice(0, STATUS_ACTIVE_LIMIT)) {
    selected.set(session.id, session);
  }
  for (const session of terminal.sort(newestFirst).slice(0, STATUS_RECENT_TERMINAL_LIMIT)) {
    selected.set(session.id, session);
  }

  const included = selected.size;
  return {
    sessions: [...selected.values()].sort(oldestFirst),
    summary: {
      total: sessions.length,
      active: active.length,
      attention: attention.length,
      terminal: terminal.length,
      included,
      omitted: sessions.length - included,
      activeLimit: STATUS_ACTIVE_LIMIT,
      attentionLimit: STATUS_ATTENTION_LIMIT,
      recentTerminalLimit: STATUS_RECENT_TERMINAL_LIMIT,
      truncated: included < sessions.length,
    },
  };
}

/**
 * Pagination for the authenticated localhost control API.  Cursors name the
 * last item by stable ordering keys rather than an array offset, so a newly
 * created session cannot make a caller skip older history between page loads.
 */
export function pageSessions(
  sessions: readonly SessionInfo[],
  options: {
    cursor?: string;
    limit?: number;
    query?: string;
    terminalOnly?: boolean;
    /** Exact local session IDs requested by a persisted sidebar selection. */
    ids?: readonly string[];
  },
): SessionListPage {
  const query = options.query?.trim() ?? "";
  const terminal = sessions.filter(isTerminalSession).length;
  const active = sessions.length - terminal;
  const ids = options.ids?.length ? new Set(options.ids) : undefined;
  const filtered = sessions
    .filter((session) => ids === undefined || ids.has(session.id))
    .filter((session) => options.terminalOnly !== true || isTerminalSession(session))
    .filter((session) => matchesQuery(session, query))
    .sort(newestFirst);
  const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
  const afterCursor = cursor ? filtered.filter((session) => isOlderThanCursor(session, cursor)) : filtered;
  const limit = options.limit ?? 50;
  const items = afterCursor.slice(0, limit);
  const hasNext = afterCursor.length > items.length;
  return {
    items,
    ...(hasNext && items.length > 0 ? { nextCursor: encodeCursor(items[items.length - 1]!) } : {}),
    total: filtered.length,
    active,
    terminal,
  };
}
