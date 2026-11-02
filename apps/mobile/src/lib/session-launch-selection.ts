import { getAgentAccountCapabilities, getAgentAccountEngine, type AgentAccount, type SessionKind } from "@prospero/protocol";

export function selectLaunchAccount(account: AgentAccount, preferredKind: SessionKind) {
  const capabilities = getAgentAccountCapabilities(account);
  return {
    agent: getAgentAccountEngine(account),
    kind: capabilities.sessionKinds.includes(preferredKind) ? preferredKind : capabilities.sessionKinds[0] ?? preferredKind,
  };
}
