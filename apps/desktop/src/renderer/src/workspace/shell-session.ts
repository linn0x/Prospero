import type { DesktopApi, SessionInfo } from "../../../shared/types";

const STORAGE_KEY = "prospero.dockShells.v1";
const requests = new Map<string, Promise<SessionInfo>>();
const shells = new Map<string, string>();
const LIMIT = 32;
const ended = new Set(["done", "completed", "failed", "cancelled", "exited", "killed", "stopped"]);

export function shellIsLive(session: SessionInfo): boolean {
  return session.agent === "shell" && session.kind === "pty" && !ended.has(session.status);
}

function readShells(): void {
  if (shells.size) return;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!stored || typeof stored !== "object" || !("version" in stored) || stored.version !== 1 || !("entries" in stored) || !Array.isArray(stored.entries)) return;
    for (const entry of stored.entries.slice(-LIMIT)) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].length <= 4096 && typeof entry[1] === "string" && entry[1].length <= 160) shells.set(entry[0], entry[1]);
    }
  } catch {}
}

function remember(cwd: string, session: SessionInfo): SessionInfo {
  shells.delete(cwd);
  shells.set(cwd, session.id);
  while (shells.size > LIMIT) shells.delete(shells.keys().next().value!);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries: [...shells] })); } catch {}
  return session;
}

export function workspaceShell(api: Pick<DesktopApi, "listSessions" | "createSession">, cwd: string, sessions: readonly SessionInfo[]): Promise<SessionInfo> {
  const inflight = requests.get(cwd);
  if (inflight) return inflight;
  readShells();
  const request = (async () => {
    const knownId = shells.get(cwd);
    const known = sessions.find((session) => session.id === knownId && session.cwd === cwd && shellIsLive(session));
    if (known) return remember(cwd, known);
    if (knownId) {
      const page = await api.listSessions({ ids: [knownId], limit: 1 });
      const existing = page.items.find((session) => session.id === knownId && session.cwd === cwd && shellIsLive(session));
      if (existing) return remember(cwd, existing);
    }
    const created = await api.createSession({ agent: "shell", kind: "pty", cwd, approvalPolicy: "standard" });
    return remember(cwd, created);
  })().finally(() => requests.delete(cwd));
  requests.set(cwd, request);
  return request;
}
