/**
 * tmux 托管:让 agent 进程活过 daemon 重启。
 *
 * 现状是 daemon 直接 fork agent,PTY 一关就是 SIGHUP,daemon 挂 = 会话全没
 * (reptyr 不支持 macOS,救不回来)。tmux 作为 supervisor 解掉这一条:
 * agent 跑在 tmux server 里,daemon 只是 client,重启后 re-attach 画面和进程都还在。
 * VibeTunnel 也是这个路子,是事实标准。
 *
 * 关键是 `new-session -A`:会话不存在就建、存在就接。建和恢复因此是同一条命令,
 * 不需要"先查再决定"那种有竞态的两步。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SpawnSpec } from "./agents.js";

/** tmux 会话名前缀。带上前缀,避免误伤用户自己的 tmux 会话。 */
const PREFIX = "prospero-";
const CLEAN_TERMINAL_ENV = [
  "/usr/bin/env",
  "-u", "NO_COLOR",
  "-u", "FORCE_COLOR",
  "COLORTERM=truecolor",
  "CLICOLOR=1",
  "TERM_PROGRAM=Prospero",
] as const;

let cachedPath: string | null | undefined;

/** tmux 可执行文件路径;没装则 null。结果缓存,每次会话创建都探一次没必要。 */
export function tmuxPath(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") {
    if (process.platform === "win32") cachedPath = null;
    return null;
  }
  if (cachedPath !== undefined) return cachedPath;
  for (const candidate of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    try {
      execFileSync(candidate, ["-V"], { stdio: "ignore" });
      cachedPath = candidate;
      return cachedPath;
    } catch {
      // 试下一个
    }
  }
  try {
    const found = execFileSync("/usr/bin/which", ["tmux"], { encoding: "utf8" }).trim();
    if (found) {
      cachedPath = found;
      return cachedPath;
    }
  } catch {
    // 没装
  }
  cachedPath = null;
  return cachedPath;
}

/** 仅供测试重置探测缓存。 */
export function resetTmuxPathCache(): void {
  cachedPath = undefined;
}

export function sessionName(id: string): string {
  return `${PREFIX}${id}`;
}

/** Prefer tmux's accurate terminfo, with the portable screen entry as fallback. */
export function defaultTerminal(): "tmux-256color" | "screen-256color" {
  for (const infocmp of ["/usr/bin/infocmp", "/opt/homebrew/bin/infocmp", "/usr/local/bin/infocmp"]) {
    try {
      execFileSync(infocmp, ["tmux-256color"], { stdio: "ignore" });
      return "tmux-256color";
    } catch {
      // Try another terminfo installation.
    }
  }
  return "screen-256color";
}

/**
 * Write only server-scoped capabilities here. A tmux server reads `-f` only
 * when it first starts and may also contain the user's unrelated sessions, so
 * Prospero input/UI options are applied to the named session below.
 */
export function writeConfig(home: string): string {
  const dir = path.join(home, "tmux");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "tmux.conf");
  writeFileSync(
    file,
    [
      // tmux must describe its own virtual terminal to applications. Advertising
      // xterm here loses capabilities and makes modern Agent TUIs render
      // differently from the same command in a normal macOS terminal.
      `set -g default-terminal '${defaultTerminal()}'`,
      // The outer Prospero xterm supports 24-bit color. Keep this explicit for
      // tmux versions which cannot infer RGB from COLORTERM.
      "set -as terminal-features ',xterm-256color:RGB'",
      "set -s focus-events on",
      // A tiny window keeps Option/Alt escape sequences intact without the
      // perceptible 500 ms default delay after a literal Escape key.
      "set -s escape-time 10",
      "",
    ].join("\n"),
  );
  return file;
}

/** Reload safe server capabilities when the tmux server predates this daemon. */
export function reloadConfig(tmux: string): void {
  // A missing server is expected on first launch. `new-session -f` will load
  // the file when it creates one, so these commands are deliberately best-effort.
  const current = spawnSync(tmux, ["show-options", "-sv", "terminal-features"], {
    encoding: "utf8",
  });
  if (current.status !== 0) return;
  spawnSync(tmux, ["set-option", "-s", "default-terminal", defaultTerminal()], { stdio: "ignore" });
  spawnSync(tmux, ["set-option", "-s", "focus-events", "on"], { stdio: "ignore" });
  spawnSync(tmux, ["set-option", "-s", "escape-time", "10"], { stdio: "ignore" });
  if (!current.stdout.includes("xterm-256color:RGB")) {
    // Append once. Re-sourcing an `-a` config on every daemon restart would
    // otherwise grow terminal-features without bound.
    spawnSync(tmux, ["set-option", "-sa", "terminal-features", ",xterm-256color:RGB"], {
      stdio: "ignore",
    });
  }
}

/**
 * Apply UI/input behavior only to one Prospero session. In particular prefix,
 * status and mouse must not change the user's unrelated sessions in the same
 * default tmux server.
 */
export function configureSession(id: string, tmux: string): boolean {
  const target = sessionName(id);
  const commands = [
    ["set-option", "-t", target, "status", "off"],
    ["set-option", "-t", target, "prefix", "None"],
    // xterm's alternate buffer has no local scrollback. Let tmux consume wheel
    // events so its own 10k-line history enters copy-mode. The Mac host enables
    // xterm's Option-drag escape hatch for native text selection.
    ["set-option", "-t", target, "mouse", "on"],
    ["set-option", "-t", target, "destroy-unattached", "off"],
    ["set-option", "-t", target, "xterm-keys", "on"],
    ["set-window-option", "-t", target, "history-limit", "10000"],
    ["set-window-option", "-t", target, "window-size", "latest"],
  ];
  return commands.every((args) => spawnSync(tmux, args, { stdio: "ignore" }).status === 0);
}

/**
 * 把原始 spawn 规格包成 tmux 调用。
 * 存在同名会话时 `-A` 直接接管,命令参数被忽略 —— 正是恢复语义。
 */
export function wrapSpawn(
  spec: SpawnSpec,
  opts: {
    id: string;
    cwd: string;
    cols: number;
    rows: number;
    configFile: string;
    tmux: string;
    /** tmux server 不会可靠继承 client 环境，必须用 new-session -e 显式带入。 */
    environment?: Record<string, string>;
  },
): SpawnSpec {
  const environmentArgs = Object.entries(opts.environment ?? {}).flatMap(([name, value]) => [
    "-e",
    `${name}=${value}`,
  ]);
  return {
    file: opts.tmux,
    args: [
      "-f", opts.configFile,
      "new-session",
      "-A", // attach-or-create
      ...environmentArgs,
      "-s", sessionName(opts.id),
      "-c", opts.cwd,
      "-x", String(opts.cols),
      "-y", String(opts.rows),
      "--",
      // A long-lived tmux server keeps the environment from the process which
      // first created it. If that process had NO_COLOR=1, merely fixing the
      // attaching client's env does not restore ANSI colors in a new pane.
      // Sanitize at the pane process boundary and describe the outer xterm's
      // real capabilities without globally mutating the user's tmux server.
      ...CLEAN_TERMINAL_ENV,
      spec.file,
      ...spec.args,
    ],
  };
}

/** 当前存在的 Prospero tmux 会话 id(去掉前缀)。 */
export function listSessions(): string[] {
  const tmux = tmuxPath();
  if (!tmux) return [];
  const result = spawnSync(tmux, ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
  // 没有 server 在跑时 tmux 以非 0 退出,这不是错误
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(PREFIX))
    .map((line) => line.slice(PREFIX.length));
}

/** 真正结束一个会话 —— 关 PTY 只是断开 client,进程还在 tmux 里活着。 */
export function killSession(id: string): void {
  const tmux = tmuxPath();
  if (!tmux) return;
  spawnSync(tmux, ["kill-session", "-t", sessionName(id)], { stdio: "ignore" });
}
