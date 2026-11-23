import type {
  BotAction,
  BotActionRequest,
  BotActionResult,
  BotFeishuInput,
  BotFeishuProbeResult,
  BotFeishuRuntimeStatus,
  BotKind,
  BotMemoryEntry,
  BotMemoryScope,
  BotMemoryView,
  BotSourceBinding,
  BotThread,
  BotThreadChannel,
  BotUpsertInput,
  FeishuConnectionState,
  FeishuDomain,
  FeishuGroupTrigger,
  PublicBot,
  PublicBotFeishuConfig,
} from "@prospero/protocol/rust-daemon";

export type {
  BotAction,
  BotActionRequest,
  BotActionResult,
  BotFeishuInput,
  BotFeishuProbeResult,
  BotFeishuRuntimeStatus,
  BotKind,
  BotMemoryEntry,
  BotMemoryScope,
  BotMemoryView,
  BotSourceBinding,
  BotThread,
  BotThreadChannel,
  BotUpsertInput,
  FeishuConnectionState,
  FeishuDomain,
  FeishuGroupTrigger,
  PublicBot,
  PublicBotFeishuConfig,
};

const BOT_ACTION_KINDS = new Set<BotAction["kind"]>([
  "list",
  "create",
  "update",
  "delete",
  "thread.create",
  "thread.adopt",
  "thread.archive",
  "thread.dispatch",
  "feishu.test",
  "feishu.reconnect",
  "memory.read",
  "memory.write",
  "memory.list",
  "memory.entry.read",
  "memory.entry.write",
  "memory.entry.delete",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function botActionRequest(value: unknown, requestId: string): BotActionRequest {
  if (!requestId.trim() || requestId.length > 100) {
    throw new Error("Bot 请求 ID 无效 / Invalid bot request id");
  }
  if (!isRecord(value) || typeof value["kind"] !== "string" || !BOT_ACTION_KINDS.has(value["kind"] as BotAction["kind"])) {
    throw new Error("Bot 请求无效 / Invalid bot request");
  }
  return {
    type: "bot.action",
    requestId,
    action: value as BotAction,
  };
}

export function botActionResult(value: unknown, requestId?: string): BotActionResult {
  if (!isRecord(value)) {
    throw new Error("Bot 响应无效 / Invalid bot response");
  }
  if (value["type"] !== "bot.result" || typeof value["requestId"] !== "string" || typeof value["ok"] !== "boolean") {
    throw new Error("Bot 响应格式无效 / Invalid bot response format");
  }
  if (requestId !== undefined && value["requestId"] !== requestId) {
    throw new Error("Bot 响应请求 ID 不匹配 / Mismatched bot response requestId");
  }
  if ((value["ok"] && value["error"]) || (!value["ok"] && !value["error"])) {
    throw new Error("Bot 响应状态无效 / Invalid bot result status");
  }
  return value as unknown as BotActionResult;
}

export function isManagedBotWorkspacePath(value: string | null | undefined): boolean {
  if (!value) return false;
  return /(?:^|[\\/])bots[\\/](?:master|bot-[a-z0-9_-]+)[\\/]workspace(?:[\\/]|$)/i.test(value.trim());
}
