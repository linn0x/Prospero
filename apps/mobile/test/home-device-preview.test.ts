import { describe, expect, it } from "vitest";
import { clampDetailPreviewPosition, homeDevicePreviewIndex, showsAddDevicePreview, type HomeDevicePreview } from "../src/lib/home-device-preview";

const hosts = [{ id: "mac" }, { id: "pc" }];
const preview: HomeDevicePreview = { detailsOpen: true, detailHostId: "mac", addDeviceSide: null, quickSwitchActive: false, previewHostId: null };

describe("detail and homepage device preview synchronization", () => {
  it("keeps real device positions stable and exposes a new-device page at each end", () => {
    expect(homeDevicePreviewIndex(hosts, "mac", preview)).toBe(0);
    expect(homeDevicePreviewIndex(hosts, "mac", { ...preview, detailHostId: "pc" })).toBe(1);
    expect(homeDevicePreviewIndex(hosts, "mac", { ...preview, addDeviceSide: "before" })).toBe(-1);
    expect(homeDevicePreviewIndex(hosts, "pc", { ...preview, addDeviceSide: "after" })).toBe(2);
    expect(clampDetailPreviewPosition(-0.65, 2)).toBe(-0.65);
    expect(clampDetailPreviewPosition(1.75, 2)).toBe(1.75);
    expect(clampDetailPreviewPosition(-3, 2)).toBe(-1);
    expect(clampDetailPreviewPosition(3, 2)).toBe(2);
  });

  it("never shows an add preview during long-press switching, even with stale detail state", () => {
    const state = { ...preview, addDeviceSide: "after" as const, quickSwitchActive: true, previewHostId: "pc" };
    expect(showsAddDevicePreview(state)).toBe(false);
    expect(homeDevicePreviewIndex(hosts, "mac", state)).toBe(1);
    expect(homeDevicePreviewIndex(hosts, "mac", { ...state, previewHostId: "mac" })).toBe(0);
  });

  it("returns to the selected real host after closing details and works with a single host", () => {
    const closed = { ...preview, detailsOpen: false, addDeviceSide: "before" as const };
    expect(showsAddDevicePreview(closed)).toBe(false);
    expect(homeDevicePreviewIndex(hosts, "pc", closed)).toBe(1);
    expect(homeDevicePreviewIndex(hosts.slice(0, 1), "mac", { ...preview, addDeviceSide: "after" })).toBe(1);
    expect(homeDevicePreviewIndex(hosts.slice(0, 1), "mac", { ...preview, addDeviceSide: "before" })).toBe(-1);
    expect(clampDetailPreviewPosition(Number.NaN, 1)).toBe(0);
  });
});
