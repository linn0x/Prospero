import { describe, expect, it } from "vitest";
import {
  deviceDetailPage,
  deviceDetailLayout,
  deviceDetailPageIndex,
  deviceDetailPosition,
  settledDeviceDetailPage,
} from "../src/lib/device-detail-pages";

describe("device detail pages", () => {
  it("keeps the close row and OS rail inside short landscape and narrow windows", () => {
    for (const height of [280, 320, 400, 600, 844]) {
      const layout = deviceDetailLayout(320, height);
      expect(layout.stageHeight).toBeLessThanOrEqual(height - 24);
      expect(layout.cardHeight + 44 + 42 + 18).toBe(layout.stageHeight);
      expect(layout.cardHeight).toBeLessThanOrEqual(540);
      expect(layout.cardWidth).toBe(288);
      expect(layout.stageTop).toBeGreaterThanOrEqual(12);
      expect(layout.stageTop + layout.stageHeight).toBeLessThanOrEqual(height - 12);
    }
    expect(deviceDetailLayout(840, 400).cardHeight).toBe(272);
    expect(deviceDetailLayout(840, 400).stageTop).toBe(12);
  });

  it("reserves the home preview above the detail title whenever the window is tall enough", () => {
    const layout = deviceDetailLayout(360, 780);
    expect(layout.stageTop).toBe(80);
    expect(layout.cardHeight).toBe(540);
    expect(layout.stageTop + layout.stageHeight).toBe(724);
    expect(deviceDetailLayout(360, 600).stageTop).toBe(80);
    expect(deviceDetailLayout(360, 844).stageTop).toBe(80);
    expect(deviceDetailLayout(720, 700).stageTop).toBe(80);
  });
  it("places an add page on each side while preserving real host positions", () => {
    expect([0, 1, 2, 3].map((index) => deviceDetailPage(index, 2))).toEqual([
      { kind: "add", side: "before" },
      { kind: "device", hostIndex: 0 },
      { kind: "device", hostIndex: 1 },
      { kind: "add", side: "after" },
    ]);
    expect(deviceDetailPosition(0, 360, 2)).toBe(-1);
    expect(deviceDetailPosition(360, 360, 2)).toBe(0);
    expect(deviceDetailPosition(540, 360, 2)).toBe(0.5);
    expect(deviceDetailPosition(1080, 360, 2)).toBe(2);
    expect(deviceDetailPosition(-50, 360, 2)).toBe(-1);
    expect(deviceDetailPosition(5000, 360, 2)).toBe(2);
  });

  it("lets an add page override the selected host, including with one host", () => {
    expect(deviceDetailPageIndex(0, 1, null)).toBe(1);
    expect(deviceDetailPageIndex(0, 1, "before")).toBe(0);
    expect(deviceDetailPageIndex(0, 1, "after")).toBe(2);
    expect(deviceDetailPageIndex(-1, 3, null)).toBe(1);
  });

  it("ignores an intermediate momentum end during a programmatic jump", () => {
    expect(settledDeviceDetailPage(360, 360, 3, 3)).toBeNull();
    expect(settledDeviceDetailPage(1080, 360, 3, 3)).toBe(3);
    expect(settledDeviceDetailPage(1079, 360, 3, 3)).toBe(3);
    expect(settledDeviceDetailPage(600, 360, 3, null)).toBe(2);
  });
});
