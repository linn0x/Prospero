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
