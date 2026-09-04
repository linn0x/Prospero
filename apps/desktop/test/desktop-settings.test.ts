import { describe, expect, it } from "vitest";
import { desktopSettingsPatch } from "../src/shared/desktop-settings";

describe("desktop settings input", () => {
  it("normalizes valid values", () => {
    expect(desktopSettingsPatch({ terminalFontFamily: "  Geist Mono  ", terminalFontSize: 14, daemonBind: "127.0.0.1" }, "darwin")).toEqual({
      terminalFontFamily: "Geist Mono",
      terminalFontSize: 14,
      daemonBind: "127.0.0.1",
    });
  });

  it("rejects unknown and malformed values", () => {
    expect(() => desktopSettingsPatch({ surprise: true }, "darwin")).toThrow("设置项无效");
    expect(() => desktopSettingsPatch({ terminalFontSize: 12.5 }, "darwin")).toThrow("终端字号设置无效");
    expect(() => desktopSettingsPatch({ daemonBind: "999.0.0.1" }, "darwin")).toThrow("监听地址无效");
  });

  it("keeps Windows-only permission changes on Windows", () => {
    expect(desktopSettingsPatch({ fullAccessPermission: true }, "win32")).toEqual({ fullAccessPermission: true });
    expect(() => desktopSettingsPatch({ fullAccessPermission: true }, "darwin")).toThrow("仅在 Windows 上可用");
  });
});
