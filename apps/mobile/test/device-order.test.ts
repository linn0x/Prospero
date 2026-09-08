import { describe, expect, it, vi } from "vitest";
import { deviceDragIndex, deviceDragScrollSpeed, moveDevice, normalizeDeviceOrder, orderDevices } from "../src/lib/device-order";
import { createDeviceOrderStore } from "../src/lib/device-order-preferences";
import { selectedEdgeHosts } from "../src/lib/edge-preferences";
import { deviceDetailPage } from "../src/lib/device-detail-pages";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: vi.fn(), setItem: vi.fn() } }));
const devices = ["mac", "pc", "linux"].map((id) => ({ id, name: id }));

describe("shared device order", () => {
  it("retains saved devices, drops deleted IDs and appends new devices without mutating metadata", () => {
    const next = orderDevices(devices, ["pc", "removed", "pc", "mac"]);
    expect(next.map((device) => device.id)).toEqual(["pc", "mac", "linux"]);
    expect(next[0]).toBe(devices[1]);
    expect(devices.map((device) => device.id)).toEqual(["mac", "pc", "linux"]);
    expect(normalizeDeviceOrder(["pc", false, null, "", "pc", "mac"])).toEqual(["pc", "mac"]);
  });

  it("applies the same order to Edge selection and real detail pages while retaining the two add pages", () => {
    const ordered = orderDevices(devices, ["linux", "pc", "mac"]);
    expect(selectedEdgeHosts(ordered, ["mac", "linux"]).map((device) => device.id)).toEqual(["linux", "mac"]);
    expect(deviceDetailPage(0, ordered.length)).toEqual({ kind: "add", side: "before" });
    expect(deviceDetailPage(4, ordered.length)).toEqual({ kind: "add", side: "after" });
    const first = deviceDetailPage(1, ordered.length);
    expect(first.kind === "device" && ordered[first.hostIndex].id).toBe("linux");
  });

  it("supports dragging both directions, clamps boundaries, and leaves absent devices alone", () => {
    const ids = devices.map((device) => device.id);
    expect(moveDevice(ids, "mac", 99)).toEqual(["pc", "linux", "mac"]);
    expect(moveDevice(ids, "linux", -10)).toEqual(["linux", "mac", "pc"]);
    expect(moveDevice(ids, "missing", 1)).toEqual(ids);
    expect(deviceDragIndex(35, 72, 3)).toBe(0);
    expect(deviceDragIndex(37, 72, 3)).toBe(1);
    expect(deviceDragIndex(900, 72, 3)).toBe(2);
    expect(deviceDragIndex(-100, 72, 3)).toBe(0);
    expect(deviceDragScrollSpeed(90, 100, 500)).toBe(-420);
    expect(deviceDragScrollSpeed(610, 100, 500)).toBe(420);
    expect(deviceDragScrollSpeed(350, 100, 500)).toBe(0);
  });

  it("restores a saved order after restart and only writes the ID preference", async () => {
    let raw: string | null = null;
    const storage = { getItem: async () => raw, setItem: vi.fn(async (_key: string, value: string) => { raw = value; }) };
    const first = createDeviceOrderStore(storage);
    await first.getState().saveOrder(["linux", "mac", "pc"]);
    const restarted = createDeviceOrderStore(storage);
    await restarted.getState().hydrate();
    expect(orderDevices(devices, restarted.getState().ids).map((device) => device.id)).toEqual(["linux", "mac", "pc"]);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith("prospero.deviceOrder.v1", '["linux","mac","pc"]');
  });

  it("waits for delayed hydration before applying a new drag", async () => {
    let resolveRead!: (raw: string) => void;
    const store = createDeviceOrderStore({ getItem: () => new Promise((resolve) => { resolveRead = resolve; }), setItem: async () => {} });
    const writing = store.getState().saveOrder(["linux", "pc", "mac"]);
    resolveRead('["mac","pc","linux"]');
    await writing;
    expect(store.getState().ids).toEqual(["linux", "pc", "mac"]);
  });

  it("serializes rapid reorders and rolls a failed final save back to the last successful one", async () => {
    let release!: () => void;
    const storage = { getItem: async () => '["mac","pc","linux"]', setItem: vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockRejectedValueOnce(new Error("disk busy")) };
    const store = createDeviceOrderStore(storage);
    await store.getState().hydrate();
    const first = store.getState().saveOrder(["pc", "mac", "linux"]);
    const second = store.getState().saveOrder(["linux", "pc", "mac"]);
    const failed = expect(second).rejects.toThrow("disk busy");
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(1));
    expect(store.getState().ids).toEqual(["linux", "pc", "mac"]);
    release();
    await first;
    await failed;
    expect(store.getState().ids).toEqual(["pc", "mac", "linux"]);
  });
});
