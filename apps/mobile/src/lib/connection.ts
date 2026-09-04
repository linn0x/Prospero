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
  CAPABILITY_AGENT_DEEPSEEK_HARNESS,
  CAPABILITY_DEEPSEEK_TRAJECTORY,
  CAPABILITY_CHAT_ATTACHMENT_PREVIEWS,
  CAPABILITY_ORCHESTRATION_AUTOMATION,
  CAPABILITY_ORCHESTRATION_GRAPH,
  CAPABILITY_ORCHESTRATION_LIFECYCLE,
  CAPABILITY_ORCHESTRATION_MANAGEMENT,
  CAPABILITY_ORCHESTRATION_MANUAL,
  CAPABILITY_ORCHESTRATION_RUN_LIFECYCLE,
  CAPABILITY_ORCHESTRATION_SNAPSHOT,
  CAPABILITY_ORCHESTRATION_WORKTREES,
  CAPABILITY_SESSION_CREATE_MODEL,
  CAPABILITY_SUBAGENT_HISTORY,
  CAPABILITY_WORKSPACE_ROOTS,
  CLOSE_AUTH_FAILED,
  CLOSE_REVOKED,
  SUPPORTED_PROTOCOL_VERSIONS,
  clientHandshakeStart,
  clientHandshakeFinish,
  parseRelayControlMessage,
  parseS2C,
  toB64,
  utf8Encode,
  validateRelayUrl,
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
import {
  selectConnectionCandidates,
  type ConnectionCandidate,
  type ConnectionPath,
  type RelayCandidate,
} from "./connection-candidates";
import {
  AllAttemptsFailed,
  raceFirstSuccessful,
  type ManagedAttempt,
} from "./connection-race";
import {
  HEARTBEAT_TICK_MS,
  nextLivenessAction,
} from "./connection-liveness";
import { Emitter } from "./emitter";
import { rememberGoodAddr, type StoredHost } from "./hosts";
import { advanceRelayClient, type RelayClientState } from "./relay-client-state";
import {
  BoundedQueue,
  acceptedDelivery,
  rejectedDelivery,
  type DeliveryResult,
} from "./outbound-queue";
import { useApp } from "./store";

export type { DeliveryResult } from "./outbound-queue";

const APP_VERSION = "0.0.19";
const ATTEMPT_TIMEOUT_MS = 6000;
const BACKOFF_MIN = 400;
const BACKOFF_MAX = 8000;
/** 心跳间隔与容忍的静默时长(daemon 每 15s ping 一次) */
/** 断线期间最多排队多少条待发消息 */
export const MAX_OFFLINE_QUEUE = 50;
const CLIENT_PLATFORM = Platform.OS === "android" ? "android" : "ios";

interface Won {
  ws: WebSocket;
  channel: SecureChannel;
  helloOk: S2CHelloOk;
  endpoint: string;
  path: ConnectionPath;
  rttMs: number;
  protocolVersion: number;
}

export interface ConnEvents extends Record<string, unknown> {
  connected: { addr: string; path: ConnectionPath; rttMs: number };
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
  activePath: ConnectionPath | null = null;
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
  private lastPingAt = 0;
  private pendingPingId: string | null = null;
  /** 格式错误重连也不会自愈；保留原因让 onclose 停止无限退避。 */
  private fatalReceiveError: string | null = null;
  private everConnected = false;
  private negotiatedProtocolVersion: number | null = null;
  /** null 表示旧 daemon 未声明能力；空 Set 表示新 daemon 明确拒绝所有可选能力。 */
  private advertisedCapabilities: Set<string> | null = null;
  /** 断线期间排队的消息,重连后按序补发 */
  private queue = new BoundedQueue<C2SMessage>(MAX_OFFLINE_QUEUE);
  private racingAttempts: ManagedAttempt<Won>[] | null = null;

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
    if (capability === CAPABILITY_WORKSPACE_ROOTS) return false;
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

  get supportsOrchestrationRunLifecycle(): boolean {
    return this.supportsCapability(CAPABILITY_ORCHESTRATION_RUN_LIFECYCLE);
  }

  /** 已登记工作树的只读检查与服务端复核后的显式清理。 */
  get supportsOrchestrationWorktrees(): boolean {
    return this.supportsCapability(CAPABILITY_ORCHESTRATION_WORKTREES);
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

  get supportsDeepseekHarness(): boolean {
    return this.supportsCapability(CAPABILITY_AGENT_DEEPSEEK_HARNESS);
  }

  get supportsDeepseekTrajectory(): boolean {
    return this.supportsCapability(CAPABILITY_DEEPSEEK_TRAJECTORY);
  }

  get supportsChatAttachmentPreviews(): boolean {
    return this.supportsCapability(CAPABILITY_CHAT_ATTACHMENT_PREVIEWS);
  }

  get supportsSessionCreateModel(): boolean {
    return this.supportsCapability(CAPABILITY_SESSION_CREATE_MODEL);
  }

  get supportsWorkspaceRoots(): boolean {
    return this.supportsCapability(CAPABILITY_WORKSPACE_ROOTS);
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
    this.abortRacingAttempts();
    this.ws?.close();
    this.ws = null;
    this.channel = null;
    this.activeAddr = null;
    this.activePath = null;
    this.queue.clear();
    useApp.getState().patchRuntime(this.host.id, {
      status: "idle",
      activeAddr: null,
      activePath: null,
    });
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
      if (this.stopped) {
        won.ws.close();
        this.connecting = false;
        return;
      }
      this.adopt(won);
    } catch {
      this.connecting = false;
      if (this.stopped) return;
      const d = this.diagnosis;
      this.patch({
        status: "failed",
        lastError: d ? `${d.summary} — ${d.hint}` : "连接失败",
      });
      if (d?.fatal !== true && !this.stopped) this.scheduleRetry();
    }
  }

  private abortRacingAttempts(): void {
    const attempts = this.racingAttempts;
    this.racingAttempts = null;
    if (!attempts) return;
    for (const attempt of attempts) {
      try { attempt.abort(); } catch { /* best effort */ }
    }
  }

  private async race(): Promise<Won> {
    const selection = selectConnectionCandidates(this.host);
    if (selection.candidates.length === 0) {
      const failures: AttemptResult[] = selection.relayCredentialsMissing
        ? [{ addr: "relay", failure: "relay_credentials_missing" }]
        : [];
      this.diagnosis = diagnose(failures, !this.everConnected, CLIENT_PLATFORM);
      throw new Error(this.diagnosis.summary);
    }

    // Starting each attempt here (rather than in a chained await) is what
    // makes auto a real direct+relay race.
    const attempts = selection.candidates.map((candidate) => this.startCandidate(candidate));
    this.racingAttempts = attempts;
    try {
      return await raceFirstSuccessful(attempts);
    } catch (error) {
      const failures = error instanceof AllAttemptsFailed ? error.failures : [];
      this.diagnosis = diagnose(failures, !this.everConnected, CLIENT_PLATFORM);
      throw error;
    } finally {
      if (this.racingAttempts === attempts) this.racingAttempts = null;
    }
  }

  private startCandidate(candidate: ConnectionCandidate): ManagedAttempt<Won> {
    return candidate.path === "direct"
      ? this.startDirectCandidate(candidate.addr)
      : this.startRelayCandidate(candidate);
  }

  private startDirectCandidate(addr: string): ManagedAttempt<Won> {
    return this.startE2ECandidate({
      label: `direct:${addr}`,
      path: "direct",
      endpoint: addr,
      open: () => new WebSocket(`ws://${addr}:${this.host.port}/ws`),
      initialOpen: () => {},
      beforeE2EFailure: () => "unreachable",
    });
  }

  private startRelayCandidate(candidate: RelayCandidate): ManagedAttempt<Won> {
    let secureUrl: string;
    try {
      secureUrl = validateRelayUrl(candidate.url, {
        allowInsecureLoopback: typeof __DEV__ !== "undefined" && __DEV__,
      });
    } catch (error) {
      return this.failedAttempt(
        `relay:${candidate.url}`,
        { addr: candidate.url, failure: "relay_tls", detail: error instanceof Error ? error.message : undefined },
      );
    }

    const relay = {
      v: 1 as const,
      url: secureUrl,
      routeId: candidate.routeId,
      deviceId: candidate.deviceId,
      token: candidate.token,
    };
    let clientUrl: string;
    try {
      const parsed = new URL(secureUrl);
      const path = parsed.pathname.replace(/\/$/, "");
      parsed.pathname = path.endsWith("/v1/client")
        ? path
        : path.endsWith("/v1")
          ? `${path}/client`
          : "/v1/client";
      clientUrl = parsed.toString();
    } catch {
      // validateRelayUrl already checked this; keep a defensive diagnosis if a
      // platform URL implementation nevertheless cannot construct it.
      return this.failedAttempt(`relay:${candidate.url}`, { addr: candidate.url, failure: "relay_tls" });
    }
    let relayState: RelayClientState = "opening";
    return this.startE2ECandidate({
      label: `relay:${clientUrl}`,
      path: "relay",
      endpoint: clientUrl,
      open: () => new WebSocket(clientUrl),
      initialOpen: (ws) => {
        // A protocol-version fallback creates a fresh relay stream; its
        // control plane starts over even though the candidate remains the same.
        relayState = "opening";
        const transition = advanceRelayClient(relayState, "opened", relay);
        relayState = transition.state;
        if (transition.action?.type === "send_connect") ws.send(transition.action.frame);
      },
      beforeE2EMessage: (text, ws) => {
        if (relayState === "e2e") return "e2e";
        try {
          const control = parseRelayControlMessage(JSON.parse(text));
          const transition = advanceRelayClient(relayState, control, relay);
          relayState = transition.state;
          if (transition.action?.type === "send_connect") {
            ws.send(transition.action.frame);
            return "waiting";
          }
          if (transition.action?.type === "start_e2e") return "e2e";
          if (transition.action?.type === "fail") return transition.action;
          return "waiting";
        } catch (error) {
          return {
            type: "fail" as const,
            failure: "relay_protocol" as const,
            detail: error instanceof Error ? error.message : "invalid relay control frame",
          };
        }
      },
      beforeE2EFailure: () => relayState === "opening" ? "relay_tls" : "relay_offline",
    });
  }

  private failedAttempt(label: string, failure: AttemptResult): ManagedAttempt<Won> {
    return { label, promise: Promise.reject(failure), abort: () => {} };
  }

  /**
   * Applies the existing protocol-version fallback and E2E handshake to either
   * a direct socket or the byte stream established on a relay socket.
   */
  private startE2ECandidate(input: {
    label: string;
    path: ConnectionPath;
    endpoint: string;
    open(): WebSocket;
    initialOpen(ws: WebSocket, frame: string): void;
    beforeE2EMessage?: (
      text: string,
      ws: WebSocket,
    ) => "waiting" | "e2e" | { type: "fail"; failure: AttemptResult["failure"]; detail?: string };
    beforeE2EFailure(): AttemptResult["failure"];
  }): ManagedAttempt<Won> {
    let activeWs: WebSocket | null = null;
    // A candidate can finish its own E2E handshake in the same microtask as a
    // different candidate wins. Keep this reference so race cleanup still
    // closes that already-resolved loser rather than leaking its socket.
    let completedWs: WebSocket | null = null;
    let settled = false;
    let rejectAttempt: ((failure: AttemptResult) => void) | null = null;

    const promise = new Promise<Won>((resolve, reject) => {
      rejectAttempt = reject;
      const startedAt = Date.now();
      const failAttempt = (failure: AttemptResult["failure"], detail?: string): void => {
        if (settled) return;
        settled = true;
        reject({ addr: input.endpoint, failure, ...(detail !== undefined ? { detail } : {}) });
      };

      const tryVersion = (versionIndex: number): void => {
        if (settled) return;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS[versionIndex];
        if (protocolVersion === undefined) {
          failAttempt("version");
          return;
        }
        let ws: WebSocket;
        try {
          ws = input.open();
        } catch (error) {
          failAttempt(input.beforeE2EFailure(), error instanceof Error ? error.message : undefined);
          return;
        }
        activeWs = ws;
        let opened = false;
        let e2eReady = input.beforeE2EMessage === undefined;
        let versionDone = false;
        let channel: SecureChannel | null = null;
        const { frame, state: hsState } = clientHandshakeStart(protocolVersion);

        const detach = (close: boolean): void => {
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
          if (activeWs === ws) activeWs = null;
          if (close) {
            try { ws.close(); } catch { /* already closed */ }
          }
        };
        const failVersion = (failure: AttemptResult["failure"], detail?: string): void => {
          if (versionDone || settled) return;
          versionDone = true;
          clearTimeout(timer);
          detach(true);
          if (failure === "version" && versionIndex + 1 < SUPPORTED_PROTOCOL_VERSIONS.length) {
            tryVersion(versionIndex + 1);
            return;
          }
          failAttempt(failure, detail);
        };
        const timer = setTimeout(() => {
          failVersion(e2eReady ? "timeout" : input.beforeE2EFailure());
        }, ATTEMPT_TIMEOUT_MS);

        ws.onopen = () => {
          opened = true;
          try {
            input.initialOpen(ws, frame);
            if (e2eReady) ws.send(frame);
          } catch (error) {
            failVersion(e2eReady ? "handshake" : input.beforeE2EFailure(), error instanceof Error ? error.message : undefined);
          }
        };
        ws.onerror = () => failVersion(opened ? (e2eReady ? "handshake" : input.beforeE2EFailure()) : input.beforeE2EFailure());
        ws.onclose = (event) => {
          if (!opened || !e2eReady) {
            failVersion(input.beforeE2EFailure());
            return;
          }
          const code = (event as { code?: number } | undefined)?.code;
          const reason = String((event as { reason?: unknown } | undefined)?.reason ?? "");
          if (code === CLOSE_AUTH_FAILED) failVersion("auth", reason || undefined);
          else if (code === CLOSE_REVOKED) failVersion("revoked", reason || undefined);
          else if (reason === "version") failVersion("version");
          else failVersion("handshake", reason || undefined);
        };
        ws.onmessage = (event) => {
          const text = String(event.data);
          try {
            if (!e2eReady) {
              const relayResult = input.beforeE2EMessage?.(text, ws);
              if (relayResult === "waiting") return;
              if (relayResult && typeof relayResult === "object") {
                failVersion(relayResult.failure, relayResult.detail);
                return;
              }
              if (relayResult !== "e2e") {
                failVersion("relay_protocol");
                return;
              }
              e2eReady = true;
              ws.send(frame);
              return;
            }
            if (channel === null) {
              const finished = clientHandshakeFinish(
                hsState,
                text,
                this.host.daemonPub,
                {
                  type: "hello",
                  token: this.host.token,
                  clientPubKey: this.keys.publicKey,
                  clientInfo: { platform: CLIENT_PLATFORM, appVersion: APP_VERSION },
                },
              );
              channel = finished.channel;
              ws.send(finished.frame);
              return;
            }
            const msg = parseS2C(channel.open(text));
            if (msg.type === "error" && msg.code === "auth_failed") {
              failVersion("auth", msg.message);
              return;
            }
            if (msg.type !== "hello.ok") {
              failVersion("handshake", `unexpected ${msg.type}`);
              return;
            }
            versionDone = true;
            clearTimeout(timer);
            detach(false);
            completedWs = ws;
            settled = true;
            resolve({
              ws,
              channel,
              helloOk: msg,
              endpoint: input.endpoint,
              path: input.path,
              rttMs: Date.now() - startedAt,
              protocolVersion,
            });
          } catch (error) {
            if (error instanceof ProtocolError && error.code === "untrusted") {
              failVersion("untrusted", error.message);
            } else if (error instanceof ProtocolError && error.code === "version") {
              failVersion("version");
            } else {
              failVersion("handshake", error instanceof ProtocolError ? error.code : undefined);
            }
          }
        };
      };
      tryVersion(0);
    });

    return {
      label: input.label,
      promise,
      abort: () => {
        if (completedWs !== null) {
          const ws = completedWs;
          completedWs = null;
          try { ws.close(); } catch { /* already closed */ }
          return;
        }
        if (settled) return;
        settled = true;
        const ws = activeWs;
        activeWs = null;
        if (ws) {
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
          try { ws.close(); } catch { /* already closed */ }
        }
        rejectAttempt?.({ addr: input.endpoint, failure: "unreachable", detail: "cancelled" });
      },
    };
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
    this.fatalReceiveError = null;
    this.activeAddr = won.endpoint;
    this.activePath = won.path;
    this.lastRttMs = won.rttMs;
    this.lastRecvAt = Date.now();
    this.lastPingAt = this.lastRecvAt;
    this.pendingPingId = null;
    this.negotiatedProtocolVersion =
      won.helloOk.host.negotiatedProtocolVersion ?? won.protocolVersion;
    this.advertisedCapabilities = won.helloOk.host.capabilities === undefined
      ? null
      : new Set(won.helloOk.host.capabilities);

    useApp.getState().setSessions(this.host.id, won.helloOk.sessions);
    this.patch({
      status: "connected",
      hostInfo: won.helloOk.host,
      activeAddr: won.endpoint,
      activePath: won.path,
      lastError: null,
      rttMs: won.rttMs,
    });

    // 记住这个地址,下次优先试(切网后往往还是同一个)
    if (won.path === "direct") void rememberGoodAddr(this.host.id, won.endpoint);

    won.ws.onmessage = (ev) => this.onMessage(String(ev.data));
    won.ws.onclose = () => this.onClose();
    won.ws.onerror = () => {
      // onclose 随后触发
    };

    this.startHeartbeat();
    this.flushQueue();
    this.events.emit("connected", { addr: won.endpoint, path: won.path, rttMs: won.rttMs });
  }

  /**
   * RN WebSocket 没有暴露底层 ping/pong。v13 起改用已加密的应用层
   * connection.ping/pong；旧 daemon 没有该消息，仍只做静默超时检测。
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected) return;
      const now = Date.now();
      const action = nextLivenessAction({
        protocolVersion: this.negotiatedProtocolVersion ?? 0,
        lastRecvAt: this.lastRecvAt,
        lastPingAt: this.lastPingAt,
        pendingPingId: this.pendingPingId,
      }, now);
      if (action === "reconnect") {
        // 半开连接:socket 还是 OPEN 但实际已死,主动断开走重连
        this.ws?.close();
        return;
      }
      if (action !== "send_ping") return;
      const id = randomUUID();
      const result = this.send({ type: "connection.ping", id });
      if (result.accepted) {
        this.pendingPingId = id;
        this.lastPingAt = now;
      }
    }, HEARTBEAT_TICK_MS);
  }

  private onMessage(text: string): void {
    this.lastRecvAt = Date.now();
    let msg: S2CMessage;
    try {
      msg = parseS2C(this.channel!.open(text));
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "format") {
        this.fatalReceiveError =
          `主机返回的数据不符合协议：${error.message}。请升级 daemon 后手动重试。`;
      }
      this.ws?.close(); // 密文/计数器错误可重连；格式错误由 onClose 停止死循环
      return;
    }
    switch (msg.type) {
      case "connection.pong":
        if (msg.id === this.pendingPingId) this.pendingPingId = null;
        return;
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
    root?: string,
    mkdir?: string,
  ): Promise<Extract<S2CMessage, { type: "workspace.listing" }>> {
    const result = await this.fsRequest<Extract<S2CMessage, { type: "workspace.listing" }>>(
      "#workspace",
      path,
      {
        type: "workspace.list",
        path,
        ...(root ? { root } : {}),
        ...(mkdir ? { mkdir } : {}),
      },
    );
    if (result.error) throw new Error(result.error);
    return result;
  }

  workspaceMkdir(
    path: string,
    root: string,
    name: string,
  ): Promise<Extract<S2CMessage, { type: "workspace.listing" }>> {
    return this.workspaceList(path, root, name);
  }

  /** 搜索电脑上由 Claude Code / Codex 自己保存、可原生接回的对话。 */
  async localConversations(
    agent: "claude" | "codex" | "deepseek",
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
    if (!this.supportsAgentAccounts) throw new Error("请先升级电脑端以管理 Code Agent 账号");
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
    if (!this.supportsAgentApiProfiles) throw new Error("请先升级电脑端以使用第三方 API Profile");
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
    if (!this.supportsAgentApiProfiles) throw new Error("请先升级电脑端以使用第三方 API Profile");
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
    // close 事件触发时 readyState 已不是 OPEN，不能再用 isConnected 判断旧状态。
    const wasConnected = this.ws !== null && this.channel !== null;
    const fatalReceiveError = this.fatalReceiveError;
    this.fatalReceiveError = null;
    // 断线时挂起的文件请求永远等不到应答了,立刻失败好过等超时
    for (const [, waiter] of this.fsWaiters) waiter.reject(new Error("连接已断开"));
    this.fsWaiters.clear();
    this.clearTimers();
    this.ws = null;
    this.channel = null;
    this.activeAddr = null;
    this.activePath = null;
    if (this.stopped) return;
    if (fatalReceiveError) {
      this.patch({ status: "failed", activeAddr: null, activePath: null, lastError: fatalReceiveError });
      if (wasConnected) this.events.emit("disconnected", { willRetry: false });
      return;
    }
    this.patch({ status: "reconnecting", activeAddr: null, activePath: null });
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
      /** 从第一轮起生效；省略时 daemon 保持最保守的 strict。 */
      approvalPolicy?: ApprovalPolicy;
      resume?: { id: string; title?: string };
      /** Goal 会同时创建编排 Run，并把新会话作为协调者。 */
      goal?: string;
      /** 账号环境与 cwd 独立；多个账号可指向同一个项目。 */
      accountId?: string;
      /** 从创建器实时目录中选择，保证第一轮就使用该模型。 */
      model?: string;
      effort?: string;
      /** DeepSeek Harness 启动时固定的 Agent 预设。 */
      agentPreset?: string;
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
        ...(options?.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options?.resume ? { resume: options.resume } : {}),
        ...(options?.goal ? { goal: options.goal } : {}),
        ...(options?.accountId ? { accountId: options.accountId } : {}),
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.effort ? { effort: options.effort } : {}),
        ...(options?.agentPreset ? { agentPreset: options.agentPreset } : {}),
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

  completeOrchestrationRun(runId: string): boolean {
    if (!this.supportsOrchestrationRunLifecycle) return false;
    return this.send({
      type: "orchestration.run.complete",
      runId,
      operationId: randomUUID(),
    }, true).accepted;
  }

  abandonOrchestrationRun(runId: string): boolean {
    if (!this.supportsOrchestrationRunLifecycle) return false;
    return this.send({
      type: "orchestration.run.abandon",
      runId,
      operationId: randomUUID(),
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

  /** 重新执行只读 Git 检查；结果会随下一份编排快照返回。 */
  inspectOrchestrationWorktree(assetId: string, targetRef?: string): boolean {
    if (!this.supportsOrchestrationWorktrees) return false;
    return this.send({
      type: "orchestration.worktree.inspect",
      assetId,
      ...(targetRef ? { targetRef } : {}),
    }, true).accepted;
  }

  /**
   * 服务端会在删除前再检查一遍；这里不暴露 force，且始终保留分支作为恢复锚点。
   */
  cleanupOrchestrationWorktree(input: {
    assetId: string;
    targetRef?: string;
  }): boolean {
    if (!this.supportsOrchestrationWorktrees) return false;
    return this.send({
      type: "orchestration.worktree.cleanup",
      operationId: randomUUID(),
      assetId: input.assetId,
      ...(input.targetRef ? { targetRef: input.targetRef } : {}),
      confirm: true,
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
      return Promise.reject(new Error("请升级电脑端以查看历史图片"));
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
    if (!this.supportsSubagentHistory) throw new Error("当前电脑端版本不支持子 Agent 历史");
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
    agent: "claude" | "codex" | "deepseek",
    accountId?: string,
  ): Promise<Extract<S2CMessage, { type: "launch.models" }>> {
    if (!this.supportsSessionCreateModel) {
      return Promise.reject(new Error("请先升级电脑端以在创建会话时选择模型"));
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

function hasSameConnectionConfig(a: StoredHost, b: StoredHost): boolean {
  return a.token === b.token &&
    a.daemonPub === b.daemonPub &&
    a.connectionMode === b.connectionMode &&
    a.port === b.port &&
    a.lastGoodAddr === b.lastGoodAddr &&
    a.relayToken === b.relayToken &&
    a.addrs.length === b.addrs.length &&
    a.addrs.every((addr, index) => addr === b.addrs[index]) &&
    a.relay?.url === b.relay?.url &&
    a.relay?.routeId === b.relay?.routeId &&
    a.relay?.deviceId === b.relay?.deviceId;
}

export function getConnection(host: StoredHost, keys: KeyPairB64): HostConnection {
  const existing = connections.get(host.id);
  if (existing) {
    // 重新配对、修改线路或切换模式后都必须换掉旧 socket，避免它继续按
    // 已过期的候选集重连。
    if (hasSameConnectionConfig(existing.host, host)) {
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
