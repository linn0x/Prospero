/**
 * 把运行时状态落到 `~/.prospero/status.json`,给菜单栏壳读。
 *
 * 为什么不开个 HTTP 状态接口:WS 协议要过 token + E2E 握手,壳要用就得实现一遍加密层;
 * 而 daemon 已经在往 `~/.prospero` 写 config/devices 了,再多一个文件是最小增量,
 * 且天然带 0600 的文件权限边界 —— 状态里有 cwd 和会话标题,不该对同机其他用户可读。
 */
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionInfo } from "@prospero/protocol";
import type { SessionManager } from "./session-manager.js";

/** 壳只需要这些字段;完整 SessionInfo 里的 seq/totals 之类没必要外泄。 */
export interface StatusSession {
  id: string;
  agent: string;
  kind: string;
  title: string;
  cwd: string;
  status: string;
  pendingPermissions: number;
  busySince?: number;
}

export interface StatusSnapshot {
  pid: number;
  startedAt: number;
  port: number;
  bind: string | null;
  sessions: StatusSession[];
}

const FILE = "status.json";

export class StatusFile {
  private readonly filePath: string;
  private timer: NodeJS.Timeout | null = null;
  private detach: (() => void) | null = null;

  constructor(
    home: string,
    private readonly manager: SessionManager,
    private readonly meta: { port: number; bind: string | null; startedAt?: number },
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
      port: this.meta.port,
      bind: this.meta.bind,
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
  };
  if (info.busySince !== undefined) session.busySince = info.busySince;
  return session;
}
