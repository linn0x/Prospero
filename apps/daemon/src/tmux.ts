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

let cachedPath: string | null | undefined;

/** tmux 可执行文件路径;没装则 null。结果缓存,每次会话创建都探一次没必要。 */
export function tmuxPath(): string | null {
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

/**
 * 写一份最小 tmux 配置。
 * 状态栏必须关掉 —— 手机上那一行是纯噪音,而且会吃掉一行高度。
 */
export function writeConfig(home: string): string {
  const dir = path.join(home, "tmux");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "tmux.conf");
  writeFileSync(
    file,
    [
      "set -g status off",
      "set -g default-terminal 'xterm-256color'",
      // 前缀键整个去掉。手机上没人从这里管理 tmux 窗口,留着任何前缀都只是
      // 从 agent 手里偷走一个键 —— Ctrl-B 本身就是 readline 的后退一字符。
      // (曾经改成 C-\\,但转义多写了一层,生成出 'C-\\\\',tmux 每次启动都报 bad key)
      "unbind C-b",
      "set -g prefix None",
      "set -g escape-time 0",
      "set -g history-limit 10000",
      // daemon 断开时不要销毁会话 —— 整件事的重点
      "set -g destroy-unattached off",
      "set -g mouse on",
      "",
    ].join("\n"),
  );
  return file;
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
