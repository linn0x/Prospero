import { create } from "zustand";
import type { HostInfo, SessionInfo } from "@prospero/protocol";
import type { StoredHost } from "./hosts";
import type { ConnectionPath } from "./connection-candidates";
import { DEFAULT_HOME_SETTINGS, type HomeSettings } from "./home-preferences";
import { recentSessions, sessionActivityChanged } from "./recent-sessions";

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
  /** 已收到过 daemon 的完整会话快照；用于区分历史基线和后续增量。 */
  sessionsLoaded: boolean;
}

const SESSION_UPDATE_FRAME_MS = 16;
const pendingSessionUpdates = new Map<string, SessionInfo>();
let sessionUpdateTimer: ReturnType<typeof setTimeout> | undefined;

export function flushSessionUpdates(): void {
  sessionUpdateTimer = undefined;
  if (pendingSessionUpdates.size === 0) return;
  const updates = [...pendingSessionUpdates.entries()];
  pendingSessionUpdates.clear();
  const app = useApp.getState();
  for (const [key, session] of updates) {
    app.upsertSession(key.slice(0, key.indexOf("\u0000")), session);
  }
}

export const emptyRuntime: HostRuntime = {
  status: "idle",
  hostInfo: null,
  activeAddr: null,
  activePath: null,
  lastError: null,
  rttMs: null,
  sessions: {},
  sessionsLoaded: false,
};

interface AppState {
  hosts: StoredHost[];
  runtimes: Record<string, HostRuntime>;
  homeSettings: HomeSettings;
  setHosts(hosts: StoredHost[]): void;
  setHomeSettings(settings: HomeSettings): void;
  patchRuntime(
    hostId: string,
    patch: Partial<Omit<HostRuntime, "sessions" | "sessionsLoaded">>,
  ): void;
  setSessions(hostId: string, sessions: SessionInfo[]): void;
  upsertSession(hostId: string, session: SessionInfo): void;
  queueSessionUpdate(hostId: string, session: SessionInfo): void;
}

export const useApp = create<AppState>()((set, get) => ({
  hosts: [],
  runtimes: {},
  homeSettings: DEFAULT_HOME_SETTINGS,
  setHosts: (hosts) => set({ hosts }),
  setHomeSettings: (homeSettings) => set({ homeSettings }),
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
          [hostId]: {
            ...(s.runtimes[hostId] ?? emptyRuntime),
            sessions: map,
            sessionsLoaded: true,
          },
        },
      };
    }),
  upsertSession: (hostId, session) => {
    const runtime = get().runtimes[hostId];
    if (runtime?.status === "connected" && sessionActivityChanged(runtime.sessions[session.id], session)) {
      recentSessions.activity(hostId, session.id, session.preview);
    }
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
    });
  },
  queueSessionUpdate: (hostId, session) => {
    pendingSessionUpdates.set(`${hostId}\u0000${session.id}`, session);
    if (sessionUpdateTimer === undefined) {
      sessionUpdateTimer = setTimeout(flushSessionUpdates, SESSION_UPDATE_FRAME_MS);
    }
  },
}));

/** 会话列表排序:待审批 > 运行中 > 其他,同组按创建时间倒序 */
export function sortSessions(sessions: Record<string, SessionInfo>): SessionInfo[] {
  const rank = (s: SessionInfo): number =>
    s.status === "waiting_approval" ? 0 : s.status === "running" || s.status === "starting" ? 1 : 2;
  return Object.values(sessions).sort(
    (a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt,
  );
}
