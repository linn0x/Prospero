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

function encodedPowerShellProgram(file: string, args: string[]): SpawnSpec {
  if ([file, ...args].some((value) => value.includes("\0"))) {
    throw new Error("Windows Agent 命令包含 NUL 字符");
  }
  // Never interpolate argv into PowerShell source. A nested base64 JSON payload
  // preserves spaces, quotes and cmd metacharacters used by Codex API profiles.
  const payload = Buffer.from(JSON.stringify([file, ...args]), "utf8").toString("base64");
  const script =
    "$ErrorActionPreference='Stop';try{" +
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;` +
    "$a=@($p|Select-Object -Skip 1);& ([string]$p[0]) @a;" +
    "$code=$LASTEXITCODE;if($null -eq $code){$code=0};exit $code" +
    "}catch{Write-Error $_;exit 127}";
  return {
    file: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
  };
}

/**
 * Run npm-installed CLI shims through Windows PowerShell.
 *
 * npm CLIs are commonly `.cmd` shims and cannot be launched directly by
 * child_process/node-pty on Windows. Encoding argv as data also avoids cmd.exe
 * parsing API URLs, TOML quotes or user-selected model names as shell syntax.
 */
export function programCommandFor(
  file: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: EnvLike = process.env,
): SpawnSpec {
  if (platform !== "win32") return { file, args };
  const command = encodedPowerShellProgram(file, args);
  const configuredShell = windowsShell(env);
  return isPowerShell(configuredShell) ? { ...command, file: configuredShell } : command;
}

export function noopCommand(): SpawnSpec {
  return { file: process.execPath, args: ["-e", ""] };
}

export function commandFor(
  agent: AgentKind,
  customCommand?: string,
  platform: NodeJS.Platform = process.platform,
  env: EnvLike = process.env,
  extraArgs: string[] = [],
): SpawnSpec {
  switch (agent) {
    case "shell":
      return shellFor(platform, env);
    case "claude":
      return programCommandFor(
        "claude",
        ["--dangerously-skip-permissions", ...extraArgs],
        platform,
        env,
      );
    case "codex":
      return programCommandFor(
        "codex",
        ["--dangerously-bypass-approvals-and-sandbox", ...extraArgs],
        platform,
        env,
      );
    case "deepseek":
      throw new Error("DeepSeek Harness 仅支持 structured 会话");
    case "opencode":
      return programCommandFor("opencode", extraArgs, platform, env);
    case "grok":
      return programCommandFor("grok", extraArgs, platform, env);
    case "trae":
      return programCommandFor("trae-cli", ["interactive", ...extraArgs], platform, env);
    case "custom": {
      if (!customCommand || customCommand.trim() === "") {
        throw new Error("custom agent requires a command");
      }
      if (extraArgs.length > 0) throw new Error("custom agent does not accept extra arguments");
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
    agent === "opencode" || agent === "claude" || agent === "codex" || agent === "grok" || agent === "deepseek"
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
 * 新交互式 PTY 的基础环境。
 *
 * daemon 可能由另一个无色输出的工具启动（Codex 自己就是一个常见来源），
 * 因而会继承 `NO_COLOR=1`。把这个环境原样交给真正的终端，会让 Codex、Git
 * 和 zsh 主题误以为用户明确要求黑白输出。PTY 本身就是 TTY，所以在这里恢复
 * 终端能力是安全的；结构化/后台进程不走这条路径，仍保留宿主环境。
 */
export function spawnEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, overrides);

  // `NO_COLOR` 只看变量是否存在，空字符串也会禁色。FORCE_COLOR=0 是 Node
  // 生态里等价的显式禁色；交互终端恢复为自动探测，而不是反向强制所有管道着色。
  delete env["NO_COLOR"];
  if (env["FORCE_COLOR"] === "0") delete env["FORCE_COLOR"];

  // 这些值描述 Prospero 外层 xterm 的真实能力。放在 overrides 之后，避免账号
  // profile 或 daemon 启动环境把一个可显示 truecolor 的 PTY 降成 dumb/no-color。
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] = "truecolor";
  env["CLICOLOR"] = "1";
  env["TERM_PROGRAM"] = "Prospero";
  env["LANG"] = env["LANG"] ?? "en_US.UTF-8";
  return env;
}
