import { create } from "zustand";
import type { HostInfo, SessionInfo } from "@prospero/protocol";
import type { StoredHost } from "./hosts";
import type { ConnectionPath } from "./connection-candidates";

export type ConnStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export interface HostRuntime {
  status: ConnStatus;
  hostInfo: HostInfo | null;
  activeAddr: string | null;
  /** Actual winner; differs from the user preference when mode is auto. */
  activePath: ConnectionPath | null;
  lastError: string | null;
  /** 握手往返耗时,用于显示连接质量 */
  rttMs: number | null;
  sessions: Record<string, SessionInfo>;
}

export const emptyRuntime: HostRuntime = {
  status: "idle",
  hostInfo: null,
  activeAddr: null,
  activePath: null,
  lastError: null,
  rttMs: null,
  sessions: {},
};

interface AppState {
  hosts: StoredHost[];
  runtimes: Record<string, HostRuntime>;
  setHosts(hosts: StoredHost[]): void;
  patchRuntime(hostId: string, patch: Partial<Omit<HostRuntime, "sessions">>): void;
  setSessions(hostId: string, sessions: SessionInfo[]): void;
  upsertSession(hostId: string, session: SessionInfo): void;
}

export const useApp = create<AppState>()((set) => ({
  hosts: [],
  runtimes: {},
  setHosts: (hosts) => set({ hosts }),
  patchRuntime: (hostId, patch) =>
    set((s) => ({
      runtimes: {
        ...s.runtimes,
        [hostId]: { ...(s.runtimes[hostId] ?? emptyRuntime), ...patch },
      },
    })),
  setSessions: (hostId, sessions) =>
    set((s) => {
      const map: Record<string, SessionInfo> = {};
      for (const info of sessions) map[info.id] = info;
      return {
        runtimes: {
          ...s.runtimes,
          [hostId]: { ...(s.runtimes[hostId] ?? emptyRuntime), sessions: map },
        },
      };
    }),
  upsertSession: (hostId, session) =>
    set((s) => {
      const rt = s.runtimes[hostId] ?? emptyRuntime;
      return {
        runtimes: {
          ...s.runtimes,
          [hostId]: {
            ...rt,
            sessions: { ...rt.sessions, [session.id]: session },
          },
        },
      };
    }),
}));

/** 会话列表排序:待审批 > 运行中 > 其他,同组按创建时间倒序 */
export function sortSessions(sessions: Record<string, SessionInfo>): SessionInfo[] {
  const rank = (s: SessionInfo): number =>
    s.status === "waiting_approval" ? 0 : s.status === "running" || s.status === "starting" ? 1 : 2;
  return Object.values(sessions).sort(
    (a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt,
  );
}
