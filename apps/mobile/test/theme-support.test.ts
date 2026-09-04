import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mobileRoot = join(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const themePlugin = require("../plugins/with-theme-colors.js") as {
  palettes: {
    light: Record<string, string>;
    dark: Record<string, string>;
  };
};

describe("mobile theme support", () => {
  it("allows the native app to switch appearance and preserves both Android palettes", () => {
    const app = JSON.parse(readFileSync(join(mobileRoot, "app.json"), "utf8")) as {
      expo: {
        userInterfaceStyle?: string;
        android?: { userInterfaceStyle?: string };
        plugins?: unknown[];
      };
    };
    expect(app.expo.userInterfaceStyle).toBe("automatic");
    expect(app.expo.android?.userInterfaceStyle).toBe("automatic");
    expect(app.expo.plugins).toContain("./plugins/with-theme-colors");

    expect(themePlugin.palettes.light.prospero_bg).toBe("#F4F5F7");
    expect(themePlugin.palettes.dark.prospero_bg).toBe("#0A0A0C");
  });

  it("keeps navigation and system bars synchronized with the selected mode", () => {
    const layout = readFileSync(join(mobileRoot, "src", "app", "_layout.tsx"), "utf8");
    expect(layout).toContain("Appearance.setColorScheme");
    expect(layout).toContain("paletteForScheme(activeScheme)");
    expect(layout).toContain("<NavigationBar style={activeScheme}");
    expect(layout).toContain('activeScheme === "dark" ? "light" : "dark"');
  });
});
