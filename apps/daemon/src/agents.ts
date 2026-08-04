/**
 * 各 agent 的 PTY 启动配置。M1 全部走 PTY 通用轨;
 * M2 起 claude/opencode/codex 迁移到结构化适配(Agent SDK / HTTP / app-server)。
 */
import type { AgentKind } from "@prospero/protocol";

export interface SpawnSpec {
  file: string;
  args: string[];
}

export function commandFor(agent: AgentKind, customCommand?: string): SpawnSpec {
  const shell = process.env["SHELL"] ?? "/bin/zsh";
  switch (agent) {
    case "shell":
      return { file: shell, args: ["-il"] };
    case "claude":
      return { file: "claude", args: [] };
    case "codex":
      return { file: "codex", args: [] };
    case "opencode":
      return { file: "opencode", args: [] };
    case "grok":
      return { file: "grok", args: [] };
    case "trae":
      return { file: "trae-cli", args: ["interactive"] };
    case "custom": {
      if (!customCommand || customCommand.trim() === "") {
        throw new Error("custom agent requires a command");
      }
      return { file: shell, args: ["-c", customCommand] };
    }
  }
}

/** 需要 allowShell 能力的会话类型(完整用户权限) */
export function requiresShellCapability(agent: AgentKind): boolean {
  return agent === "shell" || agent === "custom";
}

/**
 * 是否有结构化适配器(聊天 UI)。
 * 其余 agent 回落 PTY 轨,功能不减、只是形态是终端镜像。
 */
export function structuredCapable(agent: AgentKind): boolean {
  return (
    agent === "opencode" || agent === "claude" || agent === "codex" || agent === "grok"
  );
}

/**
 * 未指定 kind 时的默认轨道。
 *
 * Grok 有适配器但默认仍走 PTY:它的 headless 模式只有粗粒度审批
 * (--always-approve),无法把审批请求送到手机;而 TUI 里用户能看到并回答。
 * 想要聊天形态可显式指定 kind:"structured",此时等同自动批准。
 */
export function defaultKindFor(agent: AgentKind): "pty" | "structured" {
  if (agent === "grok") return "pty";
  return structuredCapable(agent) ? "structured" : "pty";
}

export function spawnEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] = "truecolor";
  env["LANG"] = env["LANG"] ?? "en_US.UTF-8";
  return env;
}
