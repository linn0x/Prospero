import { describe, expect, it, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
  },
}));

describe("home preferences", () => {
  it("waits for pending saves when entering another category and preserves fast edits in order", async () => {
    const { DEFAULT_HOME_SETTINGS, getHomeSettings, rememberHomeSettings } = await import("../src/lib/home-preferences");
    let raw: string | null = null;
    let finishFirst!: () => void;
    const write = vi.mocked(AsyncStorage.setItem).mockImplementationOnce((_key, value) => new Promise((resolve) => {
      finishFirst = () => { raw = value; resolve(); };
    })).mockImplementation(async (_key, value) => { raw = value; });
    vi.mocked(AsyncStorage.getItem).mockImplementation(async () => raw);
    const first = rememberHomeSettings({ ...DEFAULT_HOME_SETTINGS, themeMode: "light" });
    const second = rememberHomeSettings({ ...DEFAULT_HOME_SETTINGS, themeMode: "light", recentSessionLimit: 8 });
    let loaded = false;
    const read = getHomeSettings().then((value) => { loaded = true; return value; });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(loaded).toBe(false);
    finishFirst();
    await Promise.all([first, second]);
    await expect(read).resolves.toMatchObject({ themeMode: "light", recentSessionLimit: 8 });
  });

  it("fills theme and alias fields when upgrading an old settings snapshot", async () => {
    const { normalizeHomeSettings, DEFAULT_HOME_SETTINGS } = await import("../src/lib/home-preferences");
    expect(normalizeHomeSettings({ recentSessionLimit: 8 })).toEqual({
      ...DEFAULT_HOME_SETTINGS,
      recentSessionLimit: 8,
      deviceSwitcherHapticsEnabled: true,
      backgroundProgressEnabled: true,
      overlayProgressEnabled: false,
      themeMode: "system",
      conversationFontSize: 15,
      workspaceAliases: {},
    });
  });

  it("persists custom replies and compact mode across reloads, including intentionally empty groups", async () => {
    const { normalizeHomeSettings, rememberHomeSettings, getHomeSettings } = await import("../src/lib/home-preferences");
    let raw: string | null = null;
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (_key, value) => { raw = value; });
    vi.mocked(AsyncStorage.getItem).mockImplementation(async () => raw);
    const settings = normalizeHomeSettings({ sessionActionsHidden: true, quickReplies: { idle: ["  检查日志  ", "检查日志", "完成后总结"], busy: [] } });
    await rememberHomeSettings(settings, true);
    await expect(getHomeSettings()).resolves.toMatchObject({ sessionActionsHidden: true, quickReplies: { idle: ["检查日志", "完成后总结"], busy: [] } });
  });

  it("reports explicit save failures and allows the next save to succeed", async () => {
    const { DEFAULT_HOME_SETTINGS, rememberHomeSettings } = await import("../src/lib/home-preferences");
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce();
    await expect(rememberHomeSettings(DEFAULT_HOME_SETTINGS, true)).rejects.toThrow("disk full");
    await expect(rememberHomeSettings(DEFAULT_HOME_SETTINGS, true)).resolves.toBeUndefined();
  });

  it("normalizes workspace keys and removes unsafe aliases", async () => {
    const { normalizeHomeSettings, workspaceAliasKey } = await import(
      "../src/lib/home-preferences"
    );
    expect(workspaceAliasKey("pc", "C:\\work\\repo\\")).toBe("pc\u001fC:\\work\\repo");
    expect(
      normalizeHomeSettings({
        themeMode: "light",
        deviceSwitcherHapticsEnabled: false,
        workspaceAliases: { good: "  客户端  ", empty: "   ", huge: "x".repeat(61) },
      }),
    ).toMatchObject({
      deviceSwitcherHapticsEnabled: false,
      workspaceAliases: { good: "客户端" },
    });
  });
});
