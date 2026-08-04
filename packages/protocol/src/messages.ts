/**
 * Prospero Protocol v0 — 常量与类型门面。
 * 类型的单一来源是 schemas.ts(zod),这里统一再导出,
 * 使用方 `import type { C2SMessage } from "@prospero/protocol"`。
 *
 * 语义约定:
 * - 所有消息经 E2E 加密(crypto.ts SecureChannel)后走 WebSocket 文本帧;
 * - S→C 的 term.output 按会话单调递增 seq;attach 携带 lastSeq 实现断线续传,
 *   gap 超出服务端环形缓冲(ring.ts)时回退全量快照(term.snapshot);
 * - term.ack 用于背压:daemon 依据未确认字节数暂停 PTY 读取。
 */

// v1:握手改为双方临时密钥,静态密钥只用于身份证明(前向保密)。
// 与 v0 不兼容 —— 旧客户端会在版本校验处被拒,而不是悄悄降级。
export const PROTOCOL_VERSION = 1;

export type {
  AgentKind,
  SessionKind,
  SessionStatus,
  SessionInfo,
  HostInfo,
  PermissionReply,
  C2SHello,
  C2SSessionCreate,
  C2SSessionAttach,
  C2SChatSend,
  C2SToolOutputGet,
  FileDiff,
  S2CToolOutput,
  C2STermInput,
  C2STermResize,
  C2STermAck,
  C2SPermissionRespond,
  C2SMessage,
  ChatRole,
  ToolState,
  AgentEventBody,
  AgentTextDelta,
  AgentToolStart,
  AgentToolEnd,
  AgentPermissionRequest,
  AgentTurnEnd,
  S2CHelloOk,
  S2CSessionState,
  S2CTermSnapshot,
  S2CTermOutput,
  S2CAgentEvent,
  S2CChatSnapshot,
  S2CPermissionRequest,
  S2CError,
  S2CMessage,
  PairingPayload,
} from "./schemas.js";

/**
 * WebSocket 关闭码。断开时这是 daemon 唯一还能传达的信息,
 * 所以每种"客户端该怎么办"都要有独立的码 —— 混用会让 App 只能给出含糊提示。
 * 4000-4999 是应用私有区间。
 */
export const CLOSE_AUTH_FAILED = 4001;
/** 握手/加密层出错(格式、版本、解密失败) */
export const CLOSE_PROTOCOL = 4003;
/** 设备被撤销:重试永远无用,必须重新配对 */
export const CLOSE_REVOKED = 4004;
