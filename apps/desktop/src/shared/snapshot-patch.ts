import type { DaemonSnapshot, DaemonSnapshotPatch, DesktopSnapshot, DesktopSnapshotPatch, SessionInfo } from "./types";

const SNAPSHOT_KEYS = [
  "projects",
  "projectAliases",
  "pinnedProjectPaths",
  "pinnedSessionIds",
  "archivedSessionIds",
  "unreadSessionIds",
  "workflowTemplates",
  "devices",
  "accounts",
  "orchestration",
  "logs",
  "settings",
] as const satisfies readonly Exclude<keyof DesktopSnapshot, "daemon">[];
type MissingSnapshotKey = Exclude<keyof DesktopSnapshot, "daemon" | (typeof SNAPSHOT_KEYS)[number]>;
const SNAPSHOT_KEYS_ARE_EXHAUSTIVE: MissingSnapshotKey extends never ? true : never = true;
void SNAPSHOT_KEYS_ARE_EXHAUSTIVE;

const DAEMON_KEYS = [
  "running",
  "managed",
  "fullAccess",
  "starting",
  "startupProgress",
  "startupStage",
  "pid",
  "port",
  "bind",
  "state",
  "lastError",
  "persistence",
  "relay",
  "sessionSummary",
] as const satisfies readonly Exclude<keyof DaemonSnapshot, "sessions">[];
type MissingDaemonKey = Exclude<keyof DaemonSnapshot, "sessions" | (typeof DAEMON_KEYS)[number]>;
const DAEMON_KEYS_ARE_EXHAUSTIVE: MissingDaemonKey extends never ? true : never = true;
void DAEMON_KEYS_ARE_EXHAUSTIVE;

const REQUIRED_DAEMON_KEYS = [
  "running",
  "managed",
  "fullAccess",
  "starting",
  "startupProgress",
  "startupStage",
  "port",
  "bind",
  "state",
  "persistence",
  "relay",
] as const satisfies readonly (keyof DaemonSnapshot)[];

function ids(sessions: SessionInfo[]): string[] {
  return sessions.map((session) => session.id);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Snapshot payloads are bounded, JSON-only records and must also run in the renderer. */
function sameSnapshotValue(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function diffDaemonSnapshot(previous: DaemonSnapshot, next: DaemonSnapshot): DaemonSnapshotPatch | undefined {
  const patch: DaemonSnapshotPatch = {};
  for (const key of DAEMON_KEYS) {
    if (!sameSnapshotValue(previous[key], next[key])) Object.assign(patch, { [key]: next[key] });
  }

  const previousById = new Map(previous.sessions.map((session) => [session.id, session]));
  const nextById = new Map(next.sessions.map((session) => [session.id, session]));
  const sessionUpserts = next.sessions.filter((session) => !sameSnapshotValue(previousById.get(session.id), session));
  const sessionRemovedIds = previous.sessions
    .filter((session) => !nextById.has(session.id))
    .map((session) => session.id);
  const previousOrder = ids(previous.sessions);
  const nextOrder = ids(next.sessions);
  if (sessionUpserts.length > 0) patch.sessionUpserts = sessionUpserts;
  if (sessionRemovedIds.length > 0) patch.sessionRemovedIds = sessionRemovedIds;
  if (!sameStringArray(previousOrder, nextOrder)) patch.sessionOrder = nextOrder;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Creates an identity-based patch, with ID-addressed session changes. */
export function diffDesktopSnapshot(previous: DesktopSnapshot | undefined, next: DesktopSnapshot): DesktopSnapshotPatch {
  if (!previous) return next;
  const patch: DesktopSnapshotPatch = {};
  const daemon = diffDaemonSnapshot(previous.daemon, next.daemon);
  if (daemon) patch.daemon = daemon;
  for (const key of SNAPSHOT_KEYS) {
    if (previous[key] !== next[key]) Object.assign(patch, { [key]: next[key] });
  }
  return patch;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function applyDaemonSnapshotPatch(snapshot: DaemonSnapshot, patch: DaemonSnapshotPatch): DaemonSnapshot {
  const {
    sessionUpserts = [],
    sessionRemovedIds = [],
    sessionOrder,
    // `sessions` is only used by a full first patch / legacy sender.
    sessions: replacementSessions,
    ...fields
  } = patch;
  const replacesSessions = hasOwn(patch, "sessions");
  const hasSessionDelta = sessionUpserts.length > 0 || sessionRemovedIds.length > 0 || sessionOrder !== undefined;
  const isFullSnapshot = replacesSessions && !hasSessionDelta && REQUIRED_DAEMON_KEYS.every((key) => hasOwn(patch, key));
  // Initial/full snapshot sends intentionally preserve the daemon object
  // identity.  Incremental payloads normally never include `sessions`.
  if (isFullSnapshot) return patch as DaemonSnapshot;
  if (!replacesSessions && !hasSessionDelta) return { ...snapshot, ...fields };

  const base = replacesSessions ? (replacementSessions ?? []) : snapshot.sessions;
  const byId = new Map(base.map((session) => [session.id, session]));
  for (const session of sessionUpserts) byId.set(session.id, session);
  for (const id of sessionRemovedIds) byId.delete(id);

  const sourceOrder = sessionOrder ?? base.map((session) => session.id);
  const applied = sourceOrder.flatMap((id) => {
    const session = byId.get(id);
    return session ? [session] : [];
  });
  // An upsert absent from an order vector must remain visible: hiding a live
  // approval prompt is worse than appending it at the end of the list.
  for (const session of sessionUpserts) {
    if (!applied.some((item) => item.id === session.id)) applied.push(session);
  }
  return { ...snapshot, ...fields, sessions: applied };
}

export function applyDesktopSnapshotPatch(snapshot: DesktopSnapshot, patch: DesktopSnapshotPatch): DesktopSnapshot {
  if (Object.keys(patch).length === 0) return snapshot;
  const { daemon, ...fields } = patch;
  if (!daemon) return { ...snapshot, ...fields };
  return { ...snapshot, ...fields, daemon: applyDaemonSnapshotPatch(snapshot.daemon, daemon) };
}

/**
 * Combines patches received while the renderer is still resolving its initial
 * snapshot.  A plain object spread would discard an earlier session upsert,
 * producing a one-frame stale sidebar right after startup.
 */
export function mergeDesktopSnapshotPatches(previous: DesktopSnapshotPatch, next: DesktopSnapshotPatch): DesktopSnapshotPatch {
  const { daemon: previousDaemon, ...previousFields } = previous;
  const { daemon: nextDaemon, ...nextFields } = next;
  if (!previousDaemon || !nextDaemon) {
    const daemon = nextDaemon ?? previousDaemon;
    return { ...previousFields, ...nextFields, ...(daemon ? { daemon } : {}) };
  }
  const {
    sessionUpserts: previousUpserts = [],
    sessionRemovedIds: previousRemoved = [],
    sessionOrder: previousOrder,
    sessions: previousSessions,
    ...previousDaemonFields
  } = previousDaemon;
  const {
    sessionUpserts: nextUpserts = [],
    sessionRemovedIds: nextRemoved = [],
    sessionOrder: nextOrder,
    sessions: nextSessions,
    ...nextDaemonFields
  } = nextDaemon;
  const upserts = new Map(previousUpserts.map((session) => [session.id, session]));
  const removed = new Set(previousRemoved);
  for (const id of nextRemoved) {
    upserts.delete(id);
    removed.add(id);
  }
  for (const session of nextUpserts) {
    removed.delete(session.id);
    upserts.set(session.id, session);
  }
  const daemon: DaemonSnapshotPatch = {
    ...previousDaemonFields,
    ...nextDaemonFields,
    ...(nextSessions !== undefined ? { sessions: nextSessions } : previousSessions !== undefined ? { sessions: previousSessions } : {}),
    ...(upserts.size > 0 ? { sessionUpserts: [...upserts.values()] } : {}),
    ...(removed.size > 0 ? { sessionRemovedIds: [...removed] } : {}),
    ...(nextOrder !== undefined ? { sessionOrder: nextOrder } : previousOrder !== undefined ? { sessionOrder: previousOrder } : {}),
  };
  return { ...previousFields, ...nextFields, daemon };
}

export function isEmptyDesktopSnapshotPatch(patch: DesktopSnapshotPatch): boolean {
  return Object.keys(patch).length === 0;
}
