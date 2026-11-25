import type {
  BotMemoryCategory,
  BotMemoryItem,
  BotTask,
  BotUpsertInput,
  PublicBot,
} from "../../../shared/types";

export const MEMORY_CATEGORY_OPTIONS: ReadonlyArray<{
  value: BotMemoryCategory;
  zh: string;
  en: string;
}> = [
  { value: "profile", zh: "个人画像", en: "Profile" },
  { value: "preference", zh: "偏好设置", en: "Preference" },
  { value: "habit", zh: "日常习惯", en: "Habit" },
  { value: "project", zh: "长期项目", en: "Project" },
  { value: "rule", zh: "行为规则", en: "Rule" },
  { value: "fact", zh: "重要事实", en: "Fact" },
];

export function memoryCategoryLabel(
  category: BotMemoryCategory,
  t: (zh: string, en: string) => string,
): string {
  const found = MEMORY_CATEGORY_OPTIONS.find((item) => item.value === category);
  return found ? t(found.zh, found.en) : category;
}

export function formatBotScheduleSummary(
  task: Pick<BotTask, "kind" | "rrule" | "runAt">,
  t: (zh: string, en: string) => string,
): string {
  if (task.kind === "one_shot") {
    if (!task.runAt) return t("一次性提醒", "One-time reminder");
    const date = new Date(task.runAt);
    if (Number.isNaN(date.getTime())) return t("一次性提醒", "One-time reminder");
    const pad = (n: number) => String(n).padStart(2, "0");
    return t(
      `一次性 · ${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
      `Once · ${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    );
  }
  const raw = (task.rrule ?? "").trim().toUpperCase();
  if (!raw) return t("周期调度", "Recurring");
  const parts = Object.fromEntries(
    raw
      .split(";")
      .map((seg) => seg.split("=", 2))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
  const freq = parts["FREQ"];
  const interval = Math.max(1, Number.parseInt(parts["INTERVAL"] ?? "1", 10) || 1);
  const hour = parts["BYHOUR"] !== undefined ? parts["BYHOUR"].padStart(2, "0") : undefined;
  const minute = parts["BYMINUTE"] !== undefined ? parts["BYMINUTE"].padStart(2, "0") : "00";
  const timeSuffix = hour !== undefined ? ` ${hour}:${minute}` : "";
  if (freq === "DAILY") {
    return interval === 1
      ? t(`每天${timeSuffix}`, `Daily${timeSuffix}`)
      : t(`每 ${interval} 天${timeSuffix}`, `Every ${interval} days${timeSuffix}`);
  }
  if (freq === "HOURLY") {
    return interval === 1
      ? t("每小时", "Every hour")
      : t(`每 ${interval} 小时`, `Every ${interval} hours`);
  }
  if (freq === "MINUTELY") {
    return t(`每 ${interval} 分钟`, `Every ${interval} min`);
  }
  if (freq === "WEEKLY") {
    const days = parts["BYDAY"] ? ` (${parts["BYDAY"]})` : "";
    return interval === 1
      ? t(`每周${days}${timeSuffix}`, `Weekly${days}${timeSuffix}`)
      : t(`每 ${interval} 周${days}${timeSuffix}`, `Every ${interval}w${days}${timeSuffix}`);
  }
  return raw;
}

export function formatNextRunRelative(
  ts: number | null | undefined,
  t: (zh: string, en: string) => string,
): string {
  if (!ts || !Number.isFinite(ts)) return t("未排期", "Unscheduled");
  const deltaMin = Math.round((ts - Date.now()) / 60_000);
  if (deltaMin <= 0) return t("即将执行", "Due now");
  if (deltaMin < 60) return t(`${deltaMin} 分钟后`, `In ${deltaMin}m`);
  const hours = Math.floor(deltaMin / 60);
  if (hours < 24) return t(`${hours} 小时后`, `In ${hours}h`);
  const days = Math.floor(hours / 24);
  return t(`${days} 天后`, `In ${days}d`);
}

export function splitMemoryItems(items: readonly BotMemoryItem[]): {
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

export function buildBotUpdateInput(
  bot: PublicBot,
  overrides: Partial<Pick<BotUpsertInput, "autoMemory" | "proactiveNotifications" | "allowCrossWorkspace">>,
): BotUpsertInput {
  return {
    name: bot.name,
    avatar: bot.avatar,
    description: bot.description,
    systemPrompt: bot.systemPrompt,
    agent: bot.agent,
    accountId: bot.accountId ?? null,
    model: bot.model ?? null,
    effort: bot.effort ?? null,
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
