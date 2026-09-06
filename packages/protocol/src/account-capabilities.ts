import type { AgentAccount, AgentAccountCapabilities, AgentExecutionEngine } from "./schemas.js";

type AccountMetadata = Pick<AgentAccount, "agent" | "apiProfile" | "apiProfileError" | "engine" | "capabilities">;

/** Old daemons omit metadata; derive their existing restrictions consistently across clients. */
export function getAgentAccountEngine(account: AccountMetadata): AgentExecutionEngine {
  return account.engine ?? (account.apiProfile?.protocol === "openai_chat_completions" ? "opencode" : account.agent);
}

export function getAgentAccountCapabilities(account: AccountMetadata): AgentAccountCapabilities {
  if (account.apiProfileError || account.apiProfile?.modelCapabilities?.tools === false) {
    return { sessionKinds: [], plan: false, resume: false, modelSelection: false, reasoningEffort: false };
  }
  if (account.capabilities) return account.capabilities;
  const engine = getAgentAccountEngine(account);
  return {
    sessionKinds: engine === "opencode" ? ["structured"] : ["pty", "structured"],
    plan: engine !== "opencode",
    resume: engine !== "opencode",
    modelSelection: !account.apiProfile,
    reasoningEffort: !account.apiProfile,
  };
}
