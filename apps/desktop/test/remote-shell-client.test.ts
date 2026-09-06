import { describe, expect, it } from "vitest";
import {
  generateKeyPairB64,
  serverHandshakeAccept,
  serverHandshakeRespond,
  type SecureChannel,
} from "@prospero/protocol";
import {
  RemoteShellClient,
  type RemoteSocket,
} from "../src/main/remote-shell-client";

class FakeSocket implements RemoteSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  readonly sent: string[] = [];
  private serverChannel: SecureChannel | null = null;

  constructor(private readonly daemon: ReturnType<typeof generateKeyPairB64>) {}

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(data);
    if (this.sent.length === 1) {
      const response = serverHandshakeRespond(data, this.daemon.secretKey);
      this.serverChannel = null;
      queueMicrotask(() => this.onmessage?.({ data: response.frame }));
      return;
    }
    if (this.sent.length === 2) {
      if (!this.serverChannel) throw new Error("missing server handshake state");
      return;
    }
    if (!this.serverChannel) throw new Error("missing server channel");
  }

  acceptClientFrame(frame: string, state: ReturnType<typeof serverHandshakeRespond>["state"]): void {
    const accepted = serverHandshakeAccept(state, frame);
    this.serverChannel = accepted.channel;
  }

  sendHelloOk(): void {
    if (!this.serverChannel) throw new Error("missing server channel");
    queueMicrotask(() => this.onmessage?.({
      data: this.serverChannel?.seal({
        type: "hello.ok",
        host: { name: "test-host", daemonVersion: "0.0.13", protocolVersion: 16 },
        sessions: [],
      }),
    }));
  }

  close(): void { this.readyState = 3; }
}

describe("RemoteShellClient", () => {
  it("rejects an unconfigured host before opening a socket", async () => {
    const client = new RemoteShellClient({ id: "h", name: "host", addrs: [], port: 7423, token: "0123456789abcdef", daemonPubKey: "x" });
    await expect(client.connect()).rejects.toThrow("no LAN address");
  });

  it("uses the desktop E2E handshake and emits hello.ok", async () => {
    const daemon = generateKeyPairB64();
    const socket = new FakeSocket(daemon);
    // The fake server needs to retain its handshake state between the two
    // plaintext/encrypted frames, mirroring the daemon's WebSocket handler.
    const originalSend = socket.send.bind(socket);
    let serverState: ReturnType<typeof serverHandshakeRespond>["state"] | undefined;
    socket.send = (data: string) => {
      if (socket.sent.length === 0) {
        const response = serverHandshakeRespond(data, daemon.secretKey);
        serverState = response.state;
        socket.sent.push(data);
        queueMicrotask(() => socket.onmessage?.({ data: response.frame }));
        return;
      }
      if (socket.sent.length === 1) {
        socket.sent.push(data);
        if (!serverState) throw new Error("missing server state");
        socket.acceptClientFrame(data, serverState);
        socket.sendHelloOk();
        return;
      }
      originalSend(data);
    };
    const client = new RemoteShellClient(
      { id: "h", name: "host", addrs: ["127.0.0.1"], port: 7423, token: "0123456789abcdef", daemonPubKey: daemon.publicKey },
      () => { queueMicrotask(() => socket.open()); return socket; },
    );
    const connected = await client.connect();
    expect(connected.type).toBe("hello.ok");
    expect(client.isConnected).toBe(true);
    client.createShell("/tmp", 100, 30);
    expect(socket.sent).toHaveLength(3);
  });
});
