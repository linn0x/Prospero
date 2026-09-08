import type { HostConnection } from "./connection";

export interface WorkspaceSummary {
  branch: string | null;
  sizeBytes: number | null;
  sizeComplete: boolean;
  checkedAt: number;
}

interface CacheEntry { connection: HostConnection; expiresAt: number; result: Promise<WorkspaceSummary> }
const cache = new Map<string, CacheEntry>();

/** A workspace is scoped by host and path, never by a globally assumed session ID. */
export function getWorkspaceSummary(connection: HostConnection, hostId: string, path: string, sid: string): Promise<WorkspaceSummary> {
  const key = JSON.stringify([hostId, path]);
  const existing = cache.get(key);
  if (existing?.connection === connection && existing.expiresAt > Date.now()) return existing.result;
  const result: Promise<WorkspaceSummary> = connection.supportsWorkspaceSummary
    ? connection.workspaceSummary(sid)
    : connection.gitStatus(sid).then((status) => ({ branch: status.branch, sizeBytes: null, sizeComplete: false, checkedAt: Date.now() }));
  const entry = { connection, expiresAt: Date.now() + 60_000, result };
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  void result.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  return result;
}
