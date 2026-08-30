import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 定位 node 解释器,并还原登录 shell 的 PATH。
 *
 * 这在 Windows 上不是问题:PATH 对 GUI 进程和终端是同一份。macOS 与 Linux 上
 * 完全不同 —— 从 Finder/Dock 启动的进程只继承一份极简 PATH(/usr/bin:/bin:…),
 * 里面既没有 mise/nvm/volta 装的 node,也没有各家 agent 的 CLI。直接 spawn("node")
 * 会失败,而且失败得很晚:用户在终端里明明能跑。
 *
 * 所以要主动起一个登录 shell 把 PATH 问出来,再连同它一起交给 daemon —— daemon
 * 要靠这份 PATH 去找 claude/codex/opencode 等可执行文件。
 *
 * 这套逻辑对应 macOS 原生壳里的 Locator.swift。
 */

const NODE_MARKER = "<<prospero-node>>";
const PATH_MARKER = "<<prospero-path>>";
/** 登录 shell 要跑完用户的 rc 文件,几十到几百毫秒;PATH 在一次会话里几乎不变。 */
const SHELL_TTL_MS = 60_000;

let cachedAt = 0;
let cachedNode: string | undefined;
let cachedPath: string | undefined;

function executable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 起一次登录 shell,一并问出 node 位置和 PATH。
 *
 * 输出用标记行包起来而不是按行号取:用户的 rc 文件里 echo 点什么很常见,
 * 按行号取会把那些噪声当成 node 路径。
 */
function probeLoginShell(): { node: string | undefined; path: string | undefined } {
  if (Date.now() - cachedAt < SHELL_TTL_MS) return { node: cachedNode, path: cachedPath };
  cachedAt = Date.now();
  cachedNode = undefined;
  cachedPath = undefined;
  if (process.platform === "win32") return { node: undefined, path: undefined };
  const shell = process.env["SHELL"] || "/bin/zsh";
  try {
    const output = execFileSync(
      shell,
      ["-lc", `printf '${NODE_MARKER}%s\\n' "$(command -v node)"; printf '${PATH_MARKER}%s\\n' "$PATH"`],
      { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const line of output.split(/\r?\n/)) {
      if (line.startsWith(NODE_MARKER)) {
        const value = line.slice(NODE_MARKER.length).trim();
        if (value) cachedNode = value;
      } else if (line.startsWith(PATH_MARKER)) {
        const value = line.slice(PATH_MARKER.length).trim();
        if (value) cachedPath = value;
      }
    }
  } catch {
    // 登录 shell 起不来或超时:退回下面的常见安装路径,不让定位整个失败。
  }
  return { node: cachedNode, path: cachedPath };
}

/** 常见的 node 安装位置。登录 shell 问不到时按这个顺序兜底。 */
function commonNodePaths(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    return [
      join(process.env["ProgramFiles"] ?? "C:\\Program Files", "nodejs", "node.exe"),
      join(process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"), "Programs", "nodejs", "node.exe"),
    ];
  }
  return [
    // mise 的 shim 通常只在 .zshrc 里加进 PATH,而 Dock 启动的是非交互登录 shell,
    // 不一定读得到它 —— 所以显式检查这两个目录。
    join(home, ".local/share/mise/shims/node"),
    join(home, ".mise/shims/node"),
    join(home, ".volta/bin/node"),
    join(home, ".fnm/aliases/default/bin/node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ];
}

/** 供 daemon 使用的 node 解释器;找不到返回 undefined,由调用方给出可读的错误。 */
export function resolveNodeExecutable(): string | undefined {
  const override = process.env["PROSPERO_NODE"]?.trim();
  if (override && executable(override)) return override;
  const viaShell = probeLoginShell().node;
  if (viaShell && executable(viaShell)) return viaShell;
  return commonNodePaths().find(executable);
}

/**
 * 交给 daemon 的 PATH。
 *
 * 即使非交互登录 shell 漏加载了 mise,也要把已定位 node 所在目录补回去 ——
 * 同一个 shim 目录通常还放着各家 agent CLI 的版本管理器入口。
 */
export function loginPath(nodeExecutable?: string): string | undefined {
  if (process.platform === "win32") return undefined;
  const shellPath = probeLoginShell().path;
  if (!nodeExecutable) return shellPath;
  const nodeDir = join(nodeExecutable, "..");
  if (!shellPath) return nodeDir;
  return shellPath.split(":").includes(nodeDir) ? shellPath : `${nodeDir}:${shellPath}`;
}
