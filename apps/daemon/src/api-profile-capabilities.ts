import type { AgentApiProfile, AgentModelCapabilitySupport } from "@prospero/protocol";

/** This reports local application of declarations, not upstream model certification. */
export function getModelCapabilitySupport(profile: AgentApiProfile): AgentModelCapabilitySupport {
  const caps = profile.modelCapabilities;
  if (!caps) return {};
  const protocol = profile.protocol ?? (profile.provider === "anthropic_compatible" ? "anthropic" : "openai_responses");
  const support: AgentModelCapabilitySupport = {};
  if (caps.contextWindow !== undefined) {
    // Claude's override only applies reliably to unknown gateway IDs. Recognized
    // Claude families would require disabling compaction, which we do not do.
    const claudeNativeWindow = protocol === "anthropic" && /claude-|opus|sonnet|haiku|fable|\[1m\]/i.test(profile.model);
    support.contextWindow = claudeNativeWindow ? "unsupported" : "enforced";
  }
  // OpenCode's native runtime (verified with 1.18.29) consumes limit.output as
  // model metadata but omits a generation cap; overriding max_tokens is rejected.
  if (caps.maxOutputTokens !== undefined) support.maxOutputTokens = protocol === "anthropic" ? "enforced" : "unsupported";
  if (caps.tools !== undefined) support.tools = "enforced";
  // Structured sessions reject disabled images before saving or queuing them.
  // Claude has a native image input; OpenCode currently uses file references.
  if (caps.vision !== undefined) support.vision = caps.vision === false || protocol === "anthropic" ? "enforced" : "unsupported";
  if (caps.reasoning !== undefined) {
    // Codex can suppress summaries but still sends an empty reasoning object
    // (observed with 0.153.0), so a strict non-reasoning gateway may reject it.
    support.reasoning = (protocol === "anthropic" && caps.reasoning) || (protocol === "openai_responses" && !caps.reasoning)
      ? "unsupported" : "enforced";
  }
  return support;
}

export function codexModelCapabilityArgs(profile: AgentApiProfile): string[] {
  const caps = profile.modelCapabilities;
  return [
    ...(caps?.contextWindow !== undefined ? ["-c", `model_context_window=${String(caps.contextWindow)}`] : []),
    ...(caps?.reasoning !== undefined ? ["-c", `model_supports_reasoning_summaries=${String(caps.reasoning)}`] : []),
    ...(caps?.reasoning === false ? ["-c", 'model_reasoning_summary="none"'] : []),
  ];
}

export function claudeModelCapabilityEnvironment(profile: AgentApiProfile): Record<string, string> {
  const caps = profile.modelCapabilities;
  return {
    // Blank inherited global overrides when the profile leaves a value unspecified.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: caps?.contextWindow === undefined ? "" : String(caps.contextWindow),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: caps?.maxOutputTokens === undefined ? "" : String(caps.maxOutputTokens),
    MAX_THINKING_TOKENS: caps?.reasoning === false ? "0" : "",
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "",
    DISABLE_COMPACT: "",
  };
}
