import { describe, expect, it } from "vitest";
import type { PublicBot } from "@prospero/protocol";
import {
  buildMobileBotCreateInput,
  buildMobileBotUpdateInput,
  computeOneShotTimestamp,
  filterMobileMemoryItems,
  formatMobileBotSchedule,
  mobileBotWorkingStatus,
  mobileMemoryCategoryLabel,
  splitMobileMemoryItems,
} from "../src/lib/bot-helpers";

describe("mobile bot helpers", () => {
  it("formats recurring and one-shot schedules into readable Chinese labels", () => {
    expect(
      formatMobileBotSchedule({
        kind: "cron",
        rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0",
        runAt: null,
      }),
    ).toBe("每天 08:00");

    expect(
      formatMobileBotSchedule({
        kind: "heartbeat",
        rrule: "FREQ=HOURLY;INTERVAL=2",
        runAt: null,
      }),
    ).toBe("每 2 小时");

    expect(
      formatMobileBotSchedule({
        kind: "one_shot",
        rrule: null,
        runAt: new Date(2026, 10, 25, 9, 30).getTime(),
      }),
    ).toBe("一次性 · 11/25 09:30");
  });

  it("maps memory categories and splits active vs archived items", () => {
    expect(mobileMemoryCategoryLabel("preference")).toBe("偏好设置");
    expect(mobileMemoryCategoryLabel("profile")).toBe("个人画像");

    const { active, archived } = splitMobileMemoryItems([
      {
        id: "m1",
        category: "preference",
        content: "先给结论",
        scope: "global",
        pinned: true,
        source: "auto",
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "m2",
        category: "fact",
        content: "旧记忆",
        scope: "global",
        pinned: false,
        source: "manual",
        archived: true,
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    expect(active).toHaveLength(1);
    expect(archived).toHaveLength(1);
  });

  it("builds partial capability toggle payloads without losing Feishu config", () => {
    const bot: PublicBot = {
      id: "master",
      kind: "master",
      name: "Prospero Bot",
      avatar: "⚡",
      description: "个人助理",
      systemPrompt: "Prompt",
      agent: "codex",
      accountId: null,
      model: "gpt-6-astra",
      effort: null,
      sourceBinding: null,
      workspace: "/tmp/ws",
      customWorkspace: null,
      allowCrossWorkspace: true,
      autoMemory: true,
      proactiveNotifications: true,
      feishu: {
        enabled: false,
        domain: "feishu",
        appId: "",
        hasAppSecret: false,
        groupTrigger: "mention",
        streamingCard: true,
        accessPolicy: "everyone",
        adminUsers: [],
      },
      feishuStatus: {
        state: "disabled",
        botName: null,
        botOpenId: null,
        lastConnectedAt: null,
        lastEventAt: null,
        lastError: null,
        recentSenders: [],
      },
      threads: [],
      tasks: [],
      memoryItems: [],
      recentMemoryEvents: [],
      unreadProactiveCount: 0,
      latestProactiveNotice: null,
      notices: [],
      createdAt: 1,
      updatedAt: 1,
    };

    const next = buildMobileBotUpdateInput(bot, {
      autoMemory: false,
      name: "My Assistant",
      avatar: "🧠",
    });
    expect(next.autoMemory).toBe(false);
    expect(next.name).toBe("My Assistant");
    expect(next.avatar).toBe("🧠");
    expect(next.proactiveNotifications).toBe(true);
    expect(next.feishu?.enabled).toBe(false);
  });

  it("builds valid Bot creation payloads, filters memories, and computes one-shot delays", () => {
    const created = buildMobileBotCreateInput({
      name: "调研专家",
      avatar: "🔍",
      description: "深度检索与对比",
      systemPrompt: "先给结论",
      agent: "claude",
      model: "claude-opus",
      allowCrossWorkspace: true,
    });
    expect(created.name).toBe("调研专家");
    expect(created.agent).toBe("claude");
    expect(created.model).toBe("claude-opus");
    expect(created.allowCrossWorkspace).toBe(true);
    expect(created.autoMemory).toBe(true);
    expect(created.feishu?.enabled).toBe(false);

    const items = [
      {
        id: "m1",
        category: "preference" as const,
        content: "用中文先给结论",
        scope: "global" as const,
        pinned: true,
        source: "manual" as const,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "m2",
        category: "project" as const,
        content: "Prospero Mobile App",
        scope: "global" as const,
        pinned: false,
        source: "auto" as const,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    expect(filterMobileMemoryItems(items, "all", "结论")).toHaveLength(1);
    expect(filterMobileMemoryItems(items, "project", "")).toHaveLength(1);
    expect(filterMobileMemoryItems(items, "preference", "项目")).toHaveLength(0);

    const base = new Date(2026, 10, 25, 14, 0, 0).getTime();
    expect(computeOneShotTimestamp("15m", base)).toBe(base + 15 * 60_000);
    expect(computeOneShotTimestamp("1h", base)).toBe(base + 60 * 60_000);
    const tomorrow9 = new Date(computeOneShotTimestamp("tomorrow_9am", base));
    expect(tomorrow9.getDate()).toBe(26);
    expect(tomorrow9.getHours()).toBe(9);
  });

  it("only treats active or waiting statuses as workingStatus", () => {
    expect(mobileBotWorkingStatus("running")).toBe("running");
    expect(mobileBotWorkingStatus("starting")).toBe("starting");
    expect(mobileBotWorkingStatus("waiting_approval")).toBe("waiting_approval");
    expect(mobileBotWorkingStatus("waiting_input")).toBe("waiting_input");
    expect(mobileBotWorkingStatus("idle")).toBeUndefined();
    expect(mobileBotWorkingStatus("completed")).toBeUndefined();
    expect(mobileBotWorkingStatus("done")).toBeUndefined();
    expect(mobileBotWorkingStatus("died")).toBeUndefined();
    expect(mobileBotWorkingStatus(undefined)).toBeUndefined();
  });
});
