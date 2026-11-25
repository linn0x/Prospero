import type {
  AgentKind,
  BotMemoryCategory,
  BotMemoryItem,
  BotTask,
  BotUpsertInput,
  PublicBot,
  SessionStatus,
} from "@prospero/protocol";

export function mobileBotWorkingStatus(
  status: SessionStatus | undefined,
): SessionStatus | undefined {
  if (
    status === "running" ||
    status === "starting" ||
    status === "waiting_approval" ||
    status === "waiting_input"
  ) {
    return status;
  }
  return undefined;
}

export const MOBILE_BOT_AGENTS: readonly { id: AgentKind; label: string }[] = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "agy", label: "Antigravity (AGY)" },
  { id: "deepseek", label: "DeepSeek Harness" },
  { id: "pi", label: "Pi" },
  { id: "opencode", label: "OpenCode" },
];

export const MOBILE_AVATAR_PRESETS = ["⚡", "🤖", "🔍", "🛠️", "📊", "💬", "🧠", "🚀"] as const;

export const MOBILE_ROLE_PRESETS: readonly {
  id: string;
  label: string;
  avatar: string;
  description: string;
  systemPrompt: string;
  allowCrossWorkspace: boolean;
}[] = [
  {
    id: "research",
    label: "深度调研",
    avatar: "🔍",
    description: "信息搜集、技术对比与结构化简报",
    systemPrompt:
      "你是一位严谨的研究分析助理。回答先给核心结论与行动建议，再附关键依据、边界条件与风险提示。",
    allowCrossWorkspace: false,
  },
  {
    id: "advisor",
    label: "思考幕僚",
    avatar: "🧠",
    description: "方案推演、写作润色、复杂问题拆解与决策分析",
    systemPrompt:
      "你是一位敏锐的思考幕僚与写作搭档，擅长拆解复杂问题、权衡利弊并给出清晰可执行的建议。",
    allowCrossWorkspace: true,
  },
  {
    id: "feishu-assistant",
    label: "飞书助理",
    avatar: "💬",
    description: "面向飞书私聊与群聊的轻量高效个人助理",
    systemPrompt:
      "你通过飞书 IM 为用户提供日常协助。回复精炼清晰、善用 Markdown 列表与要点，主动将重要偏好记录到长期记忆。",
    allowCrossWorkspace: false,
  },
];

export type MobileOneShotDelayId = "15m" | "1h" | "3h" | "tomorrow_9am";

export const MOBILE_ONESHOT_DELAYS: readonly {
  id: MobileOneShotDelayId;
  label: string;
}[] = [
  { id: "15m", label: "15 分钟后" },
  { id: "1h", label: "1 小时后" },
  { id: "3h", label: "3 小时后" },
  { id: "tomorrow_9am", label: "明天 09:00" },
];

export function computeOneShotTimestamp(
  preset: MobileOneShotDelayId,
  now = Date.now(),
): number {
  if (preset === "15m") return now + 15 * 60_000;
  if (preset === "1h") return now + 60 * 60_000;
  if (preset === "3h") return now + 3 * 60 * 60_000;
  const target = new Date(now);
  target.setDate(target.getDate() + 1);
  target.setHours(9, 0, 0, 0);
  return target.getTime();
}

export const MOBILE_SCHEDULE_PRESETS: readonly {
  id: string;
  label: string;
  rrule: string;
}[] = [
  { id: "daily8", label: "每天 08:00", rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0" },
  { id: "hourly", label: "每小时", rrule: "FREQ=HOURLY;INTERVAL=1" },
  { id: "weekly1", label: "每周一 09:00", rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0" },
];

export const MOBILE_MEMORY_CATEGORIES: readonly {
  value: BotMemoryCategory;
  label: string;
}[] = [
  { value: "profile", label: "个人画像" },
  { value: "preference", label: "偏好设置" },
  { value: "habit", label: "日常习惯" },
  { value: "project", label: "长期项目" },
  { value: "rule", label: "行为规则" },
  { value: "fact", label: "重要事实" },
];

export function mobileMemoryCategoryLabel(category: BotMemoryCategory): string {
  return MOBILE_MEMORY_CATEGORIES.find((item) => item.value === category)?.label ?? category;
}

export function formatMobileBotSchedule(
  task: Pick<BotTask, "kind" | "rrule" | "runAt">,
): string {
  if (task.kind === "one_shot") {
    if (!task.runAt) return "一次性提醒";
    const d = new Date(task.runAt);
    if (Number.isNaN(d.getTime())) return "一次性提醒";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `一次性 · ${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const raw = (task.rrule ?? "").trim().toUpperCase();
  if (!raw) return "周期任务";
  const parts = Object.fromEntries(
    raw
      .split(";")
      .map((s) => s.split("=", 2))
      .filter((p): p is [string, string] => p.length === 2),
  );
  const freq = parts["FREQ"];
  const interval = Math.max(1, Number.parseInt(parts["INTERVAL"] ?? "1", 10) || 1);
  const hour = parts["BYHOUR"] !== undefined ? parts["BYHOUR"].padStart(2, "0") : undefined;
  const minute = parts["BYMINUTE"] !== undefined ? parts["BYMINUTE"].padStart(2, "0") : "00";
  const timeSuffix = hour !== undefined ? ` ${hour}:${minute}` : "";
  if (freq === "DAILY") {
    return interval === 1 ? `每天${timeSuffix}` : `每 ${interval} 天${timeSuffix}`;
  }
  if (freq === "HOURLY") {
    return interval === 1 ? "每小时" : `每 ${interval} 小时`;
  }
  if (freq === "MINUTELY") {
    return `每 ${interval} 分钟`;
  }
  if (freq === "WEEKLY") {
    const days = parts["BYDAY"] ? ` (${parts["BYDAY"]})` : "";
    return interval === 1 ? `每周${days}${timeSuffix}` : `每 ${interval} 周${days}${timeSuffix}`;
  }
  return raw;
}

export function splitMobileMemoryItems(items: readonly BotMemoryItem[]): {
  active: BotMemoryItem[];
  archived: BotMemoryItem[];
} {
  const active: BotMemoryItem[] = [];
  const archived: BotMemoryItem[] = [];
  for (const item of items) {
    if (item.archived) archived.push(item);
    else active.push(item);
  }
  return { active, archived };
}

export function filterMobileMemoryItems(
  items: readonly BotMemoryItem[],
  filter: "all" | BotMemoryCategory,
  query: string,
): BotMemoryItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((item) => {
    if (filter !== "all" && item.category !== filter) return false;
    if (!q) return true;
    const catLabel = mobileMemoryCategoryLabel(item.category).toLowerCase();
    return (
      item.content.toLowerCase().includes(q) ||
      item.scope.toLowerCase().includes(q) ||
      catLabel.includes(q)
    );
  });
}

export function buildMobileBotCreateInput(draft: {
  name: string;
  avatar: string;
  description: string;
  systemPrompt: string;
  agent: AgentKind;
  model?: string | null;
  allowCrossWorkspace?: boolean;
}): BotUpsertInput {
  return {
    name: draft.name.trim(),
    avatar: draft.avatar.trim() || "🤖",
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    agent: draft.agent,
    accountId: null,
    model: draft.model?.trim() || null,
    effort: null,
    sourceBinding: null,
    customWorkspace: null,
    allowCrossWorkspace: Boolean(draft.allowCrossWorkspace),
    autoMemory: true,
    proactiveNotifications: true,
    feishu: {
      enabled: false,
      domain: "feishu",
      appId: "",
      appSecret: null,
      groupTrigger: "mention",
      streamingCard: true,
      accessPolicy: "everyone",
      adminUsers: [],
    },
  };
}

export function buildMobileBotUpdateInput(
  bot: PublicBot,
  overrides: Partial<
    Pick<
      BotUpsertInput,
      | "name"
      | "avatar"
      | "description"
      | "systemPrompt"
      | "agent"
      | "model"
      | "effort"
      | "allowCrossWorkspace"
      | "autoMemory"
      | "proactiveNotifications"
    >
  >,
): BotUpsertInput {
  return {
    name: overrides.name ?? bot.name,
    avatar: overrides.avatar ?? bot.avatar,
    description: overrides.description ?? bot.description,
    systemPrompt: overrides.systemPrompt ?? bot.systemPrompt,
    agent: overrides.agent ?? bot.agent,
    accountId: bot.accountId ?? null,
    model: overrides.model !== undefined ? overrides.model : (bot.model ?? null),
    effort: overrides.effort !== undefined ? overrides.effort : (bot.effort ?? null),
    sourceBinding: bot.sourceBinding ?? null,
    customWorkspace: bot.customWorkspace ?? null,
    allowCrossWorkspace: overrides.allowCrossWorkspace ?? bot.allowCrossWorkspace,
    autoMemory: overrides.autoMemory ?? bot.autoMemory,
    proactiveNotifications: overrides.proactiveNotifications ?? bot.proactiveNotifications,
    feishu: {
      enabled: bot.feishu.enabled,
      domain: bot.feishu.domain,
      appId: bot.feishu.appId,
      appSecret: null,
      groupTrigger: bot.feishu.groupTrigger,
      streamingCard: bot.feishu.streamingCard,
      accessPolicy: bot.feishu.accessPolicy,
      adminUsers: bot.feishu.adminUsers,
    },
  };
}
