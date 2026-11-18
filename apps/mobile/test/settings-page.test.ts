import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mobileRoot = join(import.meta.dirname, "..");

describe("mobile settings page", () => {
  it("consolidates appearance, devices, and quick replies on a single settings screen", () => {
    const settings = readFileSync(join(mobileRoot, "src", "app", "settings.tsx"), "utf8");

    expect(settings).toContain("settings.themeMode");
    expect(settings).toContain("settings.recentSessionLimit");
    expect(settings).toContain("settings.deviceSwitcherHapticsEnabled");
    expect(settings).toContain("settings.conversationFontSize");
    expect(settings).toContain('router.push("/pair")');
    expect(settings).toContain("<DeviceConnectionRow");
    expect(settings).toContain("DEFAULT_QUICK_REPLIES");

    for (const removedRoute of ["appearance", "notifications", "devices", "quick-replies", "home"]) {
      expect(existsSync(join(mobileRoot, "src", "app", "settings", `${removedRoute}.tsx`))).toBe(false);
    }
    expect(existsSync(join(mobileRoot, "src", "app", "device-order.tsx"))).toBe(false);
    expect(existsSync(join(mobileRoot, "src", "app", "workspace-order.tsx"))).toBe(false);

    const connections = readFileSync(
      join(mobileRoot, "src", "components", "settings", "DeviceConnectionRow.tsx"),
      "utf8",
    );
    expect(connections).toContain('pathname: "/host/[hostId]/edit"');
    expect(connections).toContain("host.relay.url");
  });

  it("keeps settings reachable with or without a paired device", () => {
    const home = readFileSync(join(mobileRoot, "src", "app", "index.tsx"), "utf8");
    const dashboard = readFileSync(
      join(mobileRoot, "src", "components", "HomeDashboard.tsx"),
      "utf8",
    );

    expect(home).toContain('router.push("/settings")');
    expect(home).toContain('accessibilityLabel="设置"');
    expect(dashboard).not.toContain("onOpenSettings");
    expect(dashboard).not.toContain('accessibilityLabel="打开设置"');
    expect(dashboard).not.toContain("首页设置");
  });
});
