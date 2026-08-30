import type { JsonObject } from "../../shared/types";

export type ChatTimelineItem = {
  key: string;
  ordinal: number;
  event: JsonObject;
};

export type ChatTimelineSnapshot = {
  items: ChatTimelineItem[];
  resolutions: ReadonlySet<string>;
  revision: number;
  nextOrdinal: number;
};

export type ChatTimelineWindow = {
  start: number;
  end: number;
  isLatest: boolean;
  newerCount: number;
};

export type ChatTimelineItemWindow = ChatTimelineWindow & {
  cursorStart: number;
  cursorEnd: number;
};

export type ChatHistoryCursor = {
  end: number;
  mode: "frozen" | "page";
};

export const CHAT_TIMELINE_WINDOW_SIZE = 120;
export const CHAT_TIMELINE_END_THRESHOLD = 48;
export const MAX_RETAINED_CHAT_ITEMS = 2_000;
const CHAT_TIMELINE_COMPACT_TARGET = 1_800;
const MAX_PROTECTED_ACTIVE_ITEMS = 512;

export function getChatPollReconnectDelay(hasFrame: boolean, elapsedMs: number): number {
  return !hasFrame && elapsedMs < 500 ? 650 : 25;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function resolutionKey(kind: string, reqId: string): string {
  return `${kind}\u0000${reqId}`;
}

export function hasChatResolution(
  resolutions: ReadonlySet<string>,
  kind: "permission.resolved" | "question.resolved",
  reqId: string,
): boolean {
  return resolutions.has(resolutionKey(kind, reqId));
}

export function isChatViewportNearEnd(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = CHAT_TIMELINE_END_THRESHOLD,
): boolean {
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= Math.max(0, threshold);
}

export function updateChatHistoryCursorFromScroll(
  current: ChatHistoryCursor | null,
  nearEnd: boolean,
  timelineEndOrdinal: number,
): ChatHistoryCursor | null {
  if (current?.mode === "page") return current;
  if (nearEnd) return null;
  if (current) return current;
  return { end: Math.max(0, Math.floor(timelineEndOrdinal)), mode: "frozen" };
}

function isRenderableKind(kind: string): boolean {
  return kind === "user.message" ||
    kind === "permission.request" ||
    kind === "permission.auto" ||
    kind === "question.request" ||
    kind === "agent.error" ||
    kind === "subagent.started" ||
    kind === "subagent.updated" ||
    kind === "trajectory.record" ||
    kind === "turn.end";
}

/**
 * Incrementally folds the daemon's append-only event stream into stable render items.
 *
 * The accumulator is deliberately mutable and owned by one ChatPane instance. React only
 * receives immutable snapshots when the visible model changed, so an empty poll is free and
 * a text delta touches one existing item instead of replaying the complete session history.
 */
export class ChatEventAccumulator {
  private items: ChatTimelineItem[] = [];
  private resolutions = new Set<string>();
  private textIndex = new Map<string, number>();
  private reasoningIndex = new Map<string, number>();
  private toolIndex = new Map<string, number>();
  private permissionIndex = new Map<string, number>();
  private questionIndex = new Map<string, number>();
  private textIdsByMessage = new Map<string, Set<string>>();
  private nextOrdinal = 0;
  private revision = 0;

  reset(events: readonly JsonObject[]): ChatTimelineSnapshot {
    this.items = [];
    this.resolutions = new Set();
    this.textIndex = new Map();
    this.reasoningIndex = new Map();
    this.toolIndex = new Map();
    this.permissionIndex = new Map();
    this.questionIndex = new Map();
    this.textIdsByMessage = new Map();
    this.nextOrdinal = 0;
    this.apply(events);
    this.revision += 1;
    return this.snapshot();
  }

  append(events: readonly JsonObject[]): ChatTimelineSnapshot | undefined {
    if (!events.length || !this.apply(events)) return undefined;
    this.revision += 1;
    return this.snapshot();
  }

  snapshot(): ChatTimelineSnapshot {
    return {
      items: this.items.slice(),
      resolutions: new Set(this.resolutions),
      revision: this.revision,
      nextOrdinal: this.nextOrdinal,
    };
  }

  private itemKey(kind: string, event: JsonObject, ordinal: number): string {
    const hint = stringValue(
      event.reqId,
      stringValue(event.callId, stringValue(event.textId, stringValue(event.msgId, stringValue(event.recordId)))),
    );
    return `${kind}:${hint}:${String(ordinal)}`;
  }

  private push(kind: string, event: JsonObject): number {
    const index = this.items.length;
    const ordinal = this.nextOrdinal++;
    this.items.push({ key: this.itemKey(kind, event, ordinal), ordinal, event });
    return index;
  }

  private replace(index: number, event: JsonObject): void {
    const prior = this.items[index];
    if (!prior) return;
    this.items[index] = { ...prior, event };
  }

  private apply(events: readonly JsonObject[]): boolean {
    let changed = false;
    for (const source of events) {
      if (this.items.length > MAX_RETAINED_CHAT_ITEMS) this.compact();
      const kind = stringValue(source.kind);

      if (kind === "permission.resolved" || kind === "question.resolved") {
        const reqId = stringValue(source.reqId);
        const key = resolutionKey(kind, reqId);
        const requestIndex = kind === "permission.resolved" ? this.permissionIndex.get(reqId) : this.questionIndex.get(reqId);
        if (requestIndex !== undefined && !this.resolutions.has(key)) {
          this.resolutions.add(key);
          changed = true;
        }
        if (kind === "permission.resolved") this.permissionIndex.delete(reqId);
        else this.questionIndex.delete(reqId);
        continue;
      }

      if (kind === "text.delta") {
        const id = stringValue(source.textId, stringValue(source.msgId));
        const delta = stringValue(source.delta);
        const index = this.textIndex.get(id);
        if (index !== undefined) {
          if (delta) {
            const prior = this.items[index]?.event ?? {};
            this.replace(index, { ...prior, text: `${stringValue(prior.text)}${delta}` });
            changed = true;
          }
        } else if (delta) {
          const event = { ...source, kind: "assistant.text", text: delta };
          this.textIndex.set(id, this.push("assistant.text", event));
          const msgId = stringValue(source.msgId);
          const ids = this.textIdsByMessage.get(msgId) ?? new Set<string>();
          ids.add(id);
          this.textIdsByMessage.set(msgId, ids);
          changed = true;
        }
        continue;
      }

      if (kind === "reasoning.delta") {
        const id = stringValue(source.msgId);
        const delta = stringValue(source.delta);
        const index = this.reasoningIndex.get(id);
        if (index !== undefined) {
          if (delta) {
            const prior = this.items[index]?.event ?? {};
            this.replace(index, { ...prior, text: `${stringValue(prior.text)}${delta}` });
            changed = true;
          }
        } else if (delta) {
          const event = { ...source, kind: "reasoning", text: delta };
          this.reasoningIndex.set(id, this.push("reasoning", event));
          changed = true;
        }
        continue;
      }

      if (kind === "tool.start") {
        const event = { ...source };
        this.toolIndex.set(stringValue(source.callId), this.push(kind, event));
        changed = true;
        continue;
      }

      if (kind === "tool.end") {
        const callId = stringValue(source.callId);
        const index = this.toolIndex.get(callId);
        if (index === undefined) {
          this.push(kind, { ...source });
        } else {
          const prior = this.items[index]?.event ?? {};
          this.replace(index, { ...prior, ...source, kind: "tool.end", tool: prior.tool });
        }
        this.toolIndex.delete(callId);
        changed = true;
        continue;
      }

      if (kind === "permission.request") {
        this.permissionIndex.set(stringValue(source.reqId), this.push(kind, { ...source }));
        changed = true;
        continue;
      }

      if (kind === "question.request") {
        this.questionIndex.set(stringValue(source.reqId), this.push(kind, { ...source }));
        changed = true;
        continue;
      }

      if (kind === "turn.end") {
        const msgId = stringValue(source.msgId);
        for (const id of this.textIdsByMessage.get(msgId) ?? []) this.textIndex.delete(id);
        this.textIdsByMessage.delete(msgId);
        this.reasoningIndex.delete(msgId);
      }

      if (isRenderableKind(kind)) {
        this.push(kind, { ...source });
        changed = true;
      }
    }
    if (this.items.length > MAX_RETAINED_CHAT_ITEMS) this.compact();
    return changed;
  }

  private compact(): void {
    if (this.items.length <= MAX_RETAINED_CHAT_ITEMS) return;
    const activeIndexes = [
      ...this.textIndex.values(),
      ...this.reasoningIndex.values(),
      ...this.toolIndex.values(),
      ...this.permissionIndex.values(),
      ...this.questionIndex.values(),
    ];
    const allActiveKeys = new Set(activeIndexes.map((index) => this.items[index]?.key).filter((key): key is string => Boolean(key)));
    const protectedActiveKeys = new Set<string>();
    for (let index = this.items.length - 1; index >= 0 && protectedActiveKeys.size < MAX_PROTECTED_ACTIVE_ITEMS; index--) {
      const key = this.items[index]?.key;
      if (key && allActiveKeys.has(key)) protectedActiveKeys.add(key);
    }
    const keep = new Set(protectedActiveKeys);
    const target = CHAT_TIMELINE_COMPACT_TARGET;
    for (let index = this.items.length - 1; index >= 0 && keep.size < target; index--) {
      const key = this.items[index]?.key;
      if (key) keep.add(key);
    }
    this.items = this.items.filter((item) => keep.has(item.key));

    this.textIndex = new Map();
    this.reasoningIndex = new Map();
    this.toolIndex = new Map();
    this.permissionIndex = new Map();
    this.questionIndex = new Map();
    this.textIdsByMessage = new Map();
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index]!;
      const kind = stringValue(item.event.kind);
      if (kind === "assistant.text" && protectedActiveKeys.has(item.key)) {
        const id = stringValue(item.event.textId, stringValue(item.event.msgId));
        const msgId = stringValue(item.event.msgId);
        this.textIndex.set(id, index);
        const ids = this.textIdsByMessage.get(msgId) ?? new Set<string>();
        ids.add(id);
        this.textIdsByMessage.set(msgId, ids);
      } else if (kind === "reasoning" && protectedActiveKeys.has(item.key)) {
        this.reasoningIndex.set(stringValue(item.event.msgId), index);
      } else if (kind === "tool.start") {
        this.toolIndex.set(stringValue(item.event.callId), index);
      }
    }
    const retainedRequests = new Set(this.items.flatMap(({ event }) => {
      const kind = stringValue(event.kind);
      const reqId = stringValue(event.reqId);
      if (kind === "permission.request") return [resolutionKey("permission.resolved", reqId)];
      if (kind === "question.request") return [resolutionKey("question.resolved", reqId)];
      return [];
    }));
    this.resolutions = new Set([...this.resolutions].filter((key) => retainedRequests.has(key)));
    for (let index = 0; index < this.items.length; index++) {
      const event = this.items[index]!.event;
      const kind = stringValue(event.kind);
      const reqId = stringValue(event.reqId);
      if (kind === "permission.request" && !this.resolutions.has(resolutionKey("permission.resolved", reqId))) {
        this.permissionIndex.set(reqId, index);
      } else if (kind === "question.request" && !this.resolutions.has(resolutionKey("question.resolved", reqId))) {
        this.questionIndex.set(reqId, index);
      }
    }
  }
}

/** One-shot folding for the on-demand subagent transcript. It intentionally retains metadata. */
export function collapseChatEventHistory(events: readonly JsonObject[]): JsonObject[] {
  const output: JsonObject[] = [];
  const textById = new Map<string, number>();
  const reasoningById = new Map<string, number>();
  const toolById = new Map<string, number>();
  for (const source of events) {
    const kind = stringValue(source.kind);
    if (kind === "text.delta" || kind === "reasoning.delta") {
      const indexById = kind === "text.delta" ? textById : reasoningById;
      const id = kind === "text.delta"
        ? stringValue(source.textId, stringValue(source.msgId))
        : stringValue(source.msgId);
      const index = indexById.get(id);
      if (index === undefined) {
        indexById.set(id, output.length);
        output.push({
          ...source,
          kind: kind === "text.delta" ? "assistant.text" : "reasoning",
          text: stringValue(source.delta),
        });
      } else {
        const prior = output[index] ?? {};
        output[index] = { ...prior, text: `${stringValue(prior.text)}${stringValue(source.delta)}` };
      }
      continue;
    }
    if (kind === "tool.start") {
      toolById.set(stringValue(source.callId), output.length);
      output.push({ ...source });
      continue;
    }
    if (kind === "tool.end") {
      const index = toolById.get(stringValue(source.callId));
      if (index === undefined) {
        output.push({ ...source });
      } else {
        const prior = output[index] ?? {};
        output[index] = { ...prior, ...source, kind: "tool.end", tool: prior.tool };
      }
      continue;
    }
    output.push({ ...source });
  }
  return output;
}

export function getChatTimelineWindow(
  total: number,
  requestedEnd: number | null,
  size = CHAT_TIMELINE_WINDOW_SIZE,
): ChatTimelineWindow {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeSize = Math.max(1, Math.floor(size));
  const requested = requestedEnd === null ? safeTotal : Math.max(0, Math.floor(requestedEnd));
  const end = Math.min(safeTotal, requested);
  const isLatest = requestedEnd === null || end >= safeTotal;
  return {
    start: Math.max(0, end - safeSize),
    end,
    isLatest,
    newerCount: isLatest ? 0 : safeTotal - end,
  };
}

export function getChatTimelineItemWindow(
  items: readonly ChatTimelineItem[],
  nextOrdinal: number,
  requestedEnd: number | null,
  size = CHAT_TIMELINE_WINDOW_SIZE,
): ChatTimelineItemWindow {
  const safeSize = Math.max(1, Math.floor(size));
  let end = items.length;
  if (requestedEnd !== null) {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((items[middle]?.ordinal ?? Number.POSITIVE_INFINITY) < requestedEnd) low = middle + 1;
      else high = middle;
    }
    end = low;
    if (end === 0 && items.length > 0 && requestedEnd <= (items[0]?.ordinal ?? requestedEnd)) {
      end = Math.min(items.length, safeSize);
    }
  }
  const start = Math.max(0, end - safeSize);
  const isLatest = requestedEnd === null || end >= items.length;
  return {
    start,
    end,
    isLatest,
    newerCount: isLatest ? 0 : items.length - end,
    cursorStart: items[start]?.ordinal ?? 0,
    cursorEnd: items[end]?.ordinal ?? nextOrdinal,
  };
}
