import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEVICE_QUICK_SWITCH_CANCEL_Y,
  deviceIndexForCarouselOffset,
  deviceIndexForRailPosition,
  deviceIndexForTranslation,
  deviceRailWindow,
  quickSwitchShouldCancel,
} from "../src/lib/device-quick-switcher";

describe("device quick switcher", () => {
  it("keeps at most six nearby status dots around the active device", () => {
    expect(deviceRailWindow(1, 0)).toEqual([0]);
    expect(deviceRailWindow(4, 2)).toEqual([0, 1, 2, 3]);
    expect(deviceRailWindow(10, 0)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(deviceRailWindow(10, 5)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(deviceRailWindow(10, 9)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(deviceRailWindow(10, 5, 2)).toEqual([4, 5]);
  });

  it("maps horizontal travel to devices and clamps either end", () => {
    expect(deviceIndexForTranslation(3, 0, 8)).toBe(3);
    expect(deviceIndexForTranslation(3, 35, 8)).toBe(4);
    expect(deviceIndexForTranslation(3, -70, 8)).toBe(1);
    expect(deviceIndexForTranslation(3, 999, 8)).toBe(7);
    expect(deviceIndexForTranslation(3, -999, 8)).toBe(0);
  });

  it("treats a deliberate vertical escape as cancellation", () => {
    expect(quickSwitchShouldCancel(DEVICE_QUICK_SWITCH_CANCEL_Y - 1)).toBe(false);
    expect(quickSwitchShouldCancel(DEVICE_QUICK_SWITCH_CANCEL_Y)).toBe(true);
    expect(quickSwitchShouldCancel(-DEVICE_QUICK_SWITCH_CANCEL_Y)).toBe(true);
  });

  it("resolves paged cards and draggable OS rail positions", () => {
    expect(deviceIndexForCarouselOffset(0, 310, 4)).toBe(0);
    expect(deviceIndexForCarouselOffset(470, 310, 4)).toBe(2);
    expect(deviceIndexForCarouselOffset(9999, 310, 4)).toBe(3);
    expect(deviceIndexForRailPosition(0, 9, 5)).toBe(0);
    expect(deviceIndexForRailPosition(0, 108, 5)).toBe(2);
    expect(deviceIndexForRailPosition(100, 9, 5)).toBe(2);
  });

  it("animates device dots for approval, work, and unread completion", () => {
    const switcher = readFileSync(
      join(import.meta.dirname, "..", "src", "components", "DeviceQuickSwitcher.tsx"),
      "utf8",
    );

    expect(switcher).toContain('motion === "approval"');
    expect(switcher).toContain("doubleFlash(motionValue)");
    expect(switcher).toContain('motion === "working"');
    expect(switcher).toContain("transform: [{ scale: motionValue }]");
    expect(switcher).toContain('motion === "unread-completed"');
    expect(switcher).toContain("transform: [{ translateY: motionValue }]");
    expect(switcher).toContain("AccessibilityInfo.isReduceMotionEnabled()");
  });
});
