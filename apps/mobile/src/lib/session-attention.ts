import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SessionInfo } from "@prospero/protocol";
import { create } from "zustand";

const SESSION_COMPLETION_READS_KEY = "prospero.session-completion-reads.v1";
const MAX_STORED_COMPLETION_READS = 500;

export type DeviceAttentionMotion = "approval" | "working" | "unread-completed" | null;
export type SessionCompletionReads = Record<string, string>;

interface SessionAttentionState {
  completionReads: SessionCompletionReads;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  markCompletionRead: (hostId: string, session: SessionInfo) => void;
}

let hydrationPromise: Promise<void> | null = null;
let persistenceQueue = Promise.resolve();

export function sessionCompletionReadKey(hostId: string, sessionId: string): string {
  return `${encodeURIComponent(hostId)}:${encodeURIComponent(sessionId)}`;
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

export function deviceAttentionMotion(
  hostId: string,
  sessions: Record<string, SessionInfo> | undefined,
  completionReads: SessionCompletionReads | null,
): DeviceAttentionMotion {
  const values = Object.values(sessions ?? {});
  if (values.some((session) =>
    session.status === "waiting_approval" || (session.pendingPermissions ?? 0) > 0
  )) {
    return "approval";
  }
  if (values.some((session) =>
    session.status === "starting" ||
    session.status === "running" ||
    session.status === "waiting_input"
  )) {
    return "working";
  }
  if (completionReads && values.some((session) => {
    const fingerprint = sessionCompletionFingerprint(session);
    return fingerprint !== null &&
      completionReads[sessionCompletionReadKey(hostId, session.id)] !== fingerprint;
  })) {
    return "unread-completed";
  }
  return null;
}

function parseCompletionReads(raw: string | null): SessionCompletionReads {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const reads = (value as { reads?: unknown }).reads;
    if (!reads || typeof reads !== "object" || Array.isArray(reads)) return {};
    return Object.fromEntries(
      Object.entries(reads)
        .filter(([key, fingerprint]) =>
          key.length <= 1000 && typeof fingerprint === "string" && fingerprint.length <= 2000
        )
        .slice(-MAX_STORED_COMPLETION_READS),
    );
  } catch {
    return {};
  }
}

function boundedCompletionReads(reads: SessionCompletionReads): SessionCompletionReads {
  const entries = Object.entries(reads);
  return entries.length <= MAX_STORED_COMPLETION_READS
    ? reads
    : Object.fromEntries(entries.slice(-MAX_STORED_COMPLETION_READS));
}

function persistCompletionReads(reads: SessionCompletionReads): void {
  const snapshot = boundedCompletionReads(reads);
  persistenceQueue = persistenceQueue
    .catch(() => undefined)
    .then(() => AsyncStorage.setItem(
      SESSION_COMPLETION_READS_KEY,
      JSON.stringify({ version: 1, reads: snapshot }),
    ))
    .catch(() => undefined);
}

export const useSessionAttention = create<SessionAttentionState>()((set) => ({
  completionReads: {},
  hydrated: false,
  hydrate: async () => {
    if (!hydrationPromise) {
      hydrationPromise = AsyncStorage.getItem(SESSION_COMPLETION_READS_KEY)
        .then((raw) => {
          const stored = parseCompletionReads(raw);
          set((state) => ({
            completionReads: { ...stored, ...state.completionReads },
            hydrated: true,
          }));
        })
        .catch(() => set({ hydrated: true }));
    }
    await hydrationPromise;
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
      persistCompletionReads(completionReads);
      return { completionReads };
    });
  },
}));
