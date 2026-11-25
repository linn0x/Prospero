import { useEffect, useMemo, useState } from "react";
import {
  BookMarked,
  Bot,
  MessageSquarePlus,
  PanelLeft,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
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
import { BotConversationList } from "./BotConversationList";
import { BotInspectorSheet, feishuStateLabel, type BotStudioTab } from "./BotInspectorSheet";
import { accessPolicyLabel } from "./FeishuAccessControlPanel";
import { runBotAction } from "./use-bots";

const MASTER_STARTERS_ZH = [
  "帮我梳理今天的核心事项与优先级",
  "结合我的长期记忆，整理一份近期重点简报",
  "帮我规划一个由多个专职子 Bot 分工完成的任务",
];

const MASTER_STARTERS_EN = [
  "Help me plan today's priorities",
  "Summarize key context from my long-term memory",
  "Coordinate a task across specialized Sub-Bots",
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
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<BotStudioTab>("memory");
  const [listOpen, setListOpen] = useState(true);
  const [creatingThread, setCreatingThread] = useState(false);
  const [heroPrompt, setHeroPrompt] = useState("");
  const [heroError, setHeroError] = useState<string | undefined>(undefined);
  const [hydratedSession, setHydratedSession] = useState<SessionInfo | undefined>(undefined);

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
              "正在连接本地 Daemon 加载你的主控 Bot 与子 Bot 团队…",
              "Connecting to local daemon to load your Master Bot and Sub-Bots…",
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
          <Button
            variant={listOpen ? "secondary" : "ghost"}
            size="icon-sm"
            aria-pressed={listOpen}
            aria-label={t("会话列表", "Chats")}
            title={t("收起/展开会话列表", "Toggle conversations")}
            onClick={() => setListOpen((prev) => !prev)}
          >
            <PanelLeft />
          </Button>
          <span className="bots-pane-avatar" aria-hidden="true">
            {bot.avatar}
          </span>
          <div className="bots-pane-titles">
            <div className="bots-pane-title-row">
              <h2>{bot.name}</h2>
              <Badge variant={bot.kind === "master" ? "default" : "secondary"} className="h-4.5 px-1.5 text-[10px]">
                {bot.kind === "master" ? t("主控 Bot", "Master") : t("子 Bot", "Sub-Bot")}
              </Badge>
              {activeThread && (
                <span className="text-xs text-muted-foreground truncate">
                  · {activeThread.title}
                </span>
              )}
            </div>
            <div className="bots-pane-subtitle">
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
              <span className="bots-meta-chip">
                <span className="bot-feishu-dot" data-state={bot.feishuStatus.state} />
                <span>{feishuStateLabel(bot.feishuStatus.state, t)}</span>
              </span>
              {bot.feishu.enabled && (
                <button
                  type="button"
                  data-slot="bot-control"
                  className="bots-acl-pill"
                  title={t("点击配置飞书权限与管理员", "Configure Feishu permissions & admins")}
                  onClick={() => {
                    setInspectorTab("access");
                    setInspectorOpen(true);
                  }}
                >
                  <ShieldCheck className="size-3 text-emerald-600 dark:text-emerald-400" />
                  <span>
                    {accessPolicyLabel(bot.feishu.accessPolicy, t)}
                    {bot.feishu.adminUsers.length > 0 ? ` (${bot.feishu.adminUsers.length})` : ""}
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="bots-pane-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setInspectorTab("memory");
              setInspectorOpen(true);
            }}
          >
            <BookMarked data-icon="inline-start" />
            {t("记忆与权限", "Memory & ACL")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onEditBot(bot)}>
            <Settings data-icon="inline-start" />
            {t("配置 Bot", "Configure")}
          </Button>
          <span className="bots-header-divider" aria-hidden="true" />
          <Button
            variant="secondary"
            size="sm"
            disabled={creatingThread}
            onClick={() => void startNewThread()}
          >
            {creatingThread ? <Spinner data-icon="inline-start" /> : <MessageSquarePlus data-icon="inline-start" />}
            {t("新话题", "New thread")}
          </Button>
          {activeThread && (
            <Button
              variant="ghost"
              size="sm"
              className="bots-header-delete-btn"
              title={t("删除当前话题", "Delete current thread")}
              onClick={() => onArchiveThread(bot.id, activeThread.id)}
            >
              <Trash2 data-icon="inline-start" />
              {t("删除话题", "Delete")}
            </Button>
          )}
        </div>
      </header>

      <div className="bots-pane-split">
        {listOpen && (
          <BotConversationList
            botId={bot.id}
            threads={bot.threads}
            sessions={snapshot.daemon.sessions}
            adminUsers={bot.feishu.adminUsers}
            activeThreadId={activeThread?.id}
            creatingThread={creatingThread}
            onSelectThread={onSelectThread}
            onNewThread={() => void startNewThread()}
            onArchiveThread={onArchiveThread}
          />
        )}

        <div className="bots-pane-body">
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
                      "类似 GrokBot / Muse 的常驻个人智能体：发送一条消息开启新话题，或绑定飞书随时对话。",
                      "Always-on personal agent: send a message to start a thread or connect Feishu IM.",
                    )}
                </p>
              </div>

              <div className="bots-hero-meta-strip">
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
                <span className="bots-meta-chip">
                  <span className="bot-feishu-dot" data-state={bot.feishuStatus.state} />
                  <span>{feishuStateLabel(bot.feishuStatus.state, t)}</span>
                </span>
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
                      `向 ${bot.name} 发送一条消息，开启第一个话题…`,
                      `Message ${bot.name} to start a new thread…`,
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
                  {bot.kind === "sub" && !bot.feishu.enabled ? (
                    <Button variant="ghost" size="sm" onClick={() => onEditBot(bot)}>
                      {t("配置飞书机器人 IM", "Connect Feishu Bot IM")}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {bot.feishu.enabled
                        ? t("飞书 IM 已配置，桌面与飞书消息将实时同步", "Feishu IM enabled; synced with Desktop")
                        : t("支持自由切换 Codex / Claude / AGY / DeepSeek / 模型源", "Supports Codex / Claude / AGY / DeepSeek / Model Sources")}
                    </span>
                  )}
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
