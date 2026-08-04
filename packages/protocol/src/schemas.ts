/**
 * Prospero Protocol v0 — zod schema(类型的单一来源)。
 * daemon 校验 C2S,客户端校验 S2C;类型经 z.infer 从这里导出。
 */
import { z } from "zod";
import { fromB64 } from "./b64.js";
import { ProtocolError } from "./errors.js";

export const AgentKindSchema = z.enum([
  "shell",
  "claude",
  "codex",
  "opencode",
  "grok",
  "trae",
  "custom",
]);

export const SessionStatusSchema = z.enum([
  "starting",
  "running",
  "waiting_approval", // M2 结构化轨使用,先占位
  "idle",
  "done",
  "died",
]);

const b64Key32 = z.string().refine(
  (s) => {
    try {
      return fromB64(s).length === 32;
    } catch {
      return false;
    }
  },
  { message: "expected base64-encoded 32-byte key" },
);

const cols = z.number().int().min(2).max(1000);
const rows = z.number().int().min(2).max(1000);
const sid = z.string().min(1);
const seq = z.number().int().nonnegative();

/**
 * 会话轨道:
 * - pty:终端镜像(通用轨,任何 CLI 都能跑)
 * - structured:结构化事件流(聊天 UI + 一键审批),由 agent 适配器驱动
 */
export const SessionKindSchema = z.enum(["pty", "structured"]);

export const SessionInfoSchema = z.object({
  id: sid,
  agent: AgentKindSchema,
  kind: SessionKindSchema,
  title: z.string(),
  cwd: z.string(),
  status: SessionStatusSchema,
  createdAt: z.number().int().nonnegative(),
  cols,
  rows,
  /** 结构化会话:当前是否有待处理审批 */
  pendingPermissions: z.number().int().nonnegative().optional(),
});

export const HostInfoSchema = z.object({
  name: z.string(),
  daemonVersion: z.string(),
  protocolVersion: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------- C → S

export const C2SHelloSchema = z.object({
  type: z.literal("hello"),
  token: z.string().min(16),
  /** 客户端设备身份 X25519 公钥(base64),预留给按设备撤销/审计 */
  clientPubKey: b64Key32,
  clientInfo: z.object({
    platform: z.enum(["ios", "android"]),
    appVersion: z.string(),
  }),
});

export const C2SSessionCreateSchema = z.object({
  type: z.literal("session.create"),
  agent: AgentKindSchema,
  /** 省略时由 daemon 按 agent 能力决定(有适配器的走 structured) */
  kind: SessionKindSchema.optional(),
  cwd: z.string().optional(),
  /** agent === "custom" 时的完整命令行 */
  command: z.string().optional(),
  cols,
  rows,
});

/** 结构化轨:发送一条用户消息 */
export const C2SChatSendSchema = z.object({
  type: z.literal("chat.send"),
  sid,
  text: z.string().min(1),
});

export const C2SSessionAttachSchema = z.object({
  type: z.literal("session.attach"),
  sid,
  /** 客户端已收到的最后 seq;省略表示要全量快照 */
  lastSeq: seq.optional(),
});

export const C2STermInputSchema = z.object({
  type: z.literal("term.input"),
  sid,
  dataB64: z.string().min(1),
});

export const C2STermResizeSchema = z.object({
  type: z.literal("term.resize"),
  sid,
  cols,
  rows,
});

export const C2STermAckSchema = z.object({
  type: z.literal("term.ack"),
  sid,
  seq,
});

export const PermissionReplySchema = z.enum(["once", "always", "reject"]);

export const C2SPermissionRespondSchema = z.object({
  type: z.literal("permission.respond"),
  sid,
  reqId: z.string().min(1),
  reply: PermissionReplySchema,
});

export const C2SSessionInterruptSchema = z.object({
  type: z.literal("session.interrupt"),
  sid,
});

export const C2SSessionKillSchema = z.object({
  type: z.literal("session.kill"),
  sid,
});

export const C2SMessageSchema = z.discriminatedUnion("type", [
  C2SHelloSchema,
  C2SSessionCreateSchema,
  C2SSessionAttachSchema,
  C2SChatSendSchema,
  C2STermInputSchema,
  C2STermResizeSchema,
  C2STermAckSchema,
  C2SPermissionRespondSchema,
  C2SSessionInterruptSchema,
  C2SSessionKillSchema,
]);

// ---------------------------------------------------------------- S → C

export const S2CHelloOkSchema = z.object({
  type: z.literal("hello.ok"),
  host: HostInfoSchema,
  sessions: z.array(SessionInfoSchema),
});

export const S2CSessionStateSchema = z.object({
  type: z.literal("session.state"),
  session: SessionInfoSchema,
});

export const S2CTermSnapshotSchema = z.object({
  type: z.literal("term.snapshot"),
  sid,
  /** @xterm/addon-serialize 输出的 ANSI 串(含颜色/光标/scrollback) */
  ansi: z.string(),
  seq,
  cols,
  rows,
});

export const S2CTermOutputSchema = z.object({
  type: z.literal("term.output"),
  sid,
  dataB64: z.string(),
  seq,
});

// ---------------------------------------------------------------- 结构化轨事件
//
// 各 agent 适配器(opencode SSE / Claude Agent SDK / Codex app-server)统一归一化
// 到下面这组事件。客户端只认这套,不感知后端差异。
// 每条带 evSeq(会话内单调),attach 时用 chat.snapshot 一次性补齐历史。

export const ChatRoleSchema = z.enum(["user", "assistant"]);

export const ToolStateSchema = z.enum(["running", "success", "failed"]);

/** 助手文本增量;textId 用于把同一段文本的多次增量归并 */
export const AgentTextDeltaSchema = z.object({
  kind: z.literal("text.delta"),
  msgId: z.string(),
  textId: z.string(),
  delta: z.string(),
});

/** 推理(thinking)增量,UI 默认折叠 */
export const AgentReasoningDeltaSchema = z.object({
  kind: z.literal("reasoning.delta"),
  msgId: z.string(),
  delta: z.string(),
});

export const AgentToolStartSchema = z.object({
  kind: z.literal("tool.start"),
  msgId: z.string(),
  callId: z.string(),
  tool: z.string(),
  /** 参数摘要(适配器裁剪过,避免大 payload 过网) */
  summary: z.string(),
});

export const AgentToolEndSchema = z.object({
  kind: z.literal("tool.end"),
  callId: z.string(),
  state: ToolStateSchema,
  /** 结果摘要或错误信息 */
  summary: z.string(),
});

export const AgentPermissionRequestSchema = z.object({
  kind: z.literal("permission.request"),
  reqId: z.string(),
  /** 动作标识,如 "bash" / "edit" */
  action: z.string(),
  /** 涉及的资源(命令行、文件路径…) */
  resources: z.array(z.string()),
  summary: z.string(),
});

export const AgentPermissionResolvedSchema = z.object({
  kind: z.literal("permission.resolved"),
  reqId: z.string(),
  reply: PermissionReplySchema,
});

export const AgentTurnEndSchema = z.object({
  kind: z.literal("turn.end"),
  msgId: z.string(),
  finish: z.string().optional(),
  costUsd: z.number().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});

export const AgentUserMessageSchema = z.object({
  kind: z.literal("user.message"),
  msgId: z.string(),
  text: z.string(),
});

export const AgentErrorSchema = z.object({
  kind: z.literal("agent.error"),
  message: z.string(),
});

export const AgentEventBodySchema = z.discriminatedUnion("kind", [
  AgentUserMessageSchema,
  AgentTextDeltaSchema,
  AgentReasoningDeltaSchema,
  AgentToolStartSchema,
  AgentToolEndSchema,
  AgentPermissionRequestSchema,
  AgentPermissionResolvedSchema,
  AgentTurnEndSchema,
  AgentErrorSchema,
]);

export const S2CAgentEventSchema = z.object({
  type: z.literal("agent.event"),
  sid,
  evSeq: seq,
  body: AgentEventBodySchema,
});

/** attach 结构化会话时的历史快照:重放全部已知事件 */
export const S2CChatSnapshotSchema = z.object({
  type: z.literal("chat.snapshot"),
  sid,
  evSeq: seq,
  events: z.array(AgentEventBodySchema),
});

export const S2CPermissionRequestSchema = z.object({
  type: z.literal("permission.request"),
  sid,
  reqId: z.string().min(1),
  tool: z.string(),
  summary: z.string(),
});

export const S2CErrorSchema = z.object({
  type: z.literal("error"),
  code: z.enum([
    "auth_failed",
    "not_paired",
    "shell_not_allowed",
    "session_not_found",
    "agent_unavailable",
    "bad_message",
  ]),
  message: z.string(),
  sid: sid.optional(),
});

export const S2CMessageSchema = z.discriminatedUnion("type", [
  S2CHelloOkSchema,
  S2CSessionStateSchema,
  S2CTermSnapshotSchema,
  S2CTermOutputSchema,
  S2CAgentEventSchema,
  S2CChatSnapshotSchema,
  S2CPermissionRequestSchema,
  S2CErrorSchema,
]);

// ---------------------------------------------------------------- 配对 QR 载荷

export const PairingPayloadSchema = z.object({
  v: z.number().int().nonnegative(),
  name: z.string().min(1),
  /** 全部网卡候选地址(en0 / utun* …),客户端并发竞速 */
  addrs: z.array(z.string().min(1)).min(1),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(16),
  /** daemon X25519 公钥(base64) */
  pubKey: b64Key32,
});

// ---------------------------------------------------------------- 推断类型与解析入口

export type AgentKind = z.infer<typeof AgentKindSchema>;
export type SessionKind = z.infer<typeof SessionKindSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
export type HostInfo = z.infer<typeof HostInfoSchema>;
export type PermissionReply = z.infer<typeof PermissionReplySchema>;
export type C2SHello = z.infer<typeof C2SHelloSchema>;
export type C2SSessionCreate = z.infer<typeof C2SSessionCreateSchema>;
export type C2SSessionAttach = z.infer<typeof C2SSessionAttachSchema>;
export type C2SChatSend = z.infer<typeof C2SChatSendSchema>;
export type C2STermInput = z.infer<typeof C2STermInputSchema>;
export type C2STermResize = z.infer<typeof C2STermResizeSchema>;
export type C2STermAck = z.infer<typeof C2STermAckSchema>;
export type C2SPermissionRespond = z.infer<typeof C2SPermissionRespondSchema>;
export type C2SMessage = z.infer<typeof C2SMessageSchema>;
export type ChatRole = z.infer<typeof ChatRoleSchema>;
export type ToolState = z.infer<typeof ToolStateSchema>;
export type AgentEventBody = z.infer<typeof AgentEventBodySchema>;
export type AgentTextDelta = z.infer<typeof AgentTextDeltaSchema>;
export type AgentToolStart = z.infer<typeof AgentToolStartSchema>;
export type AgentToolEnd = z.infer<typeof AgentToolEndSchema>;
export type AgentPermissionRequest = z.infer<typeof AgentPermissionRequestSchema>;
export type AgentTurnEnd = z.infer<typeof AgentTurnEndSchema>;
export type S2CHelloOk = z.infer<typeof S2CHelloOkSchema>;
export type S2CSessionState = z.infer<typeof S2CSessionStateSchema>;
export type S2CTermSnapshot = z.infer<typeof S2CTermSnapshotSchema>;
export type S2CTermOutput = z.infer<typeof S2CTermOutputSchema>;
export type S2CAgentEvent = z.infer<typeof S2CAgentEventSchema>;
export type S2CChatSnapshot = z.infer<typeof S2CChatSnapshotSchema>;
export type S2CPermissionRequest = z.infer<typeof S2CPermissionRequestSchema>;
export type S2CError = z.infer<typeof S2CErrorSchema>;
export type S2CMessage = z.infer<typeof S2CMessageSchema>;
export type PairingPayload = z.infer<typeof PairingPayloadSchema>;

function summarizeZodError(e: z.ZodError): string {
  return e.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export function parseC2S(v: unknown): C2SMessage {
  const r = C2SMessageSchema.safeParse(v);
  if (!r.success) {
    throw new ProtocolError(`bad C2S message: ${summarizeZodError(r.error)}`, "format");
  }
  return r.data;
}

export function parseS2C(v: unknown): S2CMessage {
  const r = S2CMessageSchema.safeParse(v);
  if (!r.success) {
    throw new ProtocolError(`bad S2C message: ${summarizeZodError(r.error)}`, "format");
  }
  return r.data;
}
