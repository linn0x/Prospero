import type { JsonObject } from "../../../shared/types";
import { hasChatResolution, type ChatTimelineItem } from "../chat-events";
import { array, record, text } from "../state";

type CachedTurn = {
  items: readonly ChatTimelineItem[];
  resolutionKey: string;
  output: ChatTimelineItem;
};

const completedTurnCache = new WeakMap<ChatTimelineItem, CachedTurn>();
const activeTurnCache = new WeakMap<ChatTimelineItem, CachedTurn>();
const wrappedEventCache = new WeakMap<JsonObject, Map<string, JsonObject>>();

function stabilizeTurnEvent(item: ChatTimelineItem): JsonObject {
  let byKey = wrappedEventCache.get(item.event);
  if (!byKey) {
    byKey = new Map<string, JsonObject>();
    wrappedEventCache.set(item.event, byKey);
  }
  let wrapped = byKey.get(item.key);
  if (!wrapped) {
    wrapped = { ...item.event, displayKey: item.key };
    byKey.set(item.key, wrapped);
  }
  return wrapped;
}

function turnResolutionKey(turn: readonly ChatTimelineItem[], resolutions: ReadonlySet<string>): string {
  let key = "";
  for (const item of turn) {
    const kind = item.event.kind;
    if (kind === "permission.request") {
      const reqId = text(item.event.reqId);
      key += `p:${reqId}:${hasChatResolution(resolutions, "permission.resolved", reqId) ? "1" : "0"};`;
    } else if (kind === "question.request") {
      const reqId = text(item.event.reqId);
      key += `q:${reqId}:${hasChatResolution(resolutions, "question.resolved", reqId) ? "1" : "0"};`;
    }
  }
  return key;
}

function sameTurnItems(left: readonly ChatTimelineItem[], right: readonly ChatTimelineItem[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** Keep each native turn together, including steering messages and its own results. */
export function conversationTurns(items: readonly ChatTimelineItem[], resolutions: ReadonlySet<string>): ChatTimelineItem[] {
  const result: ChatTimelineItem[] = [];
  let turn: ChatTimelineItem[] = [];
  const flush = (end?: ChatTimelineItem): void => {
    const first = turn[0] ?? end;
    if (!first) return;
    if (end) {
      const cached = completedTurnCache.get(end);
      const resolutionKey = turnResolutionKey(turn, resolutions);
      if (cached && cached.resolutionKey === resolutionKey && sameTurnItems(cached.items, turn)) {
        result.push(cached.output);
        turn = [];
        return;
      }
      const built = buildTurnItem(first, turn, end, resolutions);
      completedTurnCache.set(end, { items: turn, resolutionKey, output: built });
      result.push(built);
      turn = [];
      return;
    }
    const resolutionKey = turnResolutionKey(turn, resolutions);
    const cachedActive = activeTurnCache.get(first);
    if (cachedActive && cachedActive.resolutionKey === resolutionKey && sameTurnItems(cachedActive.items, turn)) {
      result.push(cachedActive.output);
      turn = [];
      return;
    }
    const builtActive = buildTurnItem(first, turn, undefined, resolutions);
    activeTurnCache.set(first, { items: [...turn], resolutionKey, output: builtActive });
    result.push(builtActive);
    turn = [];
  };
  for (const item of items) {
    if (item.event.kind === "turn.end") flush(item);
    else turn.push(item);
  }
  flush();
  return result;
}

function buildTurnItem(
  first: ChatTimelineItem,
  turn: readonly ChatTimelineItem[],
  end: ChatTimelineItem | undefined,
  resolutions: ReadonlySet<string>,
): ChatTimelineItem {
  const answers = turn.filter(item => item.event.kind === "assistant.text");
  const final = answers.findLast(item => item.event.phase === "final_answer")
    ?? (end ? answers.findLast(item => item.event.phase !== "commentary" && item.event.msgId === end.event.msgId)
      ?? answers.findLast(item => item.event.phase !== "commentary") : undefined);
  const users: JsonObject[] = [], activity: JsonObject[] = [], outcomes: JsonObject[] = [];
  for (const item of turn) {
    const event = stabilizeTurnEvent(item);
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
  return { key: `turn:${first.key}`, ordinal: first.ordinal, event: {
    kind: "conversation.turn", text: text(users[0]?.text), users, activity, outcomes,
    completed: Boolean(end), finish: text(end?.event.finish), diffs: [...diffs.values()],
    finalText: text(final?.event.text), outputTokens: end?.event.outputTokens ?? 0,
  } };
}
