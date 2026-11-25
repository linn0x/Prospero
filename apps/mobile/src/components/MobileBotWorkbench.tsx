import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  AgentKind,
  Attachment,
  BotMemoryCategory,
  BotMemoryEntry,
  BotMemoryItem,
  BotTask,
  BotTaskDelivery,
  BotTaskKind,
  PublicBot,
  S2CMessage,
} from "@prospero/protocol";
import { ChatView } from "@/components/ChatView";
import { Icon } from "@/components/Icon";
import { Sheet, SheetAction } from "@/components/Sheet";
import { toast } from "@/components/Toast";
import { VoiceButton } from "@/components/VoiceButton";
import { pickFromLibrary, type PickedImage } from "@/lib/attach";
import {
  buildMobileBotCreateInput,
  buildMobileBotUpdateInput,
  computeOneShotTimestamp,
  filterMobileMemoryItems,
  formatMobileBotSchedule,
  MOBILE_AVATAR_PRESETS,
  MOBILE_BOT_AGENTS,
  MOBILE_MEMORY_CATEGORIES,
  MOBILE_ONESHOT_DELAYS,
  MOBILE_ROLE_PRESETS,
  MOBILE_SCHEDULE_PRESETS,
  mobileBotWorkingStatus,
  mobileMemoryCategoryLabel,
  type MobileOneShotDelayId,
  splitMobileMemoryItems,
} from "@/lib/bot-helpers";
import { deliveryFailureText } from "@/lib/outbound-queue";
import { createThemedStyles, radius, useMobileTheme } from "@/lib/theme";
import { useMobileBots } from "@/lib/use-bots";
import { useHostConnection } from "@/lib/use-host-connection";
import { appendVoiceTranscript } from "@/lib/voice-input";

type RuntimeAgentModel = Extract<S2CMessage, { type: "agent.models" }>["models"][number];

type BotSheetState =
  | { kind: "bots" }
  | { kind: "menu" }
  | { kind: "threads" }
  | { kind: "tasks" }
  | { kind: "taskAction"; task: BotTask }
  | { kind: "taskEditor"; editingTaskId: string | null }
  | { kind: "memory" }
  | { kind: "memoryAdd" }
  | { kind: "memoryAction"; item: BotMemoryItem }
  | { kind: "memoryEdit"; item: BotMemoryItem }
  | { kind: "memoryMarkdown" }
  | { kind: "capabilities" }
  | { kind: "botEditor"; editingBotId: string | null }
  | { kind: "models" }
  | null;

const STARTER_PROMPTS = [
  "帮我梳理今天的核心事项与优先级",
  "结合我的长期记忆，整理一份重点简报",
  "帮我定一个每天早上 8 点的日报提醒",
];

const TASK_PRESETS: readonly {
  id: string;
  title: string;
  prompt: string;
  kind: BotTaskKind;
  rrule?: string;
  offsetMs?: number;
}[] = [
  {
    id: "morning",
    title: "每日早报 08:00",
    prompt: "结合我的长期记忆和近期项目，生成今日核心待办与重点提示简报。",
    kind: "cron",
    rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0",
  },
  {
    id: "heartbeat",
    title: "每小时巡检",
    prompt: "检查当前是否有需要跟进或预警的事项，如有重要发现主动向我汇报。",
    kind: "heartbeat",
    rrule: "FREQ=HOURLY;INTERVAL=1",
  },
  {
    id: "one-hour",
    title: "1 小时后提醒我",
    prompt: "到了约定的时间，请主动提醒我确认当前推进事项的进展。",
    kind: "one_shot",
    offsetMs: 3_600_000,
  },
];

function computeOffsetTimestamp(offsetMs: number): number {
  return Date.now() + offsetMs;
}

export function MobileBotWorkbench({
  hostId,
  embedded = false,
  onBotUnreadChange,
}: {
  hostId: string | undefined;
  embedded?: boolean;
  onBotUnreadChange?: (count: number) => void;
}) {
  const { host, conn, runtime } = useHostConnection(hostId);
  const { palette } = useMobileTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const {
    supported: botsSupported,
    bots,
    loading,
    error,
    refresh,
    runAction,
  } = useMobileBots(conn, runtime.status, runtime.hostInfo?.capabilities);

  const [selectedBotId, setSelectedBotId] = useState<string>("master");
  const [selectedThreadsByBot, setSelectedThreadsByBot] = useState<Record<string, string>>({});
  const [activeSheet, setActiveSheet] = useState<BotSheetState>(null);

  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PickedImage[]>([]);
  const [sending, setSending] = useState(false);

  const [taskName, setTaskName] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [taskKind, setTaskKind] = useState<BotTaskKind>("cron");
  const [taskRrule, setTaskRrule] = useState("FREQ=DAILY;BYHOUR=8;BYMINUTE=0");
  const [taskOneShotPreset, setTaskOneShotPreset] = useState<MobileOneShotDelayId>("1h");
  const [taskDelivery, setTaskDelivery] = useState<BotTaskDelivery>("primary_thread");
  const [taskNotifyApp, setTaskNotifyApp] = useState(true);
  const [taskFeishuChatId, setTaskFeishuChatId] = useState("");
  const [taskBusy, setTaskBusy] = useState(false);

  const [memCategory, setMemCategory] = useState<BotMemoryCategory>("preference");
  const [memFilter, setMemFilter] = useState<"all" | BotMemoryCategory>("all");
  const [memQuery, setMemQuery] = useState("");
  const [memContent, setMemContent] = useState("");
  const [memBusy, setMemBusy] = useState(false);

  const [editMemCategory, setEditMemCategory] = useState<BotMemoryCategory>("preference");
  const [editMemContent, setEditMemContent] = useState("");
  const [editMemBusy, setEditMemBusy] = useState(false);

  const [mdEntries, setMdEntries] = useState<BotMemoryEntry[]>([]);
  const [mdSelectedKey, setMdSelectedKey] = useState<string>("global");
  const [mdContent, setMdContent] = useState("");
  const [mdLoading, setMdLoading] = useState(false);
  const [mdSaving, setMdSaving] = useState(false);

  const [botName, setBotName] = useState("");
  const [botAvatar, setBotAvatar] = useState("🤖");
  const [botDesc, setBotDesc] = useState("");
  const [botPrompt, setBotPrompt] = useState("");
  const [botAgent, setBotAgent] = useState<AgentKind>("codex");
  const [botModel, setBotModel] = useState("");
  const [botCrossWs, setBotCrossWs] = useState(false);
  const [botSaving, setBotSaving] = useState(false);

  const [modelLoading, setModelLoading] = useState(false);
  const [modelOptions, setModelOptions] = useState<RuntimeAgentModel[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | undefined>(undefined);
  const [activeEffort, setActiveEffort] = useState<string | undefined>(undefined);

  const ensuredPrimaryRef = useRef<Set<string>>(new Set());

  const totalBotUnread = useMemo(
    () => bots.reduce((sum, b) => sum + (b.unreadProactiveCount ?? 0), 0),
    [bots],
  );

  useEffect(() => {
    onBotUnreadChange?.(totalBotUnread);
  }, [onBotUnreadChange, totalBotUnread]);

  const activeBot = useMemo<PublicBot | undefined>(
    () =>
      bots.find((b) => b.id === selectedBotId) ??
      bots.find((b) => b.kind === "master") ??
      bots[0],
    [bots, selectedBotId],
  );

  const activeThread = useMemo(() => {
    if (!activeBot) return undefined;
    const preferred = selectedThreadsByBot[activeBot.id];
    return (
      activeBot.threads.find((t) => t.id === preferred) ??
      activeBot.threads.find((t) => t.isPrimary) ??
      activeBot.threads[0]
    );
  }, [activeBot, selectedThreadsByBot]);

  useEffect(() => {
    if (!conn || !activeBot || activeThread || runtime.status !== "connected") return;
    if (ensuredPrimaryRef.current.has(activeBot.id)) return;
    ensuredPrimaryRef.current.add(activeBot.id);
    void runAction({ kind: "thread.ensure_primary", botId: activeBot.id })
      .then((res) => {
        if (res.thread) {
          setSelectedThreadsByBot((prev) => ({ ...prev, [activeBot.id]: res.thread!.id }));
        }
      })
      .catch(() => {
        ensuredPrimaryRef.current.delete(activeBot.id);
      });
  }, [activeBot, activeThread, conn, runAction, runtime.status]);

  useEffect(() => {
    if (!activeBot || !activeThread || activeThread.unreadCount <= 0) return;
    void runAction({
      kind: "thread.mark_read",
      botId: activeBot.id,
      threadId: activeThread.id,
    }).catch(() => undefined);
  }, [activeBot, activeThread, runAction]);

  const activeSession = useMemo(
    () => (activeThread ? runtime.sessions[activeThread.sessionId] : undefined),
    [activeThread, runtime.sessions],
  );

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const recentAddedMemory = useMemo(() => {
    const ev = activeBot?.recentMemoryEvents?.[0];
    if (!ev || ev.reverted || ev.action !== "added") return undefined;
    if (nowMs - ev.createdAt > 10 * 60_000) return undefined;
    return ev;
  }, [activeBot?.recentMemoryEvents, nowMs]);

  const { active: activeMemories, archived: archivedMemories } = useMemo(
    () => splitMobileMemoryItems(activeBot?.memoryItems ?? []),
    [activeBot?.memoryItems],
  );

  const filteredMemories = useMemo(
    () => filterMobileMemoryItems(activeMemories, memFilter, memQuery),
    [activeMemories, memFilter, memQuery],
  );

  const sendMessage = useCallback(
    async (explicitText?: string) => {
      if (!conn || !activeBot || sending) return;
      const body = (explicitText ?? draft).trim();
      if (!body && images.length === 0) return;
      setSending(true);
      try {
        let targetSessionId = activeThread?.sessionId;
        if (!targetSessionId) {
          const ensured = await runAction({
            kind: "thread.ensure_primary",
            botId: activeBot.id,
          });
          targetSessionId = ensured.thread?.sessionId;
          if (ensured.thread) {
            setSelectedThreadsByBot((prev) => ({
              ...prev,
              [activeBot.id]: ensured.thread!.id,
            }));
          }
        }
        if (!targetSessionId) {
          toast("未能建立主对话流，请重试");
          return;
        }
        const attachments: Attachment[] = images.map(({ uri: _uri, ...att }) => ({
          ...att,
          mimeType: "image/jpeg" as const,
        }));
        const res = conn.chatSend(
          targetSessionId,
          body,
          attachments.length ? attachments : undefined,
        );
        if (!res.accepted) {
          toast(deliveryFailureText(res));
          return;
        }
        if (explicitText === undefined) setDraft("");
        setImages([]);
      } catch (err) {
        toast(err instanceof Error ? err.message : "发送失败");
      } finally {
        setSending(false);
      }
    },
    [activeBot, activeThread, conn, draft, images, runAction, sending],
  );

  const handlePickImage = async () => {
    const picked = await pickFromLibrary(4 - images.length);
    if (picked.status === "selected") {
      setImages((prev) => [...prev, ...picked.images].slice(0, 4));
    } else if (picked.status === "error") {
      toast(picked.message);
    } else if (picked.status === "permission_denied") {
      toast("请在系统设置中允许访问相册");
    }
  };

  const openTaskEditor = (existing?: BotTask) => {
    if (existing) {
      setTaskName(existing.name);
      setTaskPrompt(existing.prompt);
      setTaskKind(existing.kind);
      setTaskRrule(existing.rrule ?? "FREQ=DAILY;BYHOUR=8;BYMINUTE=0");
      setTaskDelivery(existing.delivery);
      setTaskNotifyApp(existing.notifyApp);
      setTaskFeishuChatId(existing.notifyFeishuChatId ?? "");
      setActiveSheet({ kind: "taskEditor", editingTaskId: existing.id });
    } else {
      setTaskName("");
      setTaskPrompt("");
      setTaskKind("cron");
      setTaskRrule("FREQ=DAILY;BYHOUR=8;BYMINUTE=0");
      setTaskOneShotPreset("1h");
      setTaskDelivery("primary_thread");
      setTaskNotifyApp(true);
      setTaskFeishuChatId("");
      setActiveSheet({ kind: "taskEditor", editingTaskId: null });
    }
  };

  const handleSaveTask = async (
    preset?: (typeof TASK_PRESETS)[number],
    editingTaskId?: string | null,
  ) => {
    if (!activeBot || taskBusy) return;
    const name = (preset ? preset.title : taskName).trim();
    const prompt = (preset ? preset.prompt : taskPrompt).trim();
    const kind = preset ? preset.kind : taskKind;
    const rrule = preset
      ? (preset.rrule ?? null)
      : kind === "one_shot"
        ? null
        : taskRrule.trim();
    const runAt =
      kind === "one_shot"
        ? preset
          ? computeOffsetTimestamp(preset.offsetMs ?? 3_600_000)
          : computeOneShotTimestamp(taskOneShotPreset)
        : null;
    if (!name || !prompt) {
      toast("请填写任务名称和执行指令");
      return;
    }
    const delivery = preset ? "primary_thread" : taskDelivery;
    const notifyApp = preset ? true : taskNotifyApp;
    const notifyFeishuChatId =
      !preset && activeBot.feishu.enabled && taskFeishuChatId.trim()
        ? taskFeishuChatId.trim()
        : null;
    setTaskBusy(true);
    try {
      if (editingTaskId && !preset) {
        await runAction({
          kind: "task.update",
          botId: activeBot.id,
          taskId: editingTaskId,
          input: {
            name,
            prompt,
            kind,
            rrule,
            runAt,
            delivery,
            notifyApp,
            notifyFeishuChatId,
            status: null,
          },
        });
        toast(`已更新任务「${name}」`);
      } else {
        await runAction({
          kind: "task.create",
          botId: activeBot.id,
          input: {
            name,
            prompt,
            kind,
            rrule,
            runAt,
            delivery,
            notifyApp,
            notifyFeishuChatId,
          },
        });
        toast(`已创建后台任务「${name}」`);
      }
      setTaskName("");
      setTaskPrompt("");
      setActiveSheet({ kind: "tasks" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "保存任务失败");
    } finally {
      setTaskBusy(false);
    }
  };

  const openBotEditor = (bot?: PublicBot) => {
    if (bot) {
      setBotName(bot.name);
      setBotAvatar(bot.avatar);
      setBotDesc(bot.description);
      setBotPrompt(bot.systemPrompt);
      setBotAgent(bot.agent);
      setBotModel(bot.model ?? "");
      setBotCrossWs(bot.allowCrossWorkspace);
      setActiveSheet({ kind: "botEditor", editingBotId: bot.id });
    } else {
      const preset = MOBILE_ROLE_PRESETS[0];
      setBotName("");
      setBotAvatar(preset.avatar);
      setBotDesc(preset.description);
      setBotPrompt(preset.systemPrompt);
      setBotAgent("codex");
      setBotModel("");
      setBotCrossWs(preset.allowCrossWorkspace);
      setActiveSheet({ kind: "botEditor", editingBotId: null });
    }
  };

  const handleSaveBot = async (editingBotId: string | null) => {
    if (botSaving) return;
    if (!botName.trim()) {
      toast("请填写 Bot 名称");
      return;
    }
    setBotSaving(true);
    try {
      if (editingBotId) {
        const target = bots.find((b) => b.id === editingBotId);
        if (!target) throw new Error("未找到目标 Bot");
        await runAction({
          kind: "update",
          botId: target.id,
          input: buildMobileBotUpdateInput(target, {
            name: botName.trim(),
            avatar: botAvatar.trim() || "🤖",
            description: botDesc.trim(),
            systemPrompt: botPrompt.trim(),
            agent: botAgent,
            model: botModel.trim() || null,
            allowCrossWorkspace: botCrossWs,
          }),
        });
        toast("已保存 Bot 配置");
        setActiveSheet({ kind: "capabilities" });
      } else {
        const res = await runAction({
          kind: "create",
          input: buildMobileBotCreateInput({
            name: botName,
            avatar: botAvatar,
            description: botDesc,
            systemPrompt: botPrompt,
            agent: botAgent,
            model: botModel,
            allowCrossWorkspace: botCrossWs,
          }),
        });
        if (res.bot) setSelectedBotId(res.bot.id);
        toast(`已创建子 Bot「${botName.trim()}」`);
        setActiveSheet(null);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "保存 Bot 失败");
    } finally {
      setBotSaving(false);
    }
  };

  const handleDeleteBot = (bot: PublicBot) => {
    if (bot.kind === "master") return;
    Alert.alert("删除子 Bot", `确定要删除「${bot.name}」吗？相关对话与记忆将被清理。`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          void runAction({ kind: "delete", botId: bot.id })
            .then(() => {
              setSelectedBotId("master");
              setActiveSheet(null);
              toast(`已删除「${bot.name}」`);
            })
            .catch((e) => toast(e instanceof Error ? e.message : "删除失败"));
        },
      },
    ]);
  };

  const handleAddMemory = async () => {
    if (!activeBot || !memContent.trim() || memBusy) return;
    setMemBusy(true);
    try {
      await runAction({
        kind: "memory.item.add",
        botId: activeBot.id,
        category: memCategory,
        content: memContent.trim(),
        scope: "global",
        pinned: false,
        source: "manual",
      });
      setMemContent("");
      setActiveSheet({ kind: "memory" });
      toast("已记住");
    } catch (err) {
      toast(err instanceof Error ? err.message : "保存记忆失败");
    } finally {
      setMemBusy(false);
    }
  };

  const handleSaveMemoryEdit = async (item: BotMemoryItem) => {
    if (!activeBot || editMemBusy || !editMemContent.trim()) return;
    setEditMemBusy(true);
    try {
      await runAction({
        kind: "memory.item.update",
        botId: activeBot.id,
        itemId: item.id,
        category: editMemCategory,
        content: editMemContent.trim(),
        pinned: null,
      });
      setActiveSheet({ kind: "memory" });
      toast("已更新记忆");
    } catch (err) {
      toast(err instanceof Error ? err.message : "更新记忆失败");
    } finally {
      setEditMemBusy(false);
    }
  };

  const loadMarkdownEntry = async (botId: string, key: string) => {
    setMdSelectedKey(key);
    setMdLoading(true);
    try {
      const res = await runAction({ kind: "memory.entry.read", botId, key });
      setMdContent(res.memory?.content ?? "");
    } catch (err) {
      toast(err instanceof Error ? err.message : "读取记忆文档失败");
    } finally {
      setMdLoading(false);
    }
  };

  const openMarkdownMemory = async () => {
    if (!activeBot) return;
    setActiveSheet({ kind: "memoryMarkdown" });
    setMdLoading(true);
    try {
      const listRes = await runAction({ kind: "memory.list", botId: activeBot.id });
      const entries = listRes.memories ?? [];
      setMdEntries(entries);
      const firstKey =
        entries.find((e) => e.key === "global")?.key ?? entries[0]?.key ?? "global";
      setMdSelectedKey(firstKey);
      const readRes = await runAction({
        kind: "memory.entry.read",
        botId: activeBot.id,
        key: firstKey,
      });
      setMdContent(readRes.memory?.content ?? "");
    } catch (err) {
      toast(err instanceof Error ? err.message : "加载记忆文档失败");
    } finally {
      setMdLoading(false);
    }
  };

  const handleSaveMarkdownEntry = async () => {
    if (!activeBot || mdSaving) return;
    setMdSaving(true);
    try {
      const entry = mdEntries.find((e) => e.key === mdSelectedKey);
      await runAction({
        kind: "memory.entry.write",
        botId: activeBot.id,
        key: mdSelectedKey,
        content: mdContent,
        label: entry?.label ?? null,
        chatId: entry?.chatId ?? null,
        chatName: entry?.chatName ?? null,
        userId: entry?.userId ?? null,
        userName: entry?.userName ?? null,
      });
      const listRes = await runAction({ kind: "memory.list", botId: activeBot.id });
      if (listRes.memories) setMdEntries(listRes.memories);
      toast("已保存 Markdown 记忆");
    } catch (err) {
      toast(err instanceof Error ? err.message : "保存失败");
    } finally {
      setMdSaving(false);
    }
  };

  const handleDeleteMarkdownEntry = () => {
    if (!activeBot || mdSelectedKey === "global") return;
    Alert.alert("删除作用域文档", "确定清空并删除该作用域的 Markdown 记忆吗？", [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          void runAction({
            kind: "memory.entry.delete",
            botId: activeBot.id,
            key: mdSelectedKey,
          })
            .then(async () => {
              const listRes = await runAction({ kind: "memory.list", botId: activeBot.id });
              const entries = listRes.memories ?? [];
              setMdEntries(entries);
              await loadMarkdownEntry(activeBot.id, "global");
              toast("已删除该记忆文档");
            })
            .catch((e) => toast(e instanceof Error ? e.message : "删除失败"));
        },
      },
    ]);
  };

  const openModelPicker = async () => {
    if (!conn || !activeThread) {
      toast("请先建立对话后再切换模型");
      return;
    }
    setActiveSheet({ kind: "models" });
    setModelLoading(true);
    try {
      const res = await conn.agentModels(activeThread.sessionId);
      setModelOptions(res.models);
      setActiveModelId(res.currentModel ?? activeBot?.model ?? undefined);
      setActiveEffort(res.currentEffort ?? activeBot?.effort ?? undefined);
    } catch (err) {
      toast(err instanceof Error ? err.message : "加载模型列表失败");
    } finally {
      setModelLoading(false);
    }
  };

  const handleSelectSessionModel = async (model: RuntimeAgentModel, effort?: string) => {
    if (!conn || !activeThread) return;
    setModelLoading(true);
    try {
      const res = await conn.setAgentModel(
        activeThread.sessionId,
        model.id,
        effort ?? model.defaultEffort,
      );
      if (!res.ok) throw new Error(res.message ?? "切换模型失败");
      setActiveModelId(res.currentModel ?? model.id);
      setActiveEffort(res.currentEffort ?? effort ?? model.defaultEffort);
      setActiveSheet(null);
      toast(res.message ?? `已切换至 ${model.label}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "切换模型失败");
    } finally {
      setModelLoading(false);
    }
  };

  const toggleCapability = async (
    key: "autoMemory" | "proactiveNotifications" | "allowCrossWorkspace",
    value: boolean,
  ) => {
    if (!activeBot) return;
    try {
      await runAction({
        kind: "update",
        botId: activeBot.id,
        input: buildMobileBotUpdateInput(activeBot, { [key]: value }),
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : "更新设置失败");
    }
  };

  const activeTaskCount =
    activeBot?.tasks.filter((t) => t.status === "enabled").length ?? 0;

  const sheetTitle = useMemo(() => {
    switch (activeSheet?.kind) {
      case "bots":
        return "切换或新建 Bot";
      case "menu":
        return activeBot ? `${activeBot.avatar} ${activeBot.name}` : "个人 Bot 菜单";
      case "threads":
        return "主对话与分支话题";
      case "tasks":
        return "后台任务与提醒";
      case "taskAction":
        return activeSheet.task.name;
      case "taskEditor":
        return activeSheet.editingTaskId ? "编辑后台任务" : "新建后台任务";
      case "memory":
        return "长期记忆";
      case "memoryAdd":
        return "记住一条新信息";
      case "memoryAction":
        return mobileMemoryCategoryLabel(activeSheet.item.category);
      case "memoryEdit":
        return "编辑记忆";
      case "memoryMarkdown":
        return "Markdown 记忆文档";
      case "capabilities":
        return "能力与人设";
      case "botEditor":
        return activeSheet.editingBotId ? "编辑个人 Bot" : "新建专职子 Bot";
      case "models":
        return "切换对话模型";
      default:
        return "";
    }
  }, [activeBot, activeSheet]);

  return (
    <View style={styles.root}>
      {!embedded && (
        <Stack.Screen
          options={{
            title: activeBot ? `${activeBot.avatar} ${activeBot.name}` : "个人 Bot",
            headerRight: activeBot
              ? () => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="个人 Bot 菜单"
                    onPress={() => setActiveSheet({ kind: "menu" })}
                    style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
                  >
                    <Icon name="ellipsis.circle" size={19} color={palette.text} />
                    {activeBot.unreadProactiveCount > 0 && <View style={styles.unreadDot} />}
                  </Pressable>
                )
              : undefined,
          }}
        />
      )}

      {!conn || runtime.status !== "connected" ? (
        <View style={styles.centerEmpty}>
          <ActivityIndicator color={palette.accent} />
          <Text style={styles.emptyTitle}>正在连接 {host?.name ?? "电脑"}…</Text>
          <Text style={styles.emptySub}>连接后将自动同步你的个人智能体、记忆与后台任务。</Text>
        </View>
      ) : !botsSupported ? (
        <View style={styles.centerEmpty}>
          <Icon name="exclamationmark.triangle.fill" size={28} color={palette.warn} />
          <Text style={styles.emptyTitle}>电脑端暂不支持个人 Bot 模式</Text>
          <Text style={styles.emptySub}>请先将此电脑上的 Prospero 升级到最新版本。</Text>
        </View>
      ) : loading && !activeBot ? (
        <View style={styles.centerEmpty}>
          <ActivityIndicator color={palette.accent} />
          <Text style={styles.emptySub}>正在加载个人智能体…</Text>
        </View>
      ) : error && !activeBot ? (
        <View style={styles.centerEmpty}>
          <Text style={styles.emptyTitle}>{error}</Text>
          <Pressable onPress={() => void refresh()} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>重试</Text>
          </Pressable>
        </View>
      ) : activeBot ? (
        <KeyboardAvoidingView
          style={styles.body}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={Platform.OS === "ios" ? (embedded ? 128 : 90) : 0}
        >
          {embedded && (
            <View style={styles.botTopBar}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="切换个人 Bot"
                onPress={() => setActiveSheet({ kind: "bots" })}
                style={({ pressed }) => [styles.botSelector, pressed && styles.pressed]}
              >
                <Text style={styles.botSelectorAvatar}>{activeBot.avatar}</Text>
                <Text style={styles.botSelectorName} numberOfLines={1}>
                  {activeBot.name}
                </Text>
                {activeThread && !activeThread.isPrimary && (
                  <Text style={styles.botSelectorThread} numberOfLines={1}>
                    · {activeThread.chatName || activeThread.title}
                  </Text>
                )}
                <Icon name="chevron.down" size={11} color={palette.textDim} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="个人 Bot 菜单"
                onPress={() => setActiveSheet({ kind: "menu" })}
                style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
              >
                <Icon name="ellipsis.circle" size={19} color={palette.text} />
                {activeBot.unreadProactiveCount > 0 && <View style={styles.unreadDot} />}
              </Pressable>
            </View>
          )}

          {activeBot.unreadProactiveCount > 0 && activeBot.latestProactiveNotice && (
            <View style={styles.proactiveBanner}>
              <View style={styles.bannerCopy}>
                <Text style={styles.bannerTitle} numberOfLines={1}>
                  ⏰ {activeBot.latestProactiveNotice.title}
                </Text>
                <Text style={styles.bannerSub} numberOfLines={2}>
                  {activeBot.latestProactiveNotice.summary}
                </Text>
              </View>
              <Pressable
                onPress={() =>
                  void runAction({
                    kind: "notices.ack",
                    botId: activeBot.id,
                    noticeId: activeBot.latestProactiveNotice?.id ?? null,
                  })
                }
                style={styles.bannerBtn}
              >
                <Text style={styles.bannerBtnText}>知道了</Text>
              </Pressable>
            </View>
          )}

          {recentAddedMemory && (
            <View style={styles.memoryPill}>
              <Text style={styles.memoryPillText} numberOfLines={1}>
                🧠 已记住：{recentAddedMemory.summary}
              </Text>
              <Pressable
                onPress={() =>
                  void runAction({
                    kind: "memory.item.restore",
                    botId: activeBot.id,
                    itemId: recentAddedMemory.itemId,
                  })
                }
              >
                <Text style={styles.memoryUndoText}>撤销</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.chatListWrap}>
            {activeThread ? (
              <ChatView
                conn={conn}
                sid={activeThread.sessionId}
                agent={activeBot.agent}
                workingStatus={mobileBotWorkingStatus(activeSession?.status)}
                onInterrupt={() => conn.interrupt(activeThread.sessionId)}
              />
            ) : (
              <ScrollView contentContainerStyle={styles.heroWrap}>
                <Text style={styles.heroAvatar}>{activeBot.avatar}</Text>
                <Text style={styles.heroTitle}>{activeBot.name}</Text>
                <Text style={styles.heroDesc}>
                  {activeBot.description || "永续对话 · 主动记忆 · 后台定时提醒"}
                </Text>
                <View style={styles.starterGrid}>
                  {STARTER_PROMPTS.map((p) => (
                    <Pressable
                      key={p}
                      onPress={() => void sendMessage(p)}
                      style={({ pressed }) => [styles.starterCard, pressed && styles.pressed]}
                    >
                      <Text style={styles.starterText}>{p}</Text>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
            )}
          </View>

          <View style={[styles.composerBox, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            {images.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.thumbStrip}>
                {images.map((img, idx) => (
                  <View key={`${img.uri}-${String(idx)}`} style={styles.thumbWrap}>
                    <Image source={{ uri: img.uri }} style={styles.thumbImg} />
                    <Pressable
                      onPress={() => setImages((prev) => prev.filter((_, i) => i !== idx))}
                      style={styles.thumbRemove}
                    >
                      <Icon name="xmark" size={10} color="#fff" />
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            )}
            <View style={styles.composerRow}>
              <VoiceButton
                onTranscript={(transcript) =>
                  setDraft((current) => appendVoiceTranscript(current, transcript))
                }
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="添加图片"
                onPress={() => void handlePickImage()}
                style={({ pressed }) => [styles.iconActionBtn, pressed && styles.pressed]}
              >
                <Icon name="photo" size={18} color={palette.textDim} />
              </Pressable>
              <TextInput
                style={styles.composerInput}
                value={draft}
                onChangeText={setDraft}
                placeholder={`对 ${activeBot.name} 说点什么…`}
                placeholderTextColor={palette.textFaint}
                multiline
                maxLength={8000}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="发送"
                disabled={sending || (!draft.trim() && images.length === 0)}
                onPress={() => void sendMessage()}
                style={({ pressed }) => [
                  styles.sendBtn,
                  (sending || (!draft.trim() && images.length === 0)) && styles.sendBtnDisabled,
                  pressed && styles.pressed,
                ]}
              >
                {sending ? (
                  <ActivityIndicator size="small" color={palette.onAccent} />
                ) : (
                  <Icon name="arrow.up" size={16} color={palette.onAccent} weight="bold" />
                )}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      ) : null}

      <Sheet
        visible={activeSheet !== null}
        title={sheetTitle}
        contentKey={activeSheet?.kind ?? "none"}
        onClose={() => setActiveSheet(null)}
      >
        {activeSheet?.kind === "bots" && (
          <>
            <SheetAction
              label="新建专职子 Bot"
              detail="设定角色人设与专属引擎"
              symbol="plus"
              onPress={() => openBotEditor()}
            />
            {bots.map((b) => (
              <SheetAction
                key={b.id}
                label={`${b.id === activeBot?.id ? "✓ " : ""}${b.avatar} ${b.name}`}
                detail={`${b.kind === "master" ? "主控" : "子 Bot"} · ${b.agent}${b.unreadProactiveCount > 0 ? ` · ${b.unreadProactiveCount} 条提醒` : ""}`}
                symbol="bubble.left.and.text.bubble.right"
                onPress={() => {
                  setSelectedBotId(b.id);
                  setActiveSheet(null);
                }}
              />
            ))}
          </>
        )}

        {activeSheet?.kind === "menu" && activeBot && (
          <>
            <SheetAction
              label="切换或新建 Bot"
              detail={`${activeBot.avatar} ${activeBot.name} · 共 ${bots.length} 个`}
              symbol="square.stack.3d.up"
              onPress={() => setActiveSheet({ kind: "bots" })}
            />
            <SheetAction
              label="分支话题"
              detail={
                activeThread?.isPrimary
                  ? `当前：主对话 · 共 ${activeBot.threads.length} 个话题`
                  : `当前：${activeThread?.chatName || activeThread?.title || "话题"}`
              }
              symbol="arrow.triangle.branch"
              onPress={() => setActiveSheet({ kind: "threads" })}
            />
            <SheetAction
              label="后台任务与提醒"
              detail={activeTaskCount > 0 ? `${activeTaskCount} 个运行中` : "定时早报 / 心跳巡检"}
              symbol="clock.fill"
              onPress={() => setActiveSheet({ kind: "tasks" })}
            />
            <SheetAction
              label="长期记忆"
              detail={`${activeMemories.length} 条记忆卡片与 Markdown 文档`}
              symbol="pin.fill"
              onPress={() => setActiveSheet({ kind: "memory" })}
            />
            <SheetAction
              label="切换对话模型"
              detail={activeModelId ?? activeBot.model ?? activeBot.agent}
              symbol="command"
              onPress={() => void openModelPicker()}
            />
            <SheetAction
              label="能力与人设"
              detail={`自动记忆${activeBot.autoMemory ? "已开" : "已关"} · 飞书${activeBot.feishu.enabled ? "已开启" : "未开启"}`}
              symbol="gearshape.fill"
              onPress={() => setActiveSheet({ kind: "capabilities" })}
            />
          </>
        )}

        {activeSheet?.kind === "threads" && activeBot && (
          <>
            <Pressable onPress={() => setActiveSheet({ kind: "menu" })} style={styles.backRow}>
              <Icon name="chevron.left" size={14} color={palette.accent} />
              <Text style={styles.backRowText}>返回菜单</Text>
            </Pressable>
            <SheetAction
              label="新建分支话题"
              detail="独立推进专项问题，不打乱主对话"
              symbol="plus"
              onPress={() => {
                setActiveSheet(null);
                void runAction({ kind: "thread.create", botId: activeBot.id, title: null })
                  .then((res) => {
                    if (res.thread) {
                      setSelectedThreadsByBot((prev) => ({
                        ...prev,
                        [activeBot.id]: res.thread!.id,
                      }));
                    }
                  })
                  .catch((e) => toast(e instanceof Error ? e.message : "新建失败"));
              }}
            />
            {activeBot.threads.map((thr) => (
              <View key={thr.id} style={styles.threadActionRow}>
                <View style={{ flex: 1 }}>
                  <SheetAction
                    label={
                      thr.isPrimary
                        ? `${thr.id === activeThread?.id ? "✓ " : ""}主对话（永续）`
                        : `${thr.id === activeThread?.id ? "✓ " : ""}${thr.chatName || thr.title}`
                    }
                    detail={thr.lastMessagePreview || `${thr.messageCount} 条消息`}
                    symbol={thr.isPrimary ? "pin.fill" : "bubble.left.and.text.bubble.right"}
                    onPress={() => {
                      setSelectedThreadsByBot((prev) => ({
                        ...prev,
                        [activeBot.id]: thr.id,
                      }));
                      setActiveSheet(null);
                    }}
                  />
                </View>
                {!thr.isPrimary && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`删除分支 ${thr.title}`}
                    onPress={() => {
                      Alert.alert("删除分支话题", `确定删除「${thr.chatName || thr.title}」吗？`, [
                        { text: "取消", style: "cancel" },
                        {
                          text: "删除",
                          style: "destructive",
                          onPress: () => {
                            void runAction({
                              kind: "thread.archive",
                              botId: activeBot.id,
                              threadId: thr.id,
                            })
                              .then(() => {
                                if (activeThread?.id === thr.id) {
                                  setSelectedThreadsByBot((prev) => {
                                    const next = { ...prev };
                                    delete next[activeBot.id];
                                    return next;
                                  });
                                }
                                toast("已删除分支话题");
                              })
                              .catch((e) => toast(e instanceof Error ? e.message : "删除失败"));
                          },
                        },
                      ]);
                    }}
                    style={styles.threadDeleteBtn}
                  >
                    <Icon name="trash" size={15} color={palette.danger} />
                  </Pressable>
                )}
              </View>
            ))}
          </>
        )}

        {activeSheet?.kind === "tasks" && activeBot && (
          <View style={styles.sheetStack}>
            <View style={styles.sheetNavRow}>
              <Pressable onPress={() => setActiveSheet({ kind: "menu" })} style={styles.backRow}>
                <Icon name="chevron.left" size={14} color={palette.accent} />
                <Text style={styles.backRowText}>返回菜单</Text>
              </Pressable>
              <Pressable onPress={() => openTaskEditor()} style={styles.primaryBtn}>
                <Text style={styles.primaryBtnText}>+ 新建任务</Text>
              </Pressable>
            </View>

            {activeBot.tasks.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTitle}>暂无后台任务</Text>
                <Text style={styles.emptySub}>可直接选用模板，或在对话里用自然语言定时。</Text>
                <View style={styles.presetGrid}>
                  {TASK_PRESETS.map((preset) => (
                    <Pressable
                      key={preset.id}
                      onPress={() => void handleSaveTask(preset)}
                      style={({ pressed }) => [styles.presetChip, pressed && styles.pressed]}
                    >
                      <Text style={styles.presetChipText}>{preset.title}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : (
              activeBot.tasks.map((task) => (
                <Pressable
                  key={task.id}
                  onPress={() => setActiveSheet({ kind: "taskAction", task })}
                  style={({ pressed }) => [styles.card, pressed && styles.pressed]}
                >
                  <View style={styles.cardHead}>
                    <Text style={styles.cardTitle} numberOfLines={1}>
                      {task.name}
                    </Text>
                    <Text style={styles.badgeText}>
                      {task.status === "enabled"
                        ? "运行中"
                        : task.status === "paused"
                          ? "已暂停"
                          : "已完成"}
                    </Text>
                  </View>
                  <Text style={styles.cardMeta} numberOfLines={1}>
                    {formatMobileBotSchedule(task)}
                  </Text>
                  {task.lastSummary && (
                    <Text style={styles.summaryText} numberOfLines={2}>
                      {task.lastSummary}
                    </Text>
                  )}
                </Pressable>
              ))
            )}
          </View>
        )}

        {activeSheet?.kind === "taskAction" && activeBot && (
          <>
            <Pressable onPress={() => setActiveSheet({ kind: "tasks" })} style={styles.backRow}>
              <Icon name="chevron.left" size={14} color={palette.accent} />
              <Text style={styles.backRowText}>返回任务列表</Text>
            </Pressable>
            <SheetAction
              label="立即运行"
              detail="马上触发一次并推送结果"
              symbol="play.fill"
              onPress={() => {
                const taskId = activeSheet.task.id;
                setActiveSheet(null);
                void runAction({ kind: "task.run", botId: activeBot.id, taskId })
                  .then(() => toast("已触发执行"))
                  .catch((e) => toast(e instanceof Error ? e.message : "运行失败"));
              }}
            />
            <SheetAction
              label="编辑任务"
              detail={formatMobileBotSchedule(activeSheet.task)}
              symbol="pencil"
              onPress={() => openTaskEditor(activeSheet.task)}
            />
            {activeSheet.task.status !== "completed" && (
              <SheetAction
                label={activeSheet.task.status === "enabled" ? "暂停任务" : "恢复任务"}
                detail={activeSheet.task.status === "enabled" ? "暂停自动调度" : "恢复自动调度"}
                symbol="clock.fill"
                onPress={() => {
                  const task = activeSheet.task;
                  void runAction({
                    kind: task.status === "enabled" ? "task.pause" : "task.resume",
                    botId: activeBot.id,
                    taskId: task.id,
                  })
                    .then(() => setActiveSheet({ kind: "tasks" }))
                    .catch((e) => toast(e instanceof Error ? e.message : "操作失败"));
                }}
              />
            )}
            <SheetAction
              label="删除任务"
              destructive
              symbol="trash"
              onPress={() => {
                const task = activeSheet.task;
                Alert.alert("删除任务", `确定删除「${task.name}」吗？`, [
                  { text: "取消", style: "cancel" },
                  {
                    text: "删除",
                    style: "destructive",
                    onPress: () =>
                      void runAction({
                        kind: "task.delete",
                        botId: activeBot.id,
                        taskId: task.id,
                      }).then(() => setActiveSheet({ kind: "tasks" })),
                  },
                ]);
              }}
            />
          </>
        )}

        {activeSheet?.kind === "taskEditor" && (
          <View style={styles.sheetStack}>
            <Pressable onPress={() => setActiveSheet({ kind: "tasks" })} style={styles.backRow}>
              <Icon name="chevron.left" size={14} color={palette.accent} />
              <Text style={styles.backRowText}>返回任务列表</Text>
            </Pressable>
            {!activeSheet.editingTaskId && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {TASK_PRESETS.map((preset) => (
                  <Pressable
                    key={preset.id}
                    onPress={() => {
                      setTaskName(preset.title);
                      setTaskPrompt(preset.prompt);
                      setTaskKind(preset.kind);
                      if (preset.rrule) setTaskRrule(preset.rrule);
                    }}
                    style={styles.presetChip}
                  >
                    <Text style={styles.presetChipText}>{preset.title}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            <TextInput
              style={styles.inlineInput}
              value={taskName}
              onChangeText={setTaskName}
              placeholder="任务名称，例如：每日早报"
              placeholderTextColor={palette.textFaint}
            />
            <TextInput
              style={[styles.inlineInput, { minHeight: 72, textAlignVertical: "top" }]}
              value={taskPrompt}
              onChangeText={setTaskPrompt}
              placeholder="指令内容：到点后让 Bot 做什么…"
              placeholderTextColor={palette.textFaint}
              multiline
            />
            <View style={styles.chipRow}>
              {(
                [
                  ["cron", "定时周期"],
                  ["heartbeat", "心跳巡检"],
                  ["one_shot", "一次性提醒"],
                ] as const
              ).map(([k, label]) => (
                <Pressable
                  key={k}
                  onPress={() => setTaskKind(k)}
                  style={[styles.filterChip, taskKind === k && styles.filterChipActive]}
                >
                  <Text style={[styles.filterChipText, taskKind === k && styles.filterChipTextActive]}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            {taskKind === "one_shot" ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {MOBILE_ONESHOT_DELAYS.map((opt) => (
                  <Pressable
                    key={opt.id}
                    onPress={() => setTaskOneShotPreset(opt.id)}
                    style={[styles.filterChip, taskOneShotPreset === opt.id && styles.filterChipActive]}
                  >
                    <Text
                      style={[
                        styles.filterChipText,
                        taskOneShotPreset === opt.id && styles.filterChipTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : (
              <View style={{ gap: 8 }}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                  {MOBILE_SCHEDULE_PRESETS.map((p) => (
                    <Pressable
                      key={p.id}
                      onPress={() => setTaskRrule(p.rrule)}
                      style={[styles.filterChip, taskRrule === p.rrule && styles.filterChipActive]}
                    >
                      <Text
                        style={[
                          styles.filterChipText,
                          taskRrule === p.rrule && styles.filterChipTextActive,
                        ]}
                      >
                        {p.label}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <TextInput
                  style={styles.inlineInput}
                  value={taskRrule}
                  onChangeText={setTaskRrule}
                  placeholder="FREQ=DAILY;BYHOUR=8;BYMINUTE=0"
                  placeholderTextColor={palette.textFaint}
                />
              </View>
            )}
            <View style={styles.chipRow}>
              {(
                [
                  ["primary_thread", "结果写入主对话"],
                  ["new_side_chat", "新建分支话题"],
                ] as const
              ).map(([d, label]) => (
                <Pressable
                  key={d}
                  onPress={() => setTaskDelivery(d)}
                  style={[styles.filterChip, taskDelivery === d && styles.filterChipActive]}
                >
                  <Text style={[styles.filterChipText, taskDelivery === d && styles.filterChipTextActive]}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>完成后在 App 红点提醒</Text>
              <Switch value={taskNotifyApp} onValueChange={setTaskNotifyApp} />
            </View>
            {activeBot?.feishu.enabled && (
              <TextInput
                style={styles.inlineInput}
                value={taskFeishuChatId}
                onChangeText={setTaskFeishuChatId}
                placeholder="可选：同步推送到飞书群聊 ID"
                placeholderTextColor={palette.textFaint}
              />
            )}
            <Pressable
              disabled={taskBusy}
              onPress={() => void handleSaveTask(undefined, activeSheet.editingTaskId)}
              style={styles.primaryBtn}
            >
              <Text style={styles.primaryBtnText}>
                {taskBusy ? "保存中…" : activeSheet.editingTaskId ? "保存修改" : "确认创建"}
              </Text>
            </Pressable>
          </View>
        )}

        {activeSheet?.kind === "memory" && activeBot && (
          <View style={styles.sheetStack}>
            <View style={styles.sheetNavRow}>
              <Pressable onPress={() => setActiveSheet({ kind: "menu" })} style={styles.backRow}>
                <Icon name="chevron.left" size={14} color={palette.accent} />
                <Text style={styles.backRowText}>返回菜单</Text>
              </Pressable>
              <View style={styles.sheetRightGroup}>
                <Pressable onPress={() => void openMarkdownMemory()} style={styles.ghostBtn}>
                  <Text style={styles.ghostBtnText}>高级文档</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setMemContent("");
                    setActiveSheet({ kind: "memoryAdd" });
                  }}
                  style={styles.primaryBtn}
                >
                  <Text style={styles.primaryBtnText}>+ 记住</Text>
                </Pressable>
              </View>
            </View>

            <TextInput
              style={styles.inlineInput}
              value={memQuery}
              onChangeText={setMemQuery}
              placeholder="搜索记忆内容或分类…"
              placeholderTextColor={palette.textFaint}
            />

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              <Pressable
                onPress={() => setMemFilter("all")}
                style={[styles.filterChip, memFilter === "all" && styles.filterChipActive]}
              >
                <Text style={[styles.filterChipText, memFilter === "all" && styles.filterChipTextActive]}>
                  全部 ({activeMemories.length})
                </Text>
              </Pressable>
              {MOBILE_MEMORY_CATEGORIES.map((cat) => (
                <Pressable
                  key={cat.value}
                  onPress={() => setMemFilter(cat.value)}
                  style={[styles.filterChip, memFilter === cat.value && styles.filterChipActive]}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      memFilter === cat.value && styles.filterChipTextActive,
                    ]}
                  >
                    {cat.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            {filteredMemories.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTitle}>暂无匹配的记忆</Text>
                <Text style={styles.emptySub}>点击右上角「+ 记住」添加长期偏好或规则。</Text>
              </View>
            ) : (
              filteredMemories.map((item) => (
                <Pressable
                  key={item.id}
                  onPress={() => setActiveSheet({ kind: "memoryAction", item })}
                  style={({ pressed }) => [styles.card, pressed && styles.pressed]}
                >
                  <View style={styles.cardHead}>
                    <Text style={styles.badgeText}>
                      {mobileMemoryCategoryLabel(item.category)}
                      {item.pinned ? " · 置顶" : ""}
                    </Text>
                  </View>
                  <Text style={styles.cardBody}>{item.content}</Text>
                </Pressable>
              ))
            )}

            {archivedMemories.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardMeta}>最近移除（点击恢复）</Text>
                {archivedMemories.slice(0, 5).map((item) => (
                  <Pressable
                    key={item.id}
                    onPress={() =>
                      void runAction({
                        kind: "memory.item.restore",
                        botId: activeBot.id,
                        itemId: item.id,
                      })
                    }
                    style={styles.archivedRow}
                  >
                    <Text style={styles.archivedText} numberOfLines={1}>
                      {item.content}
                    </Text>
                    <Text style={styles.ghostBtnText}>恢复</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        )}

        {activeSheet?.kind === "memoryAction" && activeBot && (
          <>
            <Pressable onPress={() => setActiveSheet({ kind: "memory" })} style={styles.backRow}>
              <Icon name="chevron.left" size={14} color={palette.accent} />
              <Text style={styles.backRowText}>返回记忆列表</Text>
            </Pressable>
            <SheetAction
              label="编辑记忆"
              detail={activeSheet.item.content}
              symbol="pencil"
              onPress={() => {
                setEditMemCategory(activeSheet.item.category);
                setEditMemContent(activeSheet.item.content);
                setActiveSheet({ kind: "memoryEdit", item: activeSheet.item });
              }}
            />
            <SheetAction
              label={activeSheet.item.pinned ? "取消置顶" : "置顶记忆"}
              detail="置顶记忆会优先带入每次对话"
              symbol={activeSheet.item.pinned ? "pin" : "pin.fill"}
              onPress={() => {
                const item = activeSheet.item;
                void runAction({
                  kind: "memory.item.update",
                  botId: activeBot.id,
                  itemId: item.id,
                  category: null,
                  content: null,
                  pinned: !item.pinned,
                }).then(() => setActiveSheet({ kind: "memory" }));
              }}
            />
            <SheetAction
              label="移除记忆"
              destructive
              symbol="trash"
              onPress={() => {
                const item = activeSheet.item;
                void runAction({
                  kind: "memory.item.delete",
                  botId: activeBot.id,
                  itemId: item.id,
                }).then(() => setActiveSheet({ kind: "memory" }));
              }}
            />
          </>
        )}

        {activeSheet?.kind === "memoryAdd" && (
          <View style={styles.sheetStack}>
            <Pressable onPress={() => setActiveSheet({ kind: "memory" })} style={styles.backRow}>
              <Icon name="chevron.left" size={14} color={palette.accent} />
              <Text style={styles.backRowText}>返回记忆列表</Text>
            </Pressable>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {MOBILE_MEMORY_CATEGORIES.map((cat) => (
                <Pressable
                  key={cat.value}
                  onPress={() => setMemCategory(cat.value)}
                  style={[styles.filterChip, memCategory === cat.value && styles.filterChipActive]}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      memCategory === cat.value && styles.filterChipTextActive,
                    ]}
                  >
                    {cat.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <TextInput
              style={[styles.inlineInput, { minHeight: 84, textAlignVertical: "top" }]}
              value={memContent}
              onChangeText={setMemContent}
              placeholder="例如：回答先给结论，代码保持极简…"
              placeholderTextColor={palette.textFaint}
              multiline
            />
            <Pressable
              disabled={memBusy || !memContent.trim()}
              onPress={() => void handleAddMemory()}
              style={[styles.primaryBtn, (memBusy || !memContent.trim()) && styles.sendBtnDisabled]}
            >
              <Text style={styles.primaryBtnText}>{memBusy ? "保存中…" : "记住"}</Text>
            </Pressable>
          </View>
        )}

        {activeSheet?.kind === "memoryEdit" && (
          <View style={styles.sheetStack}>
            <Pressable onPress={() => setActiveSheet({ kind: "memory" })} style={styles.backRow}>
              <Icon name="chevron.left" size={14} color={palette.accent} />
              <Text style={styles.backRowText}>返回记忆列表</Text>
            </Pressable>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {MOBILE_MEMORY_CATEGORIES.map((cat) => (
                <Pressable
                  key={cat.value}
                  onPress={() => setEditMemCategory(cat.value)}
                  style={[styles.filterChip, editMemCategory === cat.value && styles.filterChipActive]}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      editMemCategory === cat.value && styles.filterChipTextActive,
                    ]}
                  >
                    {cat.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <TextInput
              style={[styles.inlineInput, { minHeight: 84, textAlignVertical: "top" }]}
              value={editMemContent}
              onChangeText={setEditMemContent}
              placeholder="记忆内容…"
              placeholderTextColor={palette.textFaint}
              multiline
            />
            <Pressable
              disabled={editMemBusy || !editMemContent.trim()}
              onPress={() => void handleSaveMemoryEdit(activeSheet.item)}
              style={[styles.primaryBtn, (editMemBusy || !editMemContent.trim()) && styles.sendBtnDisabled]}
            >
              <Text style={styles.primaryBtnText}>{editMemBusy ? "保存中…" : "保存修改"}</Text>
            </Pressable>
          </View>
        )}

        {activeSheet?.kind === "memoryMarkdown" && activeBot && (
          <View style={styles.sheetStack}>
            <Pressable onPress={() => setActiveSheet({ kind: "memory" })} style={styles.backRow}>
              <Icon name="chevron.left" size={14} color={palette.accent} />
              <Text style={styles.backRowText}>返回记忆列表</Text>
            </Pressable>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {(mdEntries.length > 0
                ? mdEntries
                : [{ key: "global", label: "全局记忆", scope: "global", preview: "", hasContent: true, updatedAt: 0 }]
              ).map((entry) => (
                <Pressable
                  key={entry.key}
                  onPress={() => void loadMarkdownEntry(activeBot.id, entry.key)}
                  style={[styles.filterChip, mdSelectedKey === entry.key && styles.filterChipActive]}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      mdSelectedKey === entry.key && styles.filterChipTextActive,
                    ]}
                  >
                    {entry.label || entry.key}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            {mdLoading ? (
              <ActivityIndicator color={palette.accent} style={{ marginVertical: 20 }} />
            ) : (
              <TextInput
                style={[styles.inlineInput, { minHeight: 180, textAlignVertical: "top" }]}
                value={mdContent}
                onChangeText={setMdContent}
                placeholder="# 长期记忆 Markdown…"
                placeholderTextColor={palette.textFaint}
                multiline
              />
            )}
            <View style={styles.sheetNavRow}>
              <Pressable
                disabled={mdSaving || mdLoading}
                onPress={() => void handleSaveMarkdownEntry()}
                style={[styles.primaryBtn, { flex: 1 }]}
              >
                <Text style={styles.primaryBtnText}>{mdSaving ? "保存中…" : "保存文档"}</Text>
              </Pressable>
              {mdSelectedKey !== "global" && (
                <Pressable onPress={handleDeleteMarkdownEntry} style={styles.ghostBtn}>
                  <Text style={[styles.ghostBtnText, { color: palette.danger }]}>删除作用域</Text>
                </Pressable>
              )}
            </View>
          </View>
        )}

        {activeSheet?.kind === "capabilities" && activeBot && (
          <View style={styles.sheetStack}>
            <Pressable onPress={() => setActiveSheet({ kind: "menu" })} style={styles.backRow}>
              <Icon name="chevron.left" size={14} color={palette.accent} />
              <Text style={styles.backRowText}>返回菜单</Text>
            </Pressable>
            <View style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={{ fontSize: 28 }}>{activeBot.avatar}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{activeBot.name}</Text>
                  <Text style={styles.cardMeta}>
                    {activeBot.agent}
                    {activeBot.model ? ` · ${activeBot.model}` : ""}
                  </Text>
                </View>
                <Pressable onPress={() => openBotEditor(activeBot)} style={styles.ghostBtn}>
                  <Text style={styles.ghostBtnText}>编辑</Text>
                </Pressable>
              </View>
              {Boolean(activeBot.description) && (
                <Text style={styles.cardBody}>{activeBot.description}</Text>
              )}
            </View>

            <View style={styles.card}>
              <View style={[styles.switchRow, { borderTopWidth: 0, paddingTop: 0 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.switchLabel}>主动长期记忆</Text>
                  <Text style={styles.cardMeta}>对话自动带入长期记忆卡片</Text>
                </View>
                <Switch
                  value={activeBot.autoMemory}
                  onValueChange={(v) => void toggleCapability("autoMemory", v)}
                />
              </View>
              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.switchLabel}>后台主动提醒</Text>
                  <Text style={styles.cardMeta}>定时任务完成时标红提醒</Text>
                </View>
                <Switch
                  value={activeBot.proactiveNotifications}
                  onValueChange={(v) => void toggleCapability("proactiveNotifications", v)}
                />
              </View>
              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.switchLabel}>多 Bot 协同</Text>
                  <Text style={styles.cardMeta}>允许派发任务给专职子 Bot</Text>
                </View>
                <Switch
                  value={activeBot.allowCrossWorkspace}
                  onValueChange={(v) => void toggleCapability("allowCrossWorkspace", v)}
                />
              </View>
            </View>

            <View style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.switchLabel}>飞书外挂</Text>
                <Text style={styles.badgeText}>
                  {activeBot.feishu.enabled ? "已开启" : "未开启"}
                </Text>
              </View>
              {activeBot.feishu.enabled ? (
                <Pressable
                  onPress={() =>
                    void runAction({ kind: "feishu.reconnect", botId: activeBot.id })
                      .then(() => toast("已触发飞书重连"))
                      .catch((e) => toast(e instanceof Error ? e.message : "重连失败"))
                  }
                  style={styles.ghostBtn}
                >
                  <Text style={styles.ghostBtnText}>重连飞书长连接</Text>
                </Pressable>
              ) : (
                <Text style={styles.cardMeta}>仅作为可选外挂渠道，可在桌面端配置密钥。</Text>
              )}
            </View>

            {activeBot.kind !== "master" && (
              <Pressable onPress={() => handleDeleteBot(activeBot)} style={styles.dangerBtn}>
                <Text style={styles.dangerBtnText}>删除子 Bot</Text>
              </Pressable>
            )}
          </View>
        )}

        {activeSheet?.kind === "botEditor" && (
          <View style={styles.sheetStack}>
            <Pressable
              onPress={() =>
                setActiveSheet(activeSheet.editingBotId ? { kind: "capabilities" } : { kind: "bots" })
              }
              style={styles.backRow}
            >
              <Icon name="chevron.left" size={14} color={palette.accent} />
              <Text style={styles.backRowText}>返回</Text>
            </Pressable>
            {!activeSheet.editingBotId && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {MOBILE_ROLE_PRESETS.map((preset) => (
                  <Pressable
                    key={preset.id}
                    onPress={() => {
                      if (!botName.trim()) setBotName(preset.label);
                      setBotAvatar(preset.avatar);
                      setBotDesc(preset.description);
                      setBotPrompt(preset.systemPrompt);
                      setBotCrossWs(preset.allowCrossWorkspace);
                    }}
                    style={styles.presetChip}
                  >
                    <Text style={styles.presetChipText}>
                      {preset.avatar} {preset.label}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {MOBILE_AVATAR_PRESETS.map((av) => (
                <Pressable
                  key={av}
                  onPress={() => setBotAvatar(av)}
                  style={[styles.filterChip, botAvatar === av && styles.filterChipActive]}
                >
                  <Text style={{ fontSize: 16 }}>{av}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <TextInput
              style={styles.inlineInput}
              value={botName}
              onChangeText={setBotName}
              placeholder="Bot 名称，例如：深度调研助理"
              placeholderTextColor={palette.textFaint}
            />
            <TextInput
              style={styles.inlineInput}
              value={botDesc}
              onChangeText={setBotDesc}
              placeholder="一句话定位说明（可选）"
              placeholderTextColor={palette.textFaint}
            />
            <TextInput
              style={[styles.inlineInput, { minHeight: 84, textAlignVertical: "top" }]}
              value={botPrompt}
              onChangeText={setBotPrompt}
              placeholder="人设与系统提示词…"
              placeholderTextColor={palette.textFaint}
              multiline
            />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {MOBILE_BOT_AGENTS.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => setBotAgent(a.id)}
                  style={[styles.filterChip, botAgent === a.id && styles.filterChipActive]}
                >
                  <Text style={[styles.filterChipText, botAgent === a.id && styles.filterChipTextActive]}>
                    {a.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <TextInput
              style={styles.inlineInput}
              value={botModel}
              onChangeText={setBotModel}
              placeholder="默认模型 ID（留空使用引擎默认）"
              placeholderTextColor={palette.textFaint}
              autoCapitalize="none"
            />
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>允许跨工作区 / 团队协同</Text>
              <Switch value={botCrossWs} onValueChange={setBotCrossWs} />
            </View>
            <Pressable
              disabled={botSaving}
              onPress={() => void handleSaveBot(activeSheet.editingBotId)}
              style={styles.primaryBtn}
            >
              <Text style={styles.primaryBtnText}>
                {botSaving ? "保存中…" : activeSheet.editingBotId ? "保存配置" : "创建 Bot"}
              </Text>
            </Pressable>
          </View>
        )}

        {activeSheet?.kind === "models" && (
          <View style={styles.sheetStack}>
            <Pressable onPress={() => setActiveSheet({ kind: "menu" })} style={styles.backRow}>
              <Icon name="chevron.left" size={14} color={palette.accent} />
              <Text style={styles.backRowText}>返回菜单</Text>
            </Pressable>
            {modelLoading ? (
              <ActivityIndicator color={palette.accent} style={{ marginVertical: 24 }} />
            ) : modelOptions.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptySub}>当前会话未返回可选模型列表，将沿用 Bot 默认引擎配置。</Text>
              </View>
            ) : (
              modelOptions.map((m) => {
                const isSelected = m.id === activeModelId || (!activeModelId && m.isDefault);
                return (
                  <View key={m.id} style={styles.card}>
                    <SheetAction
                      label={`${isSelected ? "✓ " : ""}${m.label}`}
                      detail={m.description || m.id}
                      symbol="command"
                      onPress={() => void handleSelectSessionModel(m, m.defaultEffort)}
                    />
                    {m.supportedEfforts.length > 0 && (
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                        {m.supportedEfforts.map((eff) => {
                          const effActive = isSelected && activeEffort === eff;
                          return (
                            <Pressable
                              key={eff}
                              onPress={() => void handleSelectSessionModel(m, eff)}
                              style={[styles.filterChip, effActive && styles.filterChipActive]}
                            >
                              <Text style={[styles.filterChipText, effActive && styles.filterChipTextActive]}>
                                {eff}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </ScrollView>
                    )}
                  </View>
                );
              })
            )}
          </View>
        )}
      </Sheet>
    </View>
  );
}

const useStyles = createThemedStyles((palette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: palette.bg },
    body: { flex: 1 },
    botTopBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
      backgroundColor: palette.bg,
    },
    botSelector: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 3,
      paddingRight: 8,
    },
    botSelectorAvatar: { fontSize: 15 },
    botSelectorName: { color: palette.text, fontSize: 14, fontWeight: "700", flexShrink: 1 },
    botSelectorThread: { color: palette.textDim, fontSize: 12, flexShrink: 2 },
    iconBtn: {
      width: 30,
      height: 30,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      position: "relative",
    },
    unreadDot: {
      position: "absolute",
      top: 4,
      right: 4,
      width: 6.5,
      height: 6.5,
      borderRadius: 3.5,
      backgroundColor: palette.danger,
      borderWidth: 1.5,
      borderColor: palette.bg,
    },
    pressed: { opacity: 0.72 },
    centerEmpty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 10 },
    emptyTitle: { color: palette.text, fontSize: 16, fontWeight: "700", textAlign: "center" },
    emptySub: { color: palette.textDim, fontSize: 13, textAlign: "center", lineHeight: 19 },
    chatListWrap: { flex: 1 },
    proactiveBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 9,
      backgroundColor: palette.surfaceRaised,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    bannerCopy: { flex: 1, minWidth: 0, gap: 2 },
    bannerTitle: { color: palette.text, fontSize: 13, fontWeight: "700" },
    bannerSub: { color: palette.textDim, fontSize: 12 },
    bannerBtn: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: radius.pill,
      backgroundColor: palette.accent,
    },
    bannerBtnText: { color: palette.onAccent, fontSize: 12, fontWeight: "600" },
    memoryPill: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 7,
      backgroundColor: palette.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    memoryPillText: { flex: 1, color: palette.textDim, fontSize: 12 },
    memoryUndoText: { color: palette.accent, fontSize: 12, fontWeight: "700" },
    heroWrap: { padding: 24, alignItems: "center", gap: 12 },
    heroAvatar: { fontSize: 38 },
    heroTitle: { color: palette.text, fontSize: 19, fontWeight: "700" },
    heroDesc: { color: palette.textDim, fontSize: 13, textAlign: "center" },
    starterGrid: { width: "100%", gap: 8, marginTop: 8 },
    starterCard: {
      paddingHorizontal: 14,
      paddingVertical: 11,
      borderRadius: radius.lg,
      backgroundColor: palette.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    starterText: { color: palette.text, fontSize: 13, fontWeight: "500" },
    composerBox: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
      backgroundColor: palette.surface,
      paddingHorizontal: 10,
      paddingTop: 8,
      gap: 6,
    },
    thumbStrip: { flexGrow: 0 },
    thumbWrap: { marginRight: 8, position: "relative" },
    thumbImg: { width: 52, height: 52, borderRadius: 8 },
    thumbRemove: {
      position: "absolute",
      top: -4,
      right: -4,
      width: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: "rgba(0,0,0,0.7)",
      alignItems: "center",
      justifyContent: "center",
    },
    composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
    iconActionBtn: {
      width: 34,
      height: 36,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    composerInput: {
      flex: 1,
      minHeight: 36,
      maxHeight: 110,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 18,
      backgroundColor: palette.surfaceRaised,
      color: palette.text,
      fontSize: 14,
    },
    sendBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: palette.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    sendBtnDisabled: { opacity: 0.4 },
    sheetStack: { gap: 10, paddingBottom: 14 },
    sheetNavRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
    sheetRightGroup: { flexDirection: "row", alignItems: "center", gap: 10 },
    backRow: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4 },
    backRowText: { color: palette.accent, fontSize: 13, fontWeight: "600" },
    threadActionRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    threadDeleteBtn: {
      paddingHorizontal: 10,
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    primaryBtn: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: radius.pill,
      backgroundColor: palette.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    primaryBtnText: { color: palette.onAccent, fontSize: 13, fontWeight: "700" },
    chipRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    presetGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 4 },
    presetChip: {
      paddingHorizontal: 11,
      paddingVertical: 7,
      borderRadius: radius.pill,
      backgroundColor: palette.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    presetChipText: { color: palette.text, fontSize: 12, fontWeight: "600" },
    filterChip: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    filterChipActive: { backgroundColor: palette.accent, borderColor: palette.accent },
    filterChipText: { color: palette.textDim, fontSize: 12, fontWeight: "500" },
    filterChipTextActive: { color: palette.onAccent, fontWeight: "700" },
    emptyCard: {
      padding: 18,
      borderRadius: radius.lg,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      gap: 6,
      alignItems: "center",
    },
    card: {
      padding: 12,
      borderRadius: radius.lg,
      backgroundColor: palette.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      gap: 6,
    },
    cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    cardTitle: { color: palette.text, fontSize: 14, fontWeight: "700", flex: 1 },
    cardBody: { color: palette.text, fontSize: 13, lineHeight: 19 },
    cardMeta: { color: palette.textDim, fontSize: 12 },
    badgeText: { color: palette.accent, fontSize: 11, fontWeight: "600" },
    summaryText: { color: palette.textDim, fontSize: 12, lineHeight: 17 },
    ghostBtn: { paddingVertical: 4, paddingHorizontal: 6 },
    ghostBtnText: { color: palette.accent, fontSize: 12, fontWeight: "600" },
    inlineInput: {
      minHeight: 38,
      paddingHorizontal: 11,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      color: palette.text,
      fontSize: 13,
    },
    archivedRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    archivedText: { flex: 1, color: palette.textFaint, fontSize: 12 },
    switchRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    switchLabel: { color: palette.text, fontSize: 13, fontWeight: "600" },
    dangerBtn: {
      paddingVertical: 11,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.danger,
      alignItems: "center",
    },
    dangerBtnText: { color: palette.danger, fontSize: 13, fontWeight: "700" },
  }),
);
