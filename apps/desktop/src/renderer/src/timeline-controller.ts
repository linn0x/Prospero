import type { TimelinePage, TimelineQuery, TimelineRecord } from "@prospero/protocol/rust-daemon";
import type { DesktopApi, JsonObject } from "../../shared/types";
import type { ChatTimelineItem, ChatTimelineSnapshot } from "./chat-events";
import { pageRequest } from "./page-request";

type TimelineApi = Pick<DesktopApi, "readTimeline" | "readTimelineChanges" | "lookupTimeline" | "cancelSessionPage">;
export type TimelineState = { page: TimelinePage | undefined; loading: boolean; error: string | undefined; live: boolean };
const latest: TimelineQuery = { before: null, after: null, limit: 40 };

export class TimelineController {
  private state: TimelineState = { page: undefined, loading: false, error: undefined, live: true };
  private readonly listeners = new Set<() => void>();
  private active = false;
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private query = latest;
  private attemptedQuery = latest;
  private loadFailed = false;
  private sequence = 0;
  private failures = 0;

  constructor(private readonly api: TimelineApi, readonly sessionId: string) {}
  getSnapshot = (): TimelineState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  start(): void { if (!this.active) { this.active = true; void this.load(latest, true); } }
  stop(): void { this.active = false; this.controller.abort(); clearTimeout(this.timer); this.publish({ page: undefined, loading: false, error: undefined, live: true }); }
  older(): Promise<void> { return this.state.page?.older ? this.load({ before: this.state.page.older, after: null, limit: 40 }, false) : Promise.resolve(); }
  newer(): Promise<void> { return this.state.page?.newer ? this.load({ before: null, after: this.state.page.newer, limit: 40 }, false) : Promise.resolve(); }
  latest(): Promise<void> { return this.load(latest, true); }
  retry(): Promise<void> { return this.load(this.attemptedQuery, this.state.live); }
  freeze(): void {
    if (this.state.live && this.state.page) {
      this.query = { before: null, after: (this.state.page.items[0]?.position ?? 1) - 1, limit: 40 };
      this.attemptedQuery = this.query;
      this.publish({ ...this.state, live: false });
    }
  }

  private publish(state: TimelineState): void { this.state = state; for (const listener of this.listeners) listener(); }

  private async load(query: TimelineQuery, live: boolean): Promise<void> {
    if (!this.active) return;
    this.controller.abort(); clearTimeout(this.timer);
    const controller = new AbortController(); this.controller = controller;
    this.attemptedQuery = query;
    this.publish({ ...this.state, loading: true, error: undefined, live });
    try {
      const page = await pageRequest(this.api, controller.signal, id => this.api.readTimeline(this.sessionId, query, id));
      if (controller.signal.aborted) return;
      this.validate(page.items);
      if (!page.items.length && page.latestPosition > 0 && (query.before !== null || query.after !== null)) { await this.load(latest, true); return; }
      this.query = query; this.sequence = page.revision; this.failures = 0; this.loadFailed = false;
      this.publish({ page, loading: false, error: undefined, live });
    } catch { if (!controller.signal.aborted) { this.failures++; this.loadFailed = true; this.publish({ ...this.state, loading: false, error: "无法读取会话记录，请重试" }); } }
    finally { if (!controller.signal.aborted) this.schedule(Math.min(8000, 500 * 2 ** Math.min(this.failures, 4))); }
  }

  private validate(items: TimelineRecord[]): void {
    if (items.length > 40 || new TextEncoder().encode(JSON.stringify(items)).byteLength > 1024 * 1024) throw new Error("Timeline page exceeds limit");
  }

  private schedule(delay = 500): void {
    clearTimeout(this.timer);
    if (this.active && !this.controller.signal.aborted) this.timer = setTimeout(() => { void this.poll(); }, delay);
  }

  private async poll(): Promise<void> {
    const controller = this.controller;
    let delay = 500;
    try {
      const page = this.state.page;
      if (!page || this.loadFailed) { await this.load(this.attemptedQuery, this.state.live); return; }
      const changes = await pageRequest(this.api, controller.signal, id => this.api.readTimelineChanges(this.sessionId, this.sequence, id));
      if (controller.signal.aborted) return;
      if (changes.resyncRequired) { await this.load(this.query, this.state.live); return; }
      const notices = changes.items.filter(event => event.kind === "timeline.updated" && event.scope === `timeline:${this.sessionId}`);
      const positions = notices.map(event => (event.data as { position?: unknown } | null)?.position).filter((position): position is number => typeof position === "number" && Number.isSafeInteger(position) && position > 0);
      const latestPosition = Math.max(page.latestPosition, ...positions);
      if (this.state.live && latestPosition > (page.items.at(-1)?.position ?? 0)) { await this.load(latest, true); return; }
      const ids = new Set(notices.map(event => event.entityId));
      const changed = page.items.filter(item => ids.has(item.id)).map(item => item.id);
      let items = page.items;
      if (changed.length) {
        const updates = await pageRequest(this.api, controller.signal, id => this.api.lookupTimeline(this.sessionId, changed, id));
        if (controller.signal.aborted) return;
        this.validate(updates.items);
        const byId = new Map(updates.items.map(item => [item.id, item]));
        items = items.map(item => { const update = byId.get(item.id); return update && update.revision > item.revision ? update : item; });
      }
      this.sequence = changes.nextSeq; this.failures = 0;
      if (changed.length || latestPosition !== page.latestPosition || this.state.error) {
        const last = items.at(-1)?.position;
        this.publish({ ...this.state, error: undefined, page: { ...page, items, latestPosition, revision: changes.nextSeq, newer: last && last < latestPosition ? last : null } });
      }
      if (changes.hasMore) delay = 0;
    } catch { if (!controller.signal.aborted) { this.failures++; delay = Math.min(8000, 500 * 2 ** Math.min(this.failures, 4)); this.publish({ ...this.state, error: "会话更新暂不可用，正在重试" }); } }
    finally { if (!controller.signal.aborted) this.schedule(delay); }
  }
}

export function timelineEvent(record: TimelineRecord): JsonObject {
  const shared = { msgId: record.turnId, callId: record.id, hasMore: record.truncated, bodyRecordId: record.id };
  switch (record.body.kind) {
    case "message": return { ...shared, kind: record.body.role === "user" ? "user.message" : "assistant.text", text: record.preview, phase: record.body.finalAnswer ? "final_answer" : "commentary" };
    case "reasoning": return { ...shared, kind: "reasoning", text: record.preview };
    case "tool": return { ...shared, hasMore: record.bytes > 0, kind: record.body.state === "running" ? "tool.start" : "tool.end", tool: record.body.name, state: record.body.state, summary: record.body.summary };
    case "turn_end": return { ...shared, kind: "turn.end", finish: record.body.finish };
    case "error": return { ...shared, kind: "agent.error", message: record.preview };
  }
}

export class TimelineViewCache {
  private entries = new Map<string, { revision: number; item: ChatTimelineItem }>();
  project(page: TimelinePage | undefined): ChatTimelineSnapshot {
    const next = new Map<string, { revision: number; item: ChatTimelineItem }>();
    const items = (page?.items ?? []).map(record => {
      const cached = this.entries.get(record.id);
      const item = cached?.revision === record.revision ? cached.item : { key: record.id, ordinal: record.position, event: timelineEvent(record) };
      next.set(record.id, { revision: record.revision, item }); return item;
    });
    this.entries = next;
    return { items, resolutions: new Set(), revision: page?.revision ?? 0, nextOrdinal: (items.at(-1)?.ordinal ?? 0) + 1 };
  }
}
