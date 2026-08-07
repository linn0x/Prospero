/**
 * 各 agent 的常用 slash 命令。
 * 手机上打 "/compact" 要切键盘、容易打错,做成可点的列表。
 * 控制命令由 Prospero 拦截并调用 agent 的原生 API，绝不作为普通 Prompt 发给模型。
 */
import type { AgentKind } from "@prospero/protocol";

export interface SlashCommand {
  cmd: string;
  desc: string;
}

const COMMON: SlashCommand[] = [];

/** Prospero 自己处理的命令，所以每一种 ChatUI agent 都能用。 */
const PROSPERO: SlashCommand[] = [
  { cmd: "/skills", desc: "浏览并插入可用 Skill" },
];

const BY_AGENT: Partial<Record<AgentKind, SlashCommand[]>> = {
  claude: [
    { cmd: "/compact", desc: "压缩上下文" },
    { cmd: "/model", desc: "打开模型与模式设置" },
    { cmd: "/plan", desc: "切换到 Plan 模式" },
  ],
  codex: [
    { cmd: "/compact", desc: "压缩上下文" },
    { cmd: "/model", desc: "打开模型与模式设置" },
    { cmd: "/plan", desc: "切换到 Plan 模式" },
  ],
};

export function commandsFor(agent: AgentKind): SlashCommand[] {
  return [...PROSPERO, ...(BY_AGENT[agent] ?? COMMON)];
}

/** 输入以 / 开头时做前缀过滤,给出候选 */
export function matchCommands(agent: AgentKind, input: string): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const q = input.slice(1).toLowerCase();
  return commandsFor(agent).filter((c) => c.cmd.slice(1).toLowerCase().startsWith(q));
}
