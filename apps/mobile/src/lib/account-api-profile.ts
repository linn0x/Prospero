import type { AgentApiProtocol, AgentApiProvider, CodeAgentKind } from "@prospero/protocol";

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
