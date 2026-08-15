/**
 * 结构化 agent 适配器接口。
 *
 * 每个后端(opencode HTTP+SSE / Claude Agent SDK / Codex app-server)把自己的
 * 事件流归一化成 protocol 的 AgentEventBody,客户端只认这一套。
 * 适配器不关心网络/加密/多客户端广播 —— 那是 StructuredSession 与 ws-server 的事。
 */
import type {
  AgentEventBody,
  AgentMode,
  AgentModel,
  AgentQuestionAnswer,
  Attachment,
  ApprovalPolicy,
  PermissionReply,
} from "@prospero/protocol";
import type { ResolvedSkill } from "../composer-context.js";
import type { ChildProcess } from "node:child_process";

/**
 * A provider child which failed Job registration is not yet known to the
 * native Job and must not be left alive while the caller unwinds.  This is
 * deliberately a direct-child, bounded cleanup only: it is never used as a
 * substitute for normal provider-tree shutdown (that remains Job-only).
 */
async function waitForProviderChildExit(process: Pick<ChildProcess, "once" | "removeListener">, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(true);
    };
    process.once("exit", exited);
    timer = setTimeout(() => {
      process.removeListener("exit", exited);
      resolve(false);
    }, timeoutMs);
  });
}

export async function terminateUnregisteredProviderProcess(process: Pick<ChildProcess, "exitCode" | "kill" | "once" | "removeListener">): Promise<void> {
  if (process.exitCode !== null) return;
  try { process.kill(); } catch { /* the original registration error wins */ }
  if (await waitForProviderChildExit(process, 750)) return;
  // POSIX test/dev children may ignore SIGTERM. This remains exact to the
  // direct just-spawned PID and is bounded; normal provider-tree shutdown is
  // never routed through this helper.
  try { process.kill("SIGKILL"); } catch { /* the original registration error wins */ }
  await waitForProviderChildExit(process, 250);
}

export interface AdapterContext {
  cwd: string;
  /** 当前会话专属的进程环境（不含时可直接继承 daemon 环境）。 */
  env?: Record<string, string>;
  /** 只启动读取模型目录所需的最小后端，不创建原生对话。 */
  catalogOnly?: boolean;
  /** 由隔离账号生成的 Codex app-server 配置覆盖，不来自用户输入命令行。 */
  codexAppServerArgs?: string[];
  /** 当前审批策略;适配器据此决定是否绕过人工确认 */
  approvalPolicy?: () => ApprovalPolicy;
  /** 适配器产出一条归一化事件 */
  emit(body: AgentEventBody): void;
  /**
   * 登记某次工具调用的完整输出。
   * 事件里只带摘要(手机上没必要一次性收下 100KB 的测试日志),
   * 用户展开卡片时再按需拉全文。
   */
  recordOutput?(callId: string, output: string): void;
  /**
   * 适配器原生会话的恢复游标(Codex threadId、Claude sessionId 等)。
   * 上层收到后立即落盘，daemon 重启时再交还给同一个适配器。
   */
  persistState?(state: AdapterResumeState): void;
  /**
   * Durable Windows hosts register every provider child with their native
   * KILL_ON_JOB_CLOSE Job before the adapter begins using it.  Assignment
   * failure is deliberately fatal; callers must not fall back to PID kills.
   */
  registerProviderProcess?(process: { pid?: number | undefined }): Promise<void>;
}

/** 只允许 JSON 可序列化的浅对象；各适配器自行校验自己认识的字段。 */
export type AdapterResumeState = Record<string, unknown>;

export interface AgentAdapter {
  /**
   * Windows durable hosts put the Session Host itself in the Job before this
   * adapter starts; adapters inherit containment and may optionally audit a
   * child identity through `registerProviderProcess`.
   */
  readonly durableProviderJobCompatible?: boolean;
  /** 是否能直接吃图;false 时由上层落盘降级 */
  readonly acceptsImages?: boolean;
  /** 是否支持 Codex app-server 风格的原生 Skill input。 */
  readonly acceptsSkillInputs?: boolean;
  /** 启动后端并准备接收消息;抛错表示会话创建失败 */
  start(ctx: AdapterContext): Promise<void>;
  /**
   * 发送一条用户消息。
   * 附件由适配器决定怎么用:能原生收图的(Claude)走图片块,
   * 其余的由 StructuredSession 落盘成文件、把路径并进文本。
   */
  send(text: string, attachments?: Attachment[], skills?: ResolvedSkill[]): Promise<void>;
  /**
   * 在当前轮次仍运行时追加引导。返回 false 表示后端当前不能 steer，
   * 上层会把消息安全地放到队首，而不是丢掉。
   */
  steer?(text: string, attachments?: Attachment[], skills?: ResolvedSkill[]): Promise<boolean>;
  /** 审批策略切换后的后端原生配置同步；Prospero 本地审批仍是最终兜底。 */
  setApprovalPolicy?(policy: ApprovalPolicy): Promise<void>;
  /** 从 Agent 自己的实时目录取模型；客户端绝不维护一份容易过期的硬编码列表。 */
  listModels?(): Promise<AgentModelCatalog>;
  /** 切换后续轮次使用的模型/推理强度。 */
  setModel?(model: string, effort?: string): Promise<AgentModelSelection>;
  /** 原生协作模式（例如 default / plan）。 */
  listModes?(): Promise<AgentModeCatalog>;
  setMode?(mode: string): Promise<AgentModeSelection>;
  /** 原生压缩当前会话上下文；不把 `/compact` 降级成给模型看的普通文本。 */
  compact?(): Promise<void>;
  /** 给一个仍可寻址的原生子 Agent 直接发消息/引导。 */
  sendToSubagent?(subagentId: string, text: string): Promise<void>;
  /**
   * 从后端自己的持久化记录读取子 Agent 完整过程。
   * 实时事件日志可能在 daemon 启动前就已产生，也可能因上限被裁剪；原生历史
   * 是 Mac/iOS 打开子 Agent 详情时的权威只读来源。
   */
  readSubagentHistory?(subagentId: string): Promise<AgentEventBody[] | null>;
  /** 回应 Agent 主动提出的结构化问题。 */
  respondQuestion?(
    reqId: string,
    answers: AgentQuestionAnswer[],
    cancelled?: boolean,
  ): Promise<void>;
  /** 回应审批请求 */
  respondPermission(reqId: string, reply: PermissionReply): Promise<void>;
  /**
   * 用量与限流。后端拿不到就返回 null —— 大多数 agent 压根不暴露这个,
   * 所以这是可选实现,不是所有适配器都要装样子。
   */
  usage?(): Promise<UsageReport | null>;
  /** 中断当前轮次 */
  interrupt(): Promise<void>;
  /** 关闭并释放资源 */
  dispose(): Promise<void>;
}

export interface AgentModelSelection {
  currentModel: string;
  currentEffort?: string;
}

export interface AgentModelCatalog extends Partial<AgentModelSelection> {
  models: AgentModel[];
}

export interface AgentModeSelection {
  currentMode: string;
}

export interface AgentModeCatalog extends Partial<AgentModeSelection> {
  modes: AgentMode[];
}

export interface UsageReport {
  subscription?: string | null;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** 套餐限流窗口;没有不代表没有用量 */
  windows: { label: string; utilization: number; resetsAt?: string }[];
}

export class AdapterError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AdapterError";
  }
}

/** 把任意值裁剪成适合手机展示的一行摘要 */
export function summarize(value: unknown, max = 300): string {
  let s: string;
  if (typeof value === "string") s = value;
  else if (value === undefined || value === null) s = "";
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}
