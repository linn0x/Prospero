/**
 * 把 agent 事件流折叠成可渲染的聊天条目。
 *
 * 事件是增量的(text.delta 一片片来、tool.end 要回填 tool.start),
 * UI 需要的是稳定有序的条目列表 —— 这里做这层转换,纯函数便于测试。
 */
import type {
  ApprovalPolicy,
  AgentEventBody,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentUserAttachment,
  FileDiff,
  PermissionReply,
  SubagentInfo,
  ToolState,
} from "@prospero/protocol";

export interface UserItem {
  type: "user";
  key: string;
  msgId: string;
  text: string;
  attachments?: AgentUserAttachment[];
  agentId?: string;
}

export interface AssistantItem {
  type: "assistant";
  key: string;
  msgId: string;
  text: string;
  reasoning: string;
  /** 本轮结束后的用量信息 */
  finish?: { reason?: string; costUsd?: number; inputTokens?: number; outputTokens?: number };
  done: boolean;
  agentId?: string;
}

export interface ToolItem {
  type: "tool";
  key: string;
  callId: string;
  tool: string;
  input: string;
  state: ToolState;
  result?: string;
  diff?: FileDiff;
  /** 服务端还有完整输出可拉取 */
  hasMore?: boolean;
  /** 已拉取的完整输出 */
  fullOutput?: string;
  /** 服务端在安全上限处截断了按需拉取的输出。 */
  outputTruncated?: boolean;
  agentId?: string;
}

export interface PermissionItem {
  type: "permission";
  key: string;
  reqId: string;
  action: string;
  resources: string[];
  summary: string;
  diff?: FileDiff;
  /** 已回应则记录结果,卡片转为只读 */
  resolved?: PermissionReply;
  /** 被策略自动批准(没问过人);卡片以此区别于"你批过的" */
  auto?: ApprovalPolicy;
  agentId?: string;
}

export interface QuestionItem {
  type: "question";
  key: string;
  reqId: string;
  questions: AgentQuestion[];
  answers?: AgentQuestionAnswer[];
  cancelled?: boolean;
  agentId?: string;
}

export interface SubagentItem {
  type: "subagent";
  key: string;
  subagent: SubagentInfo;
}

export interface ErrorItem {
  type: "error";
  key: string;
  message: string;
  agentId?: string;
}

export interface TurnDiffFile {
  path: string;
  additions: number;
  deletions: number;
}

/** turn.end 时从本轮工具/审批事件汇总出的紧凑改动栏。 */
export interface TurnDiffSummaryItem {
  type: "turn-diff-summary";
  key: string;
  msgId: string;
  files: TurnDiffFile[];
  additions: number;
  deletions: number;
  agentId?: string;
}

export interface TrajectoryItem {
  type: "trajectory";
  key: string;
  recordId: string;
  recordKind: "turn" | "step" | "request" | "retry" | "compaction";
  phase: "running" | "completed" | "failed" | "info";
  title: string;
  detail?: string;
  turn?: number;
  step?: number;
  startedAt?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  agentId?: string;
}

export type ChatItem =
  | UserItem
  | AssistantItem
  | ToolItem
  | PermissionItem
  | QuestionItem
  | SubagentItem
  | ErrorItem
  | TrajectoryItem
  | TurnDiffSummaryItem;

export type FoldableActivityItem = ToolItem | PermissionItem;

/** 连续的低风险活动在 UI 中自动收成一张卡片，原始事件与条目仍完整保留。 */
export interface ActivityGroupItem {
  type: "activity-group";
  key: string;
  items: FoldableActivityItem[];
}

export type ChatDisplayItem = ChatItem | ActivityGroupItem;

/**
 * 增量归并:把一条事件应用到条目列表上,返回新列表(引用变化才触发重渲染)。
 * 同一 msgId 的文本增量合并进同一个助手条目;tool.end 回填对应的 tool 条目。
 */
export function applyEvent(items: ChatItem[], ev: AgentEventBody): ChatItem[] {
  const eventAgentId = "agentId" in ev ? ev.agentId : undefined;
  const scopedKey = (prefix: string, id: string): string =>
    eventAgentId ? `${prefix}:${eventAgentId}:${id}` : `${prefix}:${id}`;
  const agentField = eventAgentId ? { agentId: eventAgentId } : {};
  switch (ev.kind) {
    case "user.message":
      return [
        ...items,
        {
          type: "user",
          key: scopedKey("u", ev.msgId),
          msgId: ev.msgId,
          text: ev.text,
          ...(ev.attachments?.length ? { attachments: ev.attachments } : {}),
          ...agentField,
        },
      ];

    case "text.delta":
    case "reasoning.delta": {
      const key = scopedKey("a", ev.msgId);
      const idx = findLastIndex(items, (i) => i.type === "assistant" && i.key === key);
      const delta = ev.delta;
      if (idx < 0) {
        const created: AssistantItem = {
          type: "assistant",
          key,
          msgId: ev.msgId,
          text: ev.kind === "text.delta" ? delta : "",
          reasoning: ev.kind === "reasoning.delta" ? delta : "",
          done: false,
          ...agentField,
        };
        return [...items, created];
      }
      const prev = items[idx] as AssistantItem;
      const next: AssistantItem = {
        ...prev,
        text: ev.kind === "text.delta" ? prev.text + delta : prev.text,
        reasoning: ev.kind === "reasoning.delta" ? prev.reasoning + delta : prev.reasoning,
      };
      return replaceAt(items, idx, next);
    }

    case "tool.start":
      return [
        ...items,
        {
          type: "tool",
          key: scopedKey("t", ev.callId),
          callId: ev.callId,
          tool: ev.tool,
          input: ev.summary,
          state: "running",
          ...agentField,
          ...(ev.diff ? { diff: ev.diff } : {}),
        },
      ];

    case "tool.end": {
      const idx = findLastIndex(
        items,
        (i) => i.type === "tool" && i.callId === ev.callId && i.agentId === ev.agentId,
      );
      if (idx < 0) {
        // 少见:错过了 tool.start(历史被截断),补一个已完成条目
        return [
          ...items,
          {
            type: "tool",
            key: scopedKey("t", ev.callId),
            callId: ev.callId,
            tool: "tool",
            input: "",
            state: ev.state,
            result: ev.summary,
            ...(ev.hasMore === true ? { hasMore: true } : {}),
            ...(ev.diff ? { diff: ev.diff } : {}),
            ...agentField,
          },
        ];
      }
      const prev = items[idx] as ToolItem;
      return replaceAt(items, idx, {
        ...prev,
        state: ev.state,
        result: ev.summary,
        ...(ev.hasMore === true ? { hasMore: true } : {}),
        // tool.end 的 diff 更权威(实际应用的改动);没有则保留 start 时的预览
        ...(ev.diff ? { diff: ev.diff } : {}),
      });
    }

    // 自动批准的调用同样进聊天流。不打断不等于不留痕 ——
    // 事后要能翻出"那 20 分钟它到底动了什么"。
    case "permission.auto":
      return [
        ...items,
        {
          type: "permission",
          key: scopedKey("p", ev.reqId),
          reqId: ev.reqId,
          action: ev.action,
          resources: [],
          summary: ev.summary,
          auto: ev.policy,
          ...agentField,
        },
      ];

    case "permission.request":
      return [
        ...items,
        {
          type: "permission",
          key: scopedKey("p", ev.reqId),
          reqId: ev.reqId,
          action: ev.action,
          resources: ev.resources,
          summary: ev.summary,
          ...(ev.diff ? { diff: ev.diff } : {}),
          ...agentField,
        },
      ];

    case "permission.resolved": {
      const idx = findLastIndex(
        items,
        (i) => i.type === "permission" && i.reqId === ev.reqId && i.agentId === ev.agentId,
      );
      if (idx < 0) return items;
      const prev = items[idx] as PermissionItem;
      return replaceAt(items, idx, { ...prev, resolved: ev.reply });
    }

    case "question.request":
      return [
        ...items,
        {
          type: "question",
          key: scopedKey("q", ev.reqId),
          reqId: ev.reqId,
          questions: ev.questions,
          ...agentField,
        },
      ];

    case "question.resolved": {
      const idx = findLastIndex(
        items,
        (item) =>
          item.type === "question" && item.reqId === ev.reqId && item.agentId === ev.agentId,
      );
      if (idx < 0) return items;
      const previous = items[idx] as QuestionItem;
      return replaceAt(items, idx, {
        ...previous,
        answers: ev.answers,
        ...(ev.cancelled ? { cancelled: true } : {}),
      });
    }

    case "subagent.started": {
      const idx = findLastIndex(
        items,
        (item) => item.type === "subagent" && item.subagent.id === ev.subagent.id,
      );
      const next: SubagentItem = {
        type: "subagent",
        key: `s:${ev.subagent.id}`,
        subagent: ev.subagent,
      };
      return idx < 0 ? [...items, next] : replaceAt(items, idx, next);
    }

    case "subagent.updated": {
      const idx = findLastIndex(
        items,
        (item) => item.type === "subagent" && item.subagent.id === ev.subagentId,
      );
      if (idx < 0) return items;
      const previous = items[idx] as SubagentItem;
      return replaceAt(items, idx, {
        ...previous,
        subagent: {
          ...previous.subagent,
          status: ev.status,
          updatedAt: Date.now(),
          ...(ev.canMessage !== undefined ? { canMessage: ev.canMessage } : {}),
          ...(ev.summary ? { preview: ev.summary } : {}),
        },
      });
    }

    case "trajectory.record": {
      const key = scopedKey("tr", ev.recordId);
      const next: TrajectoryItem = {
        type: "trajectory",
        key,
        recordId: ev.recordId,
        recordKind: ev.recordKind,
        phase: ev.phase,
        title: ev.title,
        ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
        ...(ev.turn !== undefined ? { turn: ev.turn } : {}),
        ...(ev.step !== undefined ? { step: ev.step } : {}),
        ...(ev.startedAt !== undefined ? { startedAt: ev.startedAt } : {}),
        ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
        ...(ev.inputTokens !== undefined ? { inputTokens: ev.inputTokens } : {}),
        ...(ev.outputTokens !== undefined ? { outputTokens: ev.outputTokens } : {}),
        ...agentField,
      };
      const idx = findLastIndex(items, (item) => item.type === "trajectory" && item.key === key);
      return idx < 0 ? [...items, next] : replaceAt(items, idx, next);
    }

    case "turn.end": {
      const key = scopedKey("a", ev.msgId);
      const idx = findLastIndex(items, (i) => i.type === "assistant" && i.key === key);
      let next = items;
      if (idx >= 0) {
        const prev = items[idx] as AssistantItem;
        const finish: AssistantItem["finish"] = {};
        if (ev.finish !== undefined) finish.reason = ev.finish;
        if (ev.costUsd !== undefined) finish.costUsd = ev.costUsd;
        if (ev.inputTokens !== undefined) finish.inputTokens = ev.inputTokens;
        if (ev.outputTokens !== undefined) finish.outputTokens = ev.outputTokens;
        next = replaceAt(items, idx, { ...prev, done: true, finish });
      }
      if (
        items.some(
          (item) =>
            item.type === "turn-diff-summary" &&
            item.msgId === ev.msgId &&
            item.agentId === ev.agentId,
        )
      ) {
        return next;
      }
      const summary = summarizeTurnDiffs(items, ev.msgId, ev.agentId);
      return summary ? [...next, summary] : next;
    }

    case "agent.error":
      return [
        ...items,
        {
          type: "error",
          key: scopedKey("e", String(items.length)),
          message: ev.message,
          ...agentField,
        },
      ];
  }
}

export function applyEvents(items: ChatItem[], events: AgentEventBody[]): ChatItem[] {
  return events.reduce(applyEvent, items);
}

/** 按需拉取的完整工具输出到达后,填回对应卡片 */
export function applyToolOutput(
  items: ChatItem[],
  callId: string,
  output: string,
  truncated = false,
): ChatItem[] {
  const idx = findLastIndex(items, (i) => i.type === "tool" && i.callId === callId);
  if (idx < 0) return items;
  const prev = items[idx] as ToolItem;
  return replaceAt(items, idx, {
    ...prev,
    fullOutput: output,
    ...(truncated ? { outputTruncated: true } : {}),
  });
}

/** 是否有待回应的审批(驱动列表徽标与输入区提示) */
export function pendingPermissions(items: ChatItem[]): PermissionItem[] {
  return items.filter(
    (i): i is PermissionItem => i.type === "permission" && i.resolved === undefined,
  );
}

/** 所有仍需人工处理的交互（审批 + Agent 原生问题）。 */
export function pendingInteractions(items: ChatItem[]): (PermissionItem | QuestionItem)[] {
  return items.filter(
    (item): item is PermissionItem | QuestionItem =>
      (item.type === "permission" && item.resolved === undefined) ||
      (item.type === "question" && item.answers === undefined && item.cancelled !== true),
  );
}

/** 主对话不混入子 Agent token；子会话则只看对应 agentId。 */
export function itemsForAgent(items: ChatItem[], agentId?: string): ChatItem[] {
  return items.filter((item) => {
    if (item.type === "subagent") return agentId === undefined;
    return item.agentId === agentId;
  });
}

function summarizeTurnDiffs(
  items: ChatItem[],
  msgId: string,
  agentId?: string,
): TurnDiffSummaryItem | null {
  // turn.end 到来前，最后一个 done assistant 是上一轮的可靠边界；steer 可能在本轮
  // 插入多个 user.message，所以不能简单地从最后一条用户消息开始算。
  const previousTurn = findLastIndex(
    items,
    (item) => item.type === "assistant" && item.done && item.agentId === agentId,
  );
  const byPath = new Map<string, TurnDiffFile>();
  for (const item of items.slice(previousTurn + 1)) {
    if ((item.type !== "tool" && item.type !== "permission") || !item.diff?.path) continue;
    if (item.agentId !== agentId) continue;
    byPath.set(item.diff.path, {
      path: item.diff.path,
      additions: item.diff.additions,
      deletions: item.diff.deletions,
    });
  }
  const files = [...byPath.values()];
  if (files.length === 0) return null;
  return {
    type: "turn-diff-summary",
    key: agentId ? `d:${agentId}:${msgId}` : `d:${msgId}`,
    msgId,
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    ...(agentId ? { agentId } : {}),
  };
}

/**
 * 连续 3 项以上的已完成工具/已处理审批自动折叠。
 * 运行中、失败和待审批项目会切断分组，因此任何需要注意的状态都不会被藏起来。
 */
export function foldChatItems(items: ChatItem[], minimum = 3): ChatDisplayItem[] {
  const result: ChatDisplayItem[] = [];
  let run: FoldableActivityItem[] = [];
  const flush = (): void => {
    if (run.length >= minimum) {
      result.push({ type: "activity-group", key: `g:${run[0]!.key}`, items: run });
    } else {
      result.push(...run);
    }
    run = [];
  };

  for (const item of items) {
    if (isFoldableActivity(item)) {
      run.push(item);
    } else {
      flush();
      result.push(item);
    }
  }
  flush();
  return result;
}

function isFoldableActivity(item: ChatItem): item is FoldableActivityItem {
  if (item.type === "tool") return item.state === "success";
  if (item.type === "permission") {
    return item.auto !== undefined || item.resolved !== undefined;
  }
  return false;
}

function replaceAt(items: ChatItem[], idx: number, item: ChatItem): ChatItem[] {
  const next = items.slice();
  next[idx] = item;
  return next;
}

function findLastIndex(items: ChatItem[], pred: (i: ChatItem) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (pred(items[i]!)) return i;
  }
  return -1;
}
