/**
 * 各 agent 的常用 slash 命令。
 * 手机上打 "/compact" 要切键盘、容易打错,做成可点的列表。
 * 命令本身仍是当作普通消息发出去 —— 各家 agent 自己解析。
 */
import type { AgentKind } from "@prospero/protocol";

export interface SlashCommand {
  cmd: string;
  desc: string;
}

const COMMON: SlashCommand[] = [
  { cmd: "/compact", desc: "压缩上下文,释放窗口" },
  { cmd: "/clear", desc: "清空对话历史" },
];

const BY_AGENT: Partial<Record<AgentKind, SlashCommand[]>> = {
  claude: [
    { cmd: "/compact", desc: "压缩上下文" },
    { cmd: "/clear", desc: "清空对话" },
    { cmd: "/model", desc: "切换模型" },
    { cmd: "/cost", desc: "查看本次会话花费" },
    { cmd: "/review", desc: "审查改动" },
  ],
  codex: [
    { cmd: "/compact", desc: "压缩上下文" },
    { cmd: "/new", desc: "开新话题" },
    { cmd: "/diff", desc: "查看当前改动" },
    { cmd: "/model", desc: "切换模型" },
  ],
  opencode: [
    { cmd: "/compact", desc: "压缩上下文" },
    { cmd: "/new", desc: "新建会话" },
    { cmd: "/undo", desc: "撤销上一步改动" },
    { cmd: "/models", desc: "切换模型" },
  ],
  grok: [
    { cmd: "/compact", desc: "压缩上下文" },
    { cmd: "/clear", desc: "清空对话" },
  ],
};

export function commandsFor(agent: AgentKind): SlashCommand[] {
  return BY_AGENT[agent] ?? COMMON;
}

/** 输入以 / 开头时做前缀过滤,给出候选 */
export function matchCommands(agent: AgentKind, input: string): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const q = input.slice(1).toLowerCase();
  return commandsFor(agent).filter((c) => c.cmd.slice(1).toLowerCase().startsWith(q));
}
