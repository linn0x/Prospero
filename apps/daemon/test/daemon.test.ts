/**
 * daemon 集成测试:真实加密握手 + PTY 会话全链路(内存中起服务,随机端口)。
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const smokeCommand = process.platform === "win32"
  ? "echo PROSPERO_SMOKE && ping -n 2 127.0.0.1 >NUL"
  : "printf 'PROSPERO_SMOKE\\n'; sleep 0.2";
const markerCommand = process.platform === "win32"
  ? "echo MARKER_ONE && ping -n 31 127.0.0.1 >NUL"
  : "printf 'MARKER_ONE\\n'; sleep 30";
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

  static async connect(token: string, keys: KeyPairB64, protocolVersion?: number): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    // v1 三帧握手:临时公钥 → daemon 临时公钥+证明 → 加密 hello
    const start = clientHandshakeStart(protocolVersion);
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
  it("expires stalled handshakes and caps unauthenticated sockets", async () => {
    const isolatedHome = mkdtempSync(path.join(os.tmpdir(), "prospero-auth-limit-"));
    const isolated = await createDaemonServer({
      home: isolatedHome,
      port: 0,
      workspaceRoot: isolatedHome,
      structuredSupervisor: false,
      ptySupervisor: false,
      handshakeTimeoutMs: 200,
      maxUnauthenticatedConnections: 1,
    });
    try {
      const first = new WebSocket(`ws://127.0.0.1:${String(isolated.port)}/ws`);
      const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()));
      await new Promise<void>((resolve, reject) => {
        first.once("open", () => resolve());
        first.once("error", reject);
      });
      const second = new WebSocket(`ws://127.0.0.1:${String(isolated.port)}/ws`);
      second.on("error", () => undefined);
      const secondClosed = new Promise<void>((resolve) => second.once("close", () => resolve()));
      await expect(Promise.race([
        secondClosed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150)),
      ])).resolves.toBe(true);
      await expect(Promise.race([
        firstClosed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ])).resolves.toBe(true);
    } finally {
      await isolated.close();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  it("Mac 账号控制接口复用协议、鉴权并且不回显凭据", async () => {
    const status = JSON.parse(readFileSync(path.join(home, "status.json"), "utf8")) as {
      controlToken: string;
    };
    const endpoint = `http://127.0.0.1:${String(server.port)}/_prospero/control/accounts`;
    const request = async (body: Record<string, unknown>, authenticated = true): Promise<Response> =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { authorization: `Bearer ${status.controlToken}` } : {}),
        },
        body: JSON.stringify({ ...body, requestId: "mac-account-test" }),
      });

    expect((await request({ type: "agent.accounts.list" }, false)).status).toBe(401);
    expect((await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer wrong-control-token", "content-type": "application/json" },
      body: JSON.stringify({ type: "agent.accounts.list", requestId: "wrong-token" }),
    })).status).toBe(401);
    expect((await request({
      type: "session.create", agent: "shell", kind: "pty", cwd: home, cols: 80, rows: 24,
    })).status).toBe(400);
    expect((await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${status.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "agent.accounts.list", requestId: "x", padding: "x".repeat(25 * 1024) }),
    })).status).toBe(413);

    const created = await request({
      type: "agent.account.create", agent: "claude", name: "Mac 独立 Claude",
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { accounts: Array<{ id: string; name: string }> };
    const claude = createdBody.accounts.find((account) => account.name === "Mac 独立 Claude")!;
    expect(claude.id).toBeTruthy();

    const credential = "oauth-token-that-must-not-leak-from-http-response";
    const credentialResponse = await request({
      type: "agent.account.credential.set",
      accountId: claude.id,
      credentialKind: "oauth_token",
      credential,
    });
    const credentialText = await credentialResponse.text();
    expect(credentialResponse.status).toBe(200);
    expect(credentialText).not.toContain(credential);
    expect(readFileSync(path.join(home, "agent-accounts.json"), "utf8")).not.toContain(credential);

    const apiKey = "api-key-that-must-not-leak-from-http-response";
    const apiResponse = await request({
      type: "agent.account.api.create",
      agent: "codex",
      name: "Mac API Profile",
      baseUrl: "https://gateway.example.test/v1",
      model: "test-model",
      apiKey,
    });
    const apiText = await apiResponse.text();
    expect(apiResponse.status).toBe(200);
    expect(apiText).not.toContain(apiKey);
    const apiBody = JSON.parse(apiText) as { accounts: Array<{ id: string; name: string; apiProfile?: unknown }> };
    const api = apiBody.accounts.find((account) => account.name === "Mac API Profile")!;
    expect(api.apiProfile).toBeDefined();
    expect(readFileSync(path.join(home, "agent-accounts.json"), "utf8")).not.toContain(apiKey);

    const renamed = await request({
      type: "agent.account.rename", accountId: api.id, name: "重命名 API Profile",
    });
    expect(renamed.status).toBe(200);
    expect((await request({ type: "agent.account.default", accountId: api.id })).status).toBe(200);
    const configured = await request({
      type: "agent.account.api.configure",
      accountId: api.id,
      baseUrl: "https://gateway.example.test/v2",
      model: "test-model-2",
      apiKey: "replacement-api-key-that-must-not-leak",
    });
    expect(configured.status).toBe(200);
    expect((await request({ type: "agent.account.logout", accountId: api.id })).status).toBe(200);
    expect((await request({ type: "agent.account.delete", accountId: api.id })).status).toBe(200);
    expect((await request({ type: "agent.account.logout", accountId: claude.id })).status).toBe(200);
    expect((await request({ type: "agent.account.delete", accountId: claude.id })).status).toBe(200);

    // Never invoke the developer's real Codex login during regression tests.
    // The endpoint must still create a PTY and return its LocalSessionWorkspace id.
    if (process.platform !== "win32") {
      const fakeBin = mkdtempSync(path.join(os.tmpdir(), "prospero-fake-agent-"));
      const fakeCodex = path.join(fakeBin, "codex");
      writeFileSync(fakeCodex, "#!/bin/sh\nif [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo 'Logged in using Test'; exit 0; fi\nif [ \"$1\" = \"--version\" ]; then echo test; exit 0; fi\necho LOGIN_SESSION\nsleep 30\n");
      chmodSync(fakeCodex, 0o755);
      const oldPath = process.env.PATH;
      process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ""}`;
      try {
        const login = await request({
          type: "agent.account.login", accountId: "native-codex", cols: 80, rows: 24,
        });
        expect(login.status).toBe(200);
        const result = await login.json() as { sessionId?: string };
        expect(result.sessionId).toBeTruthy();
        await server.manager.kill(result.sessionId!);
      } finally {
        process.env.PATH = oldPath;
        rmSync(fakeBin, { recursive: true, force: true });
      }
    }
  }, 15_000);

  it("Mac GUI 控制接口仅接受 status.json 中的本机口令", async () => {
    const status = JSON.parse(readFileSync(path.join(home, "status.json"), "utf8")) as {
      controlToken: string;
    };
    const createUrl = `http://127.0.0.1:${String(server.port)}/_prospero/control/session/create`;
    const createBody = JSON.stringify({
      agent: "shell",
      kind: "pty",
      cwd: home,
      cols: 90,
      rows: 30,
    });
    expect((await fetch(createUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: createBody,
    })).status).toBe(401);
    const createdResponse = await fetch(createUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${status.controlToken}`,
        "content-type": "application/json",
      },
      body: createBody,
    });
    expect(createdResponse.status).toBe(201);
    const info = await createdResponse.json() as { id: string; agent: string; kind: string; cwd: string };
    expect(info).toMatchObject({ agent: "shell", kind: "pty", cwd: home });
    expect(server.manager.infoOf(info.id)).toMatchObject({ agent: "shell", kind: "pty" });

    const sessionViewUrl =
      `http://127.0.0.1:${String(server.port)}/_prospero/control/session/${info.id}/view`;
    expect((await fetch(sessionViewUrl)).status).toBe(401);
    const initialView = await fetch(sessionViewUrl, {
      headers: { authorization: `Bearer ${status.controlToken}` },
    });
    expect(initialView.status).toBe(200);
    expect(await initialView.json()).toMatchObject({ kind: "pty" });
    expect((await fetch(`${sessionViewUrl}?knownSeq=nope`, {
      headers: { authorization: `Bearer ${status.controlToken}` },
    })).status).toBe(400);

    const interactUrl =
      `http://127.0.0.1:${String(server.port)}/_prospero/control/session/${info.id}/interact`;
    const inputBody = JSON.stringify({
      type: "term.input",
      dataB64: Buffer.from("printf 'MAC_APP_INPUT_OK\\n'\\n").toString("base64"),
    });
    expect((await fetch(interactUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: inputBody,
    })).status).toBe(401);
    expect((await fetch(interactUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${status.controlToken}`,
        "content-type": "application/json",
      },
      body: inputBody,
    })).status).toBe(204);
    let terminalText = "";
    for (let attempt = 0; attempt < 80 && !terminalText.includes("MAC_APP_INPUT_OK"); attempt++) {
      const response = await fetch(sessionViewUrl, {
        headers: { authorization: `Bearer ${status.controlToken}` },
      });
      const view = await response.json() as { ansi: string };
      terminalText = view.ansi;
      if (!terminalText.includes("MAC_APP_INPUT_OK")) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(terminalText).toContain("MAC_APP_INPUT_OK");

    const childEventsUrl =
      `http://127.0.0.1:${String(server.port)}/_prospero/control/session/${info.id}/subagent/child/events`;
    expect((await fetch(childEventsUrl)).status).toBe(401);
    // 子 Agent 过程接口只接受结构化会话；PTY 不会被误当成空对话。
    expect((await fetch(childEventsUrl, {
      headers: { authorization: `Bearer ${status.controlToken}` },
    })).status).toBe(409);

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

    const actionUrl = `http://127.0.0.1:${String(server.port)}/_prospero/control/orchestration/action`;
    const createdRunResponse = await fetch(actionUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${status.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        method: "run.create",
        params: { objective: "Mac 手工编排" },
      }),
    });
    expect(createdRunResponse.status).toBe(200);
    const createdRun = await createdRunResponse.json() as { id: string; coordinatorSessionId: string | null };
    expect(createdRun.coordinatorSessionId).toBeNull();

    const createdTaskResponse = await fetch(actionUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${status.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        method: "task.create",
        params: {
          runId: createdRun.id,
          title: "Mac 创建任务",
          spec: "验证本机控制 token 保护的写入",
          deps: [],
        },
      }),
    });
    expect(createdTaskResponse.status).toBe(200);
    expect(server.orchestration.store.listTasks(createdRun.id)).toContainEqual(
      expect.objectContaining({ title: "Mac 创建任务", status: "pending" }),
    );
    const createdTask = server.orchestration.store.listTasks(createdRun.id)[0]!;
    const taskDetailUrl = `http://127.0.0.1:${String(server.port)}/_prospero/control/orchestration/task/${createdTask.id}`;
    expect((await fetch(taskDetailUrl)).status).toBe(401);
    const taskDetailResponse = await fetch(taskDetailUrl, {
      headers: { authorization: `Bearer ${status.controlToken}` },
    });
    expect(taskDetailResponse.status).toBe(200);
    expect(await taskDetailResponse.json()).toMatchObject({
      id: createdTask.id,
      spec: "验证本机控制 token 保护的写入",
    });
    const runTasksResponse = await fetch(
      `http://127.0.0.1:${String(server.port)}/_prospero/control/orchestration/run/${createdRun.id}/tasks`,
      { headers: { authorization: `Bearer ${status.controlToken}` } },
    );
    expect(runTasksResponse.status).toBe(200);
    const runTasksBody = await runTasksResponse.json() as { items: Array<Record<string, unknown>> };
    expect(runTasksBody).toMatchObject({
      items: [expect.objectContaining({ id: createdTask.id })],
    });
    expect(runTasksBody.items[0]).not.toHaveProperty("result");

    // PTY worker.create 最初返回的是 starting；worker.start 会等待首帧/quiet
    // window 后再写 prompt，HTTP 响应必须重新读取同一 sid 的实时状态，不能把
    // create() 的陈旧快照带回 macOS GUI（这在 Ubuntu/Windows CI 都出现过）。
    const startedWorkerResponse = await fetch(actionUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${status.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        method: "worker.start",
        params: {
          taskId: server.orchestration.store.listTasks(createdRun.id).find(
            (candidate) => candidate.title === "Mac 创建任务",
          )!.id,
          agent: "shell",
          kind: "pty",
          worktree: "none",
          cwd: workspaceRoot,
          approvalPolicy: "standard",
        },
      }),
    });
    expect(startedWorkerResponse.status).toBe(200);
    const startedWorker = await startedWorkerResponse.json() as {
      dispatch: { state: string };
      session: { id: string; kind: string; status: string };
    };
    expect(startedWorker.dispatch.state).toBe("running");
    expect(startedWorker.session).toMatchObject({ kind: "pty", status: "running" });
    await server.manager.kill(startedWorker.session.id);

    const graphRequest = {
      method: "graph.create",
      params: {
        operationId: "mac-graph-create",
        objective: "Mac 可视化编排",
        nodes: [
          { clientId: "design", title: "设计", spec: "定协议", deps: [] },
          { clientId: "ship", title: "发布", spec: "联合验收", deps: ["design"] },
        ],
      },
    };
    const graphResponse = await fetch(actionUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${status.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify(graphRequest),
    });
    expect(graphResponse.status).toBe(200);
    const graph = await graphResponse.json() as { run: { id: string; graphRevision: number } };
    expect(graph.run.graphRevision).toBe(1);
    const graphRetry = await fetch(actionUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${status.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify(graphRequest),
    });
    expect((await graphRetry.json() as { run: { id: string } }).run.id).toBe(graph.run.id);
    expect(server.orchestration.store.listRuns().filter(
      (candidate) => candidate.objective === "Mac 可视化编排",
    )).toHaveLength(1);
  });

  it("Mac GUI 可按需分页读取本机会话历史，而非读取全量 status.json", async () => {
    const status = JSON.parse(readFileSync(path.join(home, "status.json"), "utf8")) as {
      controlToken: string;
    };
    const endpoint = `http://127.0.0.1:${String(server.port)}/_prospero/control/sessions?limit=1`;
    expect((await fetch(endpoint)).status).toBe(401);
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${status.controlToken}` },
    });
    expect(response.status).toBe(200);
    const page = await response.json() as {
      items: Array<{ id: string }>;
      nextCursor?: string;
      total: number;
      active: number;
      terminal: number;
    };
    expect(page.items.length).toBeLessThanOrEqual(1);
    expect(page.total).toBeGreaterThanOrEqual(page.items.length);
    expect(page.active + page.terminal).toBeGreaterThanOrEqual(page.total);
    if (page.nextCursor) {
      const next = await fetch(`${endpoint}&cursor=${encodeURIComponent(page.nextCursor)}`, {
        headers: { authorization: `Bearer ${status.controlToken}` },
      });
      expect(next.status).toBe(200);
    }
    const baseEndpoint = `http://127.0.0.1:${String(server.port)}/_prospero/control/sessions`;
    expect((await fetch(`${baseEndpoint}?limit=101`, {
      headers: { authorization: `Bearer ${status.controlToken}` },
    })).status).toBe(400);
    expect((await fetch(`${baseEndpoint}?terminal=false`, {
      headers: { authorization: `Bearer ${status.controlToken}` },
    })).status).toBe(400);
    expect((await fetch(`${baseEndpoint}?id=bad%20id`, {
      headers: { authorization: `Bearer ${status.controlToken}` },
    })).status).toBe(400);
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

    c.send({ type: "workspace.list", root: "home", path: "Projects", mkdir: "CreatedOnPhone" });
    const created = (await c.waitFor(
      (m) => m.type === "workspace.listing" && m.path === "Projects" && m.root === "home",
      "workspace mkdir listing",
    )) as Extract<S2CMessage, { type: "workspace.listing" }>;
    expect(created.entries).toContainEqual(
      expect.objectContaining({ name: "CreatedOnPhone", kind: "dir" }),
    );

    if (process.platform === "win32") {
      c.send({ type: "workspace.list", root: "computer", path: "" });
      const computer = (await c.waitFor(
        (m) => m.type === "workspace.listing" && m.root === "computer",
        "workspace computer roots",
      )) as Extract<S2CMessage, { type: "workspace.listing" }>;
      expect(computer.cwd).toBe("");
      expect(computer.entries).toContainEqual(
        expect.objectContaining({ name: "C:", kind: "dir" }),
      );
    }
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

  it("已授权手机可管理 Code Agent 账号元数据", async () => {
    const c = await TestClient.connect(deviceToken, deviceKeys);
    const hello = (await c.waitFor(
      (m) => m.type === "hello.ok",
      "hello.ok",
    )) as Extract<S2CMessage, { type: "hello.ok" }>;
    expect(hello.host.capabilities).toContain("agent.accounts.v1");
    expect(hello.host.capabilities).toContain("agent.api-protocols.v1");
    expect(hello.host.capabilities).toContain("agent.deepseek-harness.v1");
    expect(hello.host.capabilities).toContain("agent.deepseek-trajectory.v1");

    c.send({ type: "agent.accounts.list", requestId: "accounts-list" });
    const initial = (await c.waitFor(
      (m) => m.type === "agent.accounts.result" && m.requestId === "accounts-list",
      "initial accounts",
      20_000,
    )) as Extract<S2CMessage, { type: "agent.accounts.result" }>;
    expect(initial.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "native-codex", managed: false }),
      expect.objectContaining({ id: "native-claude", managed: false }),
    ]));

    c.send({
      type: "agent.account.create",
      requestId: "accounts-create",
      agent: "codex",
      name: "集成测试 Codex",
    });
    const created = (await c.waitFor(
      (m) => m.type === "agent.accounts.result" && m.requestId === "accounts-create",
      "created account",
      20_000,
    )) as Extract<S2CMessage, { type: "agent.accounts.result" }>;
    const account = created.accounts.find((candidate) => candidate.name === "集成测试 Codex");
    expect(account).toMatchObject({ agent: "codex", managed: true });
    expect(created.accountId).toBe(account!.id);

    c.send({
      type: "agent.account.rename",
      requestId: "accounts-rename",
      accountId: account!.id,
      name: "发布 Codex",
    });
    const renamed = (await c.waitFor(
      (m) => m.type === "agent.accounts.result" && m.requestId === "accounts-rename",
      "renamed account",
      20_000,
    )) as Extract<S2CMessage, { type: "agent.accounts.result" }>;
    expect(renamed.accounts).toContainEqual(expect.objectContaining({ id: account!.id, name: "发布 Codex" }));

    c.send({
      type: "agent.account.api.create",
      requestId: "accounts-chat-create",
      agent: "codex",
      name: "Chat API",
      provider: "openai_compatible",
      protocol: "openai_chat_completions",
      baseUrl: "https://chat.example.com/v1/chat/completions",
      model: "chat-coder",
      apiKey: "test-key",
    });
    const chatCreated = (await c.waitFor(
      (m) => m.type === "agent.accounts.result" && m.requestId === "accounts-chat-create",
      "created chat profile",
      20_000,
    )) as Extract<S2CMessage, { type: "agent.accounts.result" }>;
    const chat = chatCreated.accounts.find((candidate) => candidate.name === "Chat API")!;
    expect(chatCreated.accountId).toBe(chat.id);
    expect(chat.apiProfile).toMatchObject({ protocol: "openai_chat_completions", baseUrl: "https://chat.example.com/v1" });
    c.send({
      type: "conversation.search",
      requestId: "chat-history",
      agent: "codex",
      accountId: chat.id,
      query: "",
    });
    const chatHistory = (await c.waitFor(
      (m) => m.type === "conversation.results" && m.requestId === "chat-history",
      "chat profile history rejection",
    )) as Extract<S2CMessage, { type: "conversation.results" }>;
    expect(chatHistory.conversations).toEqual([]);
    expect(chatHistory.error).toMatch(/暂不支持/);
    c.close();
  }, 30000);

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

  it("已授权手机可手工创建 Run 与依赖任务", async () => {
    const c = await TestClient.connect(deviceToken, deviceKeys);
    const hello = (await c.waitFor(
      (m) => m.type === "hello.ok",
      "hello.ok",
    )) as Extract<S2CMessage, { type: "hello.ok" }>;
    expect(hello.host.capabilities).toContain("orchestration.manual.v1");
    expect(hello.host.capabilities).toContain("orchestration.graph.v1");
    expect(hello.host.capabilities).toContain("orchestration.automation.v1");
    expect(hello.host.capabilities).toContain("orchestration.management.v1");
    expect(hello.host.capabilities).toContain("orchestration.lifecycle.v1");
    expect(hello.host.capabilities).toContain("orchestration.run-lifecycle.v1");
    expect(hello.host.capabilities).toContain("subagent.history.v1");
    expect(hello.host.capabilities).toContain("agent.accounts.v1");
    expect(hello.host.capabilities).toContain("chat.attachment-previews.v1");
    expect(hello.host.capabilities).toContain("session.create-model.v1");

    const objective = `手工编排-${String(Date.now())}`;
    c.send({ type: "orchestration.run.create", objective });
    const withRun = (await c.waitFor(
      (m) => m.type === "orchestration.snapshot" &&
        m.snapshot.runs.some((run) => run.objective === objective),
      "manual run snapshot",
    )) as Extract<S2CMessage, { type: "orchestration.snapshot" }>;
    const run = withRun.snapshot.runs.find((candidate) => candidate.objective === objective)!;
    expect(run.coordinatorSessionId).toBeNull();

    c.send({
      type: "orchestration.task.create",
      runId: run.id,
      title: "实现兼容握手",
      spec: "支持 v9/v8/v7/v5 并补测试",
    });
    const withTask = (await c.waitFor(
      (m) => m.type === "orchestration.snapshot" &&
        m.snapshot.tasks.some((task) => task.runId === run.id && task.title === "实现兼容握手"),
      "manual task snapshot",
    )) as Extract<S2CMessage, { type: "orchestration.snapshot" }>;
    expect(withTask.snapshot.tasks).toContainEqual(expect.objectContaining({
      runId: run.id,
      status: "pending",
    }));
    const task = withTask.snapshot.tasks.find(
      (candidate) => candidate.runId === run.id && candidate.title === "实现兼容握手",
    )!;
    c.send({
      type: "orchestration.worker.start",
      taskId: task.id,
      agent: "shell",
      kind: "pty",
      worktree: "none",
      cwd: workspaceRoot,
      approvalPolicy: "standard",
    });
    const dispatched = (await c.waitFor(
      (m) => m.type === "orchestration.snapshot" &&
        m.snapshot.dispatches.some(
          (candidate) => candidate.taskId === task.id && candidate.state === "running",
        ),
      "manual worker snapshot",
    )) as Extract<S2CMessage, { type: "orchestration.snapshot" }>;
    const dispatch = dispatched.snapshot.dispatches.find((candidate) => candidate.taskId === task.id)!;
    expect(dispatch.state).toBe("running");
    expect(dispatched.snapshot.tasks).toContainEqual(expect.objectContaining({
      id: task.id,
      status: "dispatched",
    }));
    await server.manager.kill(dispatch.sessionId);
    const stopped = (await c.waitFor(
      (m) => m.type === "orchestration.snapshot" &&
        m.snapshot.tasks.some((candidate) => candidate.id === task.id && candidate.status === "failed") &&
        m.snapshot.dispatches.some((candidate) => candidate.id === dispatch.id && candidate.state === "abandoned"),
      "ended worker orchestration snapshot",
    )) as Extract<S2CMessage, { type: "orchestration.snapshot" }>;
    expect(stopped.snapshot.tasks.find((candidate) => candidate.id === task.id)?.result)
      .toMatch(/退出|未显式交付/);

    c.send({
      type: "orchestration.task.retry",
      taskId: task.id,
      operationId: `retry-${String(Date.now())}`,
    });
    await expect(c.waitFor(
      (m) => m.type === "orchestration.snapshot" &&
        m.snapshot.tasks.some((candidate) => candidate.id === task.id && candidate.status === "pending"),
      "retried task snapshot",
    )).resolves.toMatchObject({ type: "orchestration.snapshot" });

    c.send({
      type: "orchestration.task.cancel",
      taskId: task.id,
      reason: "集成测试取消",
      operationId: `cancel-${String(Date.now())}`,
    });
    await expect(c.waitFor(
      (m) => m.type === "orchestration.snapshot" &&
        m.snapshot.tasks.some((candidate) => candidate.id === task.id && candidate.status === "cancelled"),
      "cancelled task snapshot",
    )).resolves.toMatchObject({ type: "orchestration.snapshot" });

    c.send({
      type: "orchestration.run.complete",
      runId: run.id,
      operationId: `complete-${String(Date.now())}`,
    });
    await expect(c.waitFor(
      (m) => m.type === "orchestration.snapshot" &&
        m.snapshot.runs.some((candidate) =>
          candidate.id === run.id && candidate.status === "completed"),
      "completed run snapshot",
    )).resolves.toMatchObject({ type: "orchestration.snapshot" });

    c.send({
      type: "orchestration.task.create",
      runId: run.id,
      title: "不应创建",
      spec: "历史只读",
    });
    await expect(c.waitFor(
      (m) => m.type === "error" && m.message.includes("历史编排只读"),
      "completed run is read-only",
    )).resolves.toMatchObject({ type: "error" });
    c.close();
  }, 20000);

  it("Store 变更会实时推送，手机也可放弃 Run", async () => {
    const c = await TestClient.connect(deviceToken, deviceKeys);
    await c.waitFor((m) => m.type === "hello.ok", "hello.ok");
    const objective = `实时推送-${String(Date.now())}`;
    const run = server.orchestration.store.createRun({ objective });
    await expect(c.waitFor(
      (m) => m.type === "orchestration.snapshot" &&
        m.snapshot.runs.some((candidate) => candidate.id === run.id),
      "store change snapshot",
    )).resolves.toMatchObject({ type: "orchestration.snapshot" });

    c.send({
      type: "orchestration.run.abandon",
      runId: run.id,
      operationId: `abandon-${String(Date.now())}`,
    });
    await expect(c.waitFor(
      (m) => m.type === "orchestration.snapshot" &&
        m.snapshot.runs.some((candidate) =>
          candidate.id === run.id && candidate.status === "abandoned"),
      "abandoned run snapshot",
    )).resolves.toMatchObject({ type: "orchestration.snapshot" });
    c.close();
  }, 20000);

  it("手机可原子发布可视化 DAG，重试不重复创建，过期 revision 返回冲突", async () => {
    const c = await TestClient.connect(deviceToken, deviceKeys);
    await c.waitFor((m) => m.type === "hello.ok", "hello.ok");
    const objective = `可视化 DAG-${String(Date.now())}`;
    const create = {
      type: "orchestration.graph.create",
      operationId: `graph-${String(Date.now())}`,
      objective,
      nodes: [
        { clientId: "design", title: "设计", spec: "确定协议", deps: [] },
        { clientId: "mac", title: "Mac", spec: "实现 Mac", deps: ["design"] },
        { clientId: "ios", title: "iOS", spec: "实现 iOS", deps: ["design"] },
      ],
    } as const;
    c.send(create);
    const published = (await c.waitFor(
      (m) => m.type === "orchestration.snapshot" &&
        m.snapshot.runs.some((run) => run.objective === objective),
      "graph create snapshot",
    )) as Extract<S2CMessage, { type: "orchestration.snapshot" }>;
    const run = published.snapshot.runs.find((candidate) => candidate.objective === objective)!;
    expect(run.graphRevision).toBe(1);
    expect(published.snapshot.tasks.filter((task) => task.runId === run.id)).toHaveLength(3);

    c.send(create);
    const retried = (await c.waitFor(
      (m) => m.type === "orchestration.snapshot" &&
        m.snapshot.runs.some((candidate) => candidate.id === run.id),
      "graph retry snapshot",
    )) as Extract<S2CMessage, { type: "orchestration.snapshot" }>;
    expect(retried.snapshot.runs.filter((candidate) => candidate.objective === objective)).toHaveLength(1);

    const design = retried.snapshot.tasks.find(
      (task) => task.runId === run.id && task.title === "设计",
    )!;
    c.send({
      type: "orchestration.graph.apply",
      operationId: `stale-${String(Date.now())}`,
      runId: run.id,
      baseRevision: 0,
      nodes: [{ clientId: design.id, title: "不应覆盖", spec: "过期", deps: [] }],
    });
    await expect(c.waitFor(
      (m) => m.type === "error" && m.code === "conflict",
      "stale graph conflict",
    )).resolves.toMatchObject({ code: "conflict" });
    expect(server.orchestration.store.getTask(design.id).title).toBe("设计");

    const ios = retried.snapshot.tasks.find(
      (task) => task.runId === run.id && task.title === "iOS",
    )!;
    c.send({
      type: "orchestration.graph.apply",
      operationId: `delete-node-${String(Date.now())}`,
      runId: run.id,
      baseRevision: 1,
      nodes: [],
      deleteTaskIds: [ios.id],
    });
    await expect(c.waitFor(
      (m) => m.type === "orchestration.snapshot" &&
        !m.snapshot.tasks.some((task) => task.id === ios.id),
      "deleted graph node snapshot",
    )).resolves.toMatchObject({ type: "orchestration.snapshot" });

    c.send({
      type: "orchestration.run.delete",
      operationId: `delete-run-${String(Date.now())}`,
      runId: run.id,
    });
    await expect(c.waitFor(
      (m) => m.type === "orchestration.snapshot" &&
        !m.snapshot.runs.some((candidate) => candidate.id === run.id),
      "deleted run snapshot",
    )).resolves.toMatchObject({ type: "orchestration.snapshot" });
    c.close();
  }, 20000);

  it("v15 与旧 v14/v13/v12/v8/v7/v5 客户端沿用原配对即可连接新 daemon", async () => {
    for (const version of [15, 14, 13, 12, 8, 7, 5]) {
      const c = await TestClient.connect(deviceToken, deviceKeys, version);
      const hello = (await c.waitFor(
        (m) => m.type === "hello.ok",
        `legacy v${String(version)} hello.ok`,
      )) as Extract<S2CMessage, { type: "hello.ok" }>;
      expect(hello.host.negotiatedProtocolVersion).toBe(version);
      if (version >= 15) expect(hello.host.capabilities).toContain("fs.put-ack.v1");
      else expect(hello.host.capabilities).not.toContain("fs.put-ack.v1");
      expect(hello.host.capabilities).not.toContain("agent.api-protocols.v1");
      if (version < 14) expect(hello.host.capabilities).not.toContain("agent.deepseek-trajectory.v1");
      if (version < 9) expect(hello.host.capabilities).not.toContain("subagent.history.v1");
      if (version < 11) {
        expect(hello.host.capabilities).not.toContain("chat.attachment-previews.v1");
        expect(hello.host.capabilities).not.toContain("session.create-model.v1");
      }
      if (version < 8) {
        expect(hello.host.capabilities).not.toContain("orchestration.graph.v1");
        expect(hello.host.capabilities).not.toContain("orchestration.automation.v1");
        expect(hello.host.capabilities).not.toContain("orchestration.management.v1");
        expect(hello.host.capabilities).not.toContain("orchestration.lifecycle.v1");
        expect(hello.host.capabilities).not.toContain("orchestration.run-lifecycle.v1");
      }
      c.close();
    }
    const v15 = await TestClient.connect(deviceToken, deviceKeys, 15);
    await v15.waitFor((message) => message.type === "hello.ok", "v15 hello.ok");
    v15.send({
      type: "agent.account.api.create",
      requestId: "v15-new-api-fields",
      agent: "codex",
      name: "must reject",
      provider: "openai_compatible",
      protocol: "openai_chat_completions",
      baseUrl: "https://chat.example.com/v1",
      model: "chat-coder",
      apiKey: "test-key",
    });
    await expect(v15.waitFor(
      (message) => message.type === "error" && message.code === "bad_message",
      "v15 API protocol rejection",
    )).resolves.toMatchObject({ message: expect.stringMatching(/不支持/) });
    v15.send({
      type: "agent.account.api.configure",
      requestId: "v15-empty-key",
      accountId: "not-used",
      baseUrl: "https://gateway.example.com/v1",
      model: "model",
      apiKey: "",
    });
    await expect(v15.waitFor(
      (message) => message.type === "error" && message.code === "bad_message",
      "v15 empty API key rejection",
    )).resolves.toMatchObject({ message: expect.stringMatching(/不支持/) });
    v15.close();
  }, 20000);

  it("握手 → hello.ok → 创建会话 → 输出 → 正常结束", async () => {
    const c = await TestClient.connect(deviceToken, deviceKeys);
    await c.waitFor((m) => m.type === "hello.ok", "hello.ok");
    c.send({
      type: "session.create",
      agent: "custom",
      command: smokeCommand,
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

  it("按网络帧顺序写入并确认每个上传分块", async () => {
    const c = await TestClient.connect(deviceToken, deviceKeys);
    const hello = await c.waitFor((m) => m.type === "hello.ok", "hello.ok") as Extract<
      S2CMessage,
      { type: "hello.ok" }
    >;
    expect(hello.host.capabilities).toContain("fs.put-ack.v1");
    c.send({
      type: "session.create",
      agent: "custom",
      command: markerCommand,
      cwd: workspaceRoot,
      cols: 80,
      rows: 24,
    });
    const snapshot = await c.waitFor((m) => m.type === "term.snapshot", "snapshot");
    const sid = (snapshot as { sid: string }).sid;
    const payload = Buffer.allocUnsafe(256 * 1024 * 8 + 17);
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31 + 7) % 256;
    const file = `ordered-upload-${String(Date.now())}.bin`;
    const chunkSize = 256 * 1024;

    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      const chunk = payload.subarray(offset, Math.min(offset + chunkSize, payload.length));
      c.send({
        type: "fs.put",
        sid,
        path: file,
        offset,
        dataB64: chunk.toString("base64"),
        final: offset + chunk.length === payload.length,
      });
    }

    await c.waitFor(
      (message) => message.type === "fs.written" && message.path === file && message.size === payload.length,
      "final fs.written",
    );
    expect(readFileSync(path.join(workspaceRoot, file))).toEqual(payload);
    c.send({ type: "session.kill", sid });
    await c.waitFor(
      (message) => message.type === "session.state" && message.session.id === sid && message.session.status !== "running",
      "killed",
    );
    c.close();
  }, 30000);

  it("快照完成前不提前 catch-up 且在快照后补齐增量", async () => {
    const owner = await TestClient.connect(deviceToken, deviceKeys);
    await owner.waitFor((m) => m.type === "hello.ok", "owner hello.ok");
    owner.send({
      type: "session.create",
      agent: "custom",
      command: markerCommand,
      cols: 80,
      rows: 24,
    });
    const initial = await owner.waitFor((m) => m.type === "term.snapshot", "initial snapshot");
    const sid = (initial as { sid: string }).sid;
    await owner.collectText(sid, "MARKER_ONE");
    const terminal = server.manager.requirePty(sid);
    const originalSnapshot = terminal.snapshot.bind(terminal);
    let startSnapshot!: () => void;
    let resolveSnapshot!: (value: Awaited<ReturnType<typeof terminal.snapshot>>) => void;
    const started = new Promise<void>((resolve) => { startSnapshot = resolve; });
    const pendingSnapshot = new Promise<Awaited<ReturnType<typeof terminal.snapshot>>>((resolve) => {
      resolveSnapshot = resolve;
    });
    let baseline = terminal.ring.lastSeq;
    terminal.snapshot = () => {
      baseline = terminal.ring.lastSeq;
      startSnapshot();
      return pendingSnapshot;
    };
    const viewer = await TestClient.connect(deviceToken, deviceKeys);

    try {
      await viewer.waitFor((m) => m.type === "hello.ok", "viewer hello.ok");
      viewer.send({ type: "session.attach", sid });
      await started;
      const bytes = Buffer.from("DURING_SNAPSHOT");
      const seq = terminal.ring.push(bytes);
      server.manager.emit("output", sid, bytes.toString("base64"), seq);
      const premature = await viewer.waitFor(
        (message) => message.type === "term.output" && message.sid === sid,
        "premature catch-up",
        400,
      ).then(() => true, () => false);
      resolveSnapshot({ ansi: "BASE", seq: baseline, cols: 80, rows: 24 });
      expect(premature).toBe(false);
      await expect(viewer.waitFor(
        (message) => message.type === "term.snapshot" && message.sid === sid,
        "delayed snapshot",
      )).resolves.toMatchObject({ ansi: "BASE", seq: baseline });
      const output = await viewer.waitFor(
        (message) => message.type === "term.output" && message.sid === sid,
        "post-snapshot catch-up",
      ) as Extract<S2CMessage, { type: "term.output" }>;
      expect(output.seq).toBe(seq);
      expect(Buffer.from(output.dataB64, "base64").toString()).toBe("DURING_SNAPSHOT");
    } finally {
      terminal.snapshot = originalSnapshot;
      resolveSnapshot({ ansi: "BASE", seq: baseline, cols: 80, rows: 24 });
      viewer.close();
      await server.manager.kill(sid);
      owner.close();
    }
  }, 30000);

  it("断线重连:lastSeq 增量续传;新 attach 走快照", async () => {
    const c1 = await TestClient.connect(deviceToken, deviceKeys);
    await c1.waitFor((m) => m.type === "hello.ok", "hello.ok");
    c1.send({
      type: "session.create",
      agent: "custom",
      command: markerCommand,
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
    const hello = (await c.waitFor(
      (m) => m.type === "hello.ok",
      "hello.ok",
    )) as Extract<S2CMessage, { type: "hello.ok" }>;
    expect(hello.host.capabilities).not.toContain("orchestration.manual.v1");
    expect(hello.host.capabilities).not.toContain("orchestration.graph.v1");
    expect(hello.host.capabilities).not.toContain("orchestration.automation.v1");
    expect(hello.host.capabilities).not.toContain("orchestration.management.v1");
    expect(hello.host.capabilities).not.toContain("orchestration.lifecycle.v1");
    expect(hello.host.capabilities).not.toContain("orchestration.run-lifecycle.v1");
    c.send({ type: "session.create", agent: "shell", cols: 80, rows: 24 });
    const err = await c.waitFor((m) => m.type === "error", "shell denied");
    expect((err as { code: string }).code).toBe("shell_not_allowed");
    c.send({ type: "orchestration.run.create", objective: "不应获准" });
    const orchestrationError = await c.waitFor(
      (m) => m.type === "error",
      "orchestration denied",
    );
    expect((orchestrationError as { code: string }).code).toBe("forbidden");
    c.close();
  }, 20000);

  it("允许终端但关闭人工编排的设备保持只读", async () => {
    const readOnly = mintDevice(home, {
      name: "orchestration-read-only",
      allowShell: true,
      allowOrchestration: false,
    });
    const c = await TestClient.connect(readOnly.token, generateKeyPairB64());
    const hello = (await c.waitFor(
      (m) => m.type === "hello.ok",
      "hello.ok",
    )) as Extract<S2CMessage, { type: "hello.ok" }>;
    expect(hello.host.capabilities).not.toContain("orchestration.manual.v1");
    expect(hello.host.capabilities).not.toContain("orchestration.graph.v1");
    expect(hello.host.capabilities).not.toContain("orchestration.automation.v1");
    expect(hello.host.capabilities).not.toContain("orchestration.management.v1");
    expect(hello.host.capabilities).not.toContain("orchestration.lifecycle.v1");
    expect(hello.host.capabilities).not.toContain("orchestration.run-lifecycle.v1");
    c.send({ type: "orchestration.run.create", objective: "不应获准" });
    await expect(c.waitFor(
      (m) => m.type === "error" && m.code === "forbidden",
      "orchestration denied",
    )).resolves.toMatchObject({ code: "forbidden" });
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
    // 不创建会话也要按账号返回来源；Codex 新版可直接读取账号级限流窗口，
    // 旧 CLI 则保留 available=false 和明确原因。
    expect(u.sid).toBeUndefined();
    // 账号列表依赖本机装了哪些 CLI：usage.get 会滤掉 status === "unavailable"
    // 的 agent（未安装的 CLI 没有额度可展示）。CI runner 上 claude/codex 都不装，
    // 这里就是空列表，所以不能断言"两个 native 账号一定在"——那只在开发机成立。
    // 能跨环境成立的契约是：应答里只出现真正可用的账号，且每个都自带来源。
    const accountIds = u.accounts?.map((account) => account.accountId) ?? [];
    expect(new Set(accountIds).size).toBe(accountIds.length);
    for (const account of u.accounts ?? []) {
      expect(account.source).toMatch(/subscription|api|unknown/);
      // available=false 必须给出原因，否则手机端卡片会静默空着。
      if (!account.available) expect(account.reason).toBeTruthy();
    }
    c.close();
  }, 20000);
});
