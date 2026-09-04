import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
  },
}));

describe("home preferences", () => {
  it("fills theme and alias fields when upgrading an old settings snapshot", async () => {
    const { normalizeHomeSettings } = await import("../src/lib/home-preferences");
    expect(normalizeHomeSettings({ recentSessionLimit: 8 })).toEqual({
      recentSessionLimit: 8,
      backgroundProgressEnabled: true,
      overlayProgressEnabled: false,
      themeMode: "system",
      workspaceAliases: {},
    });
  });

  it("normalizes workspace keys and removes unsafe aliases", async () => {
    const { normalizeHomeSettings, workspaceAliasKey } = await import(
      "../src/lib/home-preferences"
    );
    expect(workspaceAliasKey("pc", "C:\\work\\repo\\")).toBe("pc\u001fC:\\work\\repo");
    expect(
      normalizeHomeSettings({
        themeMode: "light",
        workspaceAliases: { good: "  客户端  ", empty: "   ", huge: "x".repeat(61) },
      }).workspaceAliases,
    ).toEqual({ good: "客户端" });
  });
});
