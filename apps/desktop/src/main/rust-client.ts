import type { ContentPage, EventPage, EventQuery, Health, RenameSession, SessionHead, SessionLookupResult, SessionPage, SessionQuery, SessionSummary, WorkspacePage, WorkspaceQuery } from "@prospero/protocol/rust-daemon";
import type { RustContent } from "../shared/rust-api";
import type { TimelinePage, TimelineQuery, TimelineLookupResult, TimelineTextQuery, TimelineTextPage } from "@prospero/protocol/rust-daemon";
import type { CreateTerminal, TerminalPage, TerminalQuery, TerminalSize, TerminalSnapshot } from "@prospero/protocol/rust-daemon";
import type { AgentSend, AgentControlResult, AgentModeCatalog, AgentModelCatalog, AgentModelSelectionResult, AgentControlsProjection, AttachmentChunk, CreateAgentSession, PermissionDecision, QuestionDecision, SubagentSnapshot, AgentQueue, AgentQueues } from "@prospero/protocol/rust-daemon";
import type { AccountListResult, ConversationSearchResult, LaunchModelCatalog, ResumableConversation, SourceResult, UsageResult } from "@prospero/protocol/rust-daemon";
import type { FsChunk, FsContent, FsDone, FsListing, FsWritten, GitDiffResult, GitDone, GitHistoryResult, GitStatusResult, SearchResult as RustProjectSearchResult, WorkspaceSummaryResult } from "@prospero/protocol/rust-daemon";
import type {
  AbandonRun, ApplyTaskGraph, CancelTask, CleanupWorktree, CompleteRun, CreateGate,
  CreateRun, CreateRunGraph, CreateTask, Dispatch, Gate, GraphMutationResult, ResolveGate,
  PluginServiceList, PluginServiceView, PublicPluginDiscoveryResult,
  Run, DeleteRun, RunDeletionResult, RunSnapshot, SettleDispatch, SettleOutcome, Skill, SkillSuggestion,
  ScheduleCreate, ScheduleRunResult, ScheduleUpdate, ScheduledAgentTask,
  StartAutomation, StartWorker, StopWorker, Task, WorktreeAsset, WorktreeCleanupResult, WorktreeInspection,
  WorkerStartOutcome,
} from "@prospero/protocol/rust-daemon";

const MAX_BYTES = 2 * 1024 * 1024;
function id(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid record id");
  return value;
}

function scheduleId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) throw new Error("Invalid schedule id");
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

  private async response(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs = 7000, ...requestInit } = init;
    try {
      return await this.fetcher(this.base + path, { ...requestInit, redirect: "error", signal: requestInit.signal ? AbortSignal.any([requestInit.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), headers: { ...requestInit.headers, authorization: `Bearer ${this.token}` } });
    } catch { if (requestInit.signal?.aborted) throw new DOMException("Request cancelled", "AbortError"); throw new Error("无法连接本机 Rust 服务"); }
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

  private async json<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const response = await this.response(path, init);
    const text = new TextDecoder().decode(await this.bytes(response));
    let result: unknown;
    try { result = JSON.parse(text); } catch { throw new Error("Invalid daemon response"); }
    if (!response.ok) {
      const code = result && typeof result === "object" ? (result as { code?: unknown }).code : undefined;
      if (code === "conflict") throw new Error("记录已变更，请刷新后重试");
      if (code === "in_use") throw new Error("该账号仍有活跃会话，请先关闭后再删除");
      if (code === "busy") throw new Error("服务繁忙，请稍后重试");
      const detail = result && typeof result === "object" ? (result as { message?: unknown }).message : undefined;
      const suffix = typeof detail === "string" && detail.trim() ? `：${detail.trim()}` : "";
      throw new Error(`Rust 服务请求失败（${response.status}）${suffix}`);
    }
    return result as T;
  }

  health(signal: AbortSignal | null = null): Promise<Health> { return this.json("/v1/health", { signal }); }
  createTerminal(input: CreateTerminal, signal: AbortSignal | null = null): Promise<SessionHead> {
    return this.json("/v1/terminals", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  terminalSnapshot(value: string, signal: AbortSignal | null = null): Promise<TerminalSnapshot | null> {
    return this.json(`/v1/terminals/${id(value)}/snapshot`, { signal });
  }
  terminalOutput(value: string, query: TerminalQuery, signal: AbortSignal | null = null): Promise<TerminalPage> {
    const params = new URLSearchParams();
    if (query.afterSeq != null) params.set("afterSeq", String(query.afterSeq));
    if (query.waitMs != null) params.set("waitMs", String(query.waitMs));
    return this.json(`/v1/terminals/${id(value)}/output?${params}`, { signal });
  }
  terminalInput(value: string, bytes: Uint8Array, signal: AbortSignal | null = null): Promise<{ ok: boolean }> {
    if (!bytes.length || bytes.length > 8192) throw new Error("Terminal input exceeds limit");
    return this.json(`/v1/terminals/${id(value)}/input`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ dataB64: Buffer.from(bytes).toString("base64") }) });
  }
  terminalResize(value: string, size: TerminalSize, signal: AbortSignal | null = null): Promise<{ ok: boolean }> {
    return this.json(`/v1/terminals/${id(value)}/resize`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(size) });
  }
  terminalClose(value: string, signal: AbortSignal | null = null): Promise<{ ok: boolean }> {
    return this.json(`/v1/terminals/${id(value)}/close`, { method: "POST", signal });
  }
  createAgentSession(input: CreateAgentSession, signal: AbortSignal | null = null): Promise<SessionHead> {
    return this.json("/v1/agent-sessions", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  localConversations(agent: "claude" | "codex" | "deepseek", query: string, limit = 20, accountId?: string, signal: AbortSignal | null = null): Promise<ResumableConversation[]> {
    const params = new URLSearchParams({ agent, query, limit: String(limit) });
    if (accountId) params.set("accountId", accountId);
    return this.json<ConversationSearchResult>(`/v1/conversations?${params}`, { signal, timeoutMs: 30_000 }).then(result => result.conversations);
  }

  agentSend(value: string, input: AgentSend, signal: AbortSignal | null = null): Promise<{ ok: boolean }> {
    return this.json(`/v1/agent-sessions/${id(value)}/send`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  agentInterrupt(value: string, signal: AbortSignal | null = null): Promise<{ ok: boolean }> {
    return this.json(`/v1/agent-sessions/${id(value)}/interrupt`, { method: "POST", signal });
  }
  agentCompact(value: string, requestId: string, signal: AbortSignal | null = null, timeoutMs = 180_000): Promise<AgentControlResult> {
    return this.json(`/v1/agent-sessions/${id(value)}/compact`, { method: "POST", signal, timeoutMs, headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId }) });
  }
  toolOutput(value: string, callId: string, signal: AbortSignal | null = null): Promise<{ output: string, truncated?: boolean }> {
    return this.json(`/v1/agent-sessions/${id(value)}/tool-output?callId=${encodeURIComponent(id(callId))}`, { signal });
  }
  chatAttachmentChunk(value: string, msgId: string, attachmentId: string, offset: number, length: number, signal: AbortSignal | null = null): Promise<AttachmentChunk> {
    const params = new URLSearchParams({ msgId: id(msgId), attachmentId: id(attachmentId), offset: String(offset), length: String(length) });
    return this.json(`/v1/agent-sessions/${id(value)}/attachment?${params}`, { signal, timeoutMs: 30_000 });
  }

  setApprovalPolicy(value: string, policy: string, signal: AbortSignal | null = null): Promise<{ ok: boolean }> {
    return this.json(`/v1/agent-sessions/${id(value)}/approval-policy`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ policy }) });
  }
  agentPermission(value: string, decision: PermissionDecision, signal: AbortSignal | null = null): Promise<{ ok: boolean }> {
    return this.json(`/v1/agent-sessions/${id(value)}/permission`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(decision) });
  }
  agentQuestion(value: string, decision: QuestionDecision, signal: AbortSignal | null = null): Promise<{ ok: boolean }> {
    return this.json(`/v1/agent-sessions/${id(value)}/question`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(decision) });
  }
  agentModes(value: string, signal: AbortSignal | null = null): Promise<AgentModeCatalog> {
    return this.json(`/v1/agent-sessions/${id(value)}/modes`, { signal });
  }
  setAgentMode(value: string, mode: string, signal: AbortSignal | null = null): Promise<{ currentMode: string }> {
    return this.json(`/v1/agent-sessions/${id(value)}/modes`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
  }
  agentModels(value: string, signal: AbortSignal | null = null, timeoutMs = 30_000): Promise<AgentModelCatalog> {
    return this.json(`/v1/agent-sessions/${id(value)}/models`, { signal, timeoutMs });
  }
  setAgentModel(value: string, model: string, effort: string | undefined, signal: AbortSignal | null = null, timeoutMs = 30_000): Promise<AgentModelSelectionResult> {
    return this.json(`/v1/agent-sessions/${id(value)}/models`, {
      method: "POST", signal, timeoutMs,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, ...(effort !== undefined ? { effort } : {}) }),
    });
  }
  agentControls(signal: AbortSignal | null = null): Promise<AgentControlsProjection> {
    return this.json("/v1/agent-sessions/controls", { signal });
  }
  agentQueue(value: string, signal: AbortSignal | null = null): Promise<AgentQueue> {
    return this.json(`/v1/agent-sessions/${id(value)}/queue`, { signal });
  }
  agentQueues(signal: AbortSignal | null = null): Promise<AgentQueues> {
    return this.json("/v1/agent-sessions/queues", { signal });
  }
  usage(sid?: string, signal: AbortSignal | null = null): Promise<UsageResult> {
    const params = new URLSearchParams();
    if (sid !== undefined) params.set("sid", id(sid));
    const suffix = params.size ? `?${params}` : "";
    return this.json(`/v1/usage${suffix}`, { signal });
  }
  agentQueueRemove(value: string, queueId: string, signal: AbortSignal | null = null): Promise<{ ok: boolean }> {
    return this.json(`/v1/agent-sessions/${id(value)}/queue/${id(queueId)}/remove`, { method: "POST", signal });
  }
  agentQueueGuide(value: string, queueId: string, signal: AbortSignal | null = null): Promise<{ ok: boolean }> {
    return this.json(`/v1/agent-sessions/${id(value)}/queue/${id(queueId)}/guide`, { method: "POST", signal });
  }
  subagentEvents(value: string, subagent: string, signal: AbortSignal | null = null): Promise<SubagentSnapshot> {
    return this.json(`/v1/agent-sessions/${id(value)}/subagents/${id(subagent)}/events`, { signal });
  }
  agentSubagentSend(value: string, subagent: string, input: AgentSend, signal: AbortSignal | null = null): Promise<{ ok: boolean }> {
    return this.json(`/v1/agent-sessions/${id(value)}/subagents/${id(subagent)}/send`, { method: "POST", body: JSON.stringify(input), signal });
  }
  agentClose(value: string, signal: AbortSignal | null = null): Promise<{ ok: boolean }> {
    return this.json(`/v1/agent-sessions/${id(value)}`, { method: "DELETE", signal });
  }
  timeline(value: string, query: TimelineQuery, signal: AbortSignal | null = null): Promise<TimelinePage> {
    const params = new URLSearchParams();
    if (query.before !== null) params.set("before", String(query.before));
    if (query.after !== null) params.set("after", String(query.after));
    if (query.limit !== null) params.set("limit", String(query.limit));
    return this.json(`/v1/sessions/${id(value)}/timeline?${params}`, { signal });
  }
  timelineLookup(value: string, ids: string[], signal: AbortSignal | null = null): Promise<TimelineLookupResult> {
    if (ids.length > 40) throw new Error("Timeline lookup exceeds limit");
    return this.json(`/v1/sessions/${id(value)}/timeline/lookup`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ids.map(id) }) });
  }
  timelineText(value: string, record: string, query: TimelineTextQuery, signal: AbortSignal | null = null): Promise<TimelineTextPage> {
    const params = new URLSearchParams();
    if (query.part !== null) params.set("part", String(query.part));
    if (query.generation !== null) params.set("generation", String(query.generation));
    return this.json(`/v1/sessions/${id(value)}/timeline/${id(record)}/body?${params}`, { signal });
  }

  workspaceSummary(value: string, requestId: string, signal: AbortSignal | null = null, timeoutMs = 15_000): Promise<WorkspaceSummaryResult> {
    return this.json(`/v1/sessions/${id(value)}/workspace-summary?requestId=${encodeURIComponent(requestId)}`, { signal, timeoutMs });
  }
  fsList(value: string, path: string, signal: AbortSignal | null = null): Promise<FsListing> {
    return this.json(`/v1/sessions/${id(value)}/fs/list?path=${encodeURIComponent(path)}`, { signal });
  }
  fsRead(value: string, path: string, signal: AbortSignal | null = null): Promise<FsContent> {
    return this.json(`/v1/sessions/${id(value)}/fs/read?path=${encodeURIComponent(path)}`, { signal });
  }
  fsWrite(value: string, input: { path: string; contentB64: string; createNew?: boolean; expectedVersion?: string }, signal: AbortSignal | null = null): Promise<FsWritten> {
    return this.json(`/v1/sessions/${id(value)}/fs/write`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  fsGet(value: string, path: string, offset: number, length: number, signal: AbortSignal | null = null): Promise<FsChunk> {
    const params = new URLSearchParams({ path, offset: String(offset), length: String(length) });
    return this.json(`/v1/sessions/${id(value)}/fs/get?${params}`, { signal });
  }
  fsPut(value: string, input: { path: string; offset: number; dataB64: string; final: boolean }, signal: AbortSignal | null = null): Promise<FsWritten> {
    return this.json(`/v1/sessions/${id(value)}/fs/put`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  fsMkdir(value: string, path: string, signal: AbortSignal | null = null): Promise<FsDone> {
    return this.json(`/v1/sessions/${id(value)}/fs/mkdir`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
  }
  fsRemove(value: string, path: string, signal: AbortSignal | null = null): Promise<FsDone> {
    return this.json(`/v1/sessions/${id(value)}/fs/remove`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
  }
  fsRename(value: string, path: string, to: string, signal: AbortSignal | null = null): Promise<FsDone> {
    return this.json(`/v1/sessions/${id(value)}/fs/rename`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ path, to }) });
  }
  projectSearch(value: string, input: { query: string; caseSensitive: boolean; wholeWord: boolean; pathFilter: string }, signal: AbortSignal | null = null, timeoutMs = 15_000): Promise<RustProjectSearchResult> {
    return this.json(`/v1/sessions/${id(value)}/search`, { method: "POST", signal, timeoutMs, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  gitStatus(value: string, signal: AbortSignal | null = null): Promise<GitStatusResult> {
    return this.json(`/v1/sessions/${id(value)}/git/status`, { signal });
  }
  gitDiff(value: string, path: string, staged: boolean, signal: AbortSignal | null = null): Promise<GitDiffResult> {
    const params = new URLSearchParams({ path, staged: String(staged) });
    return this.json(`/v1/sessions/${id(value)}/git/diff?${params}`, { signal });
  }
  gitHistory(value: string, signal: AbortSignal | null = null): Promise<GitHistoryResult> {
    return this.json(`/v1/sessions/${id(value)}/git/history`, { signal });
  }
  gitStage(value: string, paths: string[], unstage: boolean, signal: AbortSignal | null = null): Promise<GitDone> {
    return this.json(`/v1/sessions/${id(value)}/git/stage`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ paths, unstage }) });
  }
  gitDiscard(value: string, path: string, signal: AbortSignal | null = null): Promise<GitDone> {
    return this.json(`/v1/sessions/${id(value)}/git/discard`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
  }
  gitCommit(value: string, message: string, signal: AbortSignal | null = null, timeoutMs = 30_000): Promise<GitDone> {
    return this.json(`/v1/sessions/${id(value)}/git/commit`, { method: "POST", signal, timeoutMs, headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
  }

  async shutdown(signal: AbortSignal | null = null): Promise<void> { await this.json("/v1/shutdown", { method: "POST", signal }); }
  sessions(query: SessionQuery, signal: AbortSignal | null = null): Promise<SessionPage> {
    const params = new URLSearchParams();
    if (query.limit != null) params.set("limit", String(query.limit));
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.lifecycle) params.set("lifecycle", query.lifecycle);
    if (query.workspace != null) params.set("workspace", query.workspace);
    if (query.text != null) params.set("text", query.text);
    return this.json(`/v1/sessions?${params}`, { signal });
  }
  summary(workspace?: string, signal: AbortSignal | null = null): Promise<SessionSummary> {
    const params = new URLSearchParams();
    if (workspace != null) params.set("workspace", workspace);
    return this.json(`/v1/sessions/summary?${params}`, { signal });
  }
  workspaces(query: WorkspaceQuery, signal: AbortSignal | null = null): Promise<WorkspacePage> {
    const params = new URLSearchParams();
    if (query.limit != null) params.set("limit", String(query.limit));
    if (query.cursor != null) params.set("cursor", query.cursor);
    return this.json(`/v1/workspaces?${params}`, { signal });
  }
  lookup(ids: string[], signal: AbortSignal | null = null): Promise<SessionLookupResult> {
    if (ids.length > 100) throw new Error("Session lookup exceeds limit");
    return this.json("/v1/sessions/lookup", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ids.map(id) }) });
  }
  session(value: string, signal: AbortSignal | null = null): Promise<SessionHead> { return this.json(`/v1/sessions/${id(value)}`, { signal }); }
  rename(value: string, input: RenameSession, signal: AbortSignal | null = null): Promise<SessionHead> {
    return this.json(`/v1/sessions/${id(value)}`, { method: "PATCH", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  events(query: EventQuery, signal: AbortSignal | null = null): Promise<EventPage> {
    const params = new URLSearchParams({ scope: query.scope });
    if (query.afterSeq != null) params.set("afterSeq", String(query.afterSeq));
    if (query.limit != null) params.set("limit", String(query.limit));
    return this.json(`/v1/events?${params}`, { signal });
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

  // ── Orchestration (Stage 8) ─────────────────────────────────────────────
  listRuns(signal: AbortSignal | null = null): Promise<Run[]> { return this.json("/v1/runs", { signal }); }
  runSnapshot(value: string, signal: AbortSignal | null = null): Promise<RunSnapshot> {
    return this.json(`/v1/runs/${id(value)}`, { signal });
  }
  createRun(input: CreateRun, signal: AbortSignal | null = null): Promise<Run> {
    return this.json("/v1/runs", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  createRunGraph(input: CreateRunGraph, signal: AbortSignal | null = null): Promise<GraphMutationResult> {
    return this.json("/v1/runs/graph", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  applyTaskGraph(input: ApplyTaskGraph, signal: AbortSignal | null = null): Promise<GraphMutationResult> {
    return this.json("/v1/runs/graph/apply", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  completeRun(value: string, input: CompleteRun, signal: AbortSignal | null = null): Promise<Run> {
    return this.json(`/v1/runs/${id(value)}/complete`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  abandonRun(value: string, input: AbandonRun, signal: AbortSignal | null = null): Promise<Run> {
    return this.json(`/v1/runs/${id(value)}/abandon`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  deleteRun(value: string, input: Partial<DeleteRun> = {}, signal: AbortSignal | null = null): Promise<RunDeletionResult> {
    return this.json(`/v1/runs/${id(value)}`, { method: "DELETE", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  startAutomation(input: StartAutomation, signal: AbortSignal | null = null, timeoutMs = 180_000): Promise<Run> {
    return this.json(`/v1/runs/${id(input.runId)}/automation/start`, { method: "POST", signal, timeoutMs, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  pauseAutomation(runId: string, signal: AbortSignal | null = null): Promise<Run> {
    return this.json(`/v1/runs/${id(runId)}/automation/pause`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  }
  listTasks(runId?: string, signal: AbortSignal | null = null): Promise<Task[]> {
    const params = new URLSearchParams();
    if (runId != null) params.set("runId", runId);
    const suffix = params.size ? `?${params}` : "";
    return this.json(`/v1/tasks${suffix}`, { signal });
  }
  task(value: string, signal: AbortSignal | null = null): Promise<Task> {
    return this.json(`/v1/tasks/${id(value)}`, { signal });
  }
  createTask(input: CreateTask, signal: AbortSignal | null = null): Promise<Task> {
    return this.json("/v1/tasks", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  cancelTask(value: string, input: CancelTask, signal: AbortSignal | null = null): Promise<Task> {
    return this.json(`/v1/tasks/${id(value)}/cancel`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  retryTask(value: string, signal: AbortSignal | null = null): Promise<Task> {
    return this.json(`/v1/tasks/${id(value)}/retry`, { method: "POST", signal });
  }
  startWorker(input: StartWorker, signal: AbortSignal | null = null, timeoutMs = 180_000): Promise<WorkerStartOutcome> {
    return this.json("/v1/workers/start", { method: "POST", signal, timeoutMs, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  stopWorker(input: StopWorker, signal: AbortSignal | null = null): Promise<SettleOutcome> {
    return this.json("/v1/workers/stop", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  listWorktreeAssets(runId?: string, signal: AbortSignal | null = null): Promise<WorktreeAsset[]> {
    const params = new URLSearchParams();
    if (runId != null) params.set("runId", runId);
    const suffix = params.size ? `?${params}` : "";
    return this.json(`/v1/worktrees${suffix}`, { signal });
  }
  inspectWorktree(value: string, targetRef: string | null, signal: AbortSignal | null = null, timeoutMs = 180_000): Promise<WorktreeInspection> {
    return this.json(`/v1/worktrees/${id(value)}/inspect`, { method: "POST", signal, timeoutMs, headers: { "content-type": "application/json" }, body: JSON.stringify({ targetRef }) });
  }
  cleanupWorktree(value: string, input: CleanupWorktree, signal: AbortSignal | null = null, timeoutMs = 180_000): Promise<WorktreeCleanupResult> {
    return this.json(`/v1/worktrees/${id(value)}/cleanup`, { method: "POST", signal, timeoutMs, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  listDispatches(runId?: string, signal: AbortSignal | null = null): Promise<Dispatch[]> {
    const params = new URLSearchParams();
    if (runId != null) params.set("runId", runId);
    const suffix = params.size ? `?${params}` : "";
    return this.json(`/v1/dispatches${suffix}`, { signal });
  }
  settleDispatch(value: string, input: SettleDispatch, signal: AbortSignal | null = null): Promise<SettleOutcome> {
    return this.json(`/v1/dispatches/${id(value)}/settle`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  listGates(runId?: string, signal: AbortSignal | null = null): Promise<Gate[]> {
    const params = new URLSearchParams();
    if (runId != null) params.set("runId", runId);
    const suffix = params.size ? `?${params}` : "";
    return this.json(`/v1/gates${suffix}`, { signal });
  }
  resolveGate(value: string, input: ResolveGate, signal: AbortSignal | null = null): Promise<Gate> {
    return this.json(`/v1/gates/${id(value)}/resolve`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  createGate(runId: string, input: CreateGate, signal: AbortSignal | null = null): Promise<Gate> {
    return this.json(`/v1/runs/${id(runId)}/gates`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }

  // ── Skills ──────────────────────────────────────────────────────────────
  listSkills(cwd: string, signal: AbortSignal | null = null): Promise<Skill[]> {
    return this.json(`/v1/skills?cwd=${encodeURIComponent(cwd)}`, { signal }).then(page => (page as { items: Skill[] }).items);
  }
  skillSuggestions(sessionId: string, query: string, signal: AbortSignal | null = null): Promise<SkillSuggestion[]> {
    const params = new URLSearchParams({ kind: "skill", query });
    return this.json(`/v1/agent-sessions/${id(sessionId)}/suggestions?${params}`, { signal }).then(page => (page as { items: SkillSuggestion[] }).items);
  }

  schedules(signal: AbortSignal | null = null): Promise<ScheduledAgentTask[]> { return this.json("/v1/schedules", { signal }); }
  schedule(value: string, signal: AbortSignal | null = null): Promise<ScheduledAgentTask> {
    return this.json(`/v1/schedules/${encodeURIComponent(scheduleId(value))}`, { signal });
  }
  createSchedule(input: ScheduleCreate, signal: AbortSignal | null = null): Promise<ScheduledAgentTask> {
    return this.json("/v1/schedules", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  updateSchedule(value: string, input: ScheduleUpdate, signal: AbortSignal | null = null): Promise<ScheduledAgentTask> {
    return this.json(`/v1/schedules/${encodeURIComponent(scheduleId(value))}`, { method: "PATCH", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }
  pauseSchedule(value: string, signal: AbortSignal | null = null): Promise<ScheduledAgentTask> {
    return this.json(`/v1/schedules/${encodeURIComponent(scheduleId(value))}/pause`, { method: "POST", signal });
  }
  resumeSchedule(value: string, signal: AbortSignal | null = null): Promise<ScheduledAgentTask> {
    return this.json(`/v1/schedules/${encodeURIComponent(scheduleId(value))}/resume`, { method: "POST", signal });
  }
  deleteSchedule(value: string, signal: AbortSignal | null = null): Promise<{ id: string; deleted: boolean }> {
    return this.json(`/v1/schedules/${encodeURIComponent(scheduleId(value))}`, { method: "DELETE", signal });
  }
  runSchedule(value: string, signal: AbortSignal | null = null, timeoutMs = 180_000): Promise<ScheduleRunResult> {
    return this.json(`/v1/schedules/${encodeURIComponent(scheduleId(value))}/run`, { method: "POST", signal, timeoutMs });
  }

  plugins(signal: AbortSignal | null = null): Promise<PublicPluginDiscoveryResult> { return this.json("/v1/plugins", { signal }); }
  pluginServices(signal: AbortSignal | null = null): Promise<PluginServiceList> { return this.json("/v1/plugin-services", { signal }); }
  pluginServiceAction(plugin: string, service: string, action: "start" | "stop" | "restart" | "health", signal: AbortSignal | null = null, timeoutMs = 30_000): Promise<PluginServiceView> {
    const method = action === "health" ? "GET" : "POST";
    return this.json(`/v1/plugin/${encodeURIComponent(plugin)}/service/${encodeURIComponent(service)}/${action}`, { method, signal, timeoutMs });
  }

  // ── Accounts (native discovery + managed Claude accounts) ───────────────
  listAccounts(requestId: string, signal: AbortSignal | null = null, timeoutMs = 15_000): Promise<AccountListResult> {
    return this.accountControl({ type: "agent.accounts.list", requestId }, signal, timeoutMs);
  }

  /** Tag-dispatched managed-account control; the daemon re-snapshots and
   * returns the full account list (plus sessionId for login). */
  accountControl(body: Record<string, unknown>, signal: AbortSignal | null = null, timeoutMs = 30_000): Promise<AccountListResult> {
    return this.json("/v1/accounts", {
      method: "POST",
      signal,
      timeoutMs,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Same endpoint, dedicated feature envelopes such as
   * `agent.account.api.models.result` (errors encoded in-body). */
  accountFeature(body: Record<string, unknown>, signal: AbortSignal | null = null, timeoutMs = 35_000): Promise<Record<string, unknown>> {
    return this.json("/v1/accounts", {
      method: "POST",
      signal,
      timeoutMs,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  modelSource(body: Record<string, unknown>, signal: AbortSignal | null = null, timeoutMs = 45_000): Promise<SourceResult> {
    return this.json("/v1/model-sources", {
      method: "POST",
      signal,
      timeoutMs,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ── Launch model catalog ────────────────────────────────────────────────
  launchModels(agent: "claude" | "codex" | "deepseek" | "opencode" = "claude", accountId?: string, signal: AbortSignal | null = null, timeoutMs = 30_000): Promise<LaunchModelCatalog> {
    const params = new URLSearchParams({ agent });
    if (accountId) params.set("accountId", accountId);
    return this.json(`/v1/launch/models?${params.toString()}`, { signal, timeoutMs });
  }
}
