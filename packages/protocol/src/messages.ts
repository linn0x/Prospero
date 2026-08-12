/**
 * Prospero Protocol — 常量与类型门面。
 * 类型的单一来源是 schemas.ts(zod),这里统一再导出,
 * 使用方 `import type { C2SMessage } from "@prospero/protocol"`。
 *
 * 语义约定:
 * - 所有消息经 E2E 加密(crypto.ts SecureChannel)后走 WebSocket 文本帧;
 * - S→C 的 term.output 按会话单调递增 seq;attach 携带 lastSeq 实现断线续传,
 *   gap 超出服务端环形缓冲(ring.ts)时回退全量快照(term.snapshot);
 * - term.ack 用于背压:daemon 依据未确认字节数暂停 PTY 读取。
 */

/**
 * 应用层协议版本。
 *
 * v8 起不再要求两端完全相等；客户端按 SUPPORTED_PROTOCOL_VERSIONS 从新到旧
 * 尝试，daemon 接受同一兼容窗口内的版本。这样 iOS 与 Mac 可以滚动升级，
 * 配对 token 和双方身份密钥都无需轮换。
 */
export const PROTOCOL_VERSION = 11;
export const SUPPORTED_PROTOCOL_VERSIONS = [11, 10, 9, 8, 7, 5] as const;
export const MIN_PROTOCOL_VERSION = 5;

/** 加密握手格式。只有密码学帧真的不兼容时才升级。 */
export const CRYPTO_VERSION = 1;

/**
 * 二维码载荷格式与应用消息版本解耦。
 *
 * 保持 7 是为了让已发布的 v7 App 仍能扫描新 daemon 生成的二维码；新 App
 * 同时接受形状相同的 v5 载荷，之后新增 API 功能不再触碰这个数字。
 */
export const PAIRING_FORMAT_VERSION = 7;
export const SUPPORTED_PAIRING_FORMAT_VERSIONS = [7, 5] as const;

export const CAPABILITY_ORCHESTRATION_SNAPSHOT = "orchestration.snapshot.v1";
export const CAPABILITY_ORCHESTRATION_MANUAL = "orchestration.manual.v1";
export const CAPABILITY_ORCHESTRATION_GRAPH = "orchestration.graph.v1";
export const CAPABILITY_ORCHESTRATION_AUTOMATION = "orchestration.automation.v1";
export const CAPABILITY_ORCHESTRATION_MANAGEMENT = "orchestration.management.v1";
export const CAPABILITY_ORCHESTRATION_LIFECYCLE = "orchestration.lifecycle.v1";
export const CAPABILITY_SUBAGENT_HISTORY = "subagent.history.v1";
/** Codex / Claude Code 多账号与隔离配置目录。 */
export const CAPABILITY_AGENT_ACCOUNTS = "agent.accounts.v1";
/** 已发送图片的按需预览，避免把原图塞进 chat.snapshot。 */
export const CAPABILITY_CHAT_ATTACHMENT_PREVIEWS = "chat.attachment-previews.v1";

export type {
  AgentKind,
  CodeAgentKind,
  AgentCredentialKind,
  AgentAccount,
  AgentAccountStatus,
  SessionKind,
  SessionStatus,
  SessionInfo,
  HostInfo,
  PermissionReply,
  C2SHello,
  C2SSessionCreate,
  C2SOrchestrationSnapshot,
  C2SOrchestrationGateResolve,
  C2SOrchestrationRunCreate,
  C2SOrchestrationRunDelete,
  C2SOrchestrationTaskCreate,
  C2SOrchestrationTaskCancel,
  C2SOrchestrationTaskRetry,
  C2SOrchestrationWorkerStart,
  C2SOrchestrationWorkerStop,
  C2SOrchestrationGraphCreate,
  C2SOrchestrationGraphApply,
  C2SOrchestrationAutomationStart,
  C2SOrchestrationAutomationPause,
  OrchestrationGraphNodeInput,
  ResumableConversation,
  C2SConversationSearch,
  ConversationResults,
  C2SAgentAccountsList,
  C2SAgentAccountCreate,
  C2SAgentAccountRename,
  C2SAgentAccountSetDefault,
  C2SAgentAccountLogin,
  C2SAgentAccountCredentialSet,
  C2SAgentAccountLogout,
  C2SAgentAccountDelete,
  AgentAccountsResult,
  C2SWorkspaceList,
  C2SSessionAttach,
  C2SChatSend,
  C2SChatQueueRemove,
  C2SChatQueueGuide,
  C2SChatComplete,
  ChatDelivery,
  ChatSuggestionKind,
  ChatSuggestion,
  QueuedChatMessage,
  AgentModel,
  AgentMode,
  AgentControls,
  SubagentStatus,
  SubagentInfo,
  C2SAgentModelsGet,
  C2SAgentModelSet,
  C2SAgentModesGet,
  C2SAgentModeSet,
  C2SAgentCompact,
  C2SToolOutputGet,
  C2SChatAttachmentGet,
  FileDiff,
  S2CToolOutput,
  S2CChatAttachmentChunk,
  C2STermInput,
  C2STermResize,
  C2STermAck,
  C2SPermissionRespond,
  AgentQuestionAnswer,
  C2SQuestionRespond,
  C2SSubagentSend,
  C2SSubagentHistoryGet,
  C2SMessage,
  ChatRole,
  ToolState,
  AgentEventBody,
  AgentTextDelta,
  AgentToolStart,
  AgentToolEnd,
  AgentPermissionRequest,
  AgentQuestion,
  AgentQuestionRequest,
  AgentQuestionResolved,
  AgentSubagentStarted,
  AgentSubagentUpdated,
  AgentTurnEnd,
  S2CHelloOk,
  S2CSessionState,
  S2CTermSnapshot,
  S2CTermOutput,
  S2CAgentEvent,
  S2CChatSnapshot,
  S2CSubagentHistory,
  S2CChatSuggestions,
  S2CAgentModels,
  S2CAgentModes,
  S2CAgentControlResult,
  S2CPermissionRequest,
  S2CError,
  OrchestrationAutomation,
  OrchestrationRun,
  OrchestrationTask,
  OrchestrationDispatch,
  OrchestrationGate,
  OrchestrationSnapshot,
  S2COrchestrationSnapshot,
  S2CMessage,
  PairingPayload,
  WorkspaceListing,
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
