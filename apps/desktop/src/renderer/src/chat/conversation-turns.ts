import type { JsonObject } from "../../../shared/types";
import { hasChatResolution, type ChatTimelineItem } from "../chat-events";
import { array, record, text } from "../state";

/** Keep each native turn together, including steering messages and its own results. */
export function conversationTurns(items: readonly ChatTimelineItem[], resolutions: ReadonlySet<string>): ChatTimelineItem[] {
  const result: ChatTimelineItem[] = [];
  let turn: ChatTimelineItem[] = [];
  const flush = (end?: ChatTimelineItem): void => {
    const first = turn[0] ?? end;
    if (!first) return;
    const answers = turn.filter(item => item.event.kind === "assistant.text");
    const final = answers.findLast(item => item.event.phase === "final_answer")
      ?? (end ? answers.findLast(item => item.event.phase !== "commentary" && item.event.msgId === end.event.msgId)
        ?? answers.findLast(item => item.event.phase !== "commentary") : undefined);
    const users: JsonObject[] = [], activity: JsonObject[] = [], outcomes: JsonObject[] = [];
    for (const item of turn) {
      const event: JsonObject = { ...item.event, displayKey: item.key };
      const kind = text(event.kind);
      if (kind === "user.message") users.push(event);
      else if (item === final || kind === "agent.error"
        || kind === "tool.end" && ["error", "failed"].includes(text(event.state))
        || kind === "permission.request" && !hasChatResolution(resolutions, "permission.resolved", text(event.reqId))
        || kind === "question.request" && !hasChatResolution(resolutions, "question.resolved", text(event.reqId))
        || kind.startsWith("subagent.") && ["running", "starting", "waiting_input", "failed"].includes(text(record(event.subagent).status, text(event.status)))) outcomes.push(event);
      else activity.push(event);
    }
    // The turn-level patch is authoritative, including an explicitly empty diff.
    // Permission previews are proposals and must never be counted as applied edits.
    const diffs = new Map<string, JsonObject>();
    const changes = Array.isArray(end?.event.diffs) ? array(end.event.diffs).map(record)
      : turn.filter(item => item.event.kind === "tool.end" && ["success", "completed"].includes(text(item.event.state, "success")))
        .map(item => record(item.event.diff));
    for (const diff of changes) if (text(diff.path)) diffs.set(text(diff.path), diff);
    result.push({ key: `turn:${first.key}`, ordinal: first.ordinal, event: {
      kind: "conversation.turn", text: text(users[0]?.text), users, activity, outcomes,
      completed: Boolean(end), finish: text(end?.event.finish), diffs: [...diffs.values()],
      finalText: text(final?.event.text), outputTokens: end?.event.outputTokens ?? 0,
    } });
    turn = [];
  };
  for (const item of items) {
    if (item.event.kind === "turn.end") flush(item);
    else turn.push(item);
  }
  flush();
  return result;
}
