/**
 * End-to-end deployment proof.  This deliberately uses the compiled relay and
 * daemon processes plus the MySQL/Redis compose services; only the phone is a
 * test client.  The local proxy records data-plane wire shapes, never secrets.
 */
import { spawn, type ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  clientHandshakeFinish,
  clientHandshakeStart,
  decodePairingQR,
  generateKeyPairB64,
  parseS2C,
  type PairingPayload,
  type SecureChannel,
  type S2CMessage,
} from "@prospero/protocol";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const compose = join(here, "compose.integration.yaml");
const daemonCli = join(root, "apps", "daemon", "dist", "cli.js");
const relayUrl = "ws://127.0.0.1:38787";
const project = `prospero-relay-e2e-${process.pid}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, description: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve loopback port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function rawText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

async function openSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

async function nextFrame(ws: WebSocket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const onMessage = (raw: RawData) => {
      cleanup();
      resolve(rawText(raw));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before expected frame"));
    };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    ws.once("message", onMessage);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

interface AuditFrame {
  path: string;
  body: string;
}

/** A transparent loopback observer in front of the real relay process. */
class RelayAuditProxy {
  readonly controlTypes = new Set<string>();
  readonly postReadyFrames: AuditFrame[] = [];
  private readonly http = createServer();
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private readonly sockets = new Set<WebSocket>();
  private port = 0;

  constructor(private readonly target: string) {
    this.http.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://relay.invalid").pathname;
      if (!["/v1/host", "/v1/client", "/v1/stream"].includes(pathname)) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.forward(ws, request.url ?? pathname));
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${String(this.port)}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.http.listen(0, "127.0.0.1", resolve));
    const address = this.http.address();
    if (!address || typeof address === "string") throw new Error("audit proxy did not bind TCP");
    this.port = address.port;
  }

  private forward(front: WebSocket, requestUrl: string): void {
    this.sockets.add(front);
    const pathname = new URL(requestUrl, "http://relay.invalid").pathname;
    const upstream = new WebSocket(`${this.target}${requestUrl}`, { perMessageDeflate: false });
    this.sockets.add(upstream);
    let dataPlane = false;
    const queued: Array<{ data: RawData; binary: boolean }> = [];
    let closed = false;
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      if (front.readyState === WebSocket.OPEN || front.readyState === WebSocket.CONNECTING) front.close();
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
    };
    const observe = (raw: RawData) => {
      const body = rawText(raw);
      let message: { type?: unknown; c?: unknown } | undefined;
      try {
        message = JSON.parse(body) as { type?: unknown; c?: unknown };
      } catch {
        // Post-ready opaque frames are valid JSON ciphertext today, but the
        // relay must be equally transparent to future binary framing.
      }
      if (typeof message?.type === "string") this.controlTypes.add(`${pathname}:${message.type}`);
      const alreadyDataPlane = dataPlane;
      if (message?.type === "stream.ready") dataPlane = true;
      if (alreadyDataPlane) this.postReadyFrames.push({ path: pathname, body });
    };
    const sendUpstream = (data: RawData, binary: boolean) => {
      observe(data);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      else queued.push({ data, binary });
    };
    front.on("message", sendUpstream);
    upstream.on("message", (data, binary) => {
      observe(data);
      if (front.readyState === WebSocket.OPEN) front.send(data, { binary });
    });
    upstream.once("open", () => {
      for (const frame of queued.splice(0)) upstream.send(frame.data, { binary: frame.binary });
    });
    front.once("close", closeBoth);
    upstream.once("close", closeBoth);
    front.once("error", () => closeBoth());
    upstream.once("error", () => closeBoth());
    front.once("close", () => this.sockets.delete(front));
    upstream.once("close", () => this.sockets.delete(upstream));
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

class TestClient {
  private readonly messages: S2CMessage[] = [];
  private closed = false;

  private constructor(
    private readonly ws: WebSocket,
    private readonly channel: SecureChannel,
    readonly path: "direct" | "relay",
  ) {
    ws.on("message", (raw: RawData) => {
      this.messages.push(parseS2C(channel.open(rawText(raw))));
    });
    ws.once("close", () => {
      this.closed = true;
    });
  }

  static async direct(pairing: PairingPayload, keys: ReturnType<typeof generateKeyPairB64>): Promise<TestClient> {
    return TestClient.connect(`ws://127.0.0.1:${String(pairing.port)}/ws`, pairing, keys, "direct");
  }

  static async relay(pairing: PairingPayload, keys: ReturnType<typeof generateKeyPairB64>): Promise<TestClient> {
    const relay = pairing.relay;
    if (!relay) throw new Error("QR did not include relay credentials");
    return TestClient.connect(`${relay.url}/v1/client`, pairing, keys, "relay");
  }

  private static async connect(
    url: string,
    pairing: PairingPayload,
    keys: ReturnType<typeof generateKeyPairB64>,
    path: "direct" | "relay",
  ): Promise<TestClient> {
    const ws = await openSocket(url);
    if (path === "relay") {
      const relay = pairing.relay!;
      ws.send(JSON.stringify({ type: "client.open", v: relay.v, routeId: relay.routeId, deviceId: relay.deviceId, token: relay.token }));
      expect(JSON.parse(await nextFrame(ws))).toMatchObject({ type: "client.status", v: relay.v, status: "pending" });
      expect(JSON.parse(await nextFrame(ws))).toMatchObject({ type: "stream.ready", v: relay.v });
    }
    const start = clientHandshakeStart(13);
    ws.send(start.frame);
    const serverFrame = await nextFrame(ws);
    const finished = clientHandshakeFinish(start.state, serverFrame, pairing.pubKey, {
      type: "hello",
      token: pairing.token,
      clientPubKey: keys.publicKey,
      // This marker must never appear in a frame observed by the relay.
      clientInfo: { platform: "ios", appVersion: "e2e-business-opaque-marker" },
    });
    const client = new TestClient(ws, finished.channel, path);
    ws.send(finished.frame);
    return client;
  }

  send(message: unknown): void {
    this.ws.send(this.channel.seal(message));
  }

  async waitFor(predicate: (message: S2CMessage) => boolean, description: string, timeoutMs = 10_000): Promise<S2CMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0]!;
      if (this.closed) throw new Error(`socket closed while waiting for ${description}`);
      await sleep(10);
    }
    throw new Error(`timed out waiting for ${description}`);
  }

  close(): void {
    this.ws.close();
  }
}

function commandEnv(home: string, defaultRelayUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PROSPERO_HOME: home,
    PROSPERO_DEFAULT_RELAY_URL: defaultRelayUrl,
  };
}

async function startDaemon(home: string, defaultRelayUrl: string, port: number): Promise<{ child: ChildProcessWithoutNullStreams; close(): Promise<void> }> {
  const child = spawn(process.execPath, [daemonCli, "start", "--dev", "--no-bonjour", "--bind", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: commandEnv(home, defaultRelayUrl),
    stdio: "pipe",
  });
  let output = "";
  child.stdout.on("data", (data: Buffer) => { output += data.toString("utf8"); });
  child.stderr.on("data", () => undefined);
  await waitFor(() => output.includes("已启动"), "daemon startup");
  return {
    child,
    close: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(10_000)]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}

describe.skipIf(process.env.RELAY_REAL_PROCESS_E2E !== "1")("real-process relay E2E", () => {
  it("authenticates QR relay credentials and preserves opaque E2E frames across direct, relay, and auto paths", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "prospero-relay-e2e-"));
    const audit = new RelayAuditProxy(relayUrl);
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      await exec("docker", ["compose", "-p", project, "-f", compose, "up", "-d", "--build", "--wait"], { timeout: 240_000 });
      expect((await fetch(`${relayUrl.replace("ws", "http")}/health/ready`)).status).toBe(200);
      await audit.start();

      // The default is injected for this release process; no user override is
      // persisted.  The CLI has separate coverage for a supplied --url.
      await exec(process.execPath, [daemonCli, "relay", "enable", "--dev"], {
        cwd: root,
        env: commandEnv(home, audit.url),
      });
      const configured = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { relay?: { enabled?: boolean; url?: string } };
      expect(configured.relay).toMatchObject({ enabled: true });
      expect(configured.relay?.url).toBeUndefined();

      const directPort = await reserveLoopbackPort();
      daemon = await startDaemon(home, audit.url, directPort);
      const pairResult = await exec(process.execPath, [daemonCli, "pair", "--dev", "--name", "e2e-phone"], {
        cwd: root,
        env: commandEnv(home, audit.url),
      });
      const pairingUrl = pairResult.stdout.match(/prospero:\/\/pair\?\S+/)?.[0];
      if (!pairingUrl) throw new Error("pair command did not render a pairing QR URL");
      const pairing = decodePairingQR(pairingUrl, { allowInsecureLoopback: true });
      expect(pairing).toMatchObject({ port: directPort, relay: { url: audit.url } });
      expect(pairing.relay?.token).toBeTruthy();

      const keys = generateKeyPairB64();
      const direct = await TestClient.direct(pairing, keys);
      await direct.waitFor((message) => message.type === "hello.ok", "direct hello.ok");

      const relayed = await TestClient.relay(pairing, keys);
      await relayed.waitFor((message) => message.type === "hello.ok", "relay hello.ok");
      relayed.send({ type: "connection.ping", id: "e2e-ping-opaque-marker" });
      await relayed.waitFor(
        (message) => message.type === "connection.pong" && message.id === "e2e-ping-opaque-marker",
        "encrypted relay pong",
      );
      relayed.send({ type: "workspace.list", path: "" });
      await relayed.waitFor((message) => message.type === "workspace.listing" && message.path === "", "relay business response");

      const attempts = [
        TestClient.direct(pairing, keys).then(async (client) => ({ client, hello: await client.waitFor((message) => message.type === "hello.ok", "auto direct hello.ok") })),
        TestClient.relay(pairing, keys).then(async (client) => ({ client, hello: await client.waitFor((message) => message.type === "hello.ok", "auto relay hello.ok") })),
      ];
      const winner = await Promise.race(attempts);
      expect(winner.hello.type).toBe("hello.ok");
      expect(["direct", "relay"]).toContain(winner.client.path);
      const completed = await Promise.allSettled(attempts);
      for (const result of completed) if (result.status === "fulfilled") result.value.client.close();

      direct.close();
      relayed.close();
      await waitFor(() => audit.controlTypes.has("/v1/client:client.open") && audit.controlTypes.has("/v1/client:client.status") && audit.controlTypes.has("/v1/host:host.device-sync") && audit.controlTypes.has("/v1/stream:stream.accept") && audit.controlTypes.has("/v1/client:stream.ready"), "public relay control handshake");
      const ciphertextFrames = audit.postReadyFrames.filter(({ body }) => {
        try {
          const frame = JSON.parse(body) as { c?: unknown };
          return typeof frame.c === "string";
        } catch {
          return false;
        }
      });
      expect(ciphertextFrames.length).toBeGreaterThan(6);
      const wire = audit.postReadyFrames.map(({ body }) => body).join("\n");
      expect(wire).not.toContain("e2e-ping-opaque-marker");
      expect(wire).not.toContain("e2e-business-opaque-marker");
      expect(wire).not.toContain('"type":"connection.ping"');
      expect(wire).not.toContain('"type":"connection.pong"');
      expect(wire).not.toContain('"type":"workspace.list"');
      expect(audit.postReadyFrames.every(({ body }) => !body.includes('"type"'))).toBe(true);
    } finally {
      await daemon?.close();
      await audit.close();
      await exec("docker", ["compose", "-p", project, "-f", compose, "down", "-v"], { timeout: 60_000 }).catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});
