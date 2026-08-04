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

export const PROTOCOL_VERSION = 0;

export type {
  AgentKind,
  SessionStatus,
  SessionInfo,
  HostInfo,
  C2SHello,
  C2SSessionCreate,
  C2SSessionAttach,
  C2STermInput,
  C2STermResize,
  C2STermAck,
  C2SPermissionRespond,
  C2SMessage,
  S2CHelloOk,
  S2CSessionState,
  S2CTermSnapshot,
  S2CTermOutput,
  S2CPermissionRequest,
  S2CError,
  S2CMessage,
  PairingPayload,
} from "./schemas.js";
