import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@prospero/protocol";

import {
  homeHostOsLabel,
  homeHostStats,
  homeRecentSessions,
  homeWorkspaceProjects,
  resolveHomeHostSelection,
} from "../src/lib/home-dashboard";

function session(
  id: string,
  cwd: string,
  status: SessionInfo["status"] = "idle",
  createdAt = 1,
): SessionInfo {
  return {
    id,
    agent: "codex",
    kind: "structured",
    title: id,
    cwd,
    status,
    createdAt,
    cols: 80,
    rows: 24,
  };
}

describe("home dashboard", () => {
  it("设备列表刷新时保留仍然存在的当前设备", () => {
    const hosts = [{ id: "mac" }, { id: "pc" }];
    expect(resolveHomeHostSelection(hosts, "pc")).toBe("pc");
    expect(resolveHomeHostSelection(hosts, "gone")).toBe("mac");
    expect(resolveHomeHostSelection([], "pc")).toBeNull();
  });

  it("切换设备后按会话优先级聚合对应工作目录", () => {
    const projects = homeWorkspaceProjects({
      old: session("old", "/work/alpha", "idle", 1),
      active: session("active", "/work/beta", "running", 2),
      newer: session("newer", "/work/alpha/", "idle", 3),
    });

    expect(projects.map((project) => project.path)).toEqual(["/work/beta", "/work/alpha"]);
    expect(projects[1]?.sessions.map((item) => item.id)).toEqual(["newer", "old"]);
  });

  it("概览卡区分会话总量和仍活跃的主 Agent / 子 Agent", () => {
    const running = session("running", "/work", "running", 3);
    running.subagents = [
      {
        id: "child-running",
        name: "worker",
        status: "running",
        canMessage: true,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: "child-done",
        name: "done",
        status: "completed",
        canMessage: false,
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    expect(
      homeHostStats({
        running,
        idle: session("idle", "/work", "idle", 2),
        done: session("done", "/work", "done", 1),
      }),
    ).toEqual({ sessionCount: 3, activeAgentCount: 3, runningCount: 1 });
  });

  it("最近对话严格按创建时间截取用户设置的数量", () => {
    expect(
      homeRecentSessions(
        {
          old: session("old", "/work", "running", 1),
          latest: session("latest", "/work", "done", 9),
          middle: session("middle", "/work", "idle", 5),
        },
        2,
      ).map((item) => item.id),
    ).toEqual(["latest", "middle"]);
  });

  it("系统摘要在未连接时给出明确占位，连接后组合系统和架构", () => {
    expect(homeHostOsLabel(null)).toBe("连接后读取系统信息");
    expect(
      homeHostOsLabel({
        name: "studio",
        daemonVersion: "1.0.0",
        protocolVersion: 13,
        platform: "darwin",
        osVersion: "15.6",
        arch: "arm64",
      }),
    ).toBe("darwin · 15.6 · arm64");
  });

  it("动态目录关闭 Android cell 裁剪，并把设备区放在首页顶部", () => {
    const dashboard = readFileSync(
      join(import.meta.dirname, "..", "src", "components", "HomeDashboard.tsx"),
      "utf8",
    );
    const quickSwitcher = readFileSync(
      join(import.meta.dirname, "..", "src", "components", "DeviceQuickSwitcher.tsx"),
      "utf8",
    );
    const detailCarousel = readFileSync(
      join(import.meta.dirname, "..", "src", "components", "DeviceDetailCarousel.tsx"),
      "utf8",
    );

    expect(dashboard).toContain("removeClippedSubviews={false}");
    expect(dashboard).toContain("collapsable={false}");
    expect(dashboard).toContain('<Sheet');
    expect(dashboard).toContain('visible={devicePickerOpen}');
    expect(dashboard).toContain("onOpenSession(selectedHost.id, session.id)");
    expect(dashboard).toContain('label="添加设备"');
    expect(dashboard).toContain('label="新建目录"');
    expect(dashboard).not.toContain("onOpenSettings");
    expect(dashboard).not.toContain("sectionSubtitle");
    expect(dashboard).not.toContain("最近 {String(effectiveHomeSettings.recentSessionLimit)} 条");
    expect(dashboard).not.toContain("visible={settingsOpen}");
    expect(dashboard).toContain("normalizeHomeSettings(homeSettings ?? DEFAULT_HOME_SETTINGS)");
    expect(dashboard).toContain("projectCardPressed: { borderRadius: radius.md");
    expect(dashboard).toContain('name="pencil"');
    expect(dashboard).toContain("<SwipeRow");
    expect(dashboard).toContain('id: "create-session"');
    expect(dashboard).toContain('id: "edit-workspace"');
    expect(dashboard).toContain("workspaceAliasKey(selectedHost.id, editingProject.path)");
    expect(dashboard).not.toContain("styles.projectCreate");
    expect(dashboard).not.toContain("{devicePickerOpen && (");
    expect(dashboard).toContain('name={brand}');
    expect(dashboard).toContain("styles.deviceFleetPill");
    expect(dashboard).toContain("hostConnectionTone(runtime, palette)");
    expect(dashboard).toContain('`${String(runtime.rttMs)}ms`');
    expect(dashboard).toContain("orderedHosts.slice(1).map");
    expect(dashboard).toContain("styles.fleetCurrentStatus");
    expect(dashboard).toContain("hostConnectionLabel(runtime)");
    expect(dashboard).not.toContain("styles.deviceIdentityMark");
    expect(dashboard).toContain("<DeviceQuickSwitcher");
    expect(dashboard).not.toContain("DevicePreviewCarousel");
    expect(dashboard).toContain("<DeviceDetailCarousel");
    expect(dashboard).toMatch(/<View style=\{styles\.headerContent\}>\s*\{devicePanel\}/u);
    expect(dashboard).not.toContain("styles.deviceFooter");
    expect(dashboard).toContain("duration: 180");
    expect(dashboard).toContain("setPreviewHostId(hostId)");
    expect(dashboard).toContain("const homeSwipeActive = quickSwitchActive || deviceDetailsOpen");
    expect(dashboard).toContain("const deviceCardStride = deviceCardWidth * 0.94");
    expect(dashboard).toContain("{ width: viewportWidth, marginLeft: -deviceViewportBleed }");
    expect(dashboard).toContain("deviceCardSideInset - clampedPosition * deviceCardStride");
    expect(dashboard).toContain("onSwipePosition={handleDetailSwipePosition}");
    expect(dashboard).toContain("outputRange: [1, 0.9]");
    expect(dashboard).toContain("homeSwipeProgress.interpolate");
    expect(dashboard).toContain("deviceDetailsOpen && detailHostId");
    expect(dashboard).toContain("setDetailHostId(hostId)");
    expect(dashboard).toContain("hosts.map(renderHomeDeviceCard)");
    expect(quickSwitcher).toContain("hosts.length <= 1");
    expect(quickSwitcher).toContain("activateAfterLongPress(DEVICE_QUICK_SWITCH_LONG_PRESS_MS)");
    expect(quickSwitcher).toContain("Gesture.Exclusive(panGesture, tapGesture)");
    expect(quickSwitcher).toContain("quickSwitchShouldCancel(event.translationY");
    expect(quickSwitcher).toMatch(
      /deviceIndexForTranslation\(\s*session\.startIndex\(\),\s*event\.translationX/u,
    );
    expect(quickSwitcher).toContain("Haptics.selectionAsync()");
    expect(quickSwitcher).toContain("if (!enabled) return");
    expect(quickSwitcher).toContain("toValue: quickSwitchActive ? 1.2 : 1");
    expect(quickSwitcher).toContain("onOpenDeviceDetails()");
    expect(dashboard).toContain("hapticsEnabled={effectiveHomeSettings.deviceSwitcherHapticsEnabled}");
    expect(detailCarousel).toContain('testID="device-detail-carousel"');
    expect(detailCarousel).toContain('testID="device-detail-backdrop"');
    expect(detailCarousel).toContain("snapToInterval={cardStride}");
    expect(detailCarousel).toContain('testID="device-os-rail"');
    expect(detailCarousel).toContain("deviceIndexForRailPosition(");
    expect(detailCarousel).toContain("onTouchMove={handleTouchMove}");
    expect(detailCarousel).toContain("卡片内容可上下滚动");
    expect(detailCarousel).toContain("nestedScrollEnabled");
    expect(detailCarousel).toContain("工作目录");
    expect(detailCarousel).toContain('label="设备详情"');
    expect(detailCarousel).toContain('label="新建会话"');
    expect(detailCarousel).toContain('label="刷新"');
    expect(detailCarousel).toContain("const RAIL_ITEM_WIDTH = 38");
    expect(detailCarousel).toContain("const RAIL_HEIGHT = 42");
    expect(detailCarousel).toContain("size={16}");
    expect(detailCarousel).toContain("pendingScrollIndexRef.current = animated ? index : null");
    expect(detailCarousel).toContain("visibleIndexRef.current = index");
    expect(detailCarousel).toContain("onScroll={handleCarouselScroll}");
    expect(detailCarousel).toContain("scrollEventThrottle={16}");
    expect(detailCarousel).toContain("if (!visible) return");
    expect(detailCarousel).not.toContain("cardAdjacent: { borderColor: palette.border, opacity:");
    expect(quickSwitcher).toContain('flexDirection: "row"');
    expect(quickSwitcher).toContain('justifyContent: "space-evenly"');
    const railStyle = quickSwitcher.slice(
      quickSwitcher.indexOf("railCapsule: {"),
      quickSwitcher.indexOf("railDots: {"),
    );
    expect(railStyle).not.toContain("borderWidth");
    expect(railStyle).not.toContain("borderColor");
  });

  it("底部弹层由原生可见性负责关闭，不依赖可能中断的动画回调", () => {
    const sheet = readFileSync(
      join(import.meta.dirname, "..", "src", "components", "Sheet.tsx"),
      "utf8",
    );

    expect(sheet).toContain('animationType="fade"');
    expect(sheet).toContain("visible={visible}");
    expect(sheet).toContain("onDismiss={() => { if (!visible) onDismiss?.(); }}");
    expect(sheet).not.toContain("setMounted");
    expect(sheet).not.toContain("finished");
    expect(sheet).not.toContain('animationType="slide"');
  });
});
