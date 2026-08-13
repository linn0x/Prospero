/**
 * 主机连接。
 *
 * 设计要点(都是为了"切网无感"这一个目标):
 * - 多地址并发竞速:WiFi 与 WireGuard 地址同时试,先完成 E2E 握手者胜;
 * - 地址学习:成功过的地址排到最前,下次优先命中,省掉竞速时间;
 * - 心跳:iOS 切后台/切网常留下"半开"连接 —— socket 看似 OPEN 但收发已死,
 *   只靠 onclose 会卡住几十秒。心跳超时即主动断开重连;
 * - 失败诊断:逐地址记录失败原因,合成一条用户能照做的提示;
 * - 发送排队:断线瞬间的用户操作不丢,重连后按序补发。
 */
import { AppState, Platform } from "react-native";
import { randomUUID } from "expo-crypto";
import {
  CAPABILITY_AGENT_ACCOUNTS,
  CAPABILITY_AGENT_API_PROFILES,
  CAPABILITY_CHAT_ATTACHMENT_PREVIEWS,
  CAPABILITY_ORCHESTRATION_AUTOMATION,
  CAPABILITY_ORCHESTRATION_GRAPH,
  CAPABILITY_ORCHESTRATION_LIFECYCLE,
  CAPABILITY_ORCHESTRATION_MANAGEMENT,
  CAPABILITY_ORCHESTRATION_MANUAL,
  CAPABILITY_ORCHESTRATION_SNAPSHOT,
  CAPABILITY_SESSION_CREATE_MODEL,
  CAPABILITY_SUBAGENT_HISTORY,
  CLOSE_AUTH_FAILED,
  CLOSE_REVOKED,
  SUPPORTED_PROTOCOL_VERSIONS,
  clientHandshakeStart,
  clientHandshakeFinish,
  parseS2C,
  toB64,
  utf8Encode,
  ProtocolError,
  type AgentKind,
  type AgentAccount,
  type AgentAccountsResult,
  type AgentCredentialKind,
  type CodeAgentKind,
  type AgentEventBody,
  type AgentQuestionAnswer,
  type ApprovalPolicy,
  type Attachment,
  type ChatDelivery,
  type ChatSuggestionKind,
  type C2SMessage,
  type KeyPairB64,
  type PermissionReply,
  type OrchestrationGraphNodeInput,
  type ResumableConversation,
  type S2CAgentEvent,
  type S2CChatSnapshot,
  type S2CChatSuggestions,
  type S2CError,
  type S2CHelloOk,
  type S2CMessage,
  type S2COrchestrationSnapshot,
  type S2CTermOutput,
  type S2CTermSnapshot,
  type S2CToolOutput,
  type SecureChannel,
  type SessionKind,
} from "@prospero/protocol";
import { diagnose, type AttemptResult, type Diagnosis } from "./connect-diagnosis";
import { Emitter } from "./emitter";
import { rememberGoodAddr, type StoredHost } from "./hosts";
import {
  BoundedQueue,
  acceptedDelivery,
  rejectedDelivery,
  type DeliveryResult,
} from "./outbound-queue";
import { useApp } from "./store";

export type { DeliveryResult } from "./outbound-queue";

const APP_VERSION = "0.0.12";
const ATTEMPT_TIMEOUT_MS = 6000;
const BACKOFF_MIN = 400;
const BACKOFF_MAX = 8000;
/** 心跳间隔与容忍的静默时长(daemon 每 15s ping 一次) */
const HEARTBEAT_MS = 10_000;
const SILENCE_LIMIT_MS = 35_000;
/** 断线期间最多排队多少条待发消息 */
export const MAX_OFFLINE_QUEUE = 50;
const CLIENT_PLATFORM = Platform.OS === "android" ? "android" : "ios";

interface Won {
  ws: WebSocket;
  channel: SecureChannel;
  helloOk: S2CHelloOk;
  addr: string;
  rttMs: number;
  protocolVersion: number;
}

export interface ConnEvents extends Record<string, unknown> {
  connected: { addr: string; rttMs: number };
  disconnected: { willRetry: boolean };
  snapshot: S2CTermSnapshot;
  output: S2CTermOutput;
  chatSnapshot: S2CChatSnapshot;
  agentEvent: S2CAgentEvent;
  toolOutput: S2CToolOutput;
  orchestrationSnapshot: S2COrchestrationSnapshot;
  serverError: S2CError;
  /** 验收打点:A1 attach 上屏、A5 回前台恢复 */
  metric: { name: "attach" | "resume"; sid?: string; ms: number };
}

export class HostConnection {
  readonly events = new Emitter<ConnEvents>();
  activeAddr: string | null = null;
  lastRttMs: number | null = null;
  diagnosis: Diagnosis | null = null;

  private ws: WebSocket | null = null;
  private channel: SecureChannel | null = null;
  private connecting = false;
  private stopped = false;
  private backoff = BACKOFF_MIN;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastRecvAt = 0;
  private everConnected = false;
  private negotiatedProtocolVersion: number | null = null;
  /** null 表示旧 daemon 未声明能力；空 Set 表示新 daemon 明确拒绝所有可选能力。 */
  private advertisedCapabilities: Set<string> | null = null;
  /** 断线期间排队的消息,重连后按序补发 */
  private queue = new BoundedQueue<C2SMessage>(MAX_OFFLINE_QUEUE);

  constructor(
    readonly host: StoredHost,
    private readonly keys: KeyPairB64,
  ) {}

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === 1 && this.channel !== null;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  supportsCapability(capability: string): boolean {
    if (this.advertisedCapabilities !== null) {
      return this.advertisedCapabilities.has(capability);
    }
    const version = this.negotiatedProtocolVersion ?? 0;
    if (capability === CAPABILITY_ORCHESTRATION_SNAPSHOT) return version >= 7;
    if (capability === CAPABILITY_ORCHESTRATION_MANUAL) return version >= 8;
    if (capability === CAPABILITY_SUBAGENT_HISTORY) return version >= 9;
    if (capability === CAPABILITY_AGENT_ACCOUNTS) return version >= 10;
    if (capability === CAPABILITY_AGENT_API_PROFILES) return version >= 12;
    if (capability === CAPABILITY_CHAT_ATTACHMENT_PREVIEWS) return version >= 11;
    if (capability === CAPABILITY_SESSION_CREATE_MODEL) return version >= 11;
    return false;
  }

  get supportsOrchestrationSnapshot(): boolean {
    return this.supportsCapability(CAPABILITY_ORCHESTRATION_SNAPSHOT);
  }

  get supportsManualOrchestration(): boolean {
    return this.supportsCapability(CAPABILITY_ORCHESTRATION_MANUAL);
  }

  get supportsGraphOrchestration(): boolean {
    return this.supportsCapability(CAPABILITY_ORCHESTRATION_GRAPH);
  }

  get supportsAutomationOrchestration(): boolean {
    return this.supportsCapability(CAPABILITY_ORCHESTRATION_AUTOMATION);
  }

  get supportsOrchestrationManagement(): boolean {
    return this.supportsCapability(CAPABILITY_ORCHESTRATION_MANAGEMENT);
  }

  get supportsOrchestrationLifecycle(): boolean {
    return this.supportsCapability(CAPABILITY_ORCHESTRATION_LIFECYCLE);
  }

  get supportsSubagentHistory(): boolean {
    return this.supportsCapability(CAPABILITY_SUBAGENT_HISTORY);
  }

  get supportsAgentAccounts(): boolean {
    return this.supportsCapability(CAPABILITY_AGENT_ACCOUNTS);
  }

  get supportsAgentApiProfiles(): boolean {
    return this.supportsCapability(CAPABILITY_AGENT_API_PROFILES);
  }

  get supportsChatAttachmentPreviews(): boolean {
    return this.supportsCapability(CAPABILITY_CHAT_ATTACHMENT_PREVIEWS);
  }

  get supportsSessionCreateModel(): boolean {
    return this.supportsCapability(CAPABILITY_SESSION_CREATE_MODEL);
  }

  start(): void {
    this.stopped = false;
    if (this.connecting || this.isConnected) return;
    void this.connectOnce();
  }

  /** 回前台 / 网络变化 / 用户手动重试:清退避立即连 */
  kick(): void {
    this.backoff = BACKOFF_MIN;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.isConnected) return;
    this.start();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.channel = null;
    this.activeAddr = null;
    this.queue.clear();
    useApp.getState().patchRuntime(this.host.id, { status: "idle", activeAddr: null });
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private patch(patch: Parameters<ReturnType<typeof useApp.getState>["patchRuntime"]>[1]): void {
    useApp.getState().patchRuntime(this.host.id, patch);
  }

  private async connectOnce(): Promise<void> {
    if (this.connecting || this.stopped) return;
    this.connecting = true;
    this.patch({ status: this.everConnected ? "reconnecting" : "connecting" });
    try {
      const won = await this.race();
      this.adopt(won);
    } catch {
      this.connecting = false;
      const d = this.diagnosis;
      this.patch({
        status: "failed",
        lastError: d ? `${d.summary} — ${d.hint}` : "连接失败",
      });
      if (d?.fatal !== true && !this.stopped) this.scheduleRetry();
    }
  }

  /** 成功过的地址优先,其余保持原序 */
  private orderedAddrs(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const preferred = this.host.lastGoodAddr;
    if (preferred) {
      out.push(preferred);
      seen.add(preferred);
    }
    for (const a of this.host.addrs) {
      if (!seen.has(a)) {
        out.push(a);
        seen.add(a);
      }
    }
    return out;
  }

  private race(): Promise<Won> {
    const addrs = this.orderedAddrs();
    return new Promise<Won>((resolve, reject) => {
      if (addrs.length === 0) {
        this.diagnosis = diagnose([], !this.everConnected, CLIENT_PLATFORM);
        reject(new Error(this.diagnosis.summary));
        return;
      }
      let pending = addrs.length;
      let done = false;
      const failures: AttemptResult[] = [];

      const finishFailure = (): void => {
        if (done) return;
        done = true;
        this.diagnosis = diagnose(failures, !this.everConnected, CLIENT_PLATFORM);
        reject(new Error(this.diagnosis.summary));
      };

      for (const addr of addrs) {
        const startedAt = Date.now();

        const tryVersion = (versionIndex: number): void => {
          const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS[versionIndex];
          if (protocolVersion === undefined) return;
          let ws: WebSocket;
          try {
            ws = new WebSocket(`ws://${addr}:${this.host.port}/ws`);
          } catch (e) {
            failures.push({
              addr,
              failure: "unreachable",
              detail: e instanceof Error ? e.message : undefined,
            });
            if (--pending === 0) finishFailure();
            return;
          }

          // 同一地址先尝试最新版本；收到明确的 version 关闭原因后才用新连接回退。
          // v8+ 的版本已绑定进身份证明，v7/v5 保留原帧以兼容已经安装的 daemon。
          const { frame, state: hsState } = clientHandshakeStart(protocolVersion);
          let channel: SecureChannel | null = null;
          let opened = false;
          let attemptDone = false;

          const fail = (failure: AttemptResult["failure"], detail?: string): void => {
            if (attemptDone) return;
            attemptDone = true;
            clearTimeout(timer);
            ws.onopen = null;
            ws.onmessage = null;
            ws.onerror = null;
            ws.onclose = null;
            try {
              ws.close();
            } catch {
              // 已关闭
            }
            if (done) return;
            if (
              failure === "version" &&
              versionIndex + 1 < SUPPORTED_PROTOCOL_VERSIONS.length
            ) {
              tryVersion(versionIndex + 1);
              return;
            }
            failures.push({ addr, ...(detail !== undefined ? { detail } : {}), failure });
            if (failure === "auth") {
              // 鉴权失败对所有地址都成立,不必等其余
              finishFailure();
              return;
            }
            if (--pending === 0) finishFailure();
          };

          const timer = setTimeout(() => fail("timeout"), ATTEMPT_TIMEOUT_MS);
          ws.onopen = () => {
            opened = true;
            ws.send(frame);
          };
          ws.onerror = () => fail(opened ? "handshake" : "unreachable");
          ws.onclose = (ev) => {
            if (!opened) {
              fail("unreachable");
              return;
            }
            const code = (ev as { code?: number } | undefined)?.code;
            const reason = String((ev as { reason?: unknown } | undefined)?.reason ?? "");
            if (code === CLOSE_AUTH_FAILED) fail("auth", reason || undefined);
            else if (code === CLOSE_REVOKED) fail("revoked", reason || undefined);
            else if (reason === "version") fail("version");
            else fail("handshake", reason || undefined);
          };
          ws.onmessage = (ev) => {
            try {
              if (channel === null) {
                const finished = clientHandshakeFinish(
                  hsState,
                  String(ev.data),
                  this.host.daemonPub,
                  {
                    type: "hello",
                    token: this.host.token,
                    clientPubKey: this.keys.publicKey,
                    clientInfo: {
                      platform: Platform.OS === "android" ? "android" : "ios",
                      appVersion: APP_VERSION,
                    },
                  },
                );
                channel = finished.channel;
                ws.send(finished.frame);
                return;
              }
              const msg = parseS2C(channel.open(String(ev.data)));
              if (msg.type === "error" && msg.code === "auth_failed") {
                fail("auth", msg.message);
                return;
              }
              if (msg.type !== "hello.ok") {
                fail("handshake", `unexpected ${msg.type}`);
                return;
              }
              attemptDone = true;
              clearTimeout(timer);
              if (done) {
                ws.close();
                return;
              }
              done = true;
              ws.onmessage = null;
              ws.onclose = null;
              ws.onerror = null;
              resolve({
                ws,
                channel,
                helloOk: msg,
                addr,
                rttMs: Date.now() - startedAt,
                protocolVersion,
              });
            } catch (e) {
              if (e instanceof ProtocolError && e.code === "untrusted") {
                fail("untrusted", e.message);
                return;
              }
              if (e instanceof ProtocolError && e.code === "version") {
                fail("version");
                return;
              }
              fail("handshake", e instanceof ProtocolError ? e.code : undefined);
            }
          };
        };

        tryVersion(0);
      }
    });
  }

  private adopt(won: Won): void {
    if (this.foregroundAt !== null) {
      // A5 验收:iOS 挂起会掐断 socket,回前台后重连完成才算恢复
      const ms = Date.now() - this.foregroundAt;
      this.foregroundAt = null;
      this.lastResumeMs = ms;
      this.events.emit("metric", { name: "resume", ms });
    }
    this.connecting = false;
    this.backoff = BACKOFF_MIN;
    this.everConnected = true;
    this.diagnosis = null;
    this.ws = won.ws;
    this.channel = won.channel;
    this.activeAddr = won.addr;
    this.lastRttMs = won.rttMs;
    this.lastRecvAt = Date.now();
    this.negotiatedProtocolVersion =
      won.helloOk.host.negotiatedProtocolVersion ?? won.protocolVersion;
    this.advertisedCapabilities = won.helloOk.host.capabilities === undefined
      ? null
      : new Set(won.helloOk.host.capabilities);

    useApp.getState().setSessions(this.host.id, won.helloOk.sessions);
    this.patch({
      status: "connected",
      hostInfo: won.helloOk.host,
      activeAddr: won.addr,
      lastError: null,
      rttMs: won.rttMs,
    });

    // 记住这个地址,下次优先试(切网后往往还是同一个)
    void rememberGoodAddr(this.host.id, won.addr);

    won.ws.onmessage = (ev) => this.onMessage(String(ev.data));
    won.ws.onclose = () => this.onClose();
    won.ws.onerror = () => {
      // onclose 随后触发
    };

    this.startHeartbeat();
    this.flushQueue();
    this.events.emit("connected", { addr: won.addr, rttMs: won.rttMs });
  }

  /**
   * 心跳:RN 的 WebSocket 不暴露 ping/pong,靠"最近收到任何数据的时间"判活。
   * daemon 每 15s 发一次 ping(ws 协议层),RN 侧收不到 ping 事件,
   * 所以这里额外发一条无副作用的 term.ack 触发对端活动,并检测长时间静默。
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected) return;
      const silent = Date.now() - this.lastRecvAt;
      if (silent > SILENCE_LIMIT_MS) {
        // 半开连接:socket 还是 OPEN 但实际已死,主动断开走重连
        this.ws?.close();
        return;
      }
    }, HEARTBEAT_MS);
  }

  private onMessage(text: string): void {
    this.lastRecvAt = Date.now();
    let msg: S2CMessage;
    try {
      msg = parseS2C(this.channel!.open(text));
    } catch {
      this.ws?.close(); // 通道不可信,断开走重连
      return;
    }
    switch (msg.type) {
      case "session.state":
        useApp.getState().upsertSession(this.host.id, msg.session);
        return;
      case "term.snapshot": {
        // A1 验收:attach → 快照到达。真机上没有别的办法拿到这个数,
        // 靠"主观秒开"是填不了验收表的。
        const started = this.attachStartedAt.get(msg.sid);
        if (started !== undefined) {
          this.attachStartedAt.delete(msg.sid);
          this.lastAttachMs = Date.now() - started;
          this.events.emit("metric", { name: "attach", sid: msg.sid, ms: this.lastAttachMs });
        }
        this.events.emit("snapshot", msg);
        return;
      }
      case "term.output":
        this.events.emit("output", msg);
        return;
      case "chat.snapshot":
        this.events.emit("chatSnapshot", msg);
        return;
      case "agent.event":
        this.events.emit("agentEvent", msg);
        return;
      case "tool.output":
        this.events.emit("toolOutput", msg);
        return;
      case "chat.attachment.chunk":
        this.resolveFs(msg);
        return;
      case "orchestration.snapshot":
        this.events.emit("orchestrationSnapshot", msg);
        return;
      case "workspace.listing":
      case "conversation.results":
      case "agent.accounts.result":
      case "fs.listing":
      case "fs.content":
      case "fs.written":
      case "fs.chunk":
      case "fs.done":
      case "git.status.result":
      case "git.diff.result":
      case "git.done":
      case "usage.result":
      case "chat.suggestions":
      case "launch.models":
      case "agent.models":
      case "agent.modes":
      case "agent.control.result":
      case "subagent.history.result":
        this.resolveFs(msg);
        return;
      case "error":
        // 文件请求在等应答时,错误要回到那个 Promise,而不是只飘一个全局提示
        if (msg.sid !== undefined && this.rejectFsFor(msg.sid, msg.message)) return;
        // workspace.list 发生在会话创建前,协议里没有 sid。旧版 daemon 不认识
        // 这条消息时会回一个全局 bad_message,也应立刻交给目录选择器,不能让用户
        // 对着转圈等 15 秒才超时。
        if (this.rejectFsFor("#workspace", msg.message)) return;
        if (this.rejectFsFor("#conversations", msg.message)) return;
        if (this.rejectFsFor("#accounts", msg.message)) return;
        this.events.emit("serverError", msg);
        return;
      case "hello.ok":
      case "permission.request":
        return;
    }
  }

  // ---------------------------------------------------------------- 文件操作
  //
  // 文件应答靠 (sid, path) 配对；搜索/控制类应答把 requestId 编进 path 键。

  private fsWaiters = new Map<
    string,
    { resolve: (m: S2CMessage) => void; reject: (e: Error) => void }
  >();

  private fsKey(sid: string, path: string): string {
    return `${sid}\u0000${path}`;
  }

  private resolveFs(msg: S2CMessage & { sid?: string; path?: string }): void {
    // git.status / git.done 没有 path,用消息类型当 key 的一部分
    // 账号级应答不带 sid,用固定键配对(与 usageGet 省略 sid 时一致)
    const owner =
      msg.type === "workspace.listing"
        ? "#workspace"
        : msg.type === "conversation.results"
          ? "#conversations"
          : msg.type === "agent.accounts.result"
            ? "#accounts"
          : (msg.sid ?? "#account");
    const responsePath =
      msg.type === "chat.suggestions"
        ? `#chat.suggestions:${msg.requestId}`
        : msg.type === "chat.attachment.chunk"
          ? `#chat.attachment:${msg.requestId}`
        : msg.type === "subagent.history.result"
          ? `#subagent.history:${msg.requestId}`
        : msg.type === "agent.models"
          ? `#agent.models:${msg.requestId}`
          : msg.type === "launch.models"
            ? `#launch.models:${msg.requestId}`
          : msg.type === "agent.modes"
            ? `#agent.modes:${msg.requestId}`
            : msg.type === "conversation.results"
              ? `#conversation.results:${msg.requestId}`
              : msg.type === "agent.accounts.result"
                ? `#agent.accounts:${msg.requestId}`
              : msg.type === "agent.control.result"
                ? `#agent.control:${msg.requestId}`
                : (msg.path ?? `#${msg.type}`);
    const key = this.fsKey(owner, responsePath);
    const waiter = this.fsWaiters.get(key);
    if (!waiter) return;
    this.fsWaiters.delete(key);
    waiter.resolve(msg);
  }

  /** 把服务端错误交给正在等这个会话应答的请求。返回是否有人接手。 */
  private rejectFsFor(sid: string, message: string): boolean {
    let handled = false;
    for (const [key, waiter] of [...this.fsWaiters]) {
      if (!key.startsWith(`${sid}\u0000`)) continue;
      this.fsWaiters.delete(key);
      waiter.reject(new Error(message));
      handled = true;
    }
    return handled;
  }

  private fsRequest<T extends S2CMessage>(
    sid: string,
    path: string,
    msg: C2SMessage,
    timeoutMs = 15000,
    queueable = true,
  ): Promise<T> {
    if (!this.isConnected) return Promise.reject(new Error("未连接"));
    const key = this.fsKey(sid, path);
    this.fsWaiters.get(key)?.reject(new Error("被新的请求取代"));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fsWaiters.delete(key);
        reject(new Error("请求超时"));
      }, timeoutMs);
      this.fsWaiters.set(key, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send(msg, queueable);
    });
  }

  fsList(sid: string, path: string): Promise<Extract<S2CMessage, { type: "fs.listing" }>> {
    return this.fsRequest(sid, path, { type: "fs.list", sid, path });
  }

  /** 新建会话前浏览 daemon 用户 home 下的目录与文件。 */
  async workspaceList(
    path: string,
  ): Promise<Extract<S2CMessage, { type: "workspace.listing" }>> {
    const result = await this.fsRequest<Extract<S2CMessage, { type: "workspace.listing" }>>(
      "#workspace",
      path,
      { type: "workspace.list", path },
    );
    if (result.error) throw new Error(result.error);
    return result;
  }

  /** 搜索 Mac 上由 Claude Code / Codex 自己保存、可原生接回的对话。 */
  async localConversations(
    agent: "claude" | "codex",
    query: string,
    limit = 20,
    accountId?: string,
  ): Promise<ResumableConversation[]> {
    const requestId = this.agentRequestId();
    const result = await this.fsRequest<Extract<S2CMessage, { type: "conversation.results" }>>(
      "#conversations",
      `#conversation.results:${requestId}`,
      {
        type: "conversation.search",
        requestId,
        agent,
        query,
        limit,
        ...(accountId ? { accountId } : {}),
      },
      30_000,
      false,
    );
    if (result.error) throw new Error(result.error);
    return result.conversations;
  }

  private async accountRequest(
    message:
      | Extract<C2SMessage, { type: "agent.accounts.list" }>
      | Extract<C2SMessage, { type: "agent.account.create" }>
      | Extract<C2SMessage, { type: "agent.account.api.create" }>
      | Extract<C2SMessage, { type: "agent.account.api.configure" }>
      | Extract<C2SMessage, { type: "agent.account.rename" }>
      | Extract<C2SMessage, { type: "agent.account.default" }>
      | Extract<C2SMessage, { type: "agent.account.login" }>
      | Extract<C2SMessage, { type: "agent.account.credential.set" }>
      | Extract<C2SMessage, { type: "agent.account.logout" }>
      | Extract<C2SMessage, { type: "agent.account.delete" }>,
  ): Promise<AgentAccountsResult> {
    if (!this.supportsAgentAccounts) throw new Error("请先升级 Mac 端以管理 Code Agent 账号");
    const result = await this.fsRequest<Extract<S2CMessage, { type: "agent.accounts.result" }>>(
      "#accounts",
      `#agent.accounts:${message.requestId}`,
      message,
      45_000,
      false,
    );
    if (!result.ok) throw new Error(result.error ?? "账号操作失败");
    return result;
  }

  async agentAccounts(): Promise<AgentAccount[]> {
    const requestId = this.agentRequestId();
    return (await this.accountRequest({ type: "agent.accounts.list", requestId })).accounts;
  }

  createAgentAccount(agent: CodeAgentKind, name: string): Promise<AgentAccountsResult> {
    return this.accountRequest({
      type: "agent.account.create",
      requestId: this.agentRequestId(),
      agent,
      name,
    });
  }

  createAgentApiProfile(
    agent: CodeAgentKind,
    name: string,
    baseUrl: string,
    model: string,
    apiKey: string,
  ): Promise<AgentAccountsResult> {
    if (!this.supportsAgentApiProfiles) throw new Error("请先升级 Mac 端以使用第三方 API Profile");
    return this.accountRequest({
      type: "agent.account.api.create",
      requestId: this.agentRequestId(),
      agent,
      name,
      baseUrl,
      model,
      apiKey,
    });
  }

  configureAgentApiProfile(
    accountId: string,
    baseUrl: string,
    model: string,
    apiKey: string,
  ): Promise<AgentAccountsResult> {
    if (!this.supportsAgentApiProfiles) throw new Error("请先升级 Mac 端以使用第三方 API Profile");
    return this.accountRequest({
      type: "agent.account.api.configure",
      requestId: this.agentRequestId(),
      accountId,
      baseUrl,
      model,
      apiKey,
    });
  }

  renameAgentAccount(accountId: string, name: string): Promise<AgentAccountsResult> {
    return this.accountRequest({
      type: "agent.account.rename",
      requestId: this.agentRequestId(),
      accountId,
      name,
    });
  }

  setDefaultAgentAccount(accountId: string): Promise<AgentAccountsResult> {
    return this.accountRequest({
      type: "agent.account.default",
      requestId: this.agentRequestId(),
      accountId,
    });
  }

  loginAgentAccount(accountId: string, cols = 80, rows = 24): Promise<AgentAccountsResult> {
    return this.accountRequest({
      type: "agent.account.login",
      requestId: this.agentRequestId(),
      accountId,
      cols,
      rows,
    });
  }

  setAgentAccountCredential(
    accountId: string,
    credentialKind: AgentCredentialKind,
    credential: string,
  ): Promise<AgentAccountsResult> {
    return this.accountRequest({
      type: "agent.account.credential.set",
      requestId: this.agentRequestId(),
      accountId,
      credentialKind,
      credential,
    });
  }

  logoutAgentAccount(accountId: string): Promise<AgentAccountsResult> {
    return this.accountRequest({
      type: "agent.account.logout",
      requestId: this.agentRequestId(),
      accountId,
    });
  }

  deleteAgentAccount(accountId: string): Promise<AgentAccountsResult> {
    return this.accountRequest({
      type: "agent.account.delete",
      requestId: this.agentRequestId(),
      accountId,
    });
  }

  fsRead(sid: string, path: string): Promise<Extract<S2CMessage, { type: "fs.content" }>> {
    return this.fsRequest(sid, path, { type: "fs.read", sid, path });
  }

  fsWrite(
    sid: string,
    path: string,
    contentB64: string,
  ): Promise<Extract<S2CMessage, { type: "fs.written" }>> {
    return this.fsRequest(sid, path, { type: "fs.write", sid, path, contentB64 });
  }

  fsGetChunk(
    sid: string,
    path: string,
    offset: number,
    length: number,
  ): Promise<Extract<S2CMessage, { type: "fs.chunk" }>> {
    return this.fsRequest(sid, path, { type: "fs.get", sid, path, offset, length });
  }

  /**
   * 用量与限流。省略 sid 就是问账号级的 —— 限流窗口在所有会话之间共享,
   * 主机页也该看得到,不必先进某个会话。
   */
  usageGet(sid?: string): Promise<Extract<S2CMessage, { type: "usage.result" }>> {
    return this.fsRequest(
      sid ?? "#account",
      "#usage.result",
      sid !== undefined ? { type: "usage.get", sid } : { type: "usage.get" },
    );
  }

  gitStatus(sid: string): Promise<Extract<S2CMessage, { type: "git.status.result" }>> {
    return this.fsRequest(sid, "#git.status.result", { type: "git.status", sid });
  }

  gitDiff(
    sid: string,
    path: string,
    staged: boolean,
  ): Promise<Extract<S2CMessage, { type: "git.diff.result" }>> {
    return this.fsRequest(sid, path, { type: "git.diff", sid, path, staged });
  }

  gitStage(
    sid: string,
    paths: string[],
    unstage: boolean,
  ): Promise<Extract<S2CMessage, { type: "git.done" }>> {
    return this.fsRequest(sid, "#git.done", { type: "git.stage", sid, paths, unstage });
  }

  gitDiscard(sid: string, path: string): Promise<Extract<S2CMessage, { type: "git.done" }>> {
    return this.fsRequest(sid, "#git.done", { type: "git.discard", sid, path });
  }

  gitCommit(sid: string, message: string): Promise<Extract<S2CMessage, { type: "git.done" }>> {
    return this.fsRequest(sid, "#git.done", { type: "git.commit", sid, message });
  }

  fsMkdir(sid: string, path: string): Promise<Extract<S2CMessage, { type: "fs.done" }>> {
    return this.fsRequest(sid, path, { type: "fs.mkdir", sid, path });
  }

  fsRemove(sid: string, path: string): Promise<Extract<S2CMessage, { type: "fs.done" }>> {
    return this.fsRequest(sid, path, { type: "fs.remove", sid, path });
  }

  fsRename(
    sid: string,
    path: string,
    to: string,
  ): Promise<Extract<S2CMessage, { type: "fs.done" }>> {
    return this.fsRequest(sid, path, { type: "fs.rename", sid, path, to });
  }

  fsPutChunk(
    sid: string,
    path: string,
    offset: number,
    dataB64: string,
    final: boolean,
  ): Promise<Extract<S2CMessage, { type: "fs.written" }> | null> {
    if (!final) {
      // 非末块没有应答,直接发
      this.send({ type: "fs.put", sid, path, offset, dataB64, final }, true);
      return Promise.resolve(null);
    }
    return this.fsRequest<Extract<S2CMessage, { type: "fs.written" }>>(sid, path, {
      type: "fs.put",
      sid,
      path,
      offset,
      dataB64,
      final,
    });
  }

  private onClose(): void {
    const wasConnected = this.isConnected;
    // 断线时挂起的文件请求永远等不到应答了,立刻失败好过等超时
    for (const [, waiter] of this.fsWaiters) waiter.reject(new Error("连接已断开"));
    this.fsWaiters.clear();
    this.clearTimers();
    this.ws = null;
    this.channel = null;
    this.activeAddr = null;
    if (this.stopped) return;
    this.patch({ status: "reconnecting", activeAddr: null });
    if (wasConnected) this.events.emit("disconnected", { willRetry: true });
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    const delay = this.backoff + Math.random() * 250;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectOnce();
    }, delay);
  }

  // ---------------------------------------------------------------- 发送 API

  /**
   * @param queueable 断线时是否排队补发。
   * 用户意图(发消息、审批)值得排队;终端按键与 ack 过期即无意义,丢弃。
   *
   * 所有调用方都能区分“已写入连接”“已在本机排队”与“没有被接收”，不能再把
   * `void` 当作发送成功。特别是队列满时，编辑器据此保留草稿而不是静默清空。
   */
  send(msg: C2SMessage, queueable = false): DeliveryResult {
    if (this.isConnected) {
      try {
        this.ws!.send(this.channel!.seal(msg));
        return acceptedDelivery("sent");
      } catch {
        // 发送抛错时无法证明远端没有收到，绝不擅自补发 shell 或聊天字节。
        // close 会让正常的连接恢复逻辑接管后续操作。
        this.ws?.close();
        return rejectedDelivery("transport_error");
      }
    }
    if (!queueable) return rejectedDelivery("offline");
    return this.queue.offer(msg)
      ? acceptedDelivery("queued")
      : rejectedDelivery("queue_full");
  }

  private flushQueue(): void {
    while (this.queue.length > 0 && this.isConnected) {
      const message = this.queue.take();
      if (!message) return;
      const result = this.send(message);
      if (!result.accepted) {
        // 连接刚好在 flush 中断开：将未确认的头部放回，守住 FIFO 与不丢失语义。
        this.queue.putBackFront(message);
        return;
      }
    }
  }

  createSession(
    agent: AgentKind,
    cwd?: string,
    command?: string,
    kind?: SessionKind,
    cols = 80,
    rows = 24,
    options?: {
      mode?: "default" | "plan";
      resume?: { id: string; title?: string };
      /** Goal 会同时创建编排 Run，并把新会话作为协调者。 */
      goal?: string;
      /** 账号环境与 cwd 独立；多个账号可指向同一个项目。 */
      accountId?: string;
      /** 从创建器实时目录中选择，保证第一轮就使用该模型。 */
      model?: string;
      effort?: string;
    },
  ): DeliveryResult {
    return this.send(
      {
        type: "session.create",
        agent,
        ...(kind ? { kind } : {}),
        ...(cwd ? { cwd } : {}),
        ...(command ? { command } : {}),
        ...(options?.mode ? { mode: options.mode } : {}),
        ...(options?.resume ? { resume: options.resume } : {}),
        ...(options?.goal ? { goal: options.goal } : {}),
        ...(options?.accountId ? { accountId: options.accountId } : {}),
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.effort ? { effort: options.effort } : {}),
        cols,
        rows,
      },
      true,
    );
  }

  /** 最近一次 attach 到快照上屏的耗时(ms);A1 验收指标 */
  lastAttachMs: number | null = null;
  /** 供 AppState 标记回前台时刻 */
  markForeground(at: number): void {
    if (!this.isConnected) this.foregroundAt = at;
  }

  /** 最近一次"回前台 → 重新连上"的耗时(ms);A5 验收指标 */
  lastResumeMs: number | null = null;
  private foregroundAt: number | null = null;
  private attachStartedAt = new Map<string, number>();

  attach(sid: string, lastSeq?: number): void {
    this.attachStartedAt.set(sid, Date.now());
    this.send({ type: "session.attach", sid, ...(lastSeq !== undefined ? { lastSeq } : {}) });
  }

  /** 拉取 daemon 的编排快照；前台定时刷新能跨 iOS/Android 后台恢复。 */
  orchestrationSnapshot(): void {
    if (!this.supportsOrchestrationSnapshot) return;
    this.send({ type: "orchestration.snapshot" });
  }

  /** 人类在手机上解开 Gate；成功后 daemon 回传新的完整快照。 */
  resolveOrchestrationGate(gateId: string, decision: string): void {
    this.send({ type: "orchestration.gate.resolve", gateId, decision }, true);
  }

  createOrchestrationRun(objective: string): boolean {
    if (!this.supportsManualOrchestration) return false;
    return this.send({
      type: "orchestration.run.create",
      objective,
      operationId: randomUUID(),
    }, true).accepted;
  }

  createOrchestrationGraph(input: {
    objective: string;
    nodes: OrchestrationGraphNodeInput[];
    /** 编辑器生命周期内保持稳定；发送成功但响应丢失时重试仍只创建一次。 */
    operationId: string;
  }): boolean {
    if (!this.supportsGraphOrchestration) return false;
    return this.send({
      type: "orchestration.graph.create",
      objective: input.objective,
      nodes: input.nodes,
      operationId: input.operationId,
    }, true).accepted;
  }

  applyOrchestrationGraph(input: {
    runId: string;
    baseRevision: number;
    nodes: OrchestrationGraphNodeInput[];
    deleteTaskIds?: string[];
    operationId: string;
  }): boolean {
    if (!this.supportsGraphOrchestration) return false;
    return this.send({
      type: "orchestration.graph.apply",
      runId: input.runId,
      baseRevision: input.baseRevision,
      nodes: input.nodes,
      operationId: input.operationId,
      ...(input.deleteTaskIds && input.deleteTaskIds.length > 0
        ? { deleteTaskIds: input.deleteTaskIds }
        : {}),
    }, true).accepted;
  }

  deleteOrchestrationRun(runId: string): boolean {
    if (!this.supportsOrchestrationManagement) return false;
    return this.send({
      type: "orchestration.run.delete",
      runId,
      operationId: randomUUID(),
    }, true).accepted;
  }

  createOrchestrationTask(input: {
    runId: string;
    title: string;
    spec: string;
    deps?: string[];
    parentId?: string;
  }): boolean {
    if (!this.supportsManualOrchestration) return false;
    return this.send({
      type: "orchestration.task.create",
      runId: input.runId,
      title: input.title,
      spec: input.spec,
      operationId: randomUUID(),
      ...(input.deps && input.deps.length > 0 ? { deps: input.deps } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
    }, true).accepted;
  }

  cancelOrchestrationTask(taskId: string, reason?: string): boolean {
    if (!this.supportsOrchestrationLifecycle) return false;
    return this.send({
      type: "orchestration.task.cancel",
      taskId,
      operationId: randomUUID(),
      ...(reason ? { reason } : {}),
    }, true).accepted;
  }

  retryOrchestrationTask(taskId: string): boolean {
    if (!this.supportsOrchestrationLifecycle) return false;
    return this.send({
      type: "orchestration.task.retry",
      taskId,
      operationId: randomUUID(),
    }, true).accepted;
  }

  startOrchestrationWorker(input: {
    taskId: string;
    agent: AgentKind;
    accountId?: string;
    worktree: "new" | "none";
    cwd: string;
    kind?: SessionKind;
    approvalPolicy?: ApprovalPolicy;
  }): boolean {
    if (!this.supportsManualOrchestration) return false;
    return this.send({
      type: "orchestration.worker.start",
      taskId: input.taskId,
      agent: input.agent,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      worktree: input.worktree,
      cwd: input.cwd,
      operationId: randomUUID(),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
    }, true).accepted;
  }

  stopOrchestrationWorker(taskId: string, reason?: string): boolean {
    if (!this.supportsOrchestrationLifecycle) return false;
    return this.send({
      type: "orchestration.worker.stop",
      taskId,
      operationId: randomUUID(),
      ...(reason ? { reason } : {}),
    }, true).accepted;
  }

  startOrchestrationAutomation(input: {
    runId: string;
    agent: AgentKind;
    accountId?: string;
    approvalPolicy: ApprovalPolicy;
    workspace: "run" | "current";
    cwd: string;
  }): boolean {
    if (!this.supportsAutomationOrchestration) return false;
    return this.send({
      type: "orchestration.automation.start",
      operationId: randomUUID(),
      runId: input.runId,
      agent: input.agent,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      approvalPolicy: input.approvalPolicy,
      workspace: input.workspace,
      cwd: input.cwd,
    }, true).accepted;
  }

  pauseOrchestrationAutomation(runId: string): boolean {
    if (!this.supportsAutomationOrchestration) return false;
    return this.send({
      type: "orchestration.automation.pause",
      operationId: randomUUID(),
      runId,
    }, true).accepted;
  }

  /** 拉取某次工具调用的完整输出(卡片展开时) */
  getToolOutput(sid: string, callId: string): void {
    this.send({ type: "tool.output.get", sid, callId });
  }

  /** 用户历史图片按需分块读取，避免聊天快照携带原图。 */
  chatAttachmentChunk(
    sid: string,
    msgId: string,
    attachmentId: string,
    offset: number,
    length: number,
  ): Promise<Extract<S2CMessage, { type: "chat.attachment.chunk" }>> {
    if (!this.supportsChatAttachmentPreviews) {
      return Promise.reject(new Error("请升级 Mac 端以查看历史图片"));
    }
    const requestId = randomUUID();
    return this.fsRequest(
      sid,
      `#chat.attachment:${requestId}`,
      { type: "chat.attachment.get", sid, msgId, attachmentId, offset, length, requestId },
      30_000,
      false,
    );
  }

  respondPermission(sid: string, reqId: string, reply: PermissionReply): DeliveryResult {
    return this.send({ type: "permission.respond", sid, reqId, reply }, true);
  }

  respondQuestion(
    sid: string,
    reqId: string,
    answers: AgentQuestionAnswer[],
    cancelled = false,
  ): DeliveryResult {
    return this.send(
      {
        type: "question.respond",
        sid,
        reqId,
        answers,
        ...(cancelled ? { cancelled: true } : {}),
      },
      true,
    );
  }

  sendToSubagent(sid: string, subagentId: string, text: string): DeliveryResult {
    return this.send({ type: "subagent.send", sid, subagentId, text }, true);
  }

  /** 子 Agent 详情按需读取 Codex/后端原生历史；旧 daemon 继续用父快照降级。 */
  async subagentHistory(sid: string, subagentId: string): Promise<AgentEventBody[]> {
    if (!this.supportsSubagentHistory) throw new Error("当前 Mac 版本不支持子 Agent 历史");
    const requestId = this.agentRequestId();
    const result = await this.fsRequest<
      Extract<S2CMessage, { type: "subagent.history.result" }>
    >(
      sid,
      `#subagent.history:${requestId}`,
      { type: "subagent.history.get", sid, subagentId, requestId },
      30_000,
      false,
    );
    return result.events;
  }

  inputB64(sid: string, dataB64: string): DeliveryResult {
    return this.send({ type: "term.input", sid, dataB64 });
  }

  inputText(sid: string, text: string): DeliveryResult {
    return this.inputB64(sid, toB64(utf8Encode(text)));
  }

  resize(sid: string, cols: number, rows: number): void {
    this.send({ type: "term.resize", sid, cols, rows });
  }

  ack(sid: string, seq: number): void {
    this.send({ type: "term.ack", sid, seq });
  }

  interrupt(sid: string): DeliveryResult {
    return this.send({ type: "session.interrupt", sid }, true);
  }

  chatSend(
    sid: string,
    text: string,
    attachments?: Attachment[],
    delivery: ChatDelivery = "auto",
  ): DeliveryResult {
    return this.send(
      {
        type: "chat.send",
        sid,
        text,
        ...(attachments?.length ? { attachments } : {}),
        ...(delivery !== "auto" ? { delivery } : {}),
      },
      true,
    );
  }

  removeQueuedMessage(sid: string, queueId: string): DeliveryResult {
    return this.send({ type: "chat.queue.remove", sid, queueId }, true);
  }

  guideQueuedMessage(sid: string, queueId: string): DeliveryResult {
    return this.send({ type: "chat.queue.guide", sid, queueId }, true);
  }

  /** 输入补全是瞬时请求；断线时不排队，避免重连后弹出过期候选。 */
  chatComplete(
    sid: string,
    kind: ChatSuggestionKind,
    query: string,
    requestId: string,
  ): Promise<S2CChatSuggestions> {
    return this.fsRequest(
      sid,
      `#chat.suggestions:${requestId}`,
      { type: "chat.complete", sid, requestId, kind, query },
      8000,
      false,
    );
  }

  private agentRequestId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  launchModels(
    agent: "claude" | "codex",
    accountId?: string,
  ): Promise<Extract<S2CMessage, { type: "launch.models" }>> {
    if (!this.supportsSessionCreateModel) {
      return Promise.reject(new Error("请先升级 Mac 端以在创建会话时选择模型"));
    }
    const requestId = this.agentRequestId();
    return this.fsRequest<Extract<S2CMessage, { type: "launch.models" }>>(
      "#account",
      `#launch.models:${requestId}`,
      {
        type: "launch.models.get",
        requestId,
        agent,
        ...(accountId ? { accountId } : {}),
      },
      30_000,
      false,
    ).then((response) => {
      if (response.error) throw new Error(response.error);
      return response;
    });
  }

  agentModels(sid: string): Promise<Extract<S2CMessage, { type: "agent.models" }>> {
    const requestId = this.agentRequestId();
    return this.fsRequest(
      sid,
      `#agent.models:${requestId}`,
      { type: "agent.models.get", sid, requestId },
    );
  }

  agentModes(sid: string): Promise<Extract<S2CMessage, { type: "agent.modes" }>> {
    const requestId = this.agentRequestId();
    return this.fsRequest(
      sid,
      `#agent.modes:${requestId}`,
      { type: "agent.modes.get", sid, requestId },
    );
  }

  setAgentModel(
    sid: string,
    model: string,
    effort?: string,
  ): Promise<Extract<S2CMessage, { type: "agent.control.result" }>> {
    const requestId = this.agentRequestId();
    return this.fsRequest(
      sid,
      `#agent.control:${requestId}`,
      {
        type: "agent.model.set",
        sid,
        requestId,
        model,
        ...(effort ? { effort } : {}),
      },
      30_000,
    );
  }

  setAgentMode(
    sid: string,
    mode: string,
  ): Promise<Extract<S2CMessage, { type: "agent.control.result" }>> {
    const requestId = this.agentRequestId();
    return this.fsRequest(
      sid,
      `#agent.control:${requestId}`,
      { type: "agent.mode.set", sid, requestId, mode },
      30_000,
    );
  }

  compactAgent(sid: string): Promise<Extract<S2CMessage, { type: "agent.control.result" }>> {
    const requestId = this.agentRequestId();
    return this.fsRequest(
      sid,
      `#agent.control:${requestId}`,
      { type: "agent.compact", sid, requestId },
      200_000,
    );
  }

  setApprovalPolicy(sid: string, policy: ApprovalPolicy): DeliveryResult {
    return this.send({ type: "approval.policy.set", sid, policy }, true);
  }

  kill(sid: string): DeliveryResult {
    return this.send({ type: "session.kill", sid }, true);
  }
}

// ---------------------------------------------------------------- 连接注册表

const connections = new Map<string, HostConnection>();

export function getConnection(host: StoredHost, keys: KeyPairB64): HostConnection {
  const existing = connections.get(host.id);
  if (existing) {
    // 重新配对(token/公钥变化)则替换连接
    if (existing.host.token === host.token && existing.host.daemonPub === host.daemonPub) {
      return existing;
    }
    existing.stop();
  }
  const conn = new HostConnection(host, keys);
  connections.set(host.id, conn);
  return conn;
}

export function peekConnection(hostId: string): HostConnection | null {
  return connections.get(hostId) ?? null;
}

export function dropConnection(hostId: string): void {
  connections.get(hostId)?.stop();
  connections.delete(hostId);
}

let appStateWired = false;
/** 回前台立即踢所有连接重连(iOS 后台 socket 数秒即被杀) */
export function wireAppStateReconnect(): void {
  if (appStateWired) return;
  appStateWired = true;
  AppState.addEventListener("change", (state) => {
    if (state === "active") {
      // A5 的计时起点是"回到前台的那一刻",不是重连开始的那一刻 ——
      // 用户感知的等待从看到屏幕就开始了
      const now = Date.now();
      for (const conn of connections.values()) {
        conn.markForeground(now);
        conn.kick();
      }
    }
  });
}
