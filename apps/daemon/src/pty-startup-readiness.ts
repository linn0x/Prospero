import type { SessionInfo } from "@prospero/protocol";

/**
 * TUI 通常会在最初的 ANSI 初始化后重置输入行。这个窗口足够短，不应让正常
 * worker 感到迟缓；没有输出的 CLI 则由总超时保证仍可继续派发。
 */
export const PTY_STARTUP_READY_TIMEOUT_MS = 1_200;
export const PTY_STARTUP_STABILITY_WINDOW_MS = 120;

export interface PtyStartupReadinessOptions {
  timeoutMs?: number;
  stabilityWindowMs?: number;
  signal?: AbortSignal;
}

/** SessionManager 的最小观察面，也方便用确定性 fake 覆盖启动边界。 */
export interface PtyStartupReadinessSource {
  infoOf(sid: string): SessionInfo;
  on(event: "output", listener: (sid: string, dataB64: string, seq: number) => void): unknown;
  on(event: "state", listener: (info: SessionInfo) => void): unknown;
  off(event: "output", listener: (sid: string, dataB64: string, seq: number) => void): unknown;
  off(event: "state", listener: (info: SessionInfo) => void): unknown;
}

export class PtyStartupReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PtyStartupReadinessError";
  }
}

function isTerminal(info: SessionInfo): boolean {
  return info.status === "done" || info.status === "died";
}

function duration(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} 必须是有限的非负毫秒数`);
  }
  return resolved;
}

/**
 * 等到 PTY 已至少开始输出（或状态已离开 starting）后留出一个短暂稳定窗口。
 * 这不是“等待 prompt 字符串”的脆弱协议：不同 CLI 的 banner 并不一致，quiet CLI
 * 也会在 timeout 后安全继续。会话终止、调用方取消和所有 timer/listener 都会收口。
 */
export function waitForPtyStartupReadiness(
  source: PtyStartupReadinessSource,
  sid: string,
  options: PtyStartupReadinessOptions = {},
): Promise<void> {
  const timeoutMs = duration(options.timeoutMs, PTY_STARTUP_READY_TIMEOUT_MS, "timeoutMs");
  const stabilityWindowMs = duration(
    options.stabilityWindowMs,
    PTY_STARTUP_STABILITY_WINDOW_MS,
    "stabilityWindowMs",
  );

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    let stability: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (stability) clearTimeout(stability);
      source.off("output", onOutput);
      source.off("state", onState);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const readyAfterQuietWindow = () => {
      if (settled) return;
      // “stability” 的含义是随后一小段时间没有新的终端输出，而不是观察到
      // 第一帧后盲等一次。TUI 的 banner / 动画可拆成多个 output frame；每帧
      // 都应把 quiet timer 往后推，但绝不能影响已经独立启动的总 timeout。
      if (stability) {
        clearTimeout(stability);
        stability = null;
      }
      if (stabilityWindowMs === 0) {
        finish();
        return;
      }
      stability = setTimeout(() => finish(), stabilityWindowMs);
      stability.unref?.();
    };
    const observe = (info: SessionInfo) => {
      if (info.id !== sid || settled) return;
      if (info.kind !== "pty") {
        finish(new PtyStartupReadinessError(`session ${sid} 不是 PTY 会话`));
        return;
      }
      if (isTerminal(info)) {
        finish(new PtyStartupReadinessError(`PTY worker ${sid} 在启动完成前已${info.status === "died" ? "退出" : "结束"}`));
        return;
      }
      if (info.status !== "starting") readyAfterQuietWindow();
    };
    const onOutput = (outputSid: string) => {
      if (outputSid === sid) readyAfterQuietWindow();
    };
    const onState = (info: SessionInfo) => observe(info);
    const onAbort = () => finish(new PtyStartupReadinessError(`PTY worker ${sid} 的启动等待已取消`));

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    source.on("output", onOutput);
    source.on("state", onState);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    timeout = setTimeout(() => finish(), timeoutMs);
    timeout.unref?.();
    try {
      // 先订阅再读当前状态，避免 create() 返回和监听安装之间错过首帧。
      observe(source.infoOf(sid));
    } catch (error) {
      finish(new PtyStartupReadinessError(
        `PTY worker ${sid} 在启动完成前不可用: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  });
}
