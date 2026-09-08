import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

export interface EdgePreferences {
  mode: "normal" | "edge";
  /** null is the initial all-devices default; [] is an intentional empty selection. */
  selectedHostIds: string[] | null;
}

const STORAGE_KEY = "prospero.edge.v1";
const defaults: EdgePreferences = { mode: "normal", selectedHostIds: null };

export function normalizeEdgePreferences(value: unknown): EdgePreferences {
  const input = value && typeof value === "object" ? value as Partial<EdgePreferences> : {};
  return {
    mode: input.mode === "edge" ? "edge" : "normal",
    selectedHostIds: Array.isArray(input.selectedHostIds)
      ? [...new Set(input.selectedHostIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : null,
  };
}

export function selectedEdgeHosts<T extends { id: string }>(hosts: readonly T[], ids: readonly string[] | null): T[] {
  const selected = ids === null ? null : new Set(ids);
  return hosts.filter((host) => selected === null || selected.has(host.id));
}

interface EdgeState extends EdgePreferences {
  hydrated: boolean;
  hydrate(): Promise<void>;
  setMode(mode: EdgePreferences["mode"]): void;
  selectHosts(ids: string[]): void;
}

/** Serialize rapid selection writes, and never let late hydration replace a user action. */
export function createEdgePreferencesStore(storage: Pick<typeof AsyncStorage, "getItem" | "setItem">) {
  let loading: Promise<void> | undefined;
  let writes = Promise.resolve();
  let revision = 0;
  return create<EdgeState>()((set, get) => {
    const save = (patch: Partial<EdgePreferences>): void => {
      revision += 1;
      set(patch);
      const { mode, selectedHostIds } = get();
      const serialized = JSON.stringify({ mode, selectedHostIds });
      writes = writes.catch(() => undefined).then(() => storage.setItem(STORAGE_KEY, serialized));
      void writes.catch(() => undefined);
    };
    return {
      ...defaults,
      hydrated: false,
      hydrate: () => {
        loading ??= (async () => {
          const before = revision;
          let stored = defaults;
          try {
            const raw = await storage.getItem(STORAGE_KEY);
            stored = normalizeEdgePreferences(raw ? JSON.parse(raw) : null);
          } catch { /* An unavailable preference must not block the home screen. */ }
          set(revision === before ? { ...stored, hydrated: true } : { hydrated: true });
        })();
        return loading;
      },
      setMode: (mode) => save({ mode }),
      selectHosts: (ids) => save({ selectedHostIds: normalizeEdgePreferences({ selectedHostIds: ids }).selectedHostIds }),
    };
  });
}

export const useEdgePreferences = createEdgePreferencesStore(AsyncStorage);
