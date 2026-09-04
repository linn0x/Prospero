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

    const themePluginIndex = app.expo.plugins?.findIndex(
      (plugin) => plugin === "./plugins/with-theme-colors",
    ) ?? -1;
    const splashPluginIndex = app.expo.plugins?.findIndex(
      (plugin) => Array.isArray(plugin) && plugin[0] === "expo-splash-screen",
    ) ?? -1;
    // Expo 的 Android colors mod 以包装顺序执行；主题插件必须先声明，才能最终覆盖
    // splashscreen_background，而不是让浅色模式闪过固定深色启动页。
    expect(themePluginIndex).toBeGreaterThanOrEqual(0);
    expect(themePluginIndex).toBeLessThan(splashPluginIndex);

    expect(themePlugin.palettes.light.prospero_bg).toBe("#F2F4F7");
    expect(themePlugin.palettes.dark.prospero_bg).toBe("#0B0D12");
    expect(themePlugin.palettes.light.splashscreen_background).toBe("#F2F4F7");
    expect(themePlugin.palettes.dark.splashscreen_background).toBe("#0B0D12");

    const themeSource = readFileSync(join(mobileRoot, "src", "lib", "theme.ts"), "utf8");
    for (const palette of [themePlugin.palettes.light, themePlugin.palettes.dark]) {
      for (const [name, value] of Object.entries(palette)) {
        if (name === "activityBackground" || name === "splashscreen_background") continue;
        expect(themeSource, `${name} should match src/lib/theme.ts`).toContain(value);
      }
    }
  });

  it("keeps navigation and system bars synchronized with the selected mode", () => {
    const layout = readFileSync(join(mobileRoot, "src", "app", "_layout.tsx"), "utf8");
    expect(layout).toContain("applyNativeThemeMode(themeMode)");
    expect(layout).toContain("const activeScheme = resolveThemeScheme(themeMode, systemScheme)");
    expect(layout).not.toContain("function NativeThemeModeController");
    expect(layout).toContain("paletteForScheme(activeScheme)");
    expect(layout).toContain("<NavigationBar style={activeScheme}");
    expect(layout).toContain('activeScheme === "dark" ? "light" : "dark"');
  });

  it("provides an explicit React theme without remounting the navigation stack", () => {
    const layout = readFileSync(join(mobileRoot, "src", "app", "_layout.tsx"), "utf8");

    expect(layout).toContain("<MobileThemeContext.Provider value={mobileTheme}>");
    expect(layout).not.toContain("nativeThemeEpoch");
    expect(layout).not.toContain("screenLayout=");
    expect(layout).not.toContain("<Stack key={activeScheme}");
  });

  it("renders the mounted home screen from the explicit palette", () => {
    const home = readFileSync(join(mobileRoot, "src", "app", "index.tsx"), "utf8");
    const dashboard = readFileSync(
      join(mobileRoot, "src", "components", "HomeDashboard.tsx"),
      "utf8",
    );

    for (const source of [home, dashboard]) {
      expect(source).toContain("useMobileTheme()");
      expect(source).toContain("createStyles(palette)");
    }
    expect(home).not.toContain("backgroundColor: color.");
    expect(dashboard).not.toContain("backgroundColor: color.");
    expect(dashboard).not.toContain("statusColor[");
  });

  it("publishes the selected palette before syncing Android appearance", () => {
    const settings = readFileSync(join(mobileRoot, "src", "app", "settings.tsx"), "utf8");
    const layout = readFileSync(join(mobileRoot, "src", "app", "_layout.tsx"), "utf8");

    expect(settings).toContain("updateSettings({ themeMode });");
    expect(settings).not.toContain("applyNativeThemeMode(themeMode);");
    expect(settings).toContain("const styles = useMemo(() => createStyles(palette), [palette])");
    expect(settings).toContain("function createStyles(palette: ThemePalette)");
    expect(layout).toContain("useEffect(() => {");
    expect(layout).toContain("applyNativeThemeMode(themeMode);");
  });

  it("does not rerender unrelated home and progress trees for a theme-only change", () => {
    const home = readFileSync(join(mobileRoot, "src", "app", "index.tsx"), "utf8");
    const progressBridge = readFileSync(
      join(mobileRoot, "src", "components", "RunningSessionProgressBridge.tsx"),
      "utf8",
    );

    expect(home).not.toContain("useApp((state) => state.homeSettings) ??");
    expect(home).toContain("state.homeSettings?.recentSessionLimit");
    expect(home).toContain("state.homeSettings?.workspaceAliases");
    expect(progressBridge).not.toContain("useApp((state) => state.homeSettings) ??");
    expect(progressBridge).toContain("state.homeSettings?.backgroundProgressEnabled");
    expect(progressBridge).toContain("state.homeSettings?.overlayProgressEnabled");
  });

  it.each(["light", "dark"] as const)("keeps %s theme text at readable contrast", (scheme) => {
    const palette = themePlugin.palettes[scheme];
    const pairs = [
      ["prospero_text", "prospero_bg"],
      ["prospero_text", "prospero_surface"],
      ["prospero_text_dim", "prospero_surface"],
      ["prospero_text_faint", "prospero_surface"],
      ["prospero_accent", "prospero_surface"],
      ["prospero_on_accent", "prospero_accent"],
      ["prospero_success", "prospero_success_bg"],
      ["prospero_warn", "prospero_warn_bg"],
      ["prospero_danger", "prospero_danger_bg"],
    ] as const;
    for (const [foreground, background] of pairs) {
      expect(
        contrastRatio(palette[foreground] ?? "", palette[background] ?? ""),
        `${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("does not leave dark-only colors in theme-sensitive conversation surfaces", () => {
    const files = [
      "src/components/CodeBlock.tsx",
      "src/components/DiffView.tsx",
      "src/components/Markdown.tsx",
      "src/components/MathView.tsx",
      "src/components/VoiceButton.tsx",
      "src/app/host/[hostId]/files/[sid].tsx",
      "src/app/host/[hostId]/git/[sid].tsx",
    ];
    for (const file of files) {
      const source = readFileSync(join(mobileRoot, file), "utf8");
      expect(source, file).not.toMatch(/\b(?:backgroundColor|borderColor|color):\s*["']#[0-9a-f]{3,8}["']/i);
    }
  });

  it("offers a full-width expanded composer with reliable in-field controls", () => {
    const source = readFileSync(
      join(mobileRoot, "src", "app", "host", "[hostId]", "session", "[sid].tsx"),
      "utf8",
    );
    expect(source).toContain('composerExpanded ? "收起输入框" : "放大输入框"');
    expect(source).toContain("styles.composerResizeButton");
    expect(source).toContain("hitSlop={10}");
    expect(source).toContain("styles.inputShellExpanded");
    expect(source).toContain("styles.expandedComposerActions");
    expect(source).toContain('label: "@ 文件"');
    expect(source).toContain('label: "``` 代码块"');
    expect(source).toContain("insertQuickCharacter(tool.value, tool.cursorOffset ?? 0)");
    expect(source).toContain("adaptiveLayout.height * 0.22");
  });
});

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(hex: string): number {
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) throw new Error(`Invalid color ${hex}`);
  const channels = [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}
