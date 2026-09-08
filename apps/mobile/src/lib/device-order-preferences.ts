import { useEffect, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { normalizeDeviceOrder, orderDevices } from "./device-order";

const STORAGE_KEY = "prospero.deviceOrder.v1";
interface DeviceOrderState {
  ids: string[];
  hydrated: boolean;
  hydrate(): Promise<void>;
  saveOrder(ids: readonly string[]): Promise<void>;
}

/** This preference stores IDs only, independently of the address book and pairing credentials. */
export function createDeviceOrderStore(storage: Pick<typeof AsyncStorage, "getItem" | "setItem">) {
  let loading: Promise<void> | undefined;
  let writes = Promise.resolve();
  let persisted: string[] = [];
  let revision = 0;
  return create<DeviceOrderState>()((set, get) => ({
    ids: [], hydrated: false,
    hydrate: () => {
      loading ??= (async () => {
        try {
          const raw = await storage.getItem(STORAGE_KEY);
          persisted = normalizeDeviceOrder(raw ? JSON.parse(raw) : null);
        } catch { /* Invalid/unavailable preferences keep the original device order. */ }
        set({ ids: persisted, hydrated: true });
      })();
      return loading;
    },
    saveOrder: async (requested) => {
      const ids = normalizeDeviceOrder(requested);
      if (!get().hydrated) await get().hydrate();
      const currentRevision = ++revision;
      set({ ids });
      const write = writes.catch(() => undefined).then(async () => {
        await storage.setItem(STORAGE_KEY, JSON.stringify(ids));
        persisted = ids;
      });
      writes = write;
      try { await write; }
      catch (error) {
        if (currentRevision === revision) set({ ids: persisted });
        throw error;
      }
    },
  }));
}

export const useDeviceOrder = createDeviceOrderStore(AsyncStorage);

export function useOrderedDevices<T extends { id: string }>(devices: readonly T[]): T[] {
  const ids = useDeviceOrder((state) => state.ids);
  const hydrate = useDeviceOrder((state) => state.hydrate);
  useEffect(() => { void hydrate(); }, [hydrate]);
  return useMemo(() => orderDevices(devices, ids), [devices, ids]);
}
