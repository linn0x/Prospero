import type { JsonObject, SessionInfo } from "../../shared/types";

export type AccountApiProtocol =
  | "openai_chat_completions"
  | "openai_responses"
  | "anthropic";

export type AccountApiProvider = "openai_compatible" | "anthropic_compatible";

export type AccountApiDefaults = {
  agent: "codex" | "claude" | "opencode";
  baseUrl: string;
  model: string;
};

export const accountApiProtocols: AccountApiProtocol[] = [
  "openai_responses",
  "openai_chat_completions",
  "anthropic",
];

export const ACCOUNT_API_PROTOCOLS_CAPABILITY = "agent.api-protocols.v1";

export function supportsAccountApiValidation(capabilities?: readonly string[]): boolean {
  return capabilities?.includes("agent.api-validation.v1") === true;
}

export function accountApiStatus(account: JsonObject, english = false): string {
  if (account["apiProfileError"]) return english ? "Profile needs repair" : "配置需要修复";
  if (account["status"] === "signed_out") return english ? "API key missing" : "未配置密钥";
  if (account["status"] === "unavailable") return english ? "Runtime unavailable" : "运行环境不可用";
  const validation = account["apiValidation"] as JsonObject | undefined;
  if (validation?.["status"] === "passed") return english ? "API checks passed" : "API 检查通过";
  if (validation?.["status"] === "failed") return english ? "API checks failed" : "API 检查失败";
  return english ? "Configured · unverified" : "已配置 · 未验证";
}

export type ModelCapabilityDraft = {
  contextWindow: string;
  maxOutputTokens: string;
  tools: "unknown" | "true" | "false";
  vision: "unknown" | "true" | "false";
  reasoning: "unknown" | "true" | "false";
};

export function modelCapabilityDraft(value: JsonObject = {}): ModelCapabilityDraft {
  const bool = (key: string): "unknown" | "true" | "false" => typeof value[key] === "boolean" ? value[key] ? "true" : "false" : "unknown";
  return {
    contextWindow: typeof value["contextWindow"] === "number" ? String(value["contextWindow"]) : "",
    maxOutputTokens: typeof value["maxOutputTokens"] === "number" ? String(value["maxOutputTokens"]) : "",
    tools: bool("tools"), vision: bool("vision"), reasoning: bool("reasoning"),
  };
}

/** Preserve fields introduced by newer daemons when editing known model settings. */
export function parseModelCapabilities(draft: ModelCapabilityDraft, initial: JsonObject = {}, protocol?: AccountApiProtocol): JsonObject | null {
  const value = { ...initial };
  for (const key of ["contextWindow", "maxOutputTokens"] as const) {
    const raw = draft[key].trim();
    if (!raw) delete value[key];
    else {
      const parsed = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Token limits must be positive whole numbers / Token 上限必须是正整数");
      value[key] = parsed;
    }
  }
  if (protocol === "openai_chat_completions" && (value["contextWindow"] === undefined) !== (value["maxOutputTokens"] === undefined)) {
    throw new Error("Chat Completions requires both token limits or neither / Chat Completions 的两个 Token 上限须同时填写或同时留空");
  }
  if (typeof value["contextWindow"] === "number" && typeof value["maxOutputTokens"] === "number" && value["maxOutputTokens"] > value["contextWindow"]) {
    throw new Error("Output limit cannot exceed the context window / 输出上限不能大于上下文窗口");
  }
  for (const key of ["tools", "vision", "reasoning"] as const) {
    if (draft[key] === "unknown") delete value[key];
    else value[key] = draft[key] === "true";
  }
  return Object.keys(value).length ? value : null;
}

export function supportsAccountApiProtocols(capabilities?: readonly string[]): boolean {
  return capabilities?.includes(ACCOUNT_API_PROTOCOLS_CAPABILITY) === true;
}

export function accountApiConnectionLocked(account: JsonObject): boolean {
  const activeSessions = account["activeSessions"];
  return typeof activeSessions === "number" && Number.isFinite(activeSessions) && activeSessions > 0;
}

export function accountApiProfileNameAction(
  accountId: string,
  name: string,
  apiProtocolsSupported: boolean,
): JsonObject {
  return {
    type: apiProtocolsSupported ? "agent.account.api.configure" : "agent.account.rename",
    accountId,
    name,
  };
}

export function selectCreatedAccount(
  accounts: JsonObject[],
  accountId: string,
  name: string,
  agent: string,
  existingIds: ReadonlySet<string>,
): JsonObject | undefined {
  if (accountId) return accounts.find((account) => account["id"] === accountId);
  return accounts.findLast((account) =>
    account["name"] === name && account["agent"] === agent &&
    typeof account["id"] === "string" && !existingIds.has(account["id"])
  ) ?? accounts.findLast((account) => account["name"] === name && account["agent"] === agent);
}

export function accountApiProtocolDefaults(protocol: AccountApiProtocol): AccountApiDefaults {
  if (protocol === "anthropic") {
    return {
      agent: "claude",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
    };
  }
  return {
    agent: "codex",
    baseUrl: "https://api.openai.com/v1",
    model: protocol === "openai_responses" ? "gpt-5" : "gpt-4.1",
  };
}

export function accountApiProvider(protocol: AccountApiProtocol): AccountApiProvider {
  return protocol === "anthropic" ? "anthropic_compatible" : "openai_compatible";
}

export function accountApiProtocolsForAgent(agent: string): AccountApiProtocol[] {
  if (agent === "claude") return ["anthropic"];
  if (agent === "opencode") return ["openai_chat_completions"];
  return ["openai_responses", "openai_chat_completions"];
}

export function accountApiProtocolFromProfile(profile: JsonObject, agent: string): AccountApiProtocol {
  const protocol = profile["protocol"];
  if (accountApiProtocols.includes(protocol as AccountApiProtocol)) return protocol as AccountApiProtocol;
  if (profile["provider"] === "anthropic_compatible" || agent === "claude") return "anthropic";
  if (agent === "opencode") return "openai_chat_completions";
  return "openai_responses";
}

export function accountApiProtocolLabel(protocol: AccountApiProtocol): string {
  if (protocol === "openai_chat_completions") return "OpenAI Chat Completions";
  if (protocol === "openai_responses") return "OpenAI Responses";
  return "Anthropic Messages";
}

export function accountApiEngineLabel(protocol: AccountApiProtocol): string {
  if (protocol === "openai_chat_completions") return "OpenCode";
  if (protocol === "openai_responses") return "Codex";
  return "Claude";
}

export function provisionalAccountLoginSession(
  account: JsonObject,
  sessionId: string,
  createdAt = Date.now(),
): SessionInfo {
  const agent = typeof account["agent"] === "string" ? account["agent"] : "shell";
  const name = typeof account["name"] === "string" && account["name"].trim()
    ? account["name"].trim()
    : agent;
  return {
    id: sessionId,
    agent,
    kind: "pty",
    title: name,
    cwd: "",
    status: "starting",
    createdAt,
    ...(typeof account["id"] === "string" && account["id"] ? { accountId: account["id"] } : {}),
    accountName: name,
  };
}
