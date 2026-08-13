import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  primaryPaneWidth,
  verticalPaneLayout,
  windowWidthClass,
} from "../src/lib/adaptive-layout-math";

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

  it("按动态窗口宽度而不是设备型号选择布局", () => {
    expect(windowWidthClass(599)).toBe("compact");
    expect(windowWidthClass(600)).toBe("medium");
    expect(windowWidthClass(840)).toBe("expanded");
  });

  it("把竖向铰链转换为两个不会被遮挡的连续面板", () => {
    expect(
      verticalPaneLayout(860, {
        bounds: { x: 420, y: 0, width: 20, height: 720 },
        orientation: "vertical",
        state: "half-opened",
        occlusionType: "full",
        isSeparating: true,
      }),
    ).toEqual({ start: 420, gap: 20, endStart: 440, end: 420 });

    expect(
      verticalPaneLayout(860, {
        bounds: { x: 420, y: 0, width: 0, height: 720 },
        orientation: "vertical",
        state: "flat",
        occlusionType: "none",
        isSeparating: true,
      }),
    ).toEqual({ start: 420, gap: 8, endStart: 428, end: 432 });
  });

  it("不把横向折痕或过窄窗口误判成双栏", () => {
    expect(
      verticalPaneLayout(470, {
        bounds: { x: 230, y: 0, width: 10, height: 700 },
        orientation: "vertical",
        state: "half-opened",
        occlusionType: "full",
        isSeparating: true,
      }),
    ).toBeNull();
    expect(
      verticalPaneLayout(860, {
        bounds: { x: 0, y: 350, width: 860, height: 10 },
        orientation: "horizontal",
        state: "half-opened",
        occlusionType: "full",
        isSeparating: true,
      }),
    ).toBeNull();
  });

  it("忽略上一旋转帧中超出当前窗口的折痕", () => {
    expect(
      verticalPaneLayout(
        933,
        {
          bounds: { x: 352, y: 0, width: 0, height: 933 },
          orientation: "vertical",
          state: "flat",
          occlusionType: "none",
          isSeparating: true,
        },
        704,
      ),
    ).toBeNull();
  });

  it("只在真实分离铰链时把单任务页面约束在连续面板内", () => {
    const panes = verticalPaneLayout(860, {
      bounds: { x: 420, y: 0, width: 20, height: 720 },
      orientation: "vertical",
      state: "half-opened",
      occlusionType: "full",
      isSeparating: true,
    });
    expect(primaryPaneWidth(860, panes)).toBe(420);
    expect(primaryPaneWidth(860, null)).toBe(860);
  });

  it("新建页宽屏双栏首帧使用显式等宽约束", () => {
    const hostScreen = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "src",
        "app",
        "host",
        "[hostId]",
        "index.tsx",
      ),
      "utf8",
    );
    expect(hostScreen).toContain("const balancedPaneWidth = width / 2");
    expect(hostScreen).toContain("width: composerPaneWidths.start");
    expect(hostScreen).toContain("width: composerPaneWidths.end");
  });

  it("原生层订阅 Jetpack WindowManager 的实时姿态", () => {
    const module = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "modules",
        "prospero-window-layout",
        "android",
        "src",
        "main",
        "java",
        "com",
        "linn0x",
        "prospero",
        "windowlayout",
        "ProsperoWindowLayoutModule.kt",
      ),
      "utf8",
    );
    expect(module).toContain("WindowInfoTracker.getOrCreate");
    expect(module).toContain("windowLayoutInfo(activity).collect");
    expect(module).toContain("feature.isSeparating");
  });
});
