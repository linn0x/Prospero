import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSnapshot, PublicBot } from "../src/shared/types";
import { botActionRequest, botActionResult, isManagedBotWorkspacePath } from "../src/shared/bots";
import { reduceBotsCatalog } from "../src/renderer/src/bots/use-bots";
import { BotsModePane } from "../src/renderer/src/bots/BotsModePane";
import { BotInspectorSheet, feishuStateLabel } from "../src/renderer/src/bots/BotInspectorSheet";
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
  },
  feishuStatus: {
    state: "disabled",
    botName: null,
    botOpenId: null,
    lastConnectedAt: null,
    lastEventAt: null,
    lastError: null,
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
    expect(withThreadHtml).not.toContain("派发工作区会话");
    expect(withThreadHtml).not.toContain("工作区");

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

    const editorSource = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/bots/BotEditorDialog.tsx"), "utf8");
    const inspectorSource = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/bots/BotInspectorSheet.tsx"), "utf8");
    expect(editorSource).not.toContain("工作区");
    expect(editorSource).not.toContain("工作目录");
    expect(editorSource).not.toContain("bot-workspace-input");
    expect(inspectorSource).toContain("群记忆");
    expect(inspectorSource).toContain("个人记忆");
    expect(inspectorSource).toContain("群+人记忆");
    expect(inspectorSource).not.toContain("工作区");
    expect(inspectorSource).not.toContain("工作目录");
    expect(inspectorSource).not.toContain("revealPath");
    expect(inspectorSource).not.toContain("打开目录");
    expect(inspectorSource).not.toContain("memory.path");

    expect(
      stripInjectedMemoryContext(
        "[飞书群聊: 研发群 | 发言人: Alice]\n请总结今天的发布进展\n\n<prospero_memory_context>\nsecret\n</prospero_memory_context>",
      ),
    ).toBe("[飞书群聊: 研发群 | 发言人: Alice]\n请总结今天的发布进展");
    expect(stripInjectedMemoryContext("帮我看看进度\n<prospero_memory_context>\ntruncated")).toBe("帮我看看进度");

    expect(feishuStateLabel("connected", (zh) => zh)).toBe("飞书已连接");
    expect(feishuStateLabel("disabled", (zh) => zh)).toBe("未接入飞书");
  });
});
