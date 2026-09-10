import { useEffect, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { normalizeDeviceOrder } from "./device-order";
import { normalizeWorkspaceOrders, orderWorkspaces, type WorkspaceOrders } from "./workspace-order";

const STORAGE_KEY = "prospero.workspaceOrder.v1";
interface WorkspaceOrderState {
  orders: WorkspaceOrders;
  hydrated: boolean;
  hydrate(): Promise<void>;
  saveOrder(hostId: string, paths: readonly string[]): Promise<void>;
}

export function createWorkspaceOrderStore(storage: Pick<typeof AsyncStorage, "getItem" | "setItem">) {
  let loading: Promise<void> | undefined;
  let writes = Promise.resolve();
  let persisted: WorkspaceOrders = {};
  const revisions = new Map<string, number>();
  return create<WorkspaceOrderState>()((set, get) => ({
    orders: {}, hydrated: false,
    hydrate: () => {
      loading ??= (async () => {
        try {
          const raw = await storage.getItem(STORAGE_KEY);
          persisted = normalizeWorkspaceOrders(raw ? JSON.parse(raw) : null);
        } catch { /* Retain the default order if stored preferences cannot be read. */ }
        set({ orders: persisted, hydrated: true });
      })();
      return loading;
    },
    saveOrder: async (hostId, requested) => {
      if (!get().hydrated) await get().hydrate();
      const paths = normalizeDeviceOrder(requested);
      const revision = (revisions.get(hostId) ?? 0) + 1;
      revisions.set(hostId, revision);
      set({ orders: { ...get().orders, [hostId]: paths } });
      const write = writes.catch(() => undefined).then(async () => {
        const next = { ...persisted, [hostId]: paths };
        await storage.setItem(STORAGE_KEY, JSON.stringify(next));
        persisted = next;
      });
      writes = write;
      try { await write; }
      catch (error) {
        if (revisions.get(hostId) === revision) {
          set({ orders: { ...get().orders, [hostId]: persisted[hostId] ?? [] } });
        }
        throw error;
      }
    },
  }));
}

export const useWorkspaceOrder = createWorkspaceOrderStore(AsyncStorage);

export function useWorkspaceOrders() {
  const orders = useWorkspaceOrder((state) => state.orders);
  const hydrate = useWorkspaceOrder((state) => state.hydrate);
  useEffect(() => { void hydrate(); }, [hydrate]);
  return orders;
}

export function useOrderedWorkspaces<T extends { path: string }>(hostId: string | undefined, projects: readonly T[]): T[] {
  const orders = useWorkspaceOrders();
  return useMemo(() => orderWorkspaces(projects, hostId ? orders[hostId] ?? [] : []), [hostId, orders, projects]);
}
