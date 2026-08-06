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
  "waiting_approval",
  "waiting_input",
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

/**
 * 审批策略。
 *
 * - strict:每次工具调用都问(最初的行为)
 * - standard:只读工具自动放行,改文件/执行命令/联网仍然问
 * - yolo:全部自动批准
 *
 * 为什么不是布尔开关:实际的痛点是"读操作太多、把人训练成盲批",
 * 而不是"审批本身多余"。standard 才是大多数时候真正想要的,
 * yolo 是明确知道自己在干什么时的选择。
 *
 * strict/standard 在【我们这一层】审批，保留完整审计。YOLO 对 Codex 还会同步
 * `never + dangerFullAccess`；只自动点批准却不解除 sandbox，会让 Docker 等资源
 * 继续被拒，形成“界面是 YOLO、实际不是”的假开关。工具事件仍照常记录。
 */
export const ApprovalPolicySchema = z.enum(["strict", "standard", "yolo"]);

/** 忙碌会话的新消息如何送达。省略 = 空闲立即发、忙碌进入队尾。 */
export const ChatDeliverySchema = z.enum(["auto", "queue", "steer"]);

/** 输入框远程补全：文件来自会话项目，Skill 来自 daemon 的统一注册表。 */
export const ChatSuggestionKindSchema = z.enum(["file", "skill"]);
export const ChatSuggestionSchema = z.object({
  kind: ChatSuggestionKindSchema,
  /** 插入输入框的项目相对路径或 Skill 名称；绝不把服务端绝对路径发给客户端。 */
  value: z.string().min(1).max(4096),
  label: z.string().min(1).max(500),
  detail: z.string().max(1000).optional(),
});

/** Agent 原生模型目录。id/effort 都来自后端实时能力，不在客户端硬编码。 */
export const AgentModelSchema = z.object({
  id: z.string().min(1).max(300),
  label: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  supportedEfforts: z.array(z.string().min(1).max(100)).max(20),
  defaultEffort: z.string().min(1).max(100).optional(),
  isDefault: z.boolean().optional(),
});

/** Agent 原生协作模式。当前 Codex/Claude 都提供 default 与 plan。 */
export const AgentModeSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});

/** 会话当前暴露给 GUI 的原生控制能力；未实现的 Agent 不伪装成支持。 */
export const AgentControlsSchema = z.object({
  compact: z.boolean(),
  model: z.boolean(),
  mode: z.boolean(),
  currentModel: z.string().min(1).max(300).optional(),
  currentEffort: z.string().min(1).max(100).optional(),
  currentMode: z.string().min(1).max(100).optional(),
});

export const SubagentStatusSchema = z.enum([
  "starting",
  "running",
  "waiting_input",
  "idle",
  "completed",
  "failed",
  "stopped",
]);

/** 主会话下的可查看子 Agent。id 是后端可定向投递的原生身份。 */
export const SubagentInfoSchema = z.object({
  id: z.string().min(1).max(500),
  name: z.string().min(1).max(300),
  role: z.string().max(300).optional(),
  task: z.string().max(10000).optional(),
  status: SubagentStatusSchema,
  canMessage: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  preview: z.string().max(1000).optional(),
});

export const QueuedChatMessageSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  kind: z.enum(["queue", "guide"]),
  createdAt: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
});

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
  /** 结构化会话:当前有多少组 Agent 主动提问等待回答。 */
  pendingQuestions: z.number().int().nonnegative().optional(),
  /** 当前审批策略;放宽时 UI 必须显著提示 */
  approvalPolicy: ApprovalPolicySchema.optional(),
  /** 最后一条助手消息的摘要,用于会话列表预览 */
  preview: z.string().optional(),
  /** 本轮开始时间戳,客户端据此显示"运行 12s" */
  busySince: z.number().int().nonnegative().optional(),
  /** 忙碌时等待发送的消息；正文用于手机展示与取消。 */
  messageQueue: z.array(QueuedChatMessageSchema).max(50).optional(),
  /** 原生 Agent 控制（压缩、模型选择）；PTY 与尚未实现的适配器可省略。 */
  agentControls: AgentControlsSchema.optional(),
  /** 生命周期内发现的子 Agent；客户端在项目会话管理中作为子会话展示。 */
  subagents: z.array(SubagentInfoSchema).max(100).optional(),
  /** 会话累计用量(所有轮次之和) */
  totals: z
    .object({
      costUsd: z.number().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .optional(),
});

export const HostInfoSchema = z.object({
  name: z.string(),
  daemonVersion: z.string(),
  protocolVersion: z.number().int().nonnegative(),
  /** 系统与硬件 —— 手机上想知道"我那台 Mac 现在怎么样" */
  platform: z.string().optional(),
  osVersion: z.string().optional(),
  arch: z.string().optional(),
  cpus: z.number().int().positive().optional(),
  /** 内存总量 / 可用,字节 */
  memTotal: z.number().nonnegative().optional(),
  memFree: z.number().nonnegative().optional(),
  /** 系统已运行秒数 */
  uptimeSec: z.number().nonnegative().optional(),
  /** 1/5/15 分钟平均负载 */
  loadAvg: z.array(z.number()).optional(),
  /** daemon 自身启动时间戳,判断它跑了多久 */
  daemonStartedAt: z.number().int().nonnegative().optional(),
  /** 会话是否托管在 tmux(决定 daemon 重启会不会丢会话) */
  tmuxManaged: z.boolean().optional(),
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
  /** 省略 = strict */
  approvalPolicy: ApprovalPolicySchema.optional(),
  /** 省略时由 daemon 按 agent 能力决定(有适配器的走 structured) */
  kind: SessionKindSchema.optional(),
  cwd: z.string().optional(),
  /** agent === "custom" 时的完整命令行 */
  command: z.string().optional(),
  cols,
  rows,
});

/**
 * 消息附件(目前只有图片)。
 *
 * mime 限定在 Claude 接受的四种 —— iOS 相册常给 HEIC,客户端必须先转,
 * 与其让 daemon 收下再拒,不如在协议层就说清楚。
 * 单张 6MB(base64 后约 8MB),够一张压过的照片,又不至于让一条 WS 消息失控。
 */
export const AttachmentSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  dataB64: z.string().max(8 * 1024 * 1024),
  name: z.string().max(200).optional(),
});

/**
 * 结构化轨:发送一条用户消息。
 *
 * text 不再要求非空 —— 只发一张报错截图是完全合理的。但"既没字也没图"
 * 依然无意义,所以约束从"文本非空"改成"至少得有点内容"。
 */
export const C2SChatSendSchema = z.object({
  type: z.literal("chat.send"),
  sid,
  text: z.string(),
  attachments: z.array(AttachmentSchema).max(6).optional(),
  /** queue 排到队尾；steer 尝试引导当前轮，不能引导时排到队首。 */
  delivery: ChatDeliverySchema.optional(),
});

export const C2SChatQueueRemoveSchema = z.object({
  type: z.literal("chat.queue.remove"),
  sid,
  queueId: z.string().min(1),
});

export const C2SChatQueueGuideSchema = z.object({
  type: z.literal("chat.queue.guide"),
  sid,
  queueId: z.string().min(1),
});

export const C2SChatCompleteSchema = z.object({
  type: z.literal("chat.complete"),
  sid,
  requestId: z.string().min(1).max(100),
  kind: ChatSuggestionKindSchema,
  query: z.string().max(300),
});

export const C2SAgentModelsGetSchema = z.object({
  type: z.literal("agent.models.get"),
  sid,
  requestId: z.string().min(1).max(100),
});

export const C2SAgentModelSetSchema = z.object({
  type: z.literal("agent.model.set"),
  sid,
  requestId: z.string().min(1).max(100),
  model: z.string().min(1).max(300),
  effort: z.string().min(1).max(100).optional(),
});

export const C2SAgentModesGetSchema = z.object({
  type: z.literal("agent.modes.get"),
  sid,
  requestId: z.string().min(1).max(100),
});

export const C2SAgentModeSetSchema = z.object({
  type: z.literal("agent.mode.set"),
  sid,
  requestId: z.string().min(1).max(100),
  mode: z.string().min(1).max(100),
});

export const C2SAgentCompactSchema = z.object({
  type: z.literal("agent.compact"),
  sid,
  requestId: z.string().min(1).max(100),
});

/** 按需拉取某次工具调用的完整输出(卡片展开时) */
export const C2SToolOutputGetSchema = z.object({
  type: z.literal("tool.output.get"),
  sid,
  callId: z.string().min(1),
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

/** 通用问题回答；values 同时覆盖单选、多选与自由输入。 */
export const AgentQuestionAnswerSchema = z.object({
  questionId: z.string().min(1).max(300),
  values: z.array(z.string().max(10000)).max(20),
});

export const C2SQuestionRespondSchema = z.object({
  type: z.literal("question.respond"),
  sid,
  reqId: z.string().min(1),
  answers: z.array(AgentQuestionAnswerSchema).max(4),
  cancelled: z.boolean().optional(),
});

export const C2SSubagentSendSchema = z.object({
  type: z.literal("subagent.send"),
  sid,
  subagentId: z.string().min(1).max(500),
  text: z.string().min(1).max(100000),
});

/** 会话中途改审批策略 */
export const C2SApprovalPolicySetSchema = z.object({
  type: z.literal("approval.policy.set"),
  sid,
  policy: ApprovalPolicySchema,
});

export const C2SSessionInterruptSchema = z.object({
  type: z.literal("session.interrupt"),
  sid,
});

export const C2SSessionKillSchema = z.object({
  type: z.literal("session.kill"),
  sid,
});

// ---------------------------------------------------------------- 文件操作
//
// 全部路径都相对于会话的 cwd,由 daemon 侧解析并强制约束在该根之下。
// 客户端永远不发绝对路径 —— 那等于把"能访问哪里"的判断交给客户端,
// 而客户端是不可信的一侧。

/** 相对路径;拒绝绝对路径与 ".." 段(daemon 会再校验一次,这里只是早失败) */
const relPath = z
  .string()
  .max(4096)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), {
    message: "path must be relative and must not contain '..'",
  });

/**
 * 新建会话前浏览工作目录。
 *
 * 路径始终相对于 daemon 用户的 home;这让手机能做目录选择器,又不会把
 * "列整个文件系统"变成一条绕过 allowShell 的隐形后门。外部路径仍可手输。
 */
export const C2SWorkspaceListSchema = z.object({
  type: z.literal("workspace.list"),
  /** "" 表示用户 home */
  path: relPath,
});

/** 列目录 */
export const C2SFsListSchema = z.object({
  type: z.literal("fs.list"),
  sid,
  /** "" 表示会话根目录 */
  path: relPath,
});

/** 读文件(用于编辑;超过上限会被截断并置 truncated) */
export const C2SFsReadSchema = z.object({
  type: z.literal("fs.read"),
  sid,
  path: relPath,
});

/** 写回文件(编辑保存) */
export const C2SFsWriteSchema = z.object({
  type: z.literal("fs.write"),
  sid,
  path: relPath,
  contentB64: z.string(),
});

/** 分块下载:任意文件(含二进制)按 offset/length 取 */
export const C2SFsGetSchema = z.object({
  type: z.literal("fs.get"),
  sid,
  path: relPath,
  offset: z.number().int().nonnegative(),
  length: z.number().int().min(1).max(1024 * 1024),
});

/** 分块上传;offset 为 0 时截断重建,final 时收尾 */
export const C2SFsPutSchema = z.object({
  type: z.literal("fs.put"),
  sid,
  path: relPath,
  offset: z.number().int().nonnegative(),
  dataB64: z.string(),
  final: z.boolean(),
});

/** 新建目录(父目录须已存在) */
export const C2SFsMkdirSchema = z.object({
  type: z.literal("fs.mkdir"),
  sid,
  path: relPath,
});

/** 删除文件或空目录。非空目录不递归删 —— 手机上误触代价太大 */
export const C2SFsRemoveSchema = z.object({
  type: z.literal("fs.remove"),
  sid,
  path: relPath,
});

/** 重命名 / 移动;两端都必须在会话根内 */
export const C2SFsRenameSchema = z.object({
  type: z.literal("fs.rename"),
  sid,
  path: relPath,
  to: relPath,
});

// ---------------------------------------------------------------- git
//
// 只暴露固定的几种操作,不接受客户端传任意 git 参数 —— 那等于开一个命令执行口子。

export const C2SGitStatusSchema = z.object({ type: z.literal("git.status"), sid });

export const C2SGitDiffSchema = z.object({
  type: z.literal("git.diff"),
  sid,
  path: relPath,
  /** true = 看暂存区与 HEAD 的差异 */
  staged: z.boolean(),
});

export const C2SGitStageSchema = z.object({
  type: z.literal("git.stage"),
  sid,
  paths: z.array(relPath).min(1).max(500),
  /** true = 取消暂存 */
  unstage: z.boolean(),
});

export const C2SGitDiscardSchema = z.object({
  type: z.literal("git.discard"),
  sid,
  path: relPath,
});

export const C2SGitCommitSchema = z.object({
  type: z.literal("git.commit"),
  sid,
  message: z.string().min(1).max(10000),
});

/**
 * 取用量与限流。
 *
 * sid 可省略:套餐限流是【账号级】的,五小时窗口在所有会话之间共享,
 * 所以主机页也该看得到。省略时由 daemon 挑一个结构化会话去问。
 */
export const C2SUsageGetSchema = z.object({
  type: z.literal("usage.get"),
  sid: sid.optional(),
});

export const C2SMessageSchema = z.discriminatedUnion("type", [
  C2SHelloSchema,
  C2SSessionCreateSchema,
  C2SSessionAttachSchema,
  C2SChatSendSchema,
  C2SChatQueueRemoveSchema,
  C2SChatQueueGuideSchema,
  C2SChatCompleteSchema,
  C2SAgentModelsGetSchema,
  C2SAgentModelSetSchema,
  C2SAgentModesGetSchema,
  C2SAgentModeSetSchema,
  C2SAgentCompactSchema,
  C2SToolOutputGetSchema,
  C2STermInputSchema,
  C2STermResizeSchema,
  C2STermAckSchema,
  C2SPermissionRespondSchema,
  C2SQuestionRespondSchema,
  C2SSubagentSendSchema,
  C2SSessionInterruptSchema,
  C2SSessionKillSchema,
  C2SApprovalPolicySetSchema,
  C2SWorkspaceListSchema,
  C2SFsListSchema,
  C2SFsReadSchema,
  C2SFsWriteSchema,
  C2SFsGetSchema,
  C2SFsPutSchema,
  C2SFsMkdirSchema,
  C2SFsRemoveSchema,
  C2SFsRenameSchema,
  C2SGitStatusSchema,
  C2SGitDiffSchema,
  C2SGitStageSchema,
  C2SGitDiscardSchema,
  C2SGitCommitSchema,
  C2SUsageGetSchema,
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
  agentId: z.string().min(1).max(500).optional(),
});

/** 推理(thinking)增量,UI 默认折叠 */
export const AgentReasoningDeltaSchema = z.object({
  kind: z.literal("reasoning.delta"),
  msgId: z.string(),
  delta: z.string(),
  agentId: z.string().min(1).max(500).optional(),
});

/**
 * 文件改动的 diff。
 * 手机上审批"改文件"时,只给路径等于让用户盲批 —— 必须能看到改了哪几行。
 */
export const FileDiffSchema = z.object({
  path: z.string(),
  /** unified diff 正文(不含 ---/+++ 文件头),行首为 ' ' / '+' / '-' */
  patch: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** patch 因过大被截断 */
  truncated: z.boolean().optional(),
});

export const AgentToolStartSchema = z.object({
  kind: z.literal("tool.start"),
  msgId: z.string(),
  callId: z.string(),
  tool: z.string(),
  /** 参数摘要(适配器裁剪过,避免大 payload 过网) */
  summary: z.string(),
  /** 文件类工具:改动内容 */
  diff: FileDiffSchema.optional(),
  agentId: z.string().min(1).max(500).optional(),
});

export const AgentToolEndSchema = z.object({
  kind: z.literal("tool.end"),
  callId: z.string(),
  state: ToolStateSchema,
  /** 结果摘要或错误信息 */
  summary: z.string(),
  /** 完整输出比摘要长,可用 tool.output.get 按需拉取 */
  hasMore: z.boolean().optional(),
  diff: FileDiffSchema.optional(),
  agentId: z.string().min(1).max(500).optional(),
});

export const AgentPermissionRequestSchema = z.object({
  kind: z.literal("permission.request"),
  reqId: z.string(),
  /** 动作标识,如 "bash" / "edit" */
  action: z.string(),
  /** 涉及的资源(命令行、文件路径…) */
  resources: z.array(z.string()),
  summary: z.string(),
  /** 改文件类审批:待应用的改动,让用户看清再决定 */
  diff: FileDiffSchema.optional(),
  agentId: z.string().min(1).max(500).optional(),
});

/**
 * 被策略自动批准的一次调用。
 * 之所以还要发这条:自动批准是为了不打断,不是为了瞒着用户 ——
 * 聊天里必须留下痕迹,事后能翻出"那 20 分钟它到底动了什么"。
 */
export const AgentPermissionAutoSchema = z.object({
  kind: z.literal("permission.auto"),
  reqId: z.string(),
  action: z.string(),
  summary: z.string(),
  /** 当时生效的策略,便于回溯是哪一档放的行 */
  policy: ApprovalPolicySchema,
  agentId: z.string().min(1).max(500).optional(),
});

export const AgentPermissionResolvedSchema = z.object({
  kind: z.literal("permission.resolved"),
  reqId: z.string(),
  reply: PermissionReplySchema,
  agentId: z.string().min(1).max(500).optional(),
});

export const AgentQuestionOptionSchema = z.object({
  label: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  /** Claude 可选项可携带 Markdown/HTML 预览；移动端先按文本展示。 */
  preview: z.string().max(20000).optional(),
});

export const AgentQuestionSchema = z.object({
  id: z.string().min(1).max(300),
  header: z.string().max(100),
  question: z.string().min(1).max(10000),
  options: z.array(AgentQuestionOptionSchema).max(10),
  multiSelect: z.boolean(),
  allowOther: z.boolean(),
  secret: z.boolean().optional(),
});

export const AgentQuestionRequestSchema = z.object({
  kind: z.literal("question.request"),
  reqId: z.string().min(1),
  questions: z.array(AgentQuestionSchema).min(1).max(4),
  autoResolutionMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000).optional(),
  agentId: z.string().min(1).max(500).optional(),
});

export const AgentQuestionResolvedSchema = z.object({
  kind: z.literal("question.resolved"),
  reqId: z.string().min(1),
  answers: z.array(AgentQuestionAnswerSchema).max(4),
  cancelled: z.boolean().optional(),
  agentId: z.string().min(1).max(500).optional(),
});

export const AgentSubagentStartedSchema = z.object({
  kind: z.literal("subagent.started"),
  subagent: SubagentInfoSchema,
});

export const AgentSubagentUpdatedSchema = z.object({
  kind: z.literal("subagent.updated"),
  subagentId: z.string().min(1).max(500),
  status: SubagentStatusSchema,
  canMessage: z.boolean().optional(),
  summary: z.string().max(10000).optional(),
});

export const AgentTurnEndSchema = z.object({
  kind: z.literal("turn.end"),
  msgId: z.string(),
  finish: z.string().optional(),
  costUsd: z.number().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  agentId: z.string().min(1).max(500).optional(),
});

export const AgentUserMessageSchema = z.object({
  kind: z.literal("user.message"),
  msgId: z.string(),
  text: z.string(),
  agentId: z.string().min(1).max(500).optional(),
});

export const AgentErrorSchema = z.object({
  kind: z.literal("agent.error"),
  message: z.string(),
  agentId: z.string().min(1).max(500).optional(),
});

export const AgentEventBodySchema = z.discriminatedUnion("kind", [
  AgentUserMessageSchema,
  AgentTextDeltaSchema,
  AgentReasoningDeltaSchema,
  AgentToolStartSchema,
  AgentToolEndSchema,
  AgentPermissionRequestSchema,
  AgentPermissionAutoSchema,
  AgentPermissionResolvedSchema,
  AgentQuestionRequestSchema,
  AgentQuestionResolvedSchema,
  AgentSubagentStartedSchema,
  AgentSubagentUpdatedSchema,
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

/** 工具完整输出(应 tool.output.get) */
export const S2CToolOutputSchema = z.object({
  type: z.literal("tool.output"),
  sid,
  callId: z.string(),
  output: z.string(),
  /** 即便完整输出也可能被上限截断 */
  truncated: z.boolean().optional(),
});

export const S2CChatSuggestionsSchema = z.object({
  type: z.literal("chat.suggestions"),
  sid,
  requestId: z.string().min(1).max(100),
  kind: ChatSuggestionKindSchema,
  items: z.array(ChatSuggestionSchema).max(50),
});

export const S2CAgentModelsSchema = z.object({
  type: z.literal("agent.models"),
  sid,
  requestId: z.string().min(1).max(100),
  models: z.array(AgentModelSchema).max(100),
  currentModel: z.string().min(1).max(300).optional(),
  currentEffort: z.string().min(1).max(100).optional(),
});

export const S2CAgentModesSchema = z.object({
  type: z.literal("agent.modes"),
  sid,
  requestId: z.string().min(1).max(100),
  modes: z.array(AgentModeSchema).max(20),
  currentMode: z.string().min(1).max(100).optional(),
});

export const S2CAgentControlResultSchema = z.object({
  type: z.literal("agent.control.result"),
  sid,
  requestId: z.string().min(1).max(100),
  action: z.enum(["model.set", "mode.set", "compact"]),
  ok: z.boolean(),
  message: z.string().max(2000).optional(),
  currentModel: z.string().min(1).max(300).optional(),
  currentEffort: z.string().min(1).max(100).optional(),
  currentMode: z.string().min(1).max(100).optional(),
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
    /** 文件操作:路径越界或权限不足 */
    "denied",
    /** 文件操作:其余失败(不存在、不是文件、过大、IO) */
    "fs_error",
  ]),
  message: z.string(),
  sid: sid.optional(),
});

// ---------------------------------------------------------------- 文件操作应答

export const FsEntrySchema = z.object({
  name: z.string(),
  /** 目录 / 普通文件 / 符号链接(链接不跟随,避免绕过根约束) */
  kind: z.enum(["dir", "file", "symlink", "other"]),
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
});

export const S2CFsListingSchema = z.object({
  type: z.literal("fs.listing"),
  sid,
  path: z.string(),
  entries: z.array(FsEntrySchema),
});

/** 新建会话目录选择器的浏览结果;失败也原路返回,避免无 sid 请求只能超时。 */
export const S2CWorkspaceListingSchema = z.object({
  type: z.literal("workspace.listing"),
  /** 相对于用户 home 的路径 */
  path: relPath,
  /** 选中后可直接交给 session.create 的绝对路径 */
  cwd: z.string(),
  entries: z.array(FsEntrySchema),
  error: z.string().optional(),
});

export const S2CFsContentSchema = z.object({
  type: z.literal("fs.content"),
  sid,
  path: z.string(),
  contentB64: z.string(),
  size: z.number().int().nonnegative(),
  /** 超过可编辑上限被截断:此时不允许保存,否则会截断原文件 */
  truncated: z.boolean(),
  /** 含 NUL 字节等,不能当文本编辑 */
  binary: z.boolean(),
});

export const S2CFsWrittenSchema = z.object({
  type: z.literal("fs.written"),
  sid,
  path: z.string(),
  size: z.number().int().nonnegative(),
});

export const S2CFsChunkSchema = z.object({
  type: z.literal("fs.chunk"),
  sid,
  path: z.string(),
  offset: z.number().int().nonnegative(),
  dataB64: z.string(),
  /** 整个文件的大小,客户端据此算进度 */
  total: z.number().int().nonnegative(),
  eof: z.boolean(),
});

/** 变更类操作的通用应答;客户端据此刷新列表 */
export const S2CFsDoneSchema = z.object({
  type: z.literal("fs.done"),
  sid,
  path: z.string(),
  op: z.enum(["mkdir", "remove", "rename"]),
});

export const GitFileSchema = z.object({
  path: z.string(),
  /** porcelain 的 X 位(暂存区) */
  index: z.string(),
  /** porcelain 的 Y 位(工作区) */
  worktree: z.string(),
  untracked: z.boolean(),
});

export const S2CGitStatusSchema = z.object({
  type: z.literal("git.status.result"),
  sid,
  /** 不是 git 仓库时为 null */
  branch: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(GitFileSchema),
  staged: z.boolean(),
});

export const S2CGitDiffSchema = z.object({
  type: z.literal("git.diff.result"),
  sid,
  path: z.string(),
  patch: z.string(),
});

export const S2CGitDoneSchema = z.object({
  type: z.literal("git.done"),
  sid,
  op: z.enum(["stage", "unstage", "discard", "commit"]),
  /** commit 时带短 hash */
  detail: z.string().optional(),
});

/** 一个限流窗口的使用情况 */
export const UsageWindowSchema = z.object({
  /** 给人看的窗口名,如「5 小时」「7 天」 */
  label: z.string(),
  /** 已用百分比 0–100 */
  utilization: z.number().min(0).max(100),
  /** 窗口重置时间(ISO);拿不到则省略 */
  resetsAt: z.string().optional(),
});

/**
 * 一个 agent 账号的用量。
 *
 * 限流是按【账号】走的,而账号是按 agent 分的 —— claude 的 5 小时窗口和 codex
 * 的 7 天窗口互不相干,各自有各自的套餐。主机页要同时回答"我这几个订阅还剩多少",
 * 所以得是一组,而不是随便挑一个会话去问。
 */
export const UsageAccountSchema = z.object({
  agent: AgentKindSchema,
  available: z.boolean(),
  subscription: z.string().nullable().optional(),
  costUsd: z.number().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  windows: z.array(UsageWindowSchema),
  reason: z.string().optional(),
});

/**
 * 用量与限流。
 *
 * 【available 只回答"有没有东西可看"】曾经把它和"有没有套餐限流窗口"混为一谈,
 * 结果 codex 明明报了 token 和花费,却因为没有窗口而整个显示成"不可用"。
 * 用量和限流是两件事:几乎所有 agent 都有前者,只有 claude.ai 订阅会话有后者。
 */
export const S2CUsageSchema = z.object({
  type: z.literal("usage.result"),
  sid: sid.optional(),
  available: z.boolean(),
  /** 套餐类型(pro / max / team / enterprise),API key 会话为 null */
  subscription: z.string().nullable().optional(),
  /** 本会话累计花费 */
  costUsd: z.number().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  /** 套餐限流窗口;只有 claude.ai 订阅会话才有 */
  windows: z.array(UsageWindowSchema).optional(),
  /** 没有窗口时说明原因(不代表没有用量数据) */
  reason: z.string().optional(),
  /**
   * 按 agent 分开的账号用量;只有账号级查询(usage.get 不带 sid)才有。
   * 顶层那几个字段仍是"其中一个"的值,为的是老客户端不至于什么都看不到。
   */
  accounts: z.array(UsageAccountSchema).optional(),
});

export const S2CMessageSchema = z.discriminatedUnion("type", [
  S2CHelloOkSchema,
  S2CSessionStateSchema,
  S2CTermSnapshotSchema,
  S2CTermOutputSchema,
  S2CAgentEventSchema,
  S2CChatSnapshotSchema,
  S2CChatSuggestionsSchema,
  S2CAgentModelsSchema,
  S2CAgentModesSchema,
  S2CAgentControlResultSchema,
  S2CToolOutputSchema,
  S2CPermissionRequestSchema,
  S2CErrorSchema,
  S2CWorkspaceListingSchema,
  S2CFsListingSchema,
  S2CFsContentSchema,
  S2CFsWrittenSchema,
  S2CFsChunkSchema,
  S2CFsDoneSchema,
  S2CGitStatusSchema,
  S2CGitDiffSchema,
  S2CGitDoneSchema,
  S2CUsageSchema,
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
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export type ChatDelivery = z.infer<typeof ChatDeliverySchema>;
export type ChatSuggestionKind = z.infer<typeof ChatSuggestionKindSchema>;
export type ChatSuggestion = z.infer<typeof ChatSuggestionSchema>;
export type QueuedChatMessage = z.infer<typeof QueuedChatMessageSchema>;
export type AgentModel = z.infer<typeof AgentModelSchema>;
export type AgentMode = z.infer<typeof AgentModeSchema>;
export type AgentControls = z.infer<typeof AgentControlsSchema>;
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;
export type SubagentInfo = z.infer<typeof SubagentInfoSchema>;
export type C2SHello = z.infer<typeof C2SHelloSchema>;
export type C2SSessionCreate = z.infer<typeof C2SSessionCreateSchema>;
export type C2SWorkspaceList = z.infer<typeof C2SWorkspaceListSchema>;
export type C2SSessionAttach = z.infer<typeof C2SSessionAttachSchema>;
export type C2SChatSend = z.infer<typeof C2SChatSendSchema>;
export type C2SChatQueueRemove = z.infer<typeof C2SChatQueueRemoveSchema>;
export type C2SChatQueueGuide = z.infer<typeof C2SChatQueueGuideSchema>;
export type C2SChatComplete = z.infer<typeof C2SChatCompleteSchema>;
export type C2SAgentModelsGet = z.infer<typeof C2SAgentModelsGetSchema>;
export type C2SAgentModelSet = z.infer<typeof C2SAgentModelSetSchema>;
export type C2SAgentModesGet = z.infer<typeof C2SAgentModesGetSchema>;
export type C2SAgentModeSet = z.infer<typeof C2SAgentModeSetSchema>;
export type C2SAgentCompact = z.infer<typeof C2SAgentCompactSchema>;
export type C2SToolOutputGet = z.infer<typeof C2SToolOutputGetSchema>;
export type FileDiff = z.infer<typeof FileDiffSchema>;
export type S2CToolOutput = z.infer<typeof S2CToolOutputSchema>;
export type C2STermInput = z.infer<typeof C2STermInputSchema>;
export type C2STermResize = z.infer<typeof C2STermResizeSchema>;
export type C2STermAck = z.infer<typeof C2STermAckSchema>;
export type C2SPermissionRespond = z.infer<typeof C2SPermissionRespondSchema>;
export type AgentQuestionAnswer = z.infer<typeof AgentQuestionAnswerSchema>;
export type C2SQuestionRespond = z.infer<typeof C2SQuestionRespondSchema>;
export type C2SSubagentSend = z.infer<typeof C2SSubagentSendSchema>;
export type C2SMessage = z.infer<typeof C2SMessageSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type UsageWindow = z.infer<typeof UsageWindowSchema>;
export type UsageAccount = z.infer<typeof UsageAccountSchema>;
export type FsEntry = z.infer<typeof FsEntrySchema>;
export type WorkspaceListing = z.infer<typeof S2CWorkspaceListingSchema>;
export type GitFile = z.infer<typeof GitFileSchema>;
export type ChatRole = z.infer<typeof ChatRoleSchema>;
export type ToolState = z.infer<typeof ToolStateSchema>;
export type AgentEventBody = z.infer<typeof AgentEventBodySchema>;
export type AgentTextDelta = z.infer<typeof AgentTextDeltaSchema>;
export type AgentToolStart = z.infer<typeof AgentToolStartSchema>;
export type AgentToolEnd = z.infer<typeof AgentToolEndSchema>;
export type AgentPermissionRequest = z.infer<typeof AgentPermissionRequestSchema>;
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>;
export type AgentQuestionRequest = z.infer<typeof AgentQuestionRequestSchema>;
export type AgentQuestionResolved = z.infer<typeof AgentQuestionResolvedSchema>;
export type AgentSubagentStarted = z.infer<typeof AgentSubagentStartedSchema>;
export type AgentSubagentUpdated = z.infer<typeof AgentSubagentUpdatedSchema>;
export type AgentTurnEnd = z.infer<typeof AgentTurnEndSchema>;
export type S2CHelloOk = z.infer<typeof S2CHelloOkSchema>;
export type S2CSessionState = z.infer<typeof S2CSessionStateSchema>;
export type S2CTermSnapshot = z.infer<typeof S2CTermSnapshotSchema>;
export type S2CTermOutput = z.infer<typeof S2CTermOutputSchema>;
export type S2CAgentEvent = z.infer<typeof S2CAgentEventSchema>;
export type S2CChatSnapshot = z.infer<typeof S2CChatSnapshotSchema>;
export type S2CChatSuggestions = z.infer<typeof S2CChatSuggestionsSchema>;
export type S2CAgentModels = z.infer<typeof S2CAgentModelsSchema>;
export type S2CAgentModes = z.infer<typeof S2CAgentModesSchema>;
export type S2CAgentControlResult = z.infer<typeof S2CAgentControlResultSchema>;
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
  // "文本或附件至少有一样"这条跨字段约束不能写成 .refine —— 那会把成员变成
  // ZodEffects,而 discriminatedUnion 只接受纯对象(整个联合会塌成 never)。
  // 所以放在这里,仍然只有协议层一处实现。
  if (
    r.data.type === "chat.send" &&
    r.data.text.trim().length === 0 &&
    (r.data.attachments?.length ?? 0) === 0
  ) {
    throw new ProtocolError("chat.send needs text or at least one attachment", "format");
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
