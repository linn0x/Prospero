/**
 * Prospero Protocol v0 — 消息类型定义。
 * 所有消息经 E2E 加密后走 WebSocket;S→C 的会话消息带单调 seq,
 * attach 携带 lastSeq 实现断线续传(gap 超出环形缓冲则回退全量快照)。
 * zod 运行时校验在 W1 补齐(schemas.ts)。
 */

export const PROTOCOL_VERSION = 0;

export type AgentKind =
  | "shell"
  | "claude"
  | "codex"
  | "opencode"
  | "grok"
  | "trae"
  | "custom";

export type SessionStatus =
  | "starting"
  | "running"
  | "waiting_approval" // M2 结构化轨使用,类型先占位
  | "idle"
  | "done"
  | "died";

export interface SessionInfo {
  id: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  status: SessionStatus;
  createdAt: number;
  cols: number;
  rows: number;
}

export interface HostInfo {
  name: string;
  daemonVersion: string;
  protocolVersion: number;
}

// ---------------------------------------------------------------- C → S

export interface C2SHello {
  type: "hello";
  token: string;
  /** 客户端 X25519 公钥(base64),用于派生会话密钥 */
  clientPubKey: string;
  clientInfo: { platform: "ios" | "android"; appVersion: string };
}

export interface C2SSessionCreate {
  type: "session.create";
  agent: AgentKind;
  cwd?: string;
  /** agent === "custom" 时的完整命令行 */
  command?: string;
  cols: number;
  rows: number;
}

export interface C2SSessionAttach {
  type: "session.attach";
  sid: string;
  /** 客户端已收到的最后 seq;省略表示要全量快照 */
  lastSeq?: number;
}

export interface C2STermInput {
  type: "term.input";
  sid: string;
  dataB64: string;
}

export interface C2STermResize {
  type: "term.resize";
  sid: string;
  cols: number;
  rows: number;
}

export interface C2STermAck {
  type: "term.ack";
  sid: string;
  seq: number;
}

export interface C2SPermissionRespond {
  type: "permission.respond"; // M2
  sid: string;
  reqId: string;
  allow: boolean;
  always?: boolean;
}

export interface C2SSessionInterrupt {
  type: "session.interrupt";
  sid: string;
}

export interface C2SSessionKill {
  type: "session.kill";
  sid: string;
}

export type C2SMessage =
  | C2SHello
  | C2SSessionCreate
  | C2SSessionAttach
  | C2STermInput
  | C2STermResize
  | C2STermAck
  | C2SPermissionRespond
  | C2SSessionInterrupt
  | C2SSessionKill;

// ---------------------------------------------------------------- S → C

export interface S2CHelloOk {
  type: "hello.ok";
  host: HostInfo;
  sessions: SessionInfo[];
}

export interface S2CSessionState {
  type: "session.state";
  session: SessionInfo;
}

export interface S2CTermSnapshot {
  type: "term.snapshot";
  sid: string;
  /** @xterm/addon-serialize 输出的 ANSI 串(含颜色/光标/scrollback) */
  ansi: string;
  seq: number;
  cols: number;
  rows: number;
}

export interface S2CTermOutput {
  type: "term.output";
  sid: string;
  dataB64: string;
  seq: number;
}

export interface S2CPermissionRequest {
  type: "permission.request"; // M2
  sid: string;
  reqId: string;
  tool: string;
  summary: string;
}

export interface S2CError {
  type: "error";
  code:
    | "auth_failed"
    | "not_paired"
    | "shell_not_allowed"
    | "session_not_found"
    | "agent_unavailable"
    | "bad_message";
  message: string;
  sid?: string;
}

export type S2CMessage =
  | S2CHelloOk
  | S2CSessionState
  | S2CTermSnapshot
  | S2CTermOutput
  | S2CPermissionRequest
  | S2CError;

// ---------------------------------------------------------------- 配对 QR 载荷

/** QR 内容:`prospero://pair?d=<base64url(JSON.stringify(PairingPayload))>` */
export interface PairingPayload {
  v: number;
  name: string;
  /** 全部网卡候选地址(en0 / utun* …),客户端并发竞速 */
  addrs: string[];
  port: number;
  token: string;
  /** daemon X25519 公钥(base64) */
  pubKey: string;
}
