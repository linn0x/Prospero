import { afterEach, describe, expect, it, vi } from "vitest";

const appState = vi.hoisted(() => ({ callback: null as ((state: string) => void) | null }));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: vi.fn((_event: string, callback: (state: string) => void) => {
      appState.callback = callback;
      return { remove: vi.fn() };
    }),
  },
  Platform: { OS: "ios" },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "ping-0123456789" }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  isAvailableAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import {
  CAPABILITY_AGENT_ACCOUNTS,
  CAPABILITY_AGENT_API_PROFILES,
  CAPABILITY_AGENT_API_PROTOCOLS,
  CAPABILITY_FS_PUT_ACK,
  generateKeyPairB64,
} from "@prospero/protocol";
import { dropConnection, getConnection, HostConnection, wireAppStateReconnect } from "../src/lib/connection";
import type { StoredHost } from "../src/lib/hosts";

class FakeWebSocket {
  static sockets: FakeWebSocket[] = [];
  static throwFor: ((url: string) => boolean) | null = null;
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(readonly url: string) {
    if (FakeWebSocket.throwFor?.(url)) throw new Error("synchronous open failure");
    FakeWebSocket.sockets.push(this);
  }

  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
}

const makeHost = (connectionMode: StoredHost["connectionMode"]): StoredHost => ({
  id: `host-${connectionMode}`,
  name: "Mac",
  addrs: ["192.168.1.8", "10.0.0.8"],
  port: 7423,
  token: "0123456789abcdef",
  daemonPub: generateKeyPairB64().publicKey,
  pairedAt: 1,
  connectionMode,
  relay: { url: "wss://relay.example.com/v1", routeId: "route_0123456789", deviceId: "device_0123456789" },
  relayToken: "relay_token_0123456789",
});

afterEach(() => {
  FakeWebSocket.sockets = [];
  FakeWebSocket.throwFor = null;
  appState.callback = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("HostConnection WebSocket candidates", () => {
  it.each([
    ["direct", 2, ["ws://192.168.1.8:7423/ws", "ws://10.0.0.8:7423/ws"]],
    ["relay", 1, ["wss://relay.example.com/v1/client"]],
    ["auto", 3, ["ws://192.168.1.8:7423/ws", "ws://10.0.0.8:7423/ws", "wss://relay.example.com/v1/client"]],
  ] as const)("starts %s candidates concurrently", async (mode, count, urls) => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const connection = new HostConnection(makeHost(mode), generateKeyPairB64());
    const raced = (connection as unknown as { race(): Promise<unknown> }).race();
    expect(FakeWebSocket.sockets.map((socket) => socket.url)).toEqual(urls);
    expect(FakeWebSocket.sockets).toHaveLength(count);
    connection.stop();
    await expect(raced).rejects.toThrow();
  });

  it("turns a synchronous relay WebSocket failure into a candidate failure", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    FakeWebSocket.throwFor = (url) => url.startsWith("wss://");
    const connection = new HostConnection(makeHost("relay"), generateKeyPairB64());
    await expect((connection as unknown as { race(): Promise<unknown> }).race()).rejects.toThrow();
    expect(connection.diagnosis?.summary).toContain("TLS");
  });

  it("classifies sockets that never open as unreachable instead of claiming the daemon did not respond", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const connection = new HostConnection(makeHost("direct"), generateKeyPairB64());
    const raced = (connection as unknown as { race(): Promise<unknown> }).race();
    const rejected = expect(raced).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(6_000);
    await rejected;

    expect(connection.diagnosis?.summary).toContain("无法连接");
    expect(connection.diagnosis?.hint).toContain("本地网络");
    expect(connection.diagnosis?.hint).not.toContain("prosperod 没有响应");
  });

  it("keeps an opened socket with no E2E handshake response classified as a daemon timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const connection = new HostConnection(makeHost("direct"), generateKeyPairB64());
    const raced = (connection as unknown as { race(): Promise<unknown> }).race();
    const rejected = expect(raced).rejects.toThrow();
    for (const socket of FakeWebSocket.sockets) {
      socket.readyState = 1;
      socket.onopen?.();
    }

    await vi.advanceTimersByTimeAsync(6_000);
    await rejected;

    expect(connection.diagnosis?.summary).toContain("无应答");
    expect(connection.diagnosis?.hint).toContain("prosperod 没有响应");
  });

  it("restarts a stopped candidate on foreground / network recovery", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const host = makeHost("direct");
    const connection = getConnection(host, generateKeyPairB64());
    wireAppStateReconnect();
    connection.stop();
    appState.callback?.("active");
    expect(FakeWebSocket.sockets.map((socket) => socket.url)).toEqual([
      "ws://192.168.1.8:7423/ws",
      "ws://10.0.0.8:7423/ws",
    ]);
    dropConnection(host.id);
  });

  it("sends an encrypted v13 ping at fifteen seconds and reconnects after silence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
    const socket = new FakeWebSocket("ws://192.168.1.8:7423/ws");
    socket.readyState = 1;
    const connection = new HostConnection(makeHost("direct"), generateKeyPairB64());
    const internals = connection as unknown as {
      ws: FakeWebSocket;
      channel: { seal(message: unknown): string };
      negotiatedProtocolVersion: number;
      lastRecvAt: number;
      lastPingAt: number;
      startHeartbeat(): void;
    };
    internals.ws = socket;
    internals.channel = { seal: vi.fn((message: unknown) => JSON.stringify(message)) };
    internals.negotiatedProtocolVersion = 13;
    internals.lastRecvAt = Date.now();
    internals.lastPingAt = Date.now();
    internals.startHeartbeat();

    vi.advanceTimersByTime(15_000);
    expect(socket.sent).toContain('{"type":"connection.ping","id":"ping-0123456789"}');
    vi.advanceTimersByTime(20_000);
    expect(socket.readyState).toBe(3);
    connection.stop();
  });

  it("carries the selected approval policy in session.create", () => {
    const connection = new HostConnection(makeHost("direct"), generateKeyPairB64());
    const send = vi.spyOn(connection, "send").mockReturnValue({
      accepted: true,
      disposition: "sent",
    });

    connection.createSession("codex", "/work/prospero", undefined, "structured", 80, 24, {
      mode: "plan",
      approvalPolicy: "standard",
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.create",
        agent: "codex",
        kind: "structured",
        cwd: "/work/prospero",
        mode: "plan",
        approvalPolicy: "standard",
      }),
      true,
    );
  });

  it("sends explicit API protocols and preserves the key on empty reconfiguration", async () => {
    const socket = new FakeWebSocket("ws://192.168.1.8:7423/ws");
    socket.readyState = 1;
    const connection = new HostConnection(makeHost("direct"), generateKeyPairB64());
    const internals = connection as unknown as {
      ws: FakeWebSocket;
      channel: { seal(message: unknown): string; open(message: string): unknown };
      advertisedCapabilities: Set<string>;
      onMessage(message: string): void;
    };
    internals.ws = socket;
    internals.channel = {
      seal: (message) => JSON.stringify(message),
      open: (message) => JSON.parse(message),
    };
    internals.advertisedCapabilities = new Set([
      CAPABILITY_AGENT_ACCOUNTS,
      CAPABILITY_AGENT_API_PROFILES,
      CAPABILITY_AGENT_API_PROTOCOLS,
    ]);

    const pending = connection.configureAgentApiProfile(
      "account",
      "openai_chat_completions",
      "https://gateway.example.com/v1",
      "model",
    );
    const request = JSON.parse(socket.sent[0]!) as Record<string, unknown>;
    expect(request).toMatchObject({
      type: "agent.account.api.configure",
      accountId: "account",
      provider: "openai_compatible",
      protocol: "openai_chat_completions",
      baseUrl: "https://gateway.example.com/v1",
      model: "model",
    });
    expect(request).not.toHaveProperty("apiKey");
    internals.onMessage(JSON.stringify({
      type: "agent.accounts.result",
      requestId: request["requestId"],
      action: "api_configure",
      ok: true,
      accounts: [],
    }));
    await expect(pending).resolves.toMatchObject({ ok: true });
    connection.stop();
  });

  it("keeps legacy API profile updates on the old required-key contract", () => {
    const connection = new HostConnection(makeHost("direct"), generateKeyPairB64());
    const internals = connection as unknown as { advertisedCapabilities: Set<string> };
    internals.advertisedCapabilities = new Set([
      CAPABILITY_AGENT_ACCOUNTS,
      CAPABILITY_AGENT_API_PROFILES,
    ]);
    expect(() => connection.configureAgentApiProfile(
      "account",
      "openai_responses",
      "https://gateway.example.com/v1",
      "model",
    )).toThrow("需要重新输入 API Key");
  });

  it("requires advertised API validation and returns failed checks for presentation", async () => {
    const socket = new FakeWebSocket("ws://192.168.1.8:7423/ws");
    socket.readyState = 1;
    const connection = new HostConnection(makeHost("direct"), generateKeyPairB64());
    const internals = connection as unknown as {
      ws: FakeWebSocket;
      channel: { seal(message: unknown): string; open(message: string): unknown };
      advertisedCapabilities: Set<string>;
      onMessage(message: string): void;
    };
    internals.ws = socket;
    internals.channel = { seal: JSON.stringify, open: JSON.parse };
    internals.advertisedCapabilities = new Set([CAPABILITY_AGENT_ACCOUNTS, CAPABILITY_AGENT_API_PROFILES, CAPABILITY_AGENT_API_PROTOCOLS]);
    expect(connection.supportsAgentApiValidation).toBe(false);
    expect(() => connection.testAgentApiProfile("account")).toThrow("升级电脑端");
    expect(socket.sent).toHaveLength(0);

    internals.advertisedCapabilities.add("agent.api-validation.v1");
    const pending = connection.testAgentApiProfile("account");
    const request = JSON.parse(socket.sent[0]!);
    expect(request).toMatchObject({ type: "agent.account.api.test", accountId: "account" });
    expect(request).not.toHaveProperty("apiKey");
    const validation = { status: "failed", engine: "opencode", checkedAt: 123, checks: { runtime: "passed", streaming: "passed", tools: "failed" }, detail: "Tool roundtrip failed" };
    internals.onMessage(JSON.stringify({ type: "agent.accounts.result", requestId: request.requestId, action: "api_test", ok: false, error: "Validation failed", validation, accounts: [] }));
    await expect(pending).resolves.toMatchObject({ ok: false, validation });
    connection.stop();
  });

  it("only sends model metadata to daemons advertising support", async () => {
    const socket = new FakeWebSocket("ws://192.168.1.8:7423/ws");
    socket.readyState = 1;
    const connection = new HostConnection(makeHost("direct"), generateKeyPairB64());
    const internals = connection as unknown as {
      ws: FakeWebSocket;
      channel: { seal(message: unknown): string; open(message: string): unknown };
      advertisedCapabilities: Set<string>;
      onMessage(message: string): void;
    };
    internals.ws = socket;
    internals.channel = { seal: JSON.stringify, open: JSON.parse };
    internals.advertisedCapabilities = new Set([CAPABILITY_AGENT_ACCOUNTS, CAPABILITY_AGENT_API_PROFILES, CAPABILITY_AGENT_API_PROTOCOLS]);
    for (const supported of [false, true]) {
      if (supported) internals.advertisedCapabilities.add("agent.api-validation.v1");
      const pending = connection.configureAgentApiProfile("account", "openai_responses", "https://example.com/v1", "model", undefined, { contextWindow: 2000, tools: false });
      const request = JSON.parse(socket.sent.at(-1)!);
      if (supported) expect(request.modelCapabilities).toEqual({ contextWindow: 2000, tools: false });
      else expect(request).not.toHaveProperty("modelCapabilities");
      internals.onMessage(JSON.stringify({ type: "agent.accounts.result", requestId: request.requestId, action: "api_configure", ok: true, accounts: [] }));
      await pending;
    }
    connection.stop();
  });

  it("waits for every acknowledged upload chunk", async () => {
    const socket = new FakeWebSocket("ws://192.168.1.8:7423/ws");
    socket.readyState = 1;
    const connection = new HostConnection(makeHost("direct"), generateKeyPairB64());
    const internals = connection as unknown as {
      ws: FakeWebSocket;
      channel: { seal(message: unknown): string; open(message: string): unknown };
      advertisedCapabilities: Set<string>;
      onMessage(message: string): void;
    };
    internals.ws = socket;
    internals.channel = {
      seal: (message) => JSON.stringify(message),
      open: (message) => JSON.parse(message),
    };
    internals.advertisedCapabilities = new Set([CAPABILITY_FS_PUT_ACK]);

    let settled = false;
    const pending = connection.fsPutChunk("sid", "file.bin", 0, "AQ==", false)
      .then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "fs.put", final: false });

    internals.onMessage(JSON.stringify({
      type: "fs.written",
      sid: "sid",
      path: "file.bin",
      size: 1,
    }));
    await pending;
    expect(settled).toBe(true);

    const failed = connection.fsPutChunk("sid", "denied.bin", 0, "Ag==", false);
    internals.onMessage(JSON.stringify({
      type: "error",
      code: "fs_error",
      message: "cannot write file",
      sid: "sid",
    }));
    await expect(failed).rejects.toThrow("cannot write file");
    connection.stop();
  });

  it("uses legacy final acknowledgements to serialize upload chunks", async () => {
    const socket = new FakeWebSocket("ws://192.168.1.8:7423/ws");
    socket.readyState = 1;
    const connection = new HostConnection(makeHost("direct"), generateKeyPairB64());
    const internals = connection as unknown as {
      ws: FakeWebSocket;
      channel: { seal(message: unknown): string; open(message: string): unknown };
      advertisedCapabilities: Set<string>;
      onMessage(message: string): void;
    };
    internals.ws = socket;
    internals.channel = {
      seal: (message) => JSON.stringify(message),
      open: (message) => JSON.parse(message),
    };
    internals.advertisedCapabilities = new Set();

    const pending = connection.fsPutChunk("sid", "file.bin", 0, "AQ==", false);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "fs.put", final: true });
    internals.onMessage(JSON.stringify({
      type: "fs.written",
      sid: "sid",
      path: "file.bin",
      size: 1,
    }));
    await expect(pending).resolves.toMatchObject({ size: 1 });
    connection.stop();
  });
});
