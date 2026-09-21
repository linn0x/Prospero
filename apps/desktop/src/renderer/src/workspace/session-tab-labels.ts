import type { SessionInfo } from "../../../shared/types";

/** Keep the distinguishing part of generated titles; the icon already identifies the agent. */
export function sessionTabName(session: SessionInfo): string {
  if (session.displayTitle?.trim()) return session.displayTitle.trim();
  const title = (session.displayTitle || session.title || session.preview || "").trim();
  const agent = session.agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const name = title.replace(new RegExp(`^${agent}(?:\\s+Code)?(?:\\s*[·:—]\\s*|$)`, "i"), "").trim();
  return name || session.cwd.split(/[\\/]/).filter(Boolean).at(-1) || title || session.agent;
}

export function sessionTabLabels(sessions: SessionInfo[]): Map<string, string> {
  const groups = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const name = sessionTabName(session);
    groups.set(name, [...(groups.get(name) || []), session]);
  }
  const labels = new Map<string, string>();
  for (const [name, group] of groups) {
    group.sort((a, b) => a.id.localeCompare(b.id));
    group.forEach((session, index) => labels.set(session.id, group.length > 1 ? `${name} · ${index + 1}` : name));
  }
  return labels;
}
