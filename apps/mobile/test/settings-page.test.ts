import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mobileRoot = join(import.meta.dirname, "..");

describe("mobile settings page", () => {
  it("routes each category to its own page and keeps device actions under device management", () => {
    const settings = readFileSync(join(mobileRoot, "src", "app", "settings.tsx"), "utf8");

    for (const page of ["appearance", "notifications", "devices"]) {
      expect(settings).toContain(`router.push("/settings/${page}")`);
      expect(readFileSync(join(mobileRoot, "src", "app", "settings", `${page}.tsx`), "utf8")).toContain("<SettingsPage");
    }
    expect(settings).not.toContain("<Switch");
    expect(settings).not.toContain('router.push("/settings/home")');
    const appearance = readFileSync(join(mobileRoot, "src", "app", "settings", "appearance.tsx"), "utf8");
    expect(appearance).toContain("settings.recentSessionLimit");
    expect(appearance).toContain("settings.deviceSwitcherHapticsEnabled");
    expect(appearance).toContain("settings.conversationFontSize");
    expect(settings).not.toContain("<DeviceConnectionRow");
    const devices = readFileSync(join(mobileRoot, "src", "app", "settings", "devices.tsx"), "utf8");
    expect(devices).toContain('router.push("/device-order")');
    expect(devices).toContain('router.push("/pair")');
    const connections = readFileSync(join(mobileRoot, "src", "components", "settings", "DeviceConnectionRow.tsx"), "utf8");
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
