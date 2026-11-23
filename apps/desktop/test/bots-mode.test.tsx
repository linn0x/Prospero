import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSnapshot, PublicBot } from "../src/shared/types";
import { botActionRequest, botActionResult, isManagedBotWorkspacePath } from "../src/shared/bots";
import { reduceBotsCatalog } from "../src/renderer/src/bots/use-bots";
import { BotsModePane } from "../src/renderer/src/bots/BotsModePane";
import { BotConversationList } from "../src/renderer/src/bots/BotConversationList";
import { BotInspectorSheet, feishuStateLabel } from "../src/renderer/src/bots/BotInspectorSheet";
import {
  BotQaListView,
  extractBotQaEntries,
  filterBotQaEntries,
  formatBotSpeakerDisplay,
  parseBotQuestionMessage,
} from "../src/renderer/src/bots/BotQaListView";
import { FeishuAccessControlPanel, accessPolicyLabel } from "../src/renderer/src/bots/FeishuAccessControlPanel";
import { stripInjectedMemoryContext } from "../src/renderer/src/ChatPane";

afterEach(() => {
  vi.unstubAllGlobals();
});

vi.mock("../src/renderer/src/locale", () => ({
  useLocale: () => ({
    language: "zh" as const,
    t: (zh: string) => zh,
    status: (s: string) => s,
  }),
}));

const baseSnapshot: DesktopSnapshot = {
  daemon: {
    running: true,
    starting: false,
    managed: true,
    sessions: [],
    capabilities: ["bots.v1", "model.sources.v1"],
  },
  projects: [],
  projectAliases: {},
  pinnedProjectPaths: [],
  pinnedSessionIds: [],
  archivedSessionIds: [],
  unreadSessionIds: [],
  workflowTemplates: [],
  devices: [],
  accounts: [],
  orchestration: { runs: [], tasks: [], dispatches: [], gates: [], messages: [], worktreeAssets: [] },
  logs: "",
  settings: {
    startDaemonOnLaunch: true,
    daemonBackend: "rust",
    fullAccessPermission: false,
    minimizeToTray: true,
    launchAtLogin: false,
    theme: "system",
    workspaceSort: "recent",
    terminalFontFamily: "JetBrains Mono",
    terminalFontSize: 13,
    uiFontFamily: "",
    daemonBind: "127.0.0.1",
  },
};

const sampleSubBot: PublicBot = {
  id: "bot-research",
  kind: "sub",
  name: "飞书研报 Bot",
  avatar: "🔍",
  description: "专注资料检索与飞书消息同步",
  systemPrompt: "给出结构化结论",
  agent: "claude",
  accountId: null,
  model: "claude-sonnet-4-5",
  effort: null,
  sourceBinding: null,
  workspace: "/tmp/bots/bot-research/workspace",
  customWorkspace: null,
  allowCrossWorkspace: false,
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
  createdAt: 1,
  updatedAt: 1,
};

describe("bots IPC and UI state", () => {
  it("validates botActionRequest and botActionResult", () => {
    const req = botActionRequest({ kind: "list" }, "req-1");
    expect(req).toEqual({ type: "bot.action", requestId: "req-1", action: { kind: "list" } });

    expect(() => botActionRequest({ kind: "unknown.kind" }, "req-2")).toThrow();
    expect(() => botActionRequest({ kind: "list" }, "")).toThrow();

    const okResult = botActionResult({ type: "bot.result", requestId: "req-1", ok: true, bots: [sampleSubBot] }, "req-1");
    expect(okResult.bots).toHaveLength(1);

    expect(() => botActionResult({ type: "bot.result", requestId: "other", ok: true }, "req-1")).toThrow();
    expect(() => botActionResult({ type: "bot.result", requestId: "req-1", ok: false })).toThrow();

    expect(botActionRequest({ kind: "memory.list", botId: "bot-1" }, "req-m1").action.kind).toBe("memory.list");
    expect(botActionRequest({ kind: "memory.entry.read", botId: "bot-1", key: "chat:oc_1" }, "req-m2").action.kind).toBe(
      "memory.entry.read",
    );
    expect(
      botActionRequest(
        { kind: "memory.entry.write", botId: "bot-1", key: "member:oc_1:ou_1", content: "hello", label: "群 · 张三" },
        "req-m3",
      ).action.kind,
    ).toBe("memory.entry.write");
    expect(botActionRequest({ kind: "memory.entry.delete", botId: "bot-1", key: "user:ou_1" }, "req-m4").action.kind).toBe(
      "memory.entry.delete",
    );
    expect(
      botActionRequest(
        {
          kind: "feishu.access.update",
          botId: "bot-1",
          accessPolicy: "admins_only",
          adminUsers: [{ openId: "ou_owner", name: "Owner" }],
        },
        "req-acl-1",
      ).action.kind,
    ).toBe("feishu.access.update");
  });

  it("maintains stale-while-revalidate state across background refresh failures", () => {
    let state = reduceBotsCatalog({ phase: "loading_initial", bots: [] }, { type: "resolve", bots: [sampleSubBot] });
    expect(state.phase).toBe("ready");

    state = reduceBotsCatalog(state, { type: "start_request", background: true });
    expect(state.phase).toBe("revalidating");
    expect(state.bots).toEqual([sampleSubBot]);

    state = reduceBotsCatalog(state, { type: "reject", error: "network down" });
    expect(state.phase).toBe("stale_error");
    expect(state.bots).toEqual([sampleSubBot]);
  });

  it("renders BotsModePane empty hero state and hides workspace internals", () => {
    expect(isManagedBotWorkspacePath("/Users/demo/Library/Application Support/Prospero Rust/daemon/bots/master/workspace")).toBe(true);
    expect(isManagedBotWorkspacePath("/Users/demo/.prospero/bots/bot-research/workspace")).toBe(true);
    expect(isManagedBotWorkspacePath("/Users/demo/Projects/Prospero")).toBe(false);

    const html = renderToStaticMarkup(
      <BotsModePane
        bot={sampleSubBot}
        activeThread={undefined}
        snapshot={baseSnapshot}
        onSelectThread={() => {}}
        onArchiveThread={() => {}}
        onEditBot={() => {}}
        onOpenNewBot={() => {}}
        onBotsUpdated={() => {}}
      />,
    );
    expect(html).toContain("飞书研报 Bot");
    expect(html).toContain("配置飞书机器人 IM");
    expect(html).toContain("claude-sonnet-4-5");
    expect(html).not.toContain("工作区");
    expect(html).not.toContain("工作目录");
    expect(html).not.toContain("/tmp/bots/bot-research/workspace");

    vi.stubGlobal("window", {
      prospero: {
        readTimeline: vi.fn(),
        readTimelineChanges: vi.fn(),
        lookupTimeline: vi.fn(),
        cancelSessionPage: vi.fn(),
      },
    });
    const withThreadHtml = renderToStaticMarkup(
      <BotsModePane
        bot={sampleSubBot}
        activeThread={{
          id: "thr-1",
          botId: sampleSubBot.id,
          sessionId: "sess-1",
          title: "测试话题",
          channel: "desktop",
          feishuChatId: null,
          chatName: null,
          lastSenderId: null,
          lastSenderName: null,
          lastMessagePreview: "上次问题预览",
          messageCount: 2,
          createdAt: 1,
          updatedAt: 1,
        }}
        snapshot={baseSnapshot}
        onSelectThread={() => {}}
        onArchiveThread={() => {}}
        onEditBot={() => {}}
        onOpenNewBot={() => {}}
        onBotsUpdated={() => {}}
      />,
    );
    expect(withThreadHtml).toContain("删除话题");
    expect(withThreadHtml).toContain("data-chat-composer");
    expect(withThreadHtml).not.toContain("派发工作区会话");
    expect(withThreadHtml).not.toContain("工作区");

    const feishuGroupThreadHtml = renderToStaticMarkup(
      <BotsModePane
        bot={sampleSubBot}
        activeThread={{
          id: "thr-feishu",
          botId: sampleSubBot.id,
          sessionId: "sess-feishu",
          title: "示例项目群 · 看看群里都有谁",
          channel: "feishu_group",
          feishuChatId: "oc_group_1",
          chatName: "示例项目群",
          lastSenderId: "ou_owner",
          lastSenderName: "示例管理员",
          lastMessagePreview: "看看群里都有谁",
          messageCount: 3,
          createdAt: 1,
          updatedAt: 2,
        }}
        snapshot={baseSnapshot}
        onSelectThread={() => {}}
        onArchiveThread={() => {}}
        onEditBot={() => {}}
        onOpenNewBot={() => {}}
        onBotsUpdated={() => {}}
      />,
    );
    expect(feishuGroupThreadHtml).not.toContain("data-chat-composer");
    expect(feishuGroupThreadHtml).not.toContain("工作区");

    const inspectorHtml = renderToStaticMarkup(
      <BotInspectorSheet
        open={false}
        bot={sampleSubBot}
        onOpenChange={() => {}}
        onEditBot={() => {}}
      />,
    );
    expect(inspectorHtml).not.toContain("工作区");
    expect(inspectorHtml).not.toContain("打开目录");

    const convListHtml = renderToStaticMarkup(
      <BotConversationList
        botId={sampleSubBot.id}
        threads={[
          {
            id: "thr-group",
            botId: sampleSubBot.id,
            sessionId: "sess-group",
            title: "核心群 · PR汇总",
            channel: "feishu_group",
            feishuChatId: "oc_group_1",
            chatName: "核心研发群",
            lastSenderId: "ou_owner",
            lastSenderName: "管理员",
            lastMessagePreview: "帮我检查今天的服务状态",
            messageCount: 5,
            createdAt: 100,
            updatedAt: 200,
          },
          {
            id: "thr-dm",
            botId: sampleSubBot.id,
            sessionId: "sess-dm",
            title: "张三 · 日报",
            channel: "feishu_p2p",
            feishuChatId: "oc_p2p_1",
            chatName: null,
            lastSenderId: "ou_zhang",
            lastSenderName: "张三",
            lastMessagePreview: "整理今日待办",
            messageCount: 1,
            createdAt: 50,
            updatedAt: 100,
          },
        ]}
        sessions={[]}
        adminUsers={[{ openId: "ou_owner", name: "管理员" }]}
        activeThreadId="thr-group"
        creatingThread={false}
        onSelectThread={() => {}}
        onNewThread={() => {}}
        onArchiveThread={() => {}}
      />,
    );
    expect(convListHtml).toContain("会话列表");
    expect(convListHtml).toContain("飞书群");
    expect(convListHtml).toContain("飞书私聊");
    expect(convListHtml).toContain("核心研发群");
    expect(convListHtml).toContain("帮我检查今天的服务状态");
    expect(convListHtml).toContain("5条");
    expect(convListHtml).toContain("张三");
    expect(convListHtml).not.toContain("工作区");

    const editorSource = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/bots/BotEditorDialog.tsx"), "utf8");
    const inspectorSource = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/bots/BotInspectorSheet.tsx"), "utf8");
    const convListSource = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/bots/BotConversationList.tsx"), "utf8");
    const paneSource = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/bots/BotsModePane.tsx"), "utf8");
    const aclSource = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/bots/FeishuAccessControlPanel.tsx"), "utf8");
    const qaListSource = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/bots/BotQaListView.tsx"), "utf8");
    for (const [name, src] of [
      ["BotEditorDialog", editorSource],
      ["BotInspectorSheet", inspectorSource],
      ["BotConversationList", convListSource],
      ["BotsModePane", paneSource],
      ["FeishuAccessControlPanel", aclSource],
      ["BotQaListView", qaListSource],
    ] as const) {
      expect(src, `${name} should not leak 工作区`).not.toContain("工作区");
      expect(src, `${name} should not leak 工作目录`).not.toContain("工作目录");
      expect(src, `${name} should not call revealPath`).not.toContain("revealPath");
      expect(src, `${name} should not render 打开目录`).not.toContain("打开目录");
      expect(src, `${name} should not expose memory.path`).not.toContain("memory.path");
    }
    expect(inspectorSource).toContain("群记忆");
    expect(inspectorSource).toContain("个人记忆");
    expect(inspectorSource).toContain("群+人记忆");

    expect(
      stripInjectedMemoryContext(
        "[飞书群聊: 研发群 | 发言人: Alice]\n请总结今天的发布进展\n\n<prospero_memory_context>\nsecret\n</prospero_memory_context>",
      ),
    ).toBe("[飞书群聊: 研发群 | 发言人: Alice]\n请总结今天的发布进展");
    expect(stripInjectedMemoryContext("帮我看看进度\n<prospero_memory_context>\ntruncated")).toBe("帮我看看进度");

    expect(feishuStateLabel("connected", (zh) => zh)).toBe("飞书已连接");
    expect(feishuStateLabel("disabled", (zh) => zh)).toBe("未接入飞书");
    expect(accessPolicyLabel("admins_only", (zh) => zh)).toBe("仅管理员可用");
    expect(accessPolicyLabel("admins_dm_all_groups", (zh) => zh)).toBe("私聊仅管理员 · 群全员");
    expect(accessPolicyLabel("everyone", (zh) => zh)).toBe("全员可用");
  });

  it("parses Feishu speaker headers, extracts Q&A entries, and renders BotQaListView with collapsed reasoning", () => {
    expect(
      parseBotQuestionMessage(
        "[飞书群聊: 示例项目群 | 发言人: 示例管理员 (管理员)]\n看看群里都有谁\n\n<prospero_memory_context>\nsecret\n</prospero_memory_context>",
      ),
    ).toEqual({
      channel: "feishu_group",
      chatName: "示例项目群",
      speaker: "示例管理员",
      roleLabel: "管理员",
      isAdmin: true,
      body: "看看群里都有谁",
    });

    expect(
      parseBotQuestionMessage("[飞书群聊: 研发群 | 发言人: Alice]\n汇总进展"),
    ).toEqual({
      channel: "feishu_group",
      chatName: "研发群",
      speaker: "Alice",
      roleLabel: undefined,
      isAdmin: false,
      body: "汇总进展",
    });

    expect(
      parseBotQuestionMessage("[飞书私聊 | 发言人: 张三 (普通成员)]\n帮我记一下"),
    ).toEqual({
      channel: "feishu_p2p",
      speaker: "张三",
      roleLabel: "普通成员",
      isAdmin: false,
      body: "帮我记一下",
    });

    expect(parseBotQuestionMessage("帮我整理周报")).toEqual({
      channel: "desktop",
      isAdmin: false,
      body: "帮我整理周报",
    });

    expect(formatBotSpeakerDisplay("ou_0000111122223333444455556666aaaa", true, {
      ou_0000111122223333444455556666aaaa: "示例管理员",
    })).toEqual({
      label: "示例管理员",
      title: "ou_0000111122223333444455556666aaaa",
      showAdminBadge: true,
    });
    expect(formatBotSpeakerDisplay("ou_0000111122223333444455556666aaaa", true)).toEqual({
      label: "管理员",
      title: "ou_0000…aaaa (ou_0000111122223333444455556666aaaa)",
      showAdminBadge: false,
    });
    expect(formatBotSpeakerDisplay("ou_1111222233334444555566667777bbbb", false)).toEqual({
      label: "ou_1111…bbbb",
      title: "ou_1111222233334444555566667777bbbb",
      showAdminBadge: false,
    });

    const displayItems = [
      {
        key: "turn:1",
        ordinal: 1,
        event: {
          kind: "conversation.turn",
          completed: true,
          finish: "completed",
          outputTokens: 320,
          users: [
            {
              displayKey: "u-1",
              kind: "user.message",
              hasMore: true,
              bodyRecordId: "rec-u1",
              text: "[飞书群聊: 示例项目群 | 发言人: 示例管理员 (管理员)]\n看看群里都有谁\n\n<prospero_memory_context>\ninternal\n</prospero_memory_context>",
            },
          ],
          activity: [
            { displayKey: "r-1", kind: "reasoning", text: "INTERNAL_REASONING_SHOULD_STAY_COLLAPSED" },
            { displayKey: "t-1", kind: "tool.end", tool: "feishu_chat_members", state: "success", summary: "12 members" },
          ],
          outcomes: [
            { displayKey: "a-1", kind: "assistant.text", phase: "final_answer", text: "群里共有 12 位成员。" },
          ],
        },
      },
      {
        key: "turn:2",
        ordinal: 2,
        event: {
          kind: "conversation.turn",
          completed: false,
          users: [
            { displayKey: "u-2", kind: "user.message", text: "继续分析发言节奏" },
          ],
          activity: [
            { displayKey: "r-2", kind: "reasoning", text: "MORE_INTERNAL_THINKING" },
            { displayKey: "c-2", kind: "assistant.text", phase: "commentary", text: "先拉取最近聊天记录…" },
          ],
          outcomes: [],
        },
      },
    ];

    const entries = extractBotQaEntries(displayItems);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.question.speaker).toBe("示例管理员");
    expect(entries[0]?.questionHasMore).toBe(false);
    expect(entries[0]?.reasoningCount).toBe(1);
    expect(entries[0]?.toolCount).toBe(1);
    expect(entries[0]?.answers[0]?.text).toBe("群里共有 12 位成员。");

    expect(entries[1]?.completed).toBe(false);
    expect(entries[1]?.answerIsFallback).toBe(true);
    expect(entries[1]?.answers[0]?.text).toBe("先拉取最近聊天记录…");

    expect(filterBotQaEntries(entries, "示例管理员")).toHaveLength(1);
    expect(filterBotQaEntries(entries, "节奏")).toHaveLength(1);
    expect(filterBotQaEntries(entries, "不存在的词")).toHaveLength(0);

    const qaHtml = renderToStaticMarkup(
      <BotQaListView
        botName="示例助手"
        botAvatar="🤖"
        botDescription="飞书协同助手"
        displayItems={displayItems}
        resolutions={new Set()}
        nextOrdinal={3}
        pagedEnabled={false}
        pagedLive
        historyCursor={null}
        selectHistoryCursor={() => {}}
        jumpToLatest={() => {}}
        handleTimelineScroll={() => {}}
        timelineViewport={{ current: null }}
        searchQuery=""
        onClearSearch={() => {}}
        onError={() => {}}
        openOutput={() => {}}
        renderActivityEvent={() => null}
        renderOutcomeEvent={() => null}
      />,
    );
    expect(qaHtml).toContain('role="table"');
    expect(qaHtml).toContain('role="columnheader"');
    expect(qaHtml).toContain("提问");
    expect(qaHtml).toContain("示例助手");
    expect(qaHtml).toContain("补充信息");
    expect(qaHtml).toContain('data-col="question"');
    expect(qaHtml).toContain('data-col="answer"');
    expect(qaHtml).toContain('data-col="meta"');
    expect(qaHtml).toContain("问");
    expect(qaHtml).toContain("答");
    expect(qaHtml).toContain("示例管理员");
    expect(qaHtml).toContain("管理员");
    expect(qaHtml).toContain("飞书群 · 示例项目群");
    expect(qaHtml).toContain("看看群里都有谁");
    expect(qaHtml).toContain("群里共有 12 位成员");
    expect(qaHtml).toContain("思考 1");
    expect(qaHtml).toContain("工具 1");
    expect(qaHtml).not.toContain("查看完整提问");
    expect(qaHtml).not.toContain("INTERNAL_REASONING_SHOULD_STAY_COLLAPSED");
    expect(qaHtml).not.toContain("MORE_INTERNAL_THINKING");
  });

  it("renders FeishuAccessControlPanel policy cards, admins, and recent visitors cleanly", () => {
    const html = renderToStaticMarkup(
      <FeishuAccessControlPanel
        accessPolicy="admins_dm_all_groups"
        adminUsers={[{ openId: "ou_admin_1", name: "示例管理员" }]}
        recentSenders={[
          {
            openId: "ou_admin_1",
            name: "示例管理员",
            lastChatId: "oc_group_1",
            lastChatName: "示例项目群",
            lastSeenAt: Date.now() - 10_000,
            denied: false,
          },
          {
            openId: "ou_guest_2",
            name: "访客同学",
            lastChatId: "oc_p2p_2",
            lastChatName: null,
            lastSeenAt: Date.now() - 5_000,
            denied: true,
          },
        ]}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("全员可用");
    expect(html).toContain("私聊仅管理员 · 群全员");
    expect(html).toContain("仅管理员可用");
    expect(html).toContain("非管理员防篡改保护");
    expect(html).toContain("立群规");
    expect(html).toContain("示例管理员");
    expect(html).toContain("ou_admin_1");
    expect(html).toContain("访客同学");
    expect(html).toContain("已拦截");
  });
});
