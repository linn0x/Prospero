import type { SessionInfo } from "../../../shared/types";
import { normalizedRemoteCwd, type RemoteWorkspaceOpenResult } from "../../../shared/remote-workspaces";

const ended = new Set(["completed", "done", "died", "failed", "killed", "cancelled", "error"]);
const storageKey = "prospero.remoteWorkspaceSelection.v1";

export class RemoteWorkspaceOpenQueue {
  private jobs = new Map<string, Promise<RemoteWorkspaceOpenResult>>();

  run(workspaceId: string, action: () => Promise<RemoteWorkspaceOpenResult>): Promise<RemoteWorkspaceOpenResult> {
    const existing = this.jobs.get(workspaceId);
    if (existing) return existing;
    const job = Promise.resolve().then(action).finally(() => { if (this.jobs.get(workspaceId) === job) this.jobs.delete(workspaceId); });
    this.jobs.set(workspaceId, job);
    return job;
  }
}

export function remoteShellEnded(session: Pick<SessionInfo, "status">): boolean {
  return ended.has(session.status);
}

export function remoteDirectoryKey(cwd: string): string {
  return normalizedRemoteCwd(cwd);
}

export function remoteWorkspaceShells(sessions: SessionInfo[], cwd: string): SessionInfo[] {
  const directory = remoteDirectoryKey(cwd);
  const unique = new Map<string, SessionInfo>();
  for (const session of sessions) {
    if (session.kind === "pty" && !remoteShellEnded(session) && remoteDirectoryKey(session.cwd) === directory) unique.set(session.id, session);
  }
  return [...unique.values()].sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0) || left.id.localeCompare(right.id));
}

export function rememberedRemoteShell(workspaceId: string, storage: Pick<Storage, "getItem"> = localStorage): string | undefined {
  try {
    const state: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    if (!state || typeof state !== "object" || !("version" in state) || state.version !== 1 || !("entries" in state) || !Array.isArray(state.entries)) return;
    const item = state.entries.slice(0, 64).find(value => value && typeof value === "object" && value.workspaceId === workspaceId);
    return typeof item?.sessionId === "string" && item.sessionId.length <= 500 ? item.sessionId : undefined;
  } catch { return undefined; }
}

export function rememberRemoteShell(workspaceId: string, sessionId: string, storage: Pick<Storage, "getItem" | "setItem"> = localStorage): void {
  try {
    const previous: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    const entries = previous && typeof previous === "object" && "version" in previous && previous.version === 1 && "entries" in previous && Array.isArray(previous.entries)
      ? previous.entries.filter(value => value && typeof value === "object" && typeof value.workspaceId === "string" && typeof value.sessionId === "string" && value.workspaceId !== workspaceId).slice(0, 63)
      : [];
    storage.setItem(storageKey, JSON.stringify({ version: 1, entries: [{ workspaceId, sessionId }, ...entries] }));
  } catch {}
}

export function chooseRemoteShell(sessions: SessionInfo[], preferred: string | undefined, confirmed: string): string {
  return preferred && sessions.some(session => session.id === preferred) ? preferred : confirmed;
}
