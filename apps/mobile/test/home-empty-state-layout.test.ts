import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOME_EMPTY_STATE_MAX_CONTENT_WIDTH,
  HOME_EMPTY_STATE_MAX_FONT_SCALE,
  HOME_EMPTY_STATE_MIN_HIT_TARGET,
  HOME_EMPTY_STATE_MIN_VIEWPORT,
  homeEmptyStateLayout,
} from "../src/lib/home-empty-state-layout";

describe("未配对首页空态布局", () => {
  it("在最小视口和最大辅助字号下保留滚动、内容宽度和安全区尾部空间", () => {
    const layout = homeEmptyStateLayout({
      viewportWidth: HOME_EMPTY_STATE_MIN_VIEWPORT.width,
      bottomInset: 34,
      fontScale: HOME_EMPTY_STATE_MAX_FONT_SCALE,
    });

    expect(HOME_EMPTY_STATE_MIN_VIEWPORT).toEqual({ width: 320, height: 548 });
    expect(layout.contentContainer).toMatchObject({
      flexGrow: 1,
      justifyContent: "center",
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 46,
    });
    expect(layout.body).toEqual({
      width: "100%",
      maxWidth: 288,
      alignSelf: "center",
    });
  });

  it("在宽屏连续面板中限制说明宽度，但不限制文字字号", () => {
    const layout = homeEmptyStateLayout({
      viewportWidth: 1024,
      bottomInset: 20,
      fontScale: 1,
    });

    expect(layout.contentContainer).toMatchObject({
      flexGrow: 1,
      justifyContent: "center",
      paddingHorizontal: 24,
      paddingTop: 24,
      paddingBottom: 32,
    });
    expect(layout.body.maxWidth).toBe(HOME_EMPTY_STATE_MAX_CONTENT_WIDTH);
    expect(HOME_EMPTY_STATE_MIN_HIT_TARGET).toBe(44);
  });

  it("静态断言：首页空态必须是可滚动容器，不能退回不可滚动的 flex 空容器", () => {
    const screen = readFileSync(
      join(import.meta.dirname, "..", "src", "app", "index.tsx"),
      "utf8",
    );
    const emptyBranch = screen.slice(
      screen.indexOf("hosts.length === 0 ?"),
      screen.indexOf("      ) : (", screen.indexOf("hosts.length === 0 ?")),
    );

    expect(emptyBranch).toMatch(
      /<ScrollView\s+testID="hosts-empty-state-scroll"/,
    );
    expect(emptyBranch).toContain(
      "contentContainerStyle={emptyStateLayout.contentContainer}",
    );
    expect(emptyBranch).toContain("scrollEnabled");
    expect(emptyBranch).toContain("styles.emptyWrap, emptyStateLayout.body");
    expect(emptyBranch).not.toContain("<View\n          style={[\n            styles.emptyWrap");
    expect(screen).not.toContain("emptyWrap: { flex: 1");
    expect(screen).toContain("minHeight: HOME_EMPTY_STATE_MIN_HIT_TARGET");
  });
});
