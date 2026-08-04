/**
 * 把 agent 事件流折叠成可渲染的聊天条目。
 *
 * 事件是增量的(text.delta 一片片来、tool.end 要回填 tool.start),
 * UI 需要的是稳定有序的条目列表 —— 这里做这层转换,纯函数便于测试。
 */
import type {
  AgentEventBody,
  FileDiff,
  PermissionReply,
  ToolState,
} from "@prospero/protocol";

export interface UserItem {
  type: "user";
  key: string;
  text: string;
}

export interface AssistantItem {
  type: "assistant";
  key: string;
  msgId: string;
  text: string;
  reasoning: string;
  /** 本轮结束后的用量信息 */
  finish?: { costUsd?: number; inputTokens?: number; outputTokens?: number };
  done: boolean;
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
}

export interface ErrorItem {
  type: "error";
  key: string;
  message: string;
}

export type ChatItem =
  | UserItem
  | AssistantItem
  | ToolItem
  | PermissionItem
  | ErrorItem;

/**
 * 增量归并:把一条事件应用到条目列表上,返回新列表(引用变化才触发重渲染)。
 * 同一 msgId 的文本增量合并进同一个助手条目;tool.end 回填对应的 tool 条目。
 */
export function applyEvent(items: ChatItem[], ev: AgentEventBody): ChatItem[] {
  switch (ev.kind) {
    case "user.message":
      return [...items, { type: "user", key: `u:${ev.msgId}`, text: ev.text }];

    case "text.delta":
    case "reasoning.delta": {
      const key = `a:${ev.msgId}`;
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
          key: `t:${ev.callId}`,
          callId: ev.callId,
          tool: ev.tool,
          input: ev.summary,
          state: "running",
          ...(ev.diff ? { diff: ev.diff } : {}),
        },
      ];

    case "tool.end": {
      const idx = findLastIndex(
        items,
        (i) => i.type === "tool" && i.callId === ev.callId,
      );
      if (idx < 0) {
        // 少见:错过了 tool.start(历史被截断),补一个已完成条目
        return [
          ...items,
          {
            type: "tool",
            key: `t:${ev.callId}`,
            callId: ev.callId,
            tool: "tool",
            input: "",
            state: ev.state,
            result: ev.summary,
            ...(ev.hasMore === true ? { hasMore: true } : {}),
            ...(ev.diff ? { diff: ev.diff } : {}),
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

    case "permission.request":
      return [
        ...items,
        {
          type: "permission",
          key: `p:${ev.reqId}`,
          reqId: ev.reqId,
          action: ev.action,
          resources: ev.resources,
          summary: ev.summary,
          ...(ev.diff ? { diff: ev.diff } : {}),
        },
      ];

    case "permission.resolved": {
      const idx = findLastIndex(
        items,
        (i) => i.type === "permission" && i.reqId === ev.reqId,
      );
      if (idx < 0) return items;
      const prev = items[idx] as PermissionItem;
      return replaceAt(items, idx, { ...prev, resolved: ev.reply });
    }

    case "turn.end": {
      const key = `a:${ev.msgId}`;
      const idx = findLastIndex(items, (i) => i.type === "assistant" && i.key === key);
      if (idx < 0) return items;
      const prev = items[idx] as AssistantItem;
      const finish: AssistantItem["finish"] = {};
      if (ev.costUsd !== undefined) finish.costUsd = ev.costUsd;
      if (ev.inputTokens !== undefined) finish.inputTokens = ev.inputTokens;
      if (ev.outputTokens !== undefined) finish.outputTokens = ev.outputTokens;
      return replaceAt(items, idx, { ...prev, done: true, finish });
    }

    case "agent.error":
      return [
        ...items,
        { type: "error", key: `e:${items.length}`, message: ev.message },
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
): ChatItem[] {
  const idx = findLastIndex(items, (i) => i.type === "tool" && i.callId === callId);
  if (idx < 0) return items;
  const prev = items[idx] as ToolItem;
  return replaceAt(items, idx, { ...prev, fullOutput: output });
}

/** 是否有待回应的审批(驱动列表徽标与输入区提示) */
export function pendingPermissions(items: ChatItem[]): PermissionItem[] {
  return items.filter(
    (i): i is PermissionItem => i.type === "permission" && i.resolved === undefined,
  );
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
