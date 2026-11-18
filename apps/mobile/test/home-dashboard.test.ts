import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@prospero/protocol";

import {
  homeApprovalSessions,
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

  it("待授权入口只显示真正需要操作授权的对话并优先展示请求数更多的项", () => {
    const waiting = session("waiting", "/work", "waiting_approval", 2);
    const explicit = session("explicit", "/work", "idle", 3);
    explicit.pendingPermissions = 2;
    const question = session("question", "/work", "waiting_input", 4);
    question.pendingQuestions = 1;

    expect(homeApprovalSessions({ waiting, explicit, question }).map((item) => item.id))
      .toEqual(["explicit", "waiting"]);
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

  it("采用桌面端 IDE 工作台布局：紧凑工作区树、顶栏设备切换与多会话信息区分", () => {
    const dashboard = readFileSync(
      join(import.meta.dirname, "..", "src", "components", "HomeDashboard.tsx"),
      "utf8",
    );
    const home = readFileSync(
      join(import.meta.dirname, "..", "src", "app", "index.tsx"),
      "utf8",
    );

    expect(dashboard).toContain("removeClippedSubviews={false}");
    expect(dashboard).toContain("collapsable={false}");
    expect(dashboard).toContain("<Sheet");
    expect(dashboard).toContain("visible={devicePickerOpen}");
    expect(dashboard).toContain("onOpenSession(selectedHost.id, session.id)");
    expect(dashboard).toContain('label="添加设备"');
    expect(dashboard).toContain('label="添加工作区"');
    expect(dashboard).not.toContain("onOpenSettings");
    expect(dashboard).not.toContain("DeviceDetailCarousel");
    expect(dashboard).not.toContain("DeviceQuickSwitcher");
    expect(dashboard).not.toContain("styles.deviceCapsule");
    expect(dashboard).toContain("normalizeHomeSettings(homeSettings ?? DEFAULT_HOME_SETTINGS)");
    expect(dashboard).toContain('name="pencil"');
    expect(dashboard).toContain("<SwipeRow");
    expect(dashboard).toContain('id: "create-session"');
    expect(dashboard).toContain('id: "edit-workspace"');
    expect(dashboard).toContain("workspaceAliasKey(selectedHost.id, editingProject.path)");
    expect(dashboard).toContain("hostConnectionTone(selectedRuntime, palette)");
    expect(dashboard).toContain("adaptiveLayout.splitPanes");
    expect(dashboard).toContain("SplitPaneDivider");
    expect(dashboard).toContain("styles.treeChildrenGuide");
    expect(dashboard).toContain("sessionWorkbenchSubtitle(");
    expect(dashboard).toContain('testID="home-approval-sessions"');
    expect(dashboard).toContain("homeInboxSessions(selectedRuntime?.sessions)");
    expect(dashboard).not.toContain("useHomeLocatorMotion");
    expect(dashboard).not.toContain("sessionNeedsLocatorMotion");
    expect(dashboard).toContain('label="账号与模型源"');
    expect(dashboard).toContain('accessibilityLabel="在当前工作区打开终端"');
    expect(home).toContain("styles.hostPill");
    expect(home).toContain('accessibilityLabel="新建会话"');
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
