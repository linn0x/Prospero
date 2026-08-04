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

export const SessionInfoSchema = z.object({
  id: sid,
  agent: AgentKindSchema,
  title: z.string(),
  cwd: z.string(),
  status: SessionStatusSchema,
  createdAt: z.number().int().nonnegative(),
  cols,
  rows,
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
  cwd: z.string().optional(),
  /** agent === "custom" 时的完整命令行 */
  command: z.string().optional(),
  cols,
  rows,
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

export const C2SPermissionRespondSchema = z.object({
  type: z.literal("permission.respond"), // M2
  sid,
  reqId: z.string().min(1),
  allow: z.boolean(),
  always: z.boolean().optional(),
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

export const S2CPermissionRequestSchema = z.object({
  type: z.literal("permission.request"), // M2
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
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
export type HostInfo = z.infer<typeof HostInfoSchema>;
export type C2SHello = z.infer<typeof C2SHelloSchema>;
export type C2SSessionCreate = z.infer<typeof C2SSessionCreateSchema>;
export type C2SSessionAttach = z.infer<typeof C2SSessionAttachSchema>;
export type C2STermInput = z.infer<typeof C2STermInputSchema>;
export type C2STermResize = z.infer<typeof C2STermResizeSchema>;
export type C2STermAck = z.infer<typeof C2STermAckSchema>;
export type C2SPermissionRespond = z.infer<typeof C2SPermissionRespondSchema>;
export type C2SMessage = z.infer<typeof C2SMessageSchema>;
export type S2CHelloOk = z.infer<typeof S2CHelloOkSchema>;
export type S2CSessionState = z.infer<typeof S2CSessionStateSchema>;
export type S2CTermSnapshot = z.infer<typeof S2CTermSnapshotSchema>;
export type S2CTermOutput = z.infer<typeof S2CTermOutputSchema>;
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
