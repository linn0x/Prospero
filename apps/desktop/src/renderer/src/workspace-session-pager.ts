import type { DesktopApi, SessionPage } from "../../shared/types";
import { RequestQueue } from "./request-queue";

export const WORKSPACE_PAGE_SIZE = 24;
export const WORKSPACE_PREVIEW_SIZE = 6;
const requests = new RequestQueue();
type PageApi = Pick<DesktopApi, "listSessions" | "cancelSessionPage">;
export type WorkspacePageState = { page: SessionPage | undefined; loading: boolean; expanded: boolean; error: string | undefined };

export class WorkspaceSessionPager {
  private state: WorkspacePageState = { page: undefined, loading: false, expanded: false, error: undefined };
  private readonly listeners = new Set<() => void>();
  private active = false;
  private revision: string | undefined;
  private generation = 0;
  private controller: AbortController | undefined;
  private cursor: string | undefined;
  private attemptedCursor: string | undefined;

  constructor(private readonly api: PageApi, readonly workspace: string, private readonly queue = requests) {}
  getSnapshot = (): WorkspacePageState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  setRevision(revision: string | undefined): void {
    if (this.revision === revision) return;
    this.revision = revision;
    if (this.active) void this.load(this.cursor, this.state.expanded);
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active) void this.load(undefined, false);
    else {
      this.generation++;
      this.controller?.abort();
      this.cursor = undefined; this.attemptedCursor = undefined;
      this.publish({ page: undefined, loading: false, expanded: false, error: undefined });
    }
  }

  expand(): Promise<void> { return this.load(undefined, true); }
  collapse(): Promise<void> { return this.load(undefined, false); }
  first(): Promise<void> { return this.load(undefined, true); }
  next(): Promise<void> { return this.state.page?.nextCursor ? this.load(this.state.page.nextCursor, true) : Promise.resolve(); }
  previous(): Promise<void> { return this.state.page?.previousCursor ? this.load(this.state.page.previousCursor, true) : Promise.resolve(); }
  retry(): Promise<void> { return this.load(this.attemptedCursor, this.state.expanded); }

  private publish(state: WorkspacePageState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private async load(cursor: string | undefined, expanded: boolean): Promise<void> {
    if (!this.active) return;
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const requestId = crypto.randomUUID();
    let started = false;
    const cancel = (): void => { if (started) void this.api.cancelSessionPage(requestId).catch(() => {}); };
    controller.signal.addEventListener("abort", cancel, { once: true });
    this.attemptedCursor = cursor;
    this.publish({ ...this.state, loading: true, expanded, error: undefined });
    try {
      const limit = expanded ? WORKSPACE_PAGE_SIZE : WORKSPACE_PREVIEW_SIZE;
      const page = await this.queue.run(controller.signal, () => {
        controller.signal.throwIfAborted();
        started = true;
        return this.api.listSessions({ workspace: this.workspace, limit, requestId, ...(cursor ? { cursor } : {}) });
      });
      if (controller.signal.aborted || this.generation !== generation) return;
      if (page.items.length > limit || new TextEncoder().encode(JSON.stringify(page)).byteLength > 2 * 1024 * 1024) throw new Error("Page exceeds limit");
      if (!page.items.length && page.total > 0 && cursor) { await this.load(undefined, expanded); return; }
      this.cursor = cursor;
      this.publish({ page, loading: false, expanded, error: undefined });
    } catch {
      if (!controller.signal.aborted && this.generation === generation) this.publish({ ...this.state, loading: false, error: "加载失败，请重试" });
    } finally { controller.signal.removeEventListener("abort", cancel); }
  }
}
