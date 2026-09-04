import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mobileRoot = join(import.meta.dirname, "..");

describe("mobile settings page", () => {
  it("collects appearance, home, progress and per-device connection settings", () => {
    const settings = readFileSync(join(mobileRoot, "src", "app", "settings.tsx"), "utf8");

    expect(settings).toContain('title="外观"');
    expect(settings).toContain("HOME_RECENT_SESSION_LIMITS.map");
    expect(settings).toContain('title="后台任务"');
    expect(settings).toContain('title="设备与连接"');
    expect(settings).toContain("host.relay.url");
    expect(settings).toContain('pathname: "/host/[hostId]/edit"');
    expect(settings).toContain("rememberHomeSettings(next)");
  });

  it("keeps settings reachable with or without a paired device", () => {
    const home = readFileSync(join(mobileRoot, "src", "app", "index.tsx"), "utf8");
    const dashboard = readFileSync(
      join(mobileRoot, "src", "components", "HomeDashboard.tsx"),
      "utf8",
    );

    expect(home).toContain('router.push("/settings")');
    expect(home).toContain('accessibilityLabel="设置"');
    expect(dashboard).toContain("onPress={onOpenSettings}");
    expect(dashboard).not.toContain("首页设置");
  });
});
