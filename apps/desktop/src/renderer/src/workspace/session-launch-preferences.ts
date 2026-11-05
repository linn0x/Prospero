import type { SessionCreateInput } from "../../../shared/types";

const key = "prospero.session.launch-preferences";
const agents: SessionCreateInput["agent"][] = ["codex", "claude", "agy", "deepseek", "opencode", "pi", "grok", "trae", "shell"];

function preferences(): { agent?: SessionCreateInput["agent"]; kinds?: Record<string, unknown> } {
  try { return JSON.parse(localStorage.getItem(key) ?? "{}") ?? {}; } catch { return {}; }
}

export function rememberedLaunchAgent(): SessionCreateInput["agent"] {
  const agent = preferences().agent;
  return agent && agents.includes(agent) ? agent : "codex";
}

export function rememberedLaunchKind(agent: SessionCreateInput["agent"]): SessionCreateInput["kind"] {
  if (agent === "deepseek") return "structured";
  if (!["codex", "claude", "agy", "opencode", "pi"].includes(agent)) return "pty";
  const kind = preferences().kinds?.[agent];
  return kind === "pty" || kind === "structured" ? kind : agent === "opencode" ? "pty" : "structured";
}

export function rememberLaunch(agent: SessionCreateInput["agent"], kind: SessionCreateInput["kind"]): void {
  try { localStorage.setItem(key, JSON.stringify({ agent, kinds: { ...preferences().kinds, [agent]: kind } })); } catch {}
}
