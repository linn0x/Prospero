import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SessionInfo } from "@prospero/protocol";
import { create } from "zustand";

const SESSION_COMPLETION_READS_KEY = "prospero.session-completion-reads.v1";
const MAX_STORED_COMPLETION_READS = 500;
const MAX_BASELINED_HOSTS = 100;

export type DeviceAttentionMotion = "approval" | "working" | "unread-completed" | null;
export type SessionCompletionReads = Record<string, string>;
export type CompletionBaselineHosts = Record<string, true>;

interface SessionAttentionState {
  completionReads: SessionCompletionReads;
  completionBaselineHosts: CompletionBaselineHosts;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  baselineHostCompletions: (
    hostId: string,
    sessions: Record<string, SessionInfo>,
  ) => void;
  markCompletionRead: (hostId: string, session: SessionInfo) => void;
  markHostCompletionsRead: (
    hostId: string,
    sessions: Record<string, SessionInfo>,
  ) => void;
}

let hydrationPromise: Promise<void> | null = null;
let persistenceQueue = Promise.resolve();

export function sessionCompletionReadKey(hostId: string, sessionId: string): string {
  return `${encodeURIComponent(hostId)}:${encodeURIComponent(sessionId)}`;
}

export function completionBaselineHostKey(hostId: string): string {
  return encodeURIComponent(hostId);
}

export function sessionRequiresApproval(session: SessionInfo): boolean {
  return session.status === "waiting_approval" || (session.pendingPermissions ?? 0) > 0;
}

/**
 * SessionInfo has no completion timestamp, so the latest reply and cumulative usage form a
 * stable completion revision. A later turn changes at least one of these values and becomes
 * unread again without treating the long-lived session id as permanently read.
 */
export function sessionCompletionFingerprint(session: SessionInfo): string | null {
  if (session.status !== "completed") return null;
  return JSON.stringify([
    session.createdAt,
    session.title,
    session.preview?.slice(-512) ?? "",
    session.totals?.costUsd ?? null,
    session.totals?.inputTokens ?? null,
    session.totals?.outputTokens ?? null,
  ]);
}

export function sessionHasUnreadCompletion(
  hostId: string,
  session: SessionInfo,
  completionReads: SessionCompletionReads | null,
  completionBaselineReady: boolean,
): boolean {
  if (!completionReads || !completionBaselineReady) return false;
  const fingerprint = sessionCompletionFingerprint(session);
  return fingerprint !== null &&
    completionReads[sessionCompletionReadKey(hostId, session.id)] !== fingerprint;
}

export function sessionNeedsLocatorMotion(
  hostId: string,
  session: SessionInfo,
  completionReads: SessionCompletionReads | null,
  completionBaselineReady: boolean,
): boolean {
  return sessionRequiresApproval(session) || sessionHasUnreadCompletion(
    hostId,
    session,
    completionReads,
    completionBaselineReady,
  );
}

export function deviceAttentionMotion(
  hostId: string,
  sessions: Record<string, SessionInfo> | undefined,
  completionReads: SessionCompletionReads | null,
  completionBaselineReady = true,
): DeviceAttentionMotion {
  const values = Object.values(sessions ?? {});
  if (values.some(sessionRequiresApproval)) {
    return "approval";
  }
  if (values.some((session) =>
    session.status === "starting" ||
    session.status === "running" ||
    session.status === "waiting_input"
  )) {
    return "working";
  }
  if (values.some((session) => sessionHasUnreadCompletion(
    hostId,
    session,
    completionReads,
    completionBaselineReady,
  ))) {
    return "unread-completed";
  }
  return null;
}

export function unreadCompletedSessionCount(
  hostId: string,
  sessions: Record<string, SessionInfo> | undefined,
  completionReads: SessionCompletionReads,
): number {
  return Object.values(sessions ?? {}).reduce((total, session) => {
    return total + (sessionHasUnreadCompletion(hostId, session, completionReads, true) ? 1 : 0);
  }, 0);
}

interface StoredSessionAttention {
  completionReads: SessionCompletionReads;
  completionBaselineHosts: CompletionBaselineHosts;
}

function parseSessionAttention(raw: string | null): StoredSessionAttention {
  const empty: StoredSessionAttention = {
    completionReads: {},
    completionBaselineHosts: {},
  };
  if (!raw) return empty;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
    const reads = (value as { reads?: unknown }).reads;
    const completionReads = reads && typeof reads === "object" && !Array.isArray(reads)
      ? Object.fromEntries(
      Object.entries(reads)
        .filter(([key, fingerprint]) =>
          key.length <= 1000 && typeof fingerprint === "string" && fingerprint.length <= 2000
        )
        .slice(-MAX_STORED_COMPLETION_READS),
      )
      : {};
    const storedHosts = (value as { baselineHosts?: unknown }).baselineHosts;
    const completionBaselineHosts = Array.isArray(storedHosts)
      ? Object.fromEntries(
        storedHosts
          .filter((key): key is string => typeof key === "string" && key.length <= 1000)
          .slice(-MAX_BASELINED_HOSTS)
          .map((key) => [key, true] as const),
      )
      : {};
    return { completionReads, completionBaselineHosts };
  } catch {
    return empty;
  }
}

function boundedCompletionReads(reads: SessionCompletionReads): SessionCompletionReads {
  const entries = Object.entries(reads);
  return entries.length <= MAX_STORED_COMPLETION_READS
    ? reads
    : Object.fromEntries(entries.slice(-MAX_STORED_COMPLETION_READS));
}

function boundedBaselineHosts(hosts: CompletionBaselineHosts): CompletionBaselineHosts {
  const entries = Object.entries(hosts);
  return entries.length <= MAX_BASELINED_HOSTS
    ? hosts
    : Object.fromEntries(entries.slice(-MAX_BASELINED_HOSTS));
}

export function readCompletedSessions(
  hostId: string,
  sessions: Record<string, SessionInfo>,
  reads: SessionCompletionReads,
): SessionCompletionReads {
  let next = reads;
  for (const session of Object.values(sessions)) {
    const fingerprint = sessionCompletionFingerprint(session);
    const key = sessionCompletionReadKey(hostId, session.id);
    if (fingerprint && next[key] !== fingerprint) {
      if (next === reads) next = { ...reads };
      next[key] = fingerprint;
    }
  }
  return next === reads ? reads : boundedCompletionReads(next);
}

function persistSessionAttention(
  reads: SessionCompletionReads,
  hosts: CompletionBaselineHosts,
): void {
  const snapshot = boundedCompletionReads(reads);
  const baselineHosts = Object.keys(boundedBaselineHosts(hosts));
  persistenceQueue = persistenceQueue
    .catch(() => undefined)
    .then(() => AsyncStorage.setItem(
      SESSION_COMPLETION_READS_KEY,
      JSON.stringify({ version: 2, reads: snapshot, baselineHosts }),
    ))
    .catch(() => undefined);
}

export const useSessionAttention = create<SessionAttentionState>()((set) => ({
  completionReads: {},
  completionBaselineHosts: {},
  hydrated: false,
  hydrate: async () => {
    if (!hydrationPromise) {
      hydrationPromise = AsyncStorage.getItem(SESSION_COMPLETION_READS_KEY)
        .then((raw) => {
          const stored = parseSessionAttention(raw);
          set((state) => ({
            completionReads: {
              ...stored.completionReads,
              ...state.completionReads,
            },
            completionBaselineHosts: {
              ...stored.completionBaselineHosts,
              ...state.completionBaselineHosts,
            },
            hydrated: true,
          }));
        })
        .catch(() => set({ hydrated: true }));
    }
    await hydrationPromise;
  },
  baselineHostCompletions: (hostId, sessions) => {
    const hostKey = completionBaselineHostKey(hostId);
    set((state) => {
      if (!state.hydrated || state.completionBaselineHosts[hostKey]) return state;
      const completionReads = readCompletedSessions(hostId, sessions, state.completionReads);
      const completionBaselineHosts = boundedBaselineHosts({
        ...state.completionBaselineHosts,
        [hostKey]: true,
      });
      persistSessionAttention(completionReads, completionBaselineHosts);
      return { completionReads, completionBaselineHosts };
    });
  },
  markCompletionRead: (hostId, session) => {
    const fingerprint = sessionCompletionFingerprint(session);
    if (!fingerprint) return;
    const key = sessionCompletionReadKey(hostId, session.id);
    set((state) => {
      if (state.completionReads[key] === fingerprint) return state;
      const completionReads = boundedCompletionReads({
        ...state.completionReads,
        [key]: fingerprint,
      });
      persistSessionAttention(completionReads, state.completionBaselineHosts);
      return { completionReads };
    });
  },
  markHostCompletionsRead: (hostId, sessions) => {
    const hostKey = completionBaselineHostKey(hostId);
    set((state) => {
      const completionReads = readCompletedSessions(hostId, sessions, state.completionReads);
      const completionBaselineHosts = state.completionBaselineHosts[hostKey]
        ? state.completionBaselineHosts
        : boundedBaselineHosts({
          ...state.completionBaselineHosts,
          [hostKey]: true,
        });
      if (
        completionReads === state.completionReads &&
        completionBaselineHosts === state.completionBaselineHosts
      ) {
        return state;
      }
      persistSessionAttention(completionReads, completionBaselineHosts);
      return { completionReads, completionBaselineHosts };
    });
  },
}));
