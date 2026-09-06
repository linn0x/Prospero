import type { AgentAccount, AgentApiProtocol, AgentApiProvider, AgentModelCapabilities, CodeAgentKind } from "@prospero/protocol";

export interface AccountApiDefaults {
  baseUrl: string;
  model: string;
}

export const accountApiProtocols: AgentApiProtocol[] = [
  "openai_responses",
  "openai_chat_completions",
  "anthropic",
];

export function accountApiProtocolLabel(protocol: AgentApiProtocol): string {
  if (protocol === "openai_responses") return "OpenAI Responses（Codex）";
  if (protocol === "openai_chat_completions") return "OpenAI Chat Completions（OpenCode）";
  return "Anthropic Messages（Claude）";
}

export function accountApiProviderForProtocol(protocol: AgentApiProtocol): AgentApiProvider {
  return protocol === "anthropic" ? "anthropic_compatible" : "openai_compatible";
}

export function accountApiProtocolDefaults(protocol: AgentApiProtocol): AccountApiDefaults {
  if (protocol === "anthropic") {
    return { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" };
  }
  return {
    baseUrl: "https://api.openai.com/v1",
    model: protocol === "openai_responses" ? "gpt-5" : "gpt-4.1",
  };
}

export function accountApiProtocolForAgent(agent: CodeAgentKind): AgentApiProtocol {
  return agent === "claude" ? "anthropic" : "openai_responses";
}

export function accountApiProtocolsForAgent(
  agent: CodeAgentKind,
  supportsProtocols: boolean,
): AgentApiProtocol[] {
  if (!supportsProtocols) return [accountApiProtocolForAgent(agent)];
  return agent === "claude"
    ? ["anthropic"]
    : ["openai_responses", "openai_chat_completions"];
}

export function accountApiProtocolFromProfile(
  agent: CodeAgentKind,
  protocol: string | undefined,
): AgentApiProtocol {
  return accountApiProtocols.includes(protocol as AgentApiProtocol)
    ? protocol as AgentApiProtocol
    : accountApiProtocolForAgent(agent);
}

export function accountApiProfileRequiresStructured(
  agent: CodeAgentKind,
  protocol: string | undefined,
): boolean {
  return accountApiProtocolFromProfile(agent, protocol) === "openai_chat_completions";
}

export function accountApiStatus(account: Pick<AgentAccount, "status" | "apiProfileError" | "apiValidation">): string {
  if (account.apiProfileError) return "配置需要修复";
  if (account.status === "signed_out") return "未配置密钥";
  if (account.status === "unavailable") return "运行环境不可用";
  if (account.apiValidation?.status === "passed") return "API 检查通过";
  if (account.apiValidation?.status === "failed") return "API 检查失败";
  return "已配置 · 未验证";
}

export function modelTokenLimit(value: string): number | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Token 上限必须是正整数；未知可留空");
  return parsed;
}

export function updateModelTokenLimit(initial: AgentModelCapabilities | undefined, key: "contextWindow" | "maxOutputTokens", raw: string): AgentModelCapabilities {
  const result = { ...initial };
  const parsed = modelTokenLimit(raw);
  if (parsed === undefined) delete result[key];
  else result[key] = parsed;
  return result;
}
