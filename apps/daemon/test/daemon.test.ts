/**
 * daemon 集成测试:真实加密握手 + PTY 会话全链路(内存中起服务,随机端口)。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  clientHandshake,
  fromB64,
  generateKeyPairB64,
  parseS2C,
  utf8Decode,
  type KeyPairB64,
  type S2CMessage,
} from "@prospero/protocol";
import { loadIdentity, mintDevice } from "../src/pairing.js";
import { createDaemonServer, type DaemonServer } from "../src/ws-server.js";

const home = mkdtempSync(path.join(os.tmpdir(), "prospero-test-"));
let server: DaemonServer;
let daemonPub: string;

// 同一设备跨连接必须复用同一密钥对(TOFU 绑定)
const deviceKeys = generateKeyPairB64();
let deviceToken: string;

class TestClient {
  private queue: S2CMessage[] = [];
  closed = false;

  private constructor(
    private readonly ws: WebSocket,
    private readonly channel: ReturnType<typeof clientHandshake>["channel"],
  ) {}

  static async connect(token: string, keys: KeyPairB64): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const { frame, channel } = clientHandshake(daemonPub, {
      type: "hello",
      token,
      clientPubKey: keys.publicKey,
      clientInfo: { platform: "ios", appVersion: "test" },
    });
    const client = new TestClient(ws, channel);
    ws.on("message", (raw) => {
      client.queue.push(parseS2C(channel.open(raw.toString())));
    });
    ws.on("close", () => {
      client.closed = true;
    });
    ws.send(frame);
    return client;
  }

  send(msg: unknown): void {
    this.ws.send(this.channel.seal(msg));
  }

  async waitFor(
    pred: (m: S2CMessage) => boolean,
    what: string,
    timeoutMs = 8000,
  ): Promise<S2CMessage> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const i = this.queue.findIndex(pred);
      if (i >= 0) return this.queue.splice(i, 1)[0]!;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for: ${what}(queued: ${this.queue.map((m) => m.type).join(",")})`);
  }

  /** 聚合 snapshot/output 的可见文本,直到包含 marker */
  async collectText(sid: string, marker: string, timeoutMs = 8000): Promise<string> {
    let text = "";
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const i = this.queue.findIndex(
        (m) =>
          (m.type === "term.output" || m.type === "term.snapshot") && m.sid === sid,
      );
      if (i >= 0) {
        const m = this.queue.splice(i, 1)[0]!;
        text += m.type === "term.output" ? utf8Decode(fromB64(m.dataB64)) : m.ansi;
        if (text.includes(marker)) return text;
      } else {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    throw new Error(`timeout: "${marker}" 未出现在输出中(已收 ${text.length} 字节)`);
  }

  async waitClose(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!this.closed && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!this.closed) throw new Error("socket did not close");
  }

  close(): void {
    this.ws.close();
  }
}

beforeAll(async () => {
  daemonPub = loadIdentity(home).publicKey;
  deviceToken = mintDevice(home, { name: "test-device", allowShell: true }).token;
  server = await createDaemonServer({ home, port: 0 });
});

afterAll(async () => {
  await server.close();
});

describe("daemon 全链路", () => {
  it("握手 → hello.ok → 创建会话 → 输出 → 正常结束", async () => {
    const c = await TestClient.connect(deviceToken, deviceKeys);
    await c.waitFor((m) => m.type === "hello.ok", "hello.ok");
    c.send({
      type: "session.create",
      agent: "custom",
      command: "printf 'PROSPERO_SMOKE\\n'; sleep 0.2",
      cols: 80,
      rows: 24,
    });
    const snap = await c.waitFor((m) => m.type === "term.snapshot", "auto-attach snapshot");
    const sid = (snap as { sid: string }).sid;
    await c.collectText(sid, "PROSPERO_SMOKE");
    await c.waitFor(
      (m) => m.type === "session.state" && m.session.id === sid && m.session.status === "done",
      "session done",
    );
    c.close();
  }, 20000);

  it("断线重连:lastSeq 增量续传;新 attach 走快照", async () => {
    const c1 = await TestClient.connect(deviceToken, deviceKeys);
    await c1.waitFor((m) => m.type === "hello.ok", "hello.ok");
    c1.send({
      type: "session.create",
      agent: "custom",
      command: "printf 'MARKER_ONE\\n'; sleep 30",
      cols: 80,
      rows: 24,
    });
    const snap = await c1.waitFor((m) => m.type === "term.snapshot", "snapshot");
    const sid = (snap as { sid: string }).sid;
    await c1.collectText(sid, "MARKER_ONE");
    c1.close();

    // lastSeq=0 → ring 覆盖,应收到含 MARKER_ONE 的增量(term.output),而非快照
    const c2 = await TestClient.connect(deviceToken, deviceKeys);
    await c2.waitFor((m) => m.type === "hello.ok", "hello.ok");
    c2.send({ type: "session.attach", sid, lastSeq: 0 });
    const resumed = await c2.waitFor(
      (m) => m.type === "term.output" && m.sid === sid,
      "resume output",
    );
    expect(
      utf8Decode(fromB64((resumed as { dataB64: string }).dataB64)),
    ).toContain("MARKER_ONE");
    c2.close();

    // 无 lastSeq → 全量快照,画面里应有 MARKER_ONE
    const c3 = await TestClient.connect(deviceToken, deviceKeys);
    await c3.waitFor((m) => m.type === "hello.ok", "hello.ok");
    c3.send({ type: "session.attach", sid });
    const fresh = await c3.waitFor(
      (m) => m.type === "term.snapshot" && m.sid === sid,
      "fresh snapshot",
    );
    expect((fresh as { ansi: string }).ansi).toContain("MARKER_ONE");

    c3.send({ type: "session.kill", sid });
    await c3.waitFor(
      (m) => m.type === "session.state" && m.session.id === sid && m.session.status !== "running",
      "killed",
    );
    c3.close();
  }, 30000);

  it("TOFU:同 token 换公钥被拒", async () => {
    const otherKeys = generateKeyPairB64();
    const c = await TestClient.connect(deviceToken, otherKeys);
    const err = await c.waitFor((m) => m.type === "error", "auth error");
    expect((err as { code: string }).code).toBe("auth_failed");
    await c.waitClose();
  }, 20000);

  it("allowShell=false 的设备被拒 shell/custom", async () => {
    const restricted = mintDevice(home, { name: "restricted", allowShell: false });
    const keys = generateKeyPairB64();
    const c = await TestClient.connect(restricted.token, keys);
    await c.waitFor((m) => m.type === "hello.ok", "hello.ok");
    c.send({ type: "session.create", agent: "shell", cols: 80, rows: 24 });
    const err = await c.waitFor((m) => m.type === "error", "shell denied");
    expect((err as { code: string }).code).toBe("shell_not_allowed");
    c.close();
  }, 20000);

  it("非 dev 模式拒绝明文 hello", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    let closed = false;
    ws.on("close", () => {
      closed = true;
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        token: "dev-local-plaintext",
        clientPubKey: "A".repeat(43) + "=",
        clientInfo: { platform: "ios", appVersion: "x" },
      }),
    );
    const start = Date.now();
    while (!closed && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(closed).toBe(true);
  }, 20000);
});
