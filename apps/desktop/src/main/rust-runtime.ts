import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { SessionHead, TimelineQuery, TimelineTextQuery } from "@prospero/protocol/rust-daemon";
import type { DesktopSnapshot, JsonObject, SessionInfo, SessionPage, SessionPageRequest } from "../shared/types";
import { StateStore } from "./state-store";
import { RustProcess, type RustConnection } from "./rust-process";
import { orchestrationAction, readOrchestrationWindow, settleDispatchInput } from "./rust-orchestration";

export function rustSessionInfo(head: SessionHead): SessionInfo {
  return { id: head.id, agent: head.agent, kind: head.kind, ...(head.kind === "pty" ? { terminalMode: "events" as const } : { historyMode: "paged" as const }), title: head.title, cwd: head.workspace, status: head.status === "waiting_permission" ? "waiting_approval" : head.status, createdAt: head.createdAt, pendingPermissions: head.status === "waiting_permission" ? 1 : 0, pendingQuestions: head.status === "waiting_input" ? 1 : 0 };
}

export class RustRuntime {
  private readonly process: RustProcess;
  private connection: RustConnection | undefined;
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private starting: Promise<{ ok: boolean; error?: string }> | undefined;
  private stopping: Promise<{ ok: boolean; error?: string }> | undefined;
  private refreshing: Promise<void> | undefined;
  private sequence = 0;
  private orchestrationSequence = 0;
  private ready = false;
  private terminalWrites = new Map<string, { count: number; bytes: number; failed: boolean; tail: Promise<void> }>();

  constructor(private readonly store: StateStore, binary: string, directory: string) {
    if (store.backend !== "api") throw new Error("Rust requires API-only desktop state");
    this.process = new RustProcess(binary, directory, () => {
      this.controller.abort(); clearTimeout(this.timer); this.ready = false; this.connection = undefined;
      this.clearState();
      this.store.setManagedState(undefined, false, this.stopping ? undefined : "Rust 服务已退出");
    });
  }

  get managed(): boolean { return this.process.managed; }
  describeRuntime(): string { return this.process.binary; }

  start(): Promise<{ ok: boolean; error?: string }> {
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.ready && this.managed) return Promise.resolve({ ok: true });
    if (!this.starting) this.starting = this.launch().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async launch(): Promise<{ ok: boolean; error?: string }> {
    this.controller = new AbortController();
    this.store.setStartupProgress(10, "启动 Rust 服务");
    try {
      this.connection = await this.process.start();
      if (this.controller.signal.aborted) throw new Error("启动已取消");
      this.store.setStartupProgress(70, "读取会话摘要", this.connection.pid);
      await this.refresh();
      this.ready = true;
      this.store.setManagedState(this.connection.pid, false);
      this.schedule();
      return { ok: true };
    } catch {
      await this.process.stop();
      this.clearState();
      const error = "Rust 服务启动失败，请检查实验构建和独立数据目录";
      this.store.setManagedState(undefined, false, error);
      return { ok: false, error };
    }
  }

  stop(): Promise<{ ok: boolean; error?: string }> {
    if (!this.stopping) this.stopping = this.terminate().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async terminate(): Promise<{ ok: boolean; error?: string }> {
    this.controller.abort(); clearTimeout(this.timer); this.ready = false;
    try {
      await this.process.stop();
      await this.starting;
      await this.refreshing?.catch(() => {});
      this.connection = undefined; this.clearState(); this.store.setManagedState(undefined, false);
      return { ok: true };
    } catch { return { ok: false, error: "Rust 服务关闭失败" }; }
  }

  async restart(): Promise<{ ok: boolean; error?: string }> {
    const stopped = await this.stop();
    if (!stopped.ok) return stopped;
    await this.starting;
    return this.start();
  }

  private clearState(): void {
    this.store.setApiState({ running: false, config: { bind: "127.0.0.1", port: 0 }, status: {}, devices: {}, orchestration: {}, projects: [] });
  }

  private current(): RustConnection {
    if (!this.connection || this.controller.signal.aborted) throw new Error("Rust 服务尚未就绪");
    return this.connection;
  }

  private refresh(force = false): Promise<void> {
    if (this.refreshing) return force ? this.refreshing.then(() => this.refresh()) : this.refreshing;
    this.refreshing = this.readWindow().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async readWindow(): Promise<void> {
    const { client, pid, baseUrl } = this.current();
    const signal = this.controller.signal;
    const orchCursor = await client.events({ scope: "orchestration", afterSeq: this.orchestrationSequence, limit: 1 }, signal).catch(() => null);
    const [summary, active, recent, workspaces, health, orchestration] = await Promise.all([
      client.summary(undefined, signal),
      client.sessions({ limit: 100, cursor: null, lifecycle: "active", workspace: null, text: null }, signal),
      client.sessions({ limit: 20, cursor: null, lifecycle: "archived", workspace: null, text: null }, signal),
      client.workspaces({ limit: 100, cursor: null }, signal),
      client.health(signal),
      orchCursor
        ? readOrchestrationWindow(client, signal, orchCursor.latestSeq).catch((error: unknown) => {
          // Orchestration is additive; a failure here must not blank the session list.
          this.store.appendLog(`[rust] orchestration read failed: ${error instanceof Error ? error.message : String(error)}\n`);
          return null;
        })
        : Promise.resolve(null),
    ]);
    signal.throwIfAborted();
    if (orchCursor) this.orchestrationSequence = orchCursor.latestSeq;
    const sessions = [...active.items, ...recent.items].map(rustSessionInfo);
    this.sequence = Math.min(summary.latestSeq, active.latestSeq, recent.latestSeq, workspaces.latestSeq);
    this.store.setApiState({ running: true, config: {}, devices: {}, orchestration: orchestration ?? {}, projects: workspaces.items.map(item => item.workspace), status: {
      pid, port: Number(new URL(baseUrl).port), bind: "127.0.0.1", sessions, capabilities: health.capabilities,
      metadataRevision: `${pid}:${this.sequence}`,
      workspaceCounts: Object.fromEntries(workspaces.items.map(({ workspace, summary }) => [workspace, { revision: summary.revision, total: summary.total, active: summary.active, archived: summary.archived, attention: summary.attention }])),
      sessionSummary: { total: summary.total, active: summary.active, terminal: summary.archived, attention: summary.attention, activeLimit: 100, attentionLimit: 0, recentTerminalLimit: 20 },
    } });
  }

  private schedule(delay = 500): void {
    clearTimeout(this.timer);
    if (!this.ready || this.controller.signal.aborted) return;
    this.timer = setTimeout(() => { void this.poll(); }, delay);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    let delay = 500;
    try {
      const { client } = this.current();
      const [sessions, orchestration] = await Promise.all([
        client.events({ scope: "sessions", afterSeq: this.sequence, limit: 100 }, this.controller.signal),
        client.events({ scope: "orchestration", afterSeq: this.orchestrationSequence, limit: 100 }, this.controller.signal),
      ]);
      if (sessions.resyncRequired || sessions.latestSeq !== this.sequence
        || orchestration.resyncRequired || orchestration.latestSeq !== this.orchestrationSequence) {
        await this.refresh();
      }
    } catch { delay = 2000; }
    finally { this.schedule(delay); }
  }

  async listSessions(request: SessionPageRequest, cancellation?: AbortSignal): Promise<SessionPage> {
    const { client } = this.current();
    const signal = cancellation ? AbortSignal.any([cancellation, this.controller.signal]) : this.controller.signal;
    if (request.ids) {
      if (request.query || request.workspace) throw new Error("ID 查询不支持叠加筛选");
      const ids = [...new Set(request.ids)];
      const key = createHash("sha256").update(JSON.stringify([ids, request.terminal === true])).digest("hex");
      let start = 0;
      if (request.cursor) {
        let cursor: { key?: unknown; id?: unknown };
        try { cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) as typeof cursor; } catch { throw new Error("会话游标无效"); }
        if (!cursor || cursor.key !== key || typeof cursor.id !== "string" || !ids.includes(cursor.id)) throw new Error("会话游标与筛选不匹配");
        start = ids.indexOf(cursor.id) + 1;
      }
      const result = await client.lookup(ids, signal);
      const heads = result.items.filter(head => !request.terminal || head.lifecycle === "archived");
      const remaining = heads.filter(head => ids.indexOf(head.id) >= start);
      const items = remaining.slice(0, request.limit ?? 100);
      return { items: items.map(rustSessionInfo), total: heads.length, active: result.items.filter(head => head.lifecycle === "active").length, terminal: result.items.filter(head => head.lifecycle === "archived").length,
        ...(remaining.length > items.length && items.length ? { nextCursor: Buffer.from(JSON.stringify({ key, id: items.at(-1)!.id })).toString("base64url") } : {}),
      };
    }
    const [page, summary] = await Promise.all([
      client.sessions({ limit: request.limit ?? 100, cursor: request.cursor ?? null, lifecycle: request.terminal ? "archived" : null, text: request.query ?? null, workspace: request.workspace ?? null }, signal),
      client.summary(request.workspace, signal),
    ]);
    return { items: page.items.map(rustSessionInfo), total: page.total, active: summary.active, terminal: summary.archived, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), ...(page.previousCursor ? { previousCursor: page.previousCursor } : {}) };
  }

  async rename(id: string, title: string): Promise<DesktopSnapshot> {
    const { client } = this.current();
    const signal = this.controller.signal;
    const head = await client.session(id, signal);
    await client.rename(id, { revision: head.revision, title: title.trim() }, signal);
    await this.refresh(true);
    return this.store.snapshot();
  }

  readTimeline(id: string, query: TimelineQuery, signal: AbortSignal) { return this.current().client.timeline(id, query, AbortSignal.any([signal, this.controller.signal])); }
  readTimelineChanges(id: string, after: number, signal: AbortSignal) { return this.current().client.events({ scope: `timeline:${id}`, afterSeq: after, limit: 100 }, AbortSignal.any([signal, this.controller.signal])); }
  lookupTimeline(id: string, ids: string[], signal: AbortSignal) { return this.current().client.timelineLookup(id, ids, AbortSignal.any([signal, this.controller.signal])); }
  readTimelineText(id: string, record: string, query: TimelineTextQuery, signal: AbortSignal) { return this.current().client.timelineText(id, record, query, AbortSignal.any([signal, this.controller.signal])); }

  private async terminalView(id: string, cursor: number | undefined, wait: number, signal: AbortSignal): Promise<JsonObject | null> {
    const { client } = this.current();
    if (cursor === undefined) {
      const snapshot = await client.terminalSnapshot(id, signal);
      if (snapshot) return { kind: "pty", mode: "snapshot", seq: snapshot.seq, cols: snapshot.size.cols, rows: snapshot.size.rows, dataB64: snapshot.dataB64 };
    }
    const page = await client.terminalOutput(id, { afterSeq: cursor ?? 0, waitMs: Math.min(wait, 5000) }, signal);
    if (page.resyncRequired) {
      const snapshot = await client.terminalSnapshot(id, signal);
      if (!snapshot) throw new Error("终端历史已超出保留窗口，当前内容尚不能完整恢复；请保留已打开的窗口");
      return { kind: "pty", mode: "snapshot", seq: snapshot.seq, cols: snapshot.size.cols, rows: snapshot.size.rows, dataB64: snapshot.dataB64 };
    }
    if (!page.events.length && cursor !== undefined && !page.exited) return null;
    return { kind: "pty", mode: "events", seq: page.nextSeq, baseSeq: page.baseSeq, cols: page.initialSize.cols, rows: page.initialSize.rows, events: page.events, exited: page.exited, caughtUp: page.nextSeq === page.latestSeq };
  }

  private async terminalWrite(id: string, data: string, signal: AbortSignal): Promise<void> {
    if (data.length > 1_398_104) throw new Error("终端输入无效或超过 1 MiB");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > 1024 * 1024 || bytes.toString("base64") !== data) throw new Error("终端输入无效或超过 1 MiB");
    const { client } = this.current();
    const queue = this.terminalWrites.get(id) ?? { count: 0, bytes: 0, failed: false, tail: Promise.resolve() };
    if (queue.count >= 32 || queue.bytes + bytes.length > 1024 * 1024) throw new Error("终端输入队列已满");
    this.terminalWrites.set(id, queue); queue.count++; queue.bytes += bytes.length;
    const job = queue.tail.then(async () => {
      if (queue.failed) throw new Error("之前的终端输入未完成，请检查会话状态");
      for (let offset = 0; offset < bytes.length; offset += 8192) await client.terminalInput(id, bytes.subarray(offset, offset + 8192), signal);
    });
    queue.tail = job.catch(() => { queue.failed = true; });
    try { await job; } finally {
      queue.count--; queue.bytes -= bytes.length;
      if (!queue.count) this.terminalWrites.delete(id);
    }
  }

  async request(path: string, init?: { method?: "GET" | "POST"; body?: JsonObject; signal?: AbortSignal; timeoutMs?: number; acceptJsonError?: boolean }): Promise<JsonObject | null> {
    const signal = init?.signal ? AbortSignal.any([init.signal, this.controller.signal]) : this.controller.signal;
    const input = init?.body;
    if (path === "/_prospero/control/orchestration/action" && init?.method === "POST" && input) {
      const method = input["method"];
      if (typeof method !== "string") throw new Error("不支持的编排操作");
      const result = await orchestrationAction(this.current().client, method, input["params"], signal, init.timeoutMs);
      await this.refresh(true);
      return result;
    }
    const taskRoute = /^\/_prospero\/control\/orchestration\/task\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (taskRoute && (!init?.method || init.method === "GET")) {
      return this.current().client.task(taskRoute[1]!, signal) as Promise<JsonObject>;
    }
    const runTasksRoute = /^\/_prospero\/control\/orchestration\/run\/([A-Za-z0-9_-]{1,128})\/tasks$/.exec(path);
    if (runTasksRoute && (!init?.method || init.method === "GET")) {
      const items = await this.current().client.listTasks(runTasksRoute[1]!, signal);
      return { items } as JsonObject;
    }
    const gateRoute = /^\/_prospero\/control\/orchestration\/gate\/([A-Za-z0-9_-]{1,128})\/resolve$/.exec(path);
    if (gateRoute && init?.method === "POST" && input) {
      const decision = input["decision"];
      if (typeof decision !== "string" || !decision.trim()) throw new Error("决策无效");
      const gate = await this.current().client.resolveGate(gateRoute[1]!, { decision: decision.trim() }, signal);
      await this.refresh(true);
      return gate as unknown as JsonObject;
    }
    const settleRoute = /^\/_prospero\/control\/orchestration\/dispatch\/([A-Za-z0-9_-]{1,128})\/settle$/.exec(path);
    if (settleRoute && init?.method === "POST" && input) {
      const outcome = await this.current().client.settleDispatch(settleRoute[1]!, settleDispatchInput(input), signal);
      await this.refresh(true);
      return outcome as unknown as JsonObject;
    }
    const skillsRoute = /^\/_prospero\/control\/skills(?:\?(.*))?$/.exec(path);
    if (skillsRoute && (!init?.method || init.method === "GET")) {
      const cwd = new URLSearchParams(skillsRoute[1] ?? "").get("cwd") ?? "";
      if (!cwd || !isAbsolute(cwd)) throw new Error("工作区路径无效");
      const items = await this.current().client.listSkills(cwd, signal);
      return { items } as JsonObject;
    }
    const suggestionsRoute = /^\/_prospero\/control\/session\/([A-Za-z0-9_-]{1,128})\/suggestions(?:\?(.*))?$/.exec(path);
    if (suggestionsRoute && (!init?.method || init.method === "GET")) {
      const params = new URLSearchParams(suggestionsRoute[2] ?? "");
      if (params.get("kind") !== "skill") throw new Error("Skill 查询无效");
      const query = params.get("query") ?? "";
      if (query.length > 200) throw new Error("Skill 查询无效");
      const items = await this.current().client.skillSuggestions(suggestionsRoute[1]!, query, signal);
      return { items } as JsonObject;
    }
    if (path === "/_prospero/control/session/create" && init?.method === "POST" && input) {
      if (input["kind"] === "pty") {
        if (input["agent"] !== "shell" || input["command"] || input["accountId"] || input["model"]) throw new Error("Rust 当前支持普通 shell 终端，自定义命令尚未接入");
        const head = await this.current().client.createTerminal({ title: "Terminal", workspace: String(input["cwd"]), size: { cols: Number(input["cols"] ?? 120), rows: Number(input["rows"] ?? 40) } }, signal);
        await this.refresh(true);
        return rustSessionInfo(head);
      }
      if (input["agent"] !== "claude") throw new Error("Rust Agent 当前仅接入 Claude Code");
      if (input["kind"] !== "structured" || input["command"] || input["accountId"] || input["model"] || input["mode"] || input["effort"]) throw new Error("此 Agent 选项尚未接入 Rust daemon");
      const policy = input["approvalPolicy"];
      if (policy !== "strict" && policy !== "standard" && policy !== "yolo") throw new Error("审批策略无效");
      const head = await this.current().client.createAgentSession({
        title: "Claude",
        workspace: String(input["cwd"]),
        autoApprove: policy === "yolo",
      }, signal);
      await this.refresh(true);
      return rustSessionInfo(head);
    }
    const route = /^\/_prospero\/control\/session\/([A-Za-z0-9_-]{1,128})\/(view|interact|interrupt|kill)(?:\?(.*))?$/.exec(path);
    if (route) {
      const id = route[1]!; const action = route[2]; const { client } = this.current();
      const kind = await this.sessionKind(id, signal);
      if (action === "view" && (!init?.method || init.method === "GET")) {
        if (kind === "structured") return null;
        const params = new URLSearchParams(route[3]);
        return this.terminalView(id, params.has("outputAfterSeq") ? Number(params.get("outputAfterSeq")) : undefined, Number(params.get("waitMs") ?? 0), signal);
      }
      if (init?.method === "POST") {
        if (kind === "structured") {
          if (action === "interact" && input?.["type"] === "chat.send") {
            if (Array.isArray(input["attachments"]) && input["attachments"].length) throw new Error("Rust Agent 暂不支持图片附件");
            const text = input["text"];
            if (typeof text !== "string" || !text.trim()) throw new Error("消息内容无效");
            await client.agentSend(id, { text }, signal);
            return { ok: true };
          }
          if (action === "interact" && input?.["type"] === "permission.respond") {
            const requestId = input["reqId"];
            if (typeof requestId !== "string") throw new Error("审批请求无效");
            const reply = input["reply"];
            if (reply !== "once" && reply !== "always" && reply !== "reject") throw new Error("审批回复无效");
            await client.agentPermission(id, { requestId, allow: reply !== "reject" }, signal);
            return { ok: true };
          }
          if (action === "interrupt") { await client.agentInterrupt(id, signal); return { ok: true }; }
          if (action === "kill") { await client.agentClose(id, signal); await this.refresh(true); return { ok: true }; }
          throw new Error("此 Agent 操作尚未接入 Rust daemon");
        }
        if (action === "interact" && input?.["type"] === "term.input" && typeof input["dataB64"] === "string") { await this.terminalWrite(id, input["dataB64"], signal); return { ok: true }; }
        if (action === "interact" && input?.["type"] === "term.resize") return client.terminalResize(id, { cols: Number(input["cols"]), rows: Number(input["rows"]) }, signal);
        if (action === "interrupt") { await this.terminalWrite(id, "Aw==", signal); return { ok: true }; }
        if (action === "kill") return client.terminalClose(id, signal);
      }
    }
    throw new Error("此功能尚未接入 Rust daemon");
  }

  private async sessionKind(id: string, signal: AbortSignal): Promise<"structured" | "pty"> {
    const known = this.store.snapshot().daemon.sessions.find(session => session.id === id);
    if (known?.kind === "structured" || known?.kind === "pty") return known.kind;
    const head = await this.current().client.session(id, signal);
    return head.kind;
  }

  async runCli(_args: string[]): Promise<{ code: number; output: string }> {
    return { code: 1, output: "此功能尚未接入 Rust daemon" };
  }
}
