/**
 * daemon 集成测试:真实加密握手 + PTY 会话全链路(内存中起服务,随机端口)。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  clientHandshakeFinish,
  clientHandshakeStart,
  type SecureChannel,
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
const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "prospero-workspace-"));
mkdirSync(path.join(workspaceRoot, "Projects", "Demo"), { recursive: true });
writeFileSync(path.join(workspaceRoot, "Projects", "Demo", "README.md"), "demo\n");
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
    private readonly channel: SecureChannel,
  ) {}

  static async connect(token: string, keys: KeyPairB64): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    // v1 三帧握手:临时公钥 → daemon 临时公钥+证明 → 加密 hello
    const start = clientHandshakeStart();
    ws.send(start.frame);
    const serverFrame = await new Promise<string>((resolve, reject) => {
      ws.once("message", (raw: Buffer) => resolve(raw.toString()));
      ws.once("error", reject);
    });
    const { frame: helloFrame, channel } = clientHandshakeFinish(
      start.state,
      serverFrame,
      daemonPub,
      {
        type: "hello",
        token,
        clientPubKey: keys.publicKey,
        clientInfo: { platform: "ios", appVersion: "test" },
      },
    );
    const client = new TestClient(ws, channel);
    ws.on("message", (raw) => {
      client.queue.push(parseS2C(channel.open(raw.toString())));
    });
    ws.on("close", () => {
      client.closed = true;
    });
    ws.send(helloFrame);
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
  server = await createDaemonServer({
    home,
    port: 0,
    workspaceRoot,
    conversationSearch: async (agent, query, limit) => [{
      id: `${agent}-native-1`,
      agent,
      title: query ? `命中 ${query}` : "最近对话",
      preview: "本机原生上下文",
      cwd: path.join(workspaceRoot, "Projects", "Demo"),
      updatedAt: 123,
    }].slice(0, limit),
  });
});

afterAll(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("daemon 全链路", () => {
  it("Mac GUI 控制接口仅接受 status.json 中的本机口令", async () => {
    const info = await server.manager.create({
      agent: "custom",
      command: "sleep 30",
      cwd: home,
      cols: 80,
      rows: 24,
      allowShell: true,
    });
    const status = JSON.parse(readFileSync(path.join(home, "status.json"), "utf8")) as {
      controlToken: string;
    };
    const url = `http://127.0.0.1:${String(server.port)}/_prospero/control/session/${info.id}/kill`;

    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    const killed = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${status.controlToken}` },
    });
    expect(killed.status).toBe(204);
    expect(() => server.manager.infoOf(info.id)).toThrow(/no such session/);

    const run = server.orchestration.store.createRun({ objective: "Mac 处理 Gate" });
    const gate = server.orchestration.store.createGate({
      runId: run.id,
      question: "发布这次更新？",
      options: ["发布", "继续测试"],
    });
    const gateUrl = `http://127.0.0.1:${String(server.port)}/_prospero/control/orchestration/gate/${gate.id}/resolve`;
    expect(
      (await fetch(gateUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${status.controlToken}`, "content-type": "application/json" },
        body: JSON.stringify({ decision: "继续测试" }),
      })).status,
    ).toBe(204);
    expect(server.orchestration.store.getGate(gate.id)).toMatchObject({
      status: "resolved",
      decision: "继续测试",
    });
  });

  it("新建会话前可在用户 home 内预览并选择工作目录", async () => {
    const c = await TestClient.connect(deviceToken, deviceKeys);
    await c.waitFor((m) => m.type === "hello.ok", "hello.ok");
    c.send({ type: "workspace.list", path: "" });
    const result = await c.waitFor(
      (m) => m.type === "workspace.listing" && m.path === "",
      "workspace.listing",
    );
    const listing = result as Extract<S2CMessage, { type: "workspace.listing" }>;
    expect(listing.cwd).toBe(workspaceRoot);
    expect(listing.entries).toContainEqual(
      expect.objectContaining({ name: "Projects", kind: "dir" }),
    );

    // 手机点文件夹时会把相对路径再次发给 daemon；这个子目录往返此前没有测试，
    // 协议 dist 一旦陈旧就会在这里直接退成全局 bad_message。
    c.send({ type: "workspace.list", path: "Projects" });
    const nested = (await c.waitFor(
      (m) => m.type === "workspace.listing" && m.path === "Projects",
      "nested workspace.listing",
    )) as Extract<S2CMessage, { type: "workspace.listing" }>;
    expect(nested.cwd).toBe(path.join(workspaceRoot, "Projects"));
    expect(nested.entries).toContainEqual(
      expect.objectContaining({ name: "Demo", kind: "dir" }),
    );
    c.close();
  }, 20000);

  it("可搜索本机原生对话，并用 requestId 精确配回应答", async () => {
    const c = await TestClient.connect(deviceToken, deviceKeys);
    await c.waitFor((m) => m.type === "hello.ok", "hello.ok");
    c.send({
      type: "conversation.search",
      requestId: "resume-search-1",
      agent: "codex",
      query: "手机端",
      limit: 10,
    });
    const result = (await c.waitFor(
      (m) => m.type === "conversation.results" && m.requestId === "resume-search-1",
      "conversation.results",
    )) as Extract<S2CMessage, { type: "conversation.results" }>;
    expect(result.agent).toBe("codex");
    expect(result.conversations).toEqual([
      expect.objectContaining({
        id: "codex-native-1",
        title: "命中 手机端",
      }),
    ]);
    c.close();
  }, 20000);

  it("手机可拉取编排快照并处理人工 Gate", async () => {
    const run = server.orchestration.store.createRun({ objective: "验证手机 Goal 面板" });
    const gate = server.orchestration.store.createGate({
      runId: run.id,
      question: "是否发布？",
      options: ["发布", "继续测试"],
    });
    const c = await TestClient.connect(deviceToken, deviceKeys);
    await c.waitFor((m) => m.type === "hello.ok", "hello.ok");
    c.send({ type: "orchestration.snapshot" });
    const initial = (await c.waitFor(
      (m) => m.type === "orchestration.snapshot",
      "orchestration.snapshot",
    )) as Extract<S2CMessage, { type: "orchestration.snapshot" }>;
    expect(initial.snapshot.runs).toContainEqual(expect.objectContaining({ id: run.id }));
    expect(initial.snapshot.gates).toContainEqual(expect.objectContaining({ id: gate.id, status: "pending" }));

    c.send({ type: "orchestration.gate.resolve", gateId: gate.id, decision: "继续测试" });
    const resolved = (await c.waitFor(
      (m) =>
        m.type === "orchestration.snapshot" &&
        m.snapshot.gates.some((candidate) => candidate.id === gate.id && candidate.status === "resolved"),
      "resolved orchestration.snapshot",
    )) as Extract<S2CMessage, { type: "orchestration.snapshot" }>;
    expect(resolved.snapshot.gates.find((candidate) => candidate.id === gate.id)?.decision).toBe("继续测试");
    c.close();
  }, 20000);

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
  it("hello.ok 带上机器信息 —— 手机上要能看到那台 Mac 的状态", async () => {
    // 主机页的概览卡全靠这一帧。字段是 optional 的,漏发不会报错、只会静默空着,
    // 所以这里逐个断言"确实发了",而不是断言"能解析"
    const c = await TestClient.connect(deviceToken, deviceKeys);
    const ok = await c.waitFor((m) => m.type === "hello.ok", "hello.ok");
    const info = (ok as Extract<S2CMessage, { type: "hello.ok" }>).host;
    // 发的是人能读的名字,不是 process.platform —— 手机上"darwin 25.5.0"没人认
    expect(info.platform).not.toBe(process.platform);
    if (process.platform === "darwin") expect(info.platform).toBe("macOS");
    expect(info.cpus).toBeGreaterThan(0);
    expect(info.memTotal).toBeGreaterThan(0);
    expect(info.memFree).toBeGreaterThan(0);
    expect(info.uptimeSec).toBeGreaterThan(0);
    expect(info.loadAvg).toHaveLength(3);
    expect(info.daemonStartedAt).toBeGreaterThan(0);
    expect(typeof info.tmuxManaged).toBe("boolean");
    c.close();
  }, 20000);

  it("usage.get 不带 sid 也要有应答 —— 限流是账号级的", async () => {
    // 主机页在进任何会话之前就要显示额度。以前 sid 是必填,导致"想看用量
    // 得先随便开一个会话",而开会话本身就在烧额度。
    const c = await TestClient.connect(deviceToken, deviceKeys);
    await c.waitFor((m) => m.type === "hello.ok", "hello.ok");
    c.send({ type: "usage.get" });
    const r = await c.waitFor((m) => m.type === "usage.result", "usage.result");
    const u = r as Extract<S2CMessage, { type: "usage.result" }>;
    // 一个结构化会话都没有时,答"没有可用数据"而不是报错关连接
    expect(u.available).toBe(false);
    expect(u.sid).toBeUndefined();
    expect(typeof u.reason).toBe("string");
    // accounts 一定要在(哪怕是空数组):手机按它渲染订阅列表,
    // 缺字段和"没有订阅"在 UI 上是两种东西
    expect(u.accounts).toEqual([]);
    c.close();
  }, 20000);
});
