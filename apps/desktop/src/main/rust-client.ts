import type { ContentPage, EventPage, EventQuery, Health, RenameSession, SessionHead, SessionLookupResult, SessionPage, SessionQuery, SessionSummary, WorkspacePage, WorkspaceQuery } from "@prospero/protocol/rust-daemon";
import type { RustContent } from "../shared/rust-api";

const MAX_BYTES = 2 * 1024 * 1024;
function id(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid record id");
  return value;
}

export class RustClient {
  private readonly base: string;

  constructor(baseUrl: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid daemon endpoint");
    if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("Invalid daemon credential");
    this.base = url.origin;
  }

  private async response(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetcher(this.base + path, { ...init, redirect: "error", signal: AbortSignal.timeout(7000), headers: { ...init.headers, authorization: `Bearer ${this.token}` } });
    } catch { throw new Error("无法连接本机 Rust 服务"); }
  }

  private async bytes(response: Response): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty daemon response");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BYTES) throw new Error("Daemon response exceeded page limit");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const output = new Uint8Array(length); let position = 0;
    for (const chunk of chunks) { output.set(chunk, position); position += chunk.byteLength; }
    return output;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.response(path, init);
    const text = new TextDecoder().decode(await this.bytes(response));
    let result: unknown;
    try { result = JSON.parse(text); } catch { throw new Error("Invalid daemon response"); }
    if (!response.ok) {
      const code = result && typeof result === "object" ? (result as { code?: unknown }).code : undefined;
      throw new Error(code === "conflict" ? "记录已变更，请刷新后重试" : code === "busy" ? "服务繁忙，请稍后重试" : `Rust 服务请求失败（${response.status}）`);
    }
    return result as T;
  }

  health(): Promise<Health> { return this.json("/v1/health"); }
  async shutdown(): Promise<void> { await this.json("/v1/shutdown", { method: "POST" }); }
  sessions(query: SessionQuery): Promise<SessionPage> {
    const params = new URLSearchParams();
    if (query.limit != null) params.set("limit", String(query.limit));
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.lifecycle) params.set("lifecycle", query.lifecycle);
    if (query.workspace != null) params.set("workspace", query.workspace);
    if (query.text != null) params.set("text", query.text);
    return this.json(`/v1/sessions?${params}`);
  }
  summary(workspace?: string): Promise<SessionSummary> {
    const params = new URLSearchParams();
    if (workspace != null) params.set("workspace", workspace);
    return this.json(`/v1/sessions/summary?${params}`);
  }
  workspaces(query: WorkspaceQuery): Promise<WorkspacePage> {
    const params = new URLSearchParams();
    if (query.limit != null) params.set("limit", String(query.limit));
    if (query.cursor != null) params.set("cursor", query.cursor);
    return this.json(`/v1/workspaces?${params}`);
  }
  lookup(ids: string[]): Promise<SessionLookupResult> {
    if (ids.length > 100) throw new Error("Session lookup exceeds limit");
    return this.json("/v1/sessions/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ids.map(id) }) });
  }
  session(value: string): Promise<SessionHead> { return this.json(`/v1/sessions/${id(value)}`); }
  rename(value: string, input: RenameSession): Promise<SessionHead> {
    return this.json(`/v1/sessions/${id(value)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  events(query: EventQuery): Promise<EventPage> {
    const params = new URLSearchParams({ scope: query.scope });
    if (query.afterSeq != null) params.set("afterSeq", String(query.afterSeq));
    if (query.limit != null) params.set("limit", String(query.limit));
    return this.json(`/v1/events?${params}`);
  }
  contents(value: string, cursor?: string): Promise<ContentPage> {
    const params = new URLSearchParams({ limit: "20" });
    if (cursor) params.set("cursor", cursor);
    return this.json(`/v1/sessions/${id(value)}/contents?${params}`);
  }
  async content(value: string, content: string, offset: number): Promise<RustContent> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid content offset");
    const response = await this.response(`/v1/sessions/${id(value)}/content/${id(content)}?offset=${offset}`);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`正文读取失败（${response.status}）`); }
    const bytes = await this.bytes(response);
    const nextOffset = Number(response.headers.get("x-next-offset"));
    if (!Number.isSafeInteger(nextOffset) || nextOffset !== offset + bytes.byteLength) throw new Error("Invalid content cursor");
    return { bytes, nextOffset };
  }
}
