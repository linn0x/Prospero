/**
 * 单个 PTY 会话:
 * - node-pty 跑真实进程;
 * - @xterm/headless 持有画面状态,attach 时 serialize 出快照(秒开的核心);
 * - 输出按帧合并(~16ms)后进 OutputRing 分配 seq,支撑断线续传;
 * - 应答终端查询(DSR/DA1/OSC 10/11),否则 Claude Code(Ink)等 TUI 会挂起或串码。
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import {
  OutputRing,
  toB64,
  utf8Encode,
  type AgentKind,
  type SessionInfo,
  type SessionStatus,
} from "@prospero/protocol";
import type { IPty } from "node-pty";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";

// CJS/UMD 包在 NodeNext ESM 下用 createRequire 加载最稳(命名导出经 cjs-module-lexer 不可靠)
const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");
const { Terminal } = require("@xterm/headless") as {
  Terminal: typeof HeadlessTerminal;
};
const { SerializeAddon } = require("@xterm/addon-serialize") as {
  SerializeAddon: typeof SerializeAddonType;
};

const FLUSH_MS = 16;
const SCROLLBACK_LINES = 2000;
const RING_BYTES = 1024 * 1024;
const INPUT_CHUNK = 1024; // >1KB 粘贴经 PTY 有死锁报告,分片写入

export interface PtySessionOptions {
  id: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  file: string;
  args: string[];
  env: Record<string, string>;
  accountId?: string;
  accountName?: string;
}

export interface SnapshotResult {
  ansi: string;
  seq: number;
  cols: number;
  rows: number;
}

export interface PtySessionEvents {
  /** 合帧后的输出块(已入 ring、已分配 seq) */
  output: [dataB64: string, seq: number];
  state: [info: SessionInfo];
}

export class PtySession extends EventEmitter<PtySessionEvents> {
  readonly id: string;
  readonly agent: AgentKind;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt = Date.now();
  readonly accountId: string | undefined;
  readonly accountName: string | undefined;
  readonly ring = new OutputRing(RING_BYTES);

  private cols: number;
  private rows: number;
  private status: SessionStatus = "starting";
  private exited = false;

  private readonly proc: IPty;
  private readonly term: HeadlessTerminal;
  private readonly serializer: SerializeAddonType;

  private pending: string[] = [];
  private pendingBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  /** 终端查询序列可能跨 chunk 断裂,保留尾部少量字节做拼接匹配 */
  private queryCarry = "";

  constructor(opts: PtySessionOptions) {
    super();
    this.id = opts.id;
    this.agent = opts.agent;
    this.title = opts.title;
    this.cwd = opts.cwd;
    this.accountId = opts.accountId;
    this.accountName = opts.accountName;
    this.cols = opts.cols;
    this.rows = opts.rows;

    this.term = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);

    // 二进制不丢失:PTY 输出按 utf8 进来(node-pty 默认 utf8 字符串)
    this.proc = pty.spawn(opts.file, opts.args, {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });

    this.proc.onData((data) => this.onProcData(data));
    this.proc.onExit(({ exitCode }) => {
      this.flushNow();
      this.exited = true;
      this.setStatus(exitCode === 0 ? "done" : "died");
    });
  }

  get pid(): number {
    return this.proc.pid;
  }

  info(): SessionInfo {
    return {
      id: this.id,
      agent: this.agent,
      kind: "pty",
      title: this.title,
      cwd: this.cwd,
      status: this.status,
      createdAt: this.createdAt,
      cols: this.cols,
      rows: this.rows,
      ...(this.accountId ? { accountId: this.accountId } : {}),
      ...(this.accountName ? { accountName: this.accountName } : {}),
    };
  }

  private setStatus(s: SessionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit("state", this.info());
  }

  private onProcData(data: string): void {
    if (this.status === "starting") this.setStatus("running");
    // 查询应答放在 term.write 回调里:此时 headless 终端已消化该块,光标位置准确
    this.term.write(data, () => this.answerTerminalQueries(data));
    this.pending.push(data);
    this.pendingBytes += data.length;
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushNow(), FLUSH_MS);
    }
  }

  /** 立刻把待发输出入 ring 并广播(attach/退出前也会调用,保证 seq 一致性) */
  flushNow(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;
    const text = this.pending.join("");
    this.pending = [];
    this.pendingBytes = 0;
    const bytes = utf8Encode(text);
    const seq = this.ring.push(bytes);
    this.emit("output", toB64(bytes), seq);
  }

  /**
   * 生成一致性快照:先 flush(锁定 seq),再等 headless 终端消化完已写入数据
   * (term.write 是异步解析,用空写作为屏障),然后 serialize。
   */
  snapshot(): Promise<SnapshotResult> {
    this.flushNow();
    return new Promise((resolve) => {
      this.term.write("", () => {
        resolve({
          ansi: this.serializer.serialize(),
          seq: this.ring.lastSeq,
          cols: this.cols,
          rows: this.rows,
        });
      });
    });
  }

  /** 客户端键盘输入(base64 的 utf8 字节) */
  writeInput(text: string): void {
    if (this.exited) return;
    for (let i = 0; i < text.length; i += INPUT_CHUNK) {
      this.proc.write(text.slice(i, i + INPUT_CHUNK));
    }
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.cols = cols;
    this.rows = rows;
    this.proc.resize(cols, rows);
    this.term.resize(cols, rows);
    this.emit("state", this.info());
  }

  interrupt(): void {
    if (!this.exited) this.proc.write("\x03");
  }

  kill(): void {
    if (!this.exited) this.proc.kill();
  }

  dispose(): void {
    this.kill();
    this.term.dispose();
    this.removeAllListeners();
  }

  /**
   * 应答子进程发出的终端查询(它们出现在输出流里):
   * - DSR CSI 6n → 光标位置(Claude Code/Ink 启动必发,不答会挂起)
   * - DA1 CSI c / CSI 0c → 设备属性(crossterm/ratatui 探测)
   * - OSC 10/11 前景/背景色查询 → 默认深色主题
   * 回复直接写回 PTY(等同"终端"作答),不进入输出流。
   */
  private answerTerminalQueries(chunk: string): void {
    const carryLen = this.queryCarry.length;
    const s = this.queryCarry + chunk;
    this.queryCarry = s.slice(-8);

    // 只应答"至少有一个字节落在新 chunk"的匹配,避免 carry 里已应答的查询被重复应答
    const scan = (pattern: string, onHit: () => void): void => {
      for (let i = s.indexOf(pattern); i !== -1; i = s.indexOf(pattern, i + 1)) {
        if (i + pattern.length > carryLen) onHit();
      }
    };

    scan("\x1b[6n", () => {
      const buf = this.term.buffer.active;
      this.proc.write(`\x1b[${buf.cursorY + 1};${buf.cursorX + 1}R`);
    });
    scan("\x1b[c", () => this.proc.write("\x1b[?6c")); // DA1 → VT102
    scan("\x1b[0c", () => this.proc.write("\x1b[?6c"));
    scan("\x1b]10;?", () => this.proc.write("\x1b]10;rgb:ffff/ffff/ffff\x1b\\"));
    scan("\x1b]11;?", () => this.proc.write("\x1b]11;rgb:0000/0000/0000\x1b\\"));
  }
}
