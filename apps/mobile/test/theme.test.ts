import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  PlatformColor: (name: string) => name,
}));

// Mock must be registered before the theme module evaluates its native colors.
// eslint-disable-next-line import/first
import { color, quotaRemainingColor, quotaRemainingPct } from "../src/lib/theme";

describe("subscription quota presentation", () => {
  it("shrinks from full balance to empty as utilization rises", () => {
    expect(quotaRemainingPct(0)).toBe(100);
    expect(quotaRemainingPct(42.4)).toBe(58);
    expect(quotaRemainingPct(100)).toBe(0);
    expect(quotaRemainingPct(-20)).toBe(100);
    expect(quotaRemainingPct(140)).toBe(0);
  });

  it("turns red only below fifteen percent remaining", () => {
    expect(quotaRemainingColor(100)).toBe(color.accent);
    expect(quotaRemainingColor(34)).toBe(color.warn);
    expect(quotaRemainingColor(15)).toBe(color.warn);
    expect(quotaRemainingColor(14)).toBe(color.danger);
  });
});
