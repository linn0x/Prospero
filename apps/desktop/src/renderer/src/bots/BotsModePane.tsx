import { useEffect, useMemo, useRef, useState } from "react";
import {
  BellRing,
  Bot,
  Brain,
  Clock,
  MessageSquare,
  MessageSquarePlus,
  PanelLeft,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  BotThread,
  DesktopSnapshot,
  PublicBot,
  SessionInfo,
} from "../../../shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupTextarea } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { AgentLogo } from "../AgentLogo";
import { ChatPane } from "../ChatPane";
import { useLocale } from "../locale";
import { displayError } from "../state";
import { BotCapabilitiesPanel } from "./BotCapabilitiesPanel";
import { BotConversationList } from "./BotConversationList";
import { BotInspectorSheet, type BotStudioTab } from "./BotInspectorSheet";
import { BotMemoryPanel } from "./BotMemoryPanel";
import { BotTasksPanel } from "./BotTasksPanel";
import { runBotAction } from "./use-bots";

export type BotWorkbenchTab = "chat" | "tasks" | "memory" | "capabilities";

const MASTER_STARTERS_ZH = [
  "帮我梳理今天的核心事项与优先级",
  "结合我的长期记忆，整理一份近期重点简报",
  "帮我设置一个每天早上 8 点的工作日报任务",
];

const MASTER_STARTERS_EN = [
  "Help me plan today's priorities",
  "Summarize key context from my long-term memory",
  "Set up a daily 8:00 AM briefing task",
];

const SUB_STARTERS_ZH = [
  "介绍一下你的职责与可用能力",
  "读取并整理你当前的长期记忆",
  "帮我制定今天的工作计划",
];

const SUB_STARTERS_EN = [
  "Introduce your role and capabilities",
  "Review your long-term memory notes",
  "Draft an action plan for today",
];

export function BotsModePane({
  bot,
  activeThread,
  snapshot,
  onSelectThread,
  onArchiveThread,
  onEditBot,
  onOpenNewBot,
  onBotsUpdated,
}: {
  bot: PublicBot | undefined;
  activeThread: BotThread | undefined;
  snapshot: DesktopSnapshot;
  onSelectThread: (botId: string, threadId: string) => void;
  onArchiveThread: (botId: string, threadId: string) => void;
  onEditBot: (bot: PublicBot) => void;
  onOpenNewBot: () => void;
  onBotsUpdated: (bots: PublicBot[]) => void;
}) {
  const { language, t } = useLocale();
  const [workbenchTab, setWorkbenchTab] = useState<BotWorkbenchTab>("chat");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<BotStudioTab>("memory");
  const [listOpen, setListOpen] = useState(true);
  const [creatingThread, setCreatingThread] = useState(false);
  const [heroPrompt, setHeroPrompt] = useState("");
  const [heroError, setHeroError] = useState<string | undefined>(undefined);
  const [hydratedSession, setHydratedSession] = useState<SessionInfo | undefined>(undefined);
  const [memoryBannerBusy, setMemoryBannerBusy] = useState(false);
  const [noticeBusy, setNoticeBusy] = useState(false);
  const ensuredPrimaryForRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setWorkbenchTab("chat");
  }, [bot?.id]);

  // Auto-enter persistent Primary Thread when opening a Bot with no active thread
  useEffect(() => {
    if (!bot || activeThread) return;
    if (ensuredPrimaryForRef.current.has(bot.id)) return;
    ensuredPrimaryForRef.current.add(bot.id);
    let cancelled = false;
    void runBotAction({ kind: "thread.ensure_primary", botId: bot.id })
      .then((res) => {
        if (cancelled) return;
        if (res.bots) onBotsUpdated(res.bots);
        if (res.thread) onSelectThread(bot.id, res.thread.id);
      })
      .catch(() => {
        ensuredPrimaryForRef.current.delete(bot.id);
      });
    return () => {
      cancelled = true;
    };
  }, [activeThread, bot, onBotsUpdated, onSelectThread]);

  // Clear unread proactive badge when opening an unread thread
  useEffect(() => {
    if (!bot || !activeThread || activeThread.unreadCount <= 0) return;
    void runBotAction({
      kind: "thread.mark_read",
      botId: bot.id,
      threadId: activeThread.id,
    })
      .then((res) => {
        if (res.bots) onBotsUpdated(res.bots);
      })
      .catch(() => undefined);
  }, [activeThread?.id, activeThread?.unreadCount, bot?.id, onBotsUpdated]);

  const liveSession = useMemo(() => {
    if (!activeThread) return undefined;
    return snapshot.daemon.sessions.find((item) => item.id === activeThread.sessionId);
  }, [activeThread, snapshot.daemon.sessions]);

  useEffect(() => {
    if (!activeThread || liveSession) {
      setHydratedSession(undefined);
      return;
    }
    if (typeof window.prospero?.listSessions !== "function") return;
    let cancelled = false;
    void window.prospero
      .listSessions({ ids: [activeThread.sessionId], limit: 1 })
      .then((page) => {
        if (cancelled) return;
        const found = page.items.find((item) => item.id === activeThread.sessionId);
        if (found) setHydratedSession(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeThread, liveSession]);

  const resolvedSession = useMemo<SessionInfo | undefined>(() => {
    if (!activeThread) return undefined;
    if (liveSession) return liveSession;
    if (hydratedSession) return hydratedSession;
    if (!bot) return undefined;
    return {
      id: activeThread.sessionId,
      agent: bot.agent,
      kind: "structured",
      historyMode: "paged" as const,
      title: activeThread.title,
      cwd: bot.workspace,
      status: "idle",
      ...(bot.accountId ? { accountId: bot.accountId } : {}),
      ...(bot.model ? { model: bot.model } : {}),
      ...(bot.effort ? { effort: bot.effort } : {}),
    };
  }, [activeThread, bot, hydratedSession, liveSession]);

  const resolvedAccount = useMemo(() => {
    const id = resolvedSession?.accountId ?? bot?.accountId;
    if (!id) return undefined;
    return snapshot.accounts.find((item) => item["id"] === id);
  }, [bot?.accountId, resolvedSession?.accountId, snapshot.accounts]);

  const speakerNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const sender of bot?.feishuStatus.recentSenders ?? []) {
      const name = sender.name?.trim();
      if (sender.openId && name) map[sender.openId] = name;
    }
    for (const admin of bot?.feishu.adminUsers ?? []) {
      const name = admin.name?.trim();
      if (admin.openId && name) map[admin.openId] = name;
    }
    return map;
  }, [bot?.feishu.adminUsers, bot?.feishuStatus.recentSenders]);

  const recentAddedMemory = useMemo(() => {
    const ev = bot?.recentMemoryEvents?.[0];
    if (!ev || ev.reverted || ev.action !== "added") return undefined;
    if (Date.now() - ev.createdAt > 10 * 60_000) return undefined;
    return ev;
  }, [bot?.recentMemoryEvents]);

  if (!bot) {
    return (
      <div className="bots-pane">
        <div className="bots-hero">
          <div className="bots-hero-avatar">
            <Bot className="size-8 text-primary" />
          </div>
          <h2 className="text-lg font-semibold">
            {t("欢迎来到 Prospero Bot 模式", "Welcome to Prospero Bot Mode")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t(
              "正在连接本地 Daemon 加载你的个人智能体与子 Bot 团队…",
              "Connecting to local daemon to load your Personal Agent and Sub-Bots…",
            )}
          </p>
          <Button onClick={onOpenNewBot}>
            <Sparkles data-icon="inline-start" />
            {t("新建子 Bot", "Create Sub-Bot")}
          </Button>
        </div>
      </div>
    );
  }

  const startNewThread = async (initialPrompt?: string): Promise<void> => {
    if (creatingThread) return;
    setCreatingThread(true);
    setHeroError(undefined);
    try {
      const prompt = initialPrompt?.trim();
      const result = prompt
        ? await runBotAction({
            kind: "thread.dispatch",
            botId: bot.id,
            task: prompt,
            threadId: null,
            title: null,
          })
        : await runBotAction({
            kind: "thread.create",
            botId: bot.id,
            title: null,
          });
      if (result.bots) onBotsUpdated(result.bots);
      if (result.thread) onSelectThread(bot.id, result.thread.id);
      setHeroPrompt("");
    } catch (reason) {
      setHeroError(displayError(reason));
    } finally {
      setCreatingThread(false);
    }
  };

  const ackLatestNotice = async (): Promise<void> => {
    if (noticeBusy) return;
    setNoticeBusy(true);
    try {
      const res = await runBotAction({
        kind: "notices.ack",
        botId: bot.id,
        noticeId: bot.latestProactiveNotice?.id ?? null,
      });
      if (res.bots) onBotsUpdated(res.bots);
    } finally {
      setNoticeBusy(false);
    }
  };

  const undoRecentMemory = async (): Promise<void> => {
    if (!recentAddedMemory || memoryBannerBusy) return;
    setMemoryBannerBusy(true);
    try {
      const res = await runBotAction({
        kind: "memory.item.restore",
        botId: bot.id,
        itemId: recentAddedMemory.itemId,
      });
      if (res.bots) onBotsUpdated(res.bots);
    } finally {
      setMemoryBannerBusy(false);
    }
  };

  const activeTaskCount = bot.tasks.filter((item) => item.status === "enabled").length;
  const activeMemoryCount = bot.memoryItems.filter((item) => !item.archived).length;
  const starters =
    bot.kind === "master"
      ? language === "zh"
        ? MASTER_STARTERS_ZH
        : MASTER_STARTERS_EN
      : language === "zh"
        ? SUB_STARTERS_ZH
        : SUB_STARTERS_EN;

  return (
    <div className="bots-pane" data-testid="bots-mode-pane">
      <header className="bots-pane-header">
        <div className="bots-pane-identity">
          {workbenchTab === "chat" && (
            <Button
              variant={listOpen ? "secondary" : "ghost"}
              size="icon-sm"
              aria-pressed={listOpen}
              aria-label={t("会话列表", "Chats")}
              title={t("收起/展开分支话题", "Toggle Side Chats")}
              onClick={() => setListOpen((prev) => !prev)}
            >
              <PanelLeft />
            </Button>
          )}
          <span className="bots-pane-avatar" aria-hidden="true">
            {bot.avatar}
          </span>
          <div className="bots-pane-titles">
            <div className="bots-pane-title-row">
              <h2>{bot.name}</h2>
              <Badge variant={bot.kind === "master" ? "default" : "secondary"} className="h-4.5 px-1.5 text-[10px]">
                {bot.kind === "master" ? t("个人助理", "Personal") : t("专职子 Bot", "Sub-Bot")}
              </Badge>
              <span className="bots-meta-chip">
                <AgentLogo agent={bot.agent} size={12} decorative />
                <span>{bot.agent}</span>
                {bot.model && (
                  <>
                    <span className="opacity-45">·</span>
                    <code>{bot.model}</code>
                  </>
                )}
              </span>
            </div>
          </div>
        </div>

        {/* 4-Tab Personal Agent Switcher */}
        <div className="bot-workbench-tabs" role="tablist" aria-label={t("智能体工作台板块", "Personal Agent sections")}>
          <button
            type="button"
            role="tab"
            data-slot="bot-control"
            aria-selected={workbenchTab === "chat"}
            className="bot-workbench-tab"
            data-active={workbenchTab === "chat"}
            onClick={() => setWorkbenchTab("chat")}
          >
            <MessageSquare className="size-3.5" />
            <span>{t("对话", "Chat")}</span>
          </button>
          <button
            type="button"
            role="tab"
            data-slot="bot-control"
            aria-selected={workbenchTab === "tasks"}
            className="bot-workbench-tab"
            data-active={workbenchTab === "tasks"}
            onClick={() => setWorkbenchTab("tasks")}
          >
            <Clock className="size-3.5" />
            <span>{t("任务", "Tasks")}</span>
            {activeTaskCount > 0 && <span className="bot-tab-count">{activeTaskCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            data-slot="bot-control"
            aria-selected={workbenchTab === "memory"}
            className="bot-workbench-tab"
            data-active={workbenchTab === "memory"}
            onClick={() => setWorkbenchTab("memory")}
          >
            <Brain className="size-3.5" />
            <span>{t("记忆", "Memory")}</span>
            {activeMemoryCount > 0 && <span className="bot-tab-count">{activeMemoryCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            data-slot="bot-control"
            aria-selected={workbenchTab === "capabilities"}
            className="bot-workbench-tab"
            data-active={workbenchTab === "capabilities"}
            onClick={() => setWorkbenchTab("capabilities")}
          >
            <Sparkles className="size-3.5" />
            <span>{t("能力", "Skills")}</span>
          </button>
        </div>

        <div className="bots-pane-actions">
          {workbenchTab === "chat" && (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={creatingThread}
                onClick={() => void startNewThread()}
              >
                {creatingThread ? <Spinner data-icon="inline-start" /> : <MessageSquarePlus data-icon="inline-start" />}
                {t("新分支", "Side Chat")}
              </Button>
              {activeThread && !activeThread.isPrimary && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="bots-header-delete-btn"
                  title={t("删除当前分支话题", "Delete current side chat")}
                  onClick={() => onArchiveThread(bot.id, activeThread.id)}
                >
                  <Trash2 data-icon="inline-start" />
                  {t("删除", "Delete")}
                </Button>
              )}
            </>
          )}
          <Button variant="ghost" size="sm" onClick={() => onEditBot(bot)}>
            <Settings data-icon="inline-start" />
            {t("配置", "Settings")}
          </Button>
        </div>
      </header>

      {workbenchTab === "tasks" ? (
        <BotTasksPanel bot={bot} onBotsUpdated={onBotsUpdated} />
      ) : workbenchTab === "memory" ? (
        <BotMemoryPanel
          bot={bot}
          activeThread={activeThread}
          onBotsUpdated={onBotsUpdated}
          onOpenMarkdownInspector={() => {
            setInspectorTab("memory");
            setInspectorOpen(true);
          }}
        />
      ) : workbenchTab === "capabilities" ? (
        <BotCapabilitiesPanel
          bot={bot}
          onBotsUpdated={onBotsUpdated}
          onEditPersona={() => onEditBot(bot)}
          onEditFeishu={() => onEditBot(bot)}
          onOpenFeishuAccess={() => {
            setInspectorTab("access");
            setInspectorOpen(true);
          }}
        />
      ) : (
        <div className="bots-pane-split">
          {listOpen && (
            <BotConversationList
              botId={bot.id}
              threads={bot.threads}
              sessions={snapshot.daemon.sessions}
              adminUsers={bot.feishu.adminUsers}
              feishuEnabled={bot.feishu.enabled}
              activeThreadId={activeThread?.id}
              creatingThread={creatingThread}
              onSelectThread={onSelectThread}
              onNewThread={() => void startNewThread()}
              onArchiveThread={onArchiveThread}
            />
          )}

          <div className="bots-pane-body">
            {/* Proactive Reminder & Active Memory Banners */}
            {(bot.unreadProactiveCount > 0 && bot.latestProactiveNotice) && (
              <div className="bot-proactive-banner" role="status">
                <div className="flex items-center gap-2 min-w-0">
                  <BellRing className="size-4 text-primary shrink-0" />
                  <div className="min-w-0 truncate text-xs">
                    <strong>{bot.latestProactiveNotice.title}</strong>
                    <span className="text-muted-foreground"> — {bot.latestProactiveNotice.summary}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button variant="outline" size="xs" onClick={() => setWorkbenchTab("tasks")}>
                    {t("查看任务", "View Tasks")}
                  </Button>
                  <Button size="xs" disabled={noticeBusy} onClick={() => void ackLatestNotice()}>
                    {t("知道了", "Got it")}
                  </Button>
                </div>
              </div>
            )}

            {recentAddedMemory && (
              <div className="bot-memory-toast-pill" role="status">
                <div className="flex items-center gap-1.5 min-w-0 text-xs">
                  <Brain className="size-3.5 text-primary shrink-0" />
                  <span className="font-medium shrink-0">{t("已记住：", "Remembered:")}</span>
                  <span className="truncate text-muted-foreground">{recentAddedMemory.summary}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="xs" onClick={() => setWorkbenchTab("memory")}>
                    {t("查看", "View")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={memoryBannerBusy}
                    onClick={() => void undoRecentMemory()}
                  >
                    <RotateCcw className="size-3" />
                    {t("撤销", "Undo")}
                  </Button>
                </div>
              </div>
            )}

            {resolvedSession ? (
              <ChatPane
                key={resolvedSession.id}
                session={resolvedSession}
                account={resolvedAccount}
                snapshot={snapshot}
                botContext={{
                  name: bot.name,
                  avatar: bot.avatar,
                  description: bot.description,
                  channel: activeThread?.channel,
                  speakerNames,
                }}
                onMissingSession={() => {
                  if (activeThread) onArchiveThread(bot.id, activeThread.id);
                }}
              />
            ) : (
              <div className="bots-hero">
                <div className="bots-hero-avatar-wrap">
                  <div className="bots-hero-avatar">{bot.avatar}</div>
                </div>
                <div className="grid gap-1.5">
                  <h3 className="text-lg font-semibold tracking-tight">{bot.name}</h3>
                  <p className="text-sm text-muted-foreground max-w-md mx-auto">
                    {bot.description ||
                      t(
                        "永续个人智能体：默认开启主对话流，记住你的偏好并支持后台定时巡检与主动提醒。",
                        "Always-on personal agent with persistent memory, background tasks, and proactive alerts.",
                      )}
                  </p>
                </div>

                {heroError && (
                  <p className="text-xs text-destructive" role="alert">
                    {heroError}
                  </p>
                )}

                <div className="w-full max-w-xl grid gap-2.5">
                  <InputGroup className="h-auto rounded-2xl border-border/90 bg-card shadow-sm transition-shadow focus-within:border-ring focus-within:shadow-md">
                    <InputGroupTextarea
                      rows={3}
                      value={heroPrompt}
                      disabled={creatingThread}
                      placeholder={t(
                        `向 ${bot.name} 发送一条消息…`,
                        `Message ${bot.name}…`,
                      )}
                      onChange={(event) => setHeroPrompt(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          if (heroPrompt.trim()) void startNewThread(heroPrompt);
                        }
                      }}
                    />
                  </InputGroup>
                  <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
                    <span className="text-xs text-muted-foreground">
                      {t(
                        "支持自由切换模型源、后台定时提醒与长期记忆沉淀",
                        "Supports model switching, background reminders, and persistent memory",
                      )}
                    </span>
                    <Button
                      disabled={creatingThread || !heroPrompt.trim()}
                      onClick={() => void startNewThread(heroPrompt)}
                    >
                      {creatingThread ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />}
                      {t("开始对话", "Start chat")}
                    </Button>
                  </div>
                </div>

                <div className="bots-hero-prompts">
                  {starters.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      data-slot="bot-control"
                      className="bots-hero-prompt-card"
                      disabled={creatingThread}
                      onClick={() => void startNewThread(prompt)}
                    >
                      <Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                      <span className="text-left leading-snug">{prompt}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <BotInspectorSheet
        open={inspectorOpen}
        bot={bot}
        activeThread={activeThread}
        initialTab={inspectorTab}
        onOpenChange={setInspectorOpen}
        onBotsUpdated={onBotsUpdated}
        onEditBot={() => {
          setInspectorOpen(false);
          onEditBot(bot);
        }}
      />
    </div>
  );
}
