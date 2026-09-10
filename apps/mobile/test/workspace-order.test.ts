import { describe, expect, it, vi } from "vitest";
import { normalizeWorkspaceOrders, orderEdgeWorkspaces, orderWorkspaces } from "../src/lib/workspace-order";
import { createWorkspaceOrderStore } from "../src/lib/workspace-order-preferences";
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: vi.fn(), setItem: vi.fn() } }));

describe("directory ordering", () => {
  it("retains identity, appends new paths and ignores removed or duplicate paths", () => {
    const projects = ["D:\\work\\a", "D:\\work\\b", "D:\\work\\new"].map((path) => ({ path }));
    const result = orderWorkspaces(projects, [projects[1]!.path, "removed", projects[1]!.path]);
    expect(result).toEqual([projects[1], projects[0], projects[2]]);
    expect(result[0]).toBe(projects[1]);
    expect(normalizeWorkspaceOrders({ pc: [null, "a", "a", 3], mac: false })).toEqual({ pc: ["a"], mac: [] });
  });
  it("keeps same-named paths on different hosts independent in Edge", () => {
    const rows = [["pc", "a"], ["mac", "a"], ["pc", "b"], ["mac", "b"]].map(([id, path]) => ({ host: { id: id! }, project: { path: path! } }));
    expect(orderEdgeWorkspaces(rows, { pc: ["b", "a"] })).toEqual([rows[2], rows[1], rows[0], rows[3]]);
  });
  it("serializes edits across devices, rolls failed writes back and restores after restart", async () => {
    let raw = '{"pc":["a","b"]}';
    const storage = { getItem: async () => raw, setItem: vi.fn(async (_key: string, value: string) => { raw = value; }) };
    const store = createWorkspaceOrderStore(storage);
    await Promise.all([store.getState().saveOrder("pc", ["b", "a"]), store.getState().saveOrder("mac", ["x", "y"])]);
    storage.setItem.mockRejectedValueOnce(new Error("disk full"));
    await expect(store.getState().saveOrder("pc", ["a", "b"])).rejects.toThrow("disk full");
    const restarted = createWorkspaceOrderStore(storage);
    await restarted.getState().hydrate();
    expect(restarted.getState().orders).toEqual({ pc: ["b", "a"], mac: ["x", "y"] });
    expect(store.getState().orders).toEqual(restarted.getState().orders);
  });
});
