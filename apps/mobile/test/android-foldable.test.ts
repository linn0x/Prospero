import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Android 折叠屏适配", () => {
  it("不锁定竖屏并启用 Fold 配置插件", () => {
    const app = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "app.json"), "utf8"),
    ) as {
      expo: { orientation: string; plugins: unknown[] };
    };
    expect(app.expo.orientation).toBe("default");
    expect(app.expo.plugins).toContain("./plugins/with-foldable-support");
  });

  it("预构建时显式允许调整窗口并移除方向和宽高比限制", () => {
    const plugin = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "plugins",
        "with-foldable-support.js",
      ),
      "utf8",
    );
    expect(plugin).toContain('["android:resizeableActivity"] = "true"');
    expect(plugin).toContain('delete activity.$["android:screenOrientation"]');
    expect(plugin).toContain('delete activity.$["android:maxAspectRatio"]');
  });
});
