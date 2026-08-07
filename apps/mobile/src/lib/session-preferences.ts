import AsyncStorage from "@react-native-async-storage/async-storage";

export interface SessionPreferences {
  archivedSessionIds: string[];
  collapsedProjects: string[];
}

const KEY_PREFIX = "prospero.sessionPreferences.v1:";
const writes = new Map<string, Promise<void>>();

function storageKey(hostId: string): string {
  return `${KEY_PREFIX}${hostId}`;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string"))];
}

function parse(raw: string | null): SessionPreferences {
  if (!raw) return { archivedSessionIds: [], collapsedProjects: [] };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      archivedSessionIds: stringArray(value["archivedSessionIds"]),
      collapsedProjects: stringArray(value["collapsedProjects"]),
    };
  } catch {
    return { archivedSessionIds: [], collapsedProjects: [] };
  }
}

async function readNow(hostId: string): Promise<SessionPreferences> {
  return parse(await AsyncStorage.getItem(storageKey(hostId)));
}

/** 等待同一台主机的在途写入，页面重新聚焦时不会读到旧值。 */
export async function getSessionPreferences(hostId: string): Promise<SessionPreferences> {
  await writes.get(hostId)?.catch(() => undefined);
  return readNow(hostId);
}

function updateSessionPreferences(
  hostId: string,
  change: (current: SessionPreferences) => SessionPreferences,
): Promise<void> {
  const previous = writes.get(hostId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const updated = change(await readNow(hostId));
      await AsyncStorage.setItem(storageKey(hostId), JSON.stringify(updated));
    });
  writes.set(hostId, next);
  const cleanup = (): void => {
    if (writes.get(hostId) === next) writes.delete(hostId);
  };
  void next.then(cleanup, cleanup);
  return next;
}

export function setSessionArchived(
  hostId: string,
  sessionId: string,
  archived: boolean,
): Promise<void> {
  return updateSessionPreferences(hostId, (current) => {
    const ids = new Set(current.archivedSessionIds);
    if (archived) ids.add(sessionId);
    else ids.delete(sessionId);
    return { ...current, archivedSessionIds: [...ids] };
  });
}

export function setProjectCollapsed(
  hostId: string,
  path: string,
  collapsed: boolean,
): Promise<void> {
  return updateSessionPreferences(hostId, (current) => {
    const paths = new Set(current.collapsedProjects);
    if (collapsed) paths.add(path);
    else paths.delete(path);
    return { ...current, collapsedProjects: [...paths] };
  });
}

export async function clearSessionPreferences(hostId: string): Promise<void> {
  await writes.get(hostId)?.catch(() => undefined);
  await AsyncStorage.removeItem(storageKey(hostId));
}
