/**
 * 各 agent 的 PTY 启动配置。M1 全部走 PTY 通用轨;
 * M2 起 claude/opencode/codex 迁移到结构化适配(Agent SDK / HTTP / app-server)。
 */
import type { AgentKind } from "@prospero/protocol";

export interface SpawnSpec {
  file: string;
  args: string[];
}

type EnvLike = Pick<NodeJS.ProcessEnv, string>;

function windowsShell(env: EnvLike): string {
  return env["COMSPEC"] ?? env["ComSpec"] ?? "cmd.exe";
}

function isPowerShell(file: string): boolean {
  const name = file.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  return name === "powershell.exe" || name === "pwsh.exe" || name === "powershell" || name === "pwsh";
}

export function shellFor(
  platform: NodeJS.Platform = process.platform,
  env: EnvLike = process.env,
): SpawnSpec {
  if (platform === "win32") {
    const shell = windowsShell(env);
    return isPowerShell(shell)
      ? { file: shell, args: ["-NoLogo"] }
      : { file: shell, args: ["/d"] };
  }
  return { file: env["SHELL"] ?? "/bin/zsh", args: ["-il"] };
}

function shellCommandFor(
  command: string,
  platform: NodeJS.Platform,
  env: EnvLike,
): SpawnSpec {
  const shell = platform === "win32" ? windowsShell(env) : (env["SHELL"] ?? "/bin/zsh");
  if (platform === "win32") {
    return isPowerShell(shell)
      ? { file: shell, args: ["-NoLogo", "-NoProfile", "-Command", command] }
      : { file: shell, args: ["/d", "/s", "/c", command] };
  }
  return { file: shell, args: ["-c", command] };
}

const SAFE_PROGRAM_TOKEN = /^[A-Za-z0-9_./:\\-]+$/;

/** Run npm-installed CLI shims through the Windows command processor. */
export function programCommandFor(
  file: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: EnvLike = process.env,
): SpawnSpec {
  if (platform !== "win32") return { file, args };
  const tokens = [file, ...args];
  if (tokens.some((token) => !SAFE_PROGRAM_TOKEN.test(token))) {
    throw new Error("Windows Agent 命令包含不安全字符");
  }
  return shellCommandFor(tokens.join(" "), platform, env);
}

export function noopCommand(): SpawnSpec {
  return { file: process.execPath, args: ["-e", ""] };
}

export function commandFor(
  agent: AgentKind,
  customCommand?: string,
  platform: NodeJS.Platform = process.platform,
  env: EnvLike = process.env,
): SpawnSpec {
  switch (agent) {
    case "shell":
      return shellFor(platform, env);
    case "claude":
      return programCommandFor("claude", ["--dangerously-skip-permissions"], platform, env);
    case "codex":
      return programCommandFor(
        "codex",
        ["--dangerously-bypass-approvals-and-sandbox"],
        platform,
        env,
      );
    case "opencode":
      return programCommandFor("opencode", [], platform, env);
    case "grok":
      return programCommandFor("grok", [], platform, env);
    case "trae":
      return programCommandFor("trae-cli", ["interactive"], platform, env);
    case "custom": {
      if (!customCommand || customCommand.trim() === "") {
        throw new Error("custom agent requires a command");
      }
      return shellCommandFor(customCommand, platform, env);
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

/**
 * 新会话的基础环境；编排层可补入会话身份和控制 socket 信息。
 * 覆盖项放最后，确保每个 worker 都带自己的 PROSPERO_SESSION_ID。
 */
export function spawnEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] = "truecolor";
  env["LANG"] = env["LANG"] ?? "en_US.UTF-8";
  return { ...env, ...overrides };
}
