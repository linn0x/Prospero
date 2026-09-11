import { spawn, type ChildProcess } from "node:child_process";
import { constants, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { RustClient } from "./rust-client";

export type RustConnection = { client: RustClient; pid: number; baseUrl: string };

async function exitedWithin(exited: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([exited.then(() => true), new Promise<false>(done => { timer = setTimeout(() => done(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export class RustProcess {
  private child: ChildProcess | undefined;
  private exited: Promise<void> = Promise.resolve();
  private starting: Promise<RustConnection> | undefined;
  private stopping: Promise<void> | undefined;
  private startup: AbortController | undefined;
  private connection: RustConnection | undefined;

  constructor(readonly binary: string, readonly directory: string, private readonly onExit: () => void = () => {}) {
    if (!isAbsolute(binary) || !isAbsolute(directory)) throw new Error("Rust runtime paths must be absolute");
  }

  get managed(): boolean { return Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null); }

  start(): Promise<RustConnection> {
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.connection && this.managed) return Promise.resolve(this.connection);
    if (!this.starting) this.starting = this.launch().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async launch(): Promise<RustConnection> {
    const startup = new AbortController();
    this.startup = startup;
    const child = spawn(this.binary, ["serve", "--data-dir", this.directory], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.on("error", () => {});
    this.exited = new Promise(done => child.once("close", () => {
      if (this.child === child) { this.child = undefined; this.connection = undefined; this.onExit(); }
      done();
    }));
    child.stderr?.resume();
    const timer = setTimeout(() => startup.abort(), 10000);
    try {
      const ready = await new Promise<{ pid: number; baseUrl: string }>((done, fail) => {
        let output = "";
        const cleanup = (): void => { child.stdout?.off("data", data); child.off("error", error); child.off("exit", exit); startup.signal.removeEventListener("abort", abort); };
        const reject = (message: string): void => { cleanup(); fail(new Error(message)); };
        const error = (): void => reject("Rust 服务启动失败，请检查二进制与数据目录");
        const exit = (): void => reject("Rust 服务在就绪前退出");
        const abort = (): void => reject("Rust 服务启动已取消或超时");
        const data = (chunk: Buffer): void => {
          output += chunk.toString("utf8");
          if (Buffer.byteLength(output) > 16384) { reject("Rust startup output exceeds limit"); return; }
          const newline = output.indexOf("\n");
          if (newline < 0) return;
          try {
            const value = JSON.parse(output.slice(0, newline)) as Record<string, unknown>;
            if (value["event"] !== "ready" || value["apiVersion"] !== 1 || value["pid"] !== child.pid || typeof value["baseUrl"] !== "string") throw new Error();
            cleanup(); child.stdout?.resume(); done({ pid: Number(value["pid"]), baseUrl: value["baseUrl"] });
          } catch { reject("Invalid Rust readiness response"); }
        };
        child.stdout?.on("data", data);
        child.once("error", error); child.once("exit", exit);
        startup.signal.addEventListener("abort", abort, { once: true });
      });
      const descriptor = openSync(resolve(this.directory, "connection.json"), constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      let value: Record<string, unknown>;
      try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.size > 4096 || stat.nlink !== 1 || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("Invalid Rust connection file");
        value = JSON.parse(readFileSync(descriptor, "utf8")) as Record<string, unknown>;
      } finally { closeSync(descriptor); }
      if (value["apiVersion"] !== 1 || value["pid"] !== ready.pid || value["baseUrl"] !== ready.baseUrl || typeof value["token"] !== "string") throw new Error("Rust connection does not match the owned process");
      const client = new RustClient(ready.baseUrl, value["token"]);
      const health = await client.health(startup.signal);
      if (health.apiVersion !== 1 || health.backend !== "rust" || startup.signal.aborted || !this.managed) throw new Error("Rust health check failed");
      this.connection = { client, ...ready };
      return this.connection;
    } catch (error) {
      await this.stop();
      throw error;
    } finally { clearTimeout(timer); if (this.startup === startup) this.startup = undefined; }
  }

  stop(): Promise<void> {
    if (!this.stopping) this.stopping = this.terminate().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async terminate(): Promise<void> {
    this.startup?.abort();
    const child = this.child;
    if (!child) return;
    const exited = this.exited;
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1800);
    try {
      if (this.connection) await this.connection.client.shutdown(AbortSignal.timeout(700)).catch(() => {});
      if (await exitedWithin(exited, 700)) return;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (!(await exitedWithin(exited, 1800))) throw new Error("Rust 服务未在关闭期限内退出");
    } finally { clearTimeout(force); }
  }
}
