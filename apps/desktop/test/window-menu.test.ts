import { describe, expect, it } from "vitest";
import { windowMenuRequest } from "../src/shared/window-menu";
import { windowAppearance } from "../src/shared/window-appearance";

describe("platform window capabilities", () => {
  it("permits only named menus at finite local coordinates", () => {
    expect(windowMenuRequest({ menu: "file", x: 8.2, y: 44, language: "zh" })).toEqual({ menu: "file", x: 8, y: 44, language: "zh" });
    for (const request of [null, {}, { menu: "shell", x: 1, y: 1, language: "zh" }, { menu: "edit", x: NaN, y: 1, language: "en" }, { menu: "edit", x: -1, y: 1, language: "en" }]) expect(() => windowMenuRequest(request)).toThrow();
  });
  const preferences = { prefersReducedTransparency: false, shouldUseHighContrastColors: false, inForcedColorsMode: false };
  it("reserves native glass for macOS and respects accessibility preferences", () => {
    expect(windowAppearance("win32", preferences).nativeGlass).toBe(false);
    expect(windowAppearance("linux", preferences).nativeGlass).toBe(false);
    expect(windowAppearance("darwin", preferences).nativeGlass).toBe(true);
    expect(windowAppearance("darwin", { ...preferences, prefersReducedTransparency: true }).nativeGlass).toBe(false);
    expect(windowAppearance("darwin", { ...preferences, shouldUseHighContrastColors: true }).nativeGlass).toBe(false);
  });
});
