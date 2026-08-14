/**
 * 把运行时状态落到 `~/.prospero/status.json`,给菜单栏壳读。
 *
 * 为什么不开个 HTTP 状态接口:WS 协议要过 token + E2E 握手,壳要用就得实现一遍加密层;
 * 而 daemon 已经在往 `~/.prospero` 写 config/devices 了,再多一个文件是最小增量,
 * 且天然带 0600 的文件权限边界 —— 状态里有 cwd 和会话标题,不该对同机其他用户可读。
 */
import { chmodSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { SessionInfo } from "@prospero/protocol";
import type { SessionManager } from "./session-manager.js";
import type { RelayRuntimeStatus } from "./relay-host-client.js";

/** 壳只需要这些字段;完整 SessionInfo 里的 seq/totals 之类没必要外泄。 */
export interface StatusSession {
  id: string;
  agent: string;
  kind: string;
  title: string;
  cwd: string;
  status: string;
  pendingPermissions: number;
  pendingQuestions: number;
  createdAt: number;
  approvalPolicy?: string;
  preview?: string;
  busySince?: number;
  subagents?: Array<{
    id: string;
    name: string;
    status: string;
    canMessage: boolean;
    role?: string;
    task?: string;
    preview?: string;
  }>;
}

export interface StatusSnapshot {
  pid: number;
  startedAt: number;
  /** 本进程加载的代码的构建时间 —— 壳拿它和磁盘上的 dist 比,发现"daemon 比代码旧" */
  builtAt: number;
  port: number;
  bind: string | null;
  /** 仅供同用户 Mac GUI 调用回环控制接口；status.json 权限固定为 0600。 */
  controlToken: string;
  persistence: { pty: boolean; structured: boolean };
  /** Deliberately safe relay observability; credentials are never copied here. */
  relay?: RelayRuntimeStatus;
  sessions: StatusSession[];
}

const FILE = "status.json";

/**
 * 本模块文件的 mtime,作为"这份代码何时编译出来"的近似。
 * 改完 daemon 忘记重启是个很难查的坑 —— 手机侧有新功能、Mac 侧没有,
 * 表现是消息被当成非法而拒绝,错误信息完全指不到真正的原因。
 */
let cachedBuiltAt: number | null = null;
function buildTimestamp(): number {
  if (cachedBuiltAt !== null) return cachedBuiltAt;
  try {
    cachedBuiltAt = Math.floor(statSync(fileURLToPath(import.meta.url)).mtimeMs);
  } catch {
    cachedBuiltAt = 0;
  }
  return cachedBuiltAt;
}

export class StatusFile {
  private readonly filePath: string;
  private timer: NodeJS.Timeout | null = null;
  private detach: (() => void) | null = null;
  private relay: RelayRuntimeStatus | undefined;

  constructor(
    home: string,
    private readonly manager: SessionManager,
    private readonly meta: {
      port: number;
      bind: string | null;
      controlToken: string;
      persistence: { pty: boolean; structured: boolean };
      startedAt?: number;
    },
  ) {
    this.filePath = path.join(home, FILE);
  }

  /** @param actualPort listen 后的真实端口;传 0 或省略则沿用构造时的 */
  start(actualPort?: number): void {
    if (actualPort) this.meta.port = actualPort;
    const onState = (): void => this.schedule();
    this.manager.on("state", onState);
    this.detach = () => this.manager.off("state", onState);
    this.write();
  }

  setRelayStatus(status: RelayRuntimeStatus): void {
    this.relay = status;
    this.schedule();
  }

  /**
   * 合并写。洪峰输出时 state 事件很密,每次都写文件会白白打盘;
   * 壳是 3 秒轮询的,250ms 的合帧对它来说已经是即时。
   */
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, 250);
    this.timer.unref?.();
  }

  private write(): void {
    const snapshot: StatusSnapshot = {
      pid: process.pid,
      startedAt: this.meta.startedAt ?? Date.now(),
      builtAt: buildTimestamp(),
      port: this.meta.port,
      bind: this.meta.bind,
      controlToken: this.meta.controlToken,
      persistence: this.meta.persistence,
      ...(this.relay ? { relay: this.relay } : {}),
      sessions: this.manager.list().map(toStatusSession),
    };
    try {
      writeFileSync(this.filePath, JSON.stringify(snapshot, null, 2));
      chmodSync(this.filePath, 0o600);
    } catch {
      // 状态文件是给 UI 看的,写不进去不该影响会话
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.detach?.();
    this.detach = null;
    // 删掉而不是留一份陈旧快照 —— 壳看到文件不存在就知道 daemon 没在跑
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

export function toStatusSession(info: SessionInfo): StatusSession {
  const session: StatusSession = {
    id: info.id,
    agent: info.agent,
    kind: info.kind,
    title: info.title,
    cwd: info.cwd,
    status: info.status,
    pendingPermissions: info.pendingPermissions ?? 0,
    pendingQuestions: info.pendingQuestions ?? 0,
    createdAt: info.createdAt,
  };
  if (info.approvalPolicy !== undefined) session.approvalPolicy = info.approvalPolicy;
  if (info.preview !== undefined) session.preview = info.preview;
  if (info.busySince !== undefined) session.busySince = info.busySince;
  if (info.subagents?.length) {
    session.subagents = info.subagents.map((subagent) => ({
      id: subagent.id,
      name: subagent.name,
      status: subagent.status,
      canMessage: subagent.canMessage,
      ...(subagent.role ? { role: subagent.role } : {}),
      ...(subagent.task ? { task: subagent.task } : {}),
      ...(subagent.preview ? { preview: subagent.preview } : {}),
    }));
  }
  return session;
}
