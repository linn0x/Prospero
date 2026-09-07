/** Actual desktop client -> daemon -> PTY, plus the production relay data plane.
 * All credentials, shell processes, files and listening ports belong to fixtures.
 * Relay storage uses in-memory adapters; WSS termination is outside this test.
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairB64 } from "@prospero/protocol";
import { RemoteShellClient, type RemoteSocket } from "../../desktop/src/main/remote-shell-client";
import { RemoteShellManager, type RemoteShellEvent } from "../../desktop/src/main/remote-shell-manager";
import { createDaemonServer } from "../src/ws-server.js";
import { loadIdentity, mintDevice, issueRelayCredentials, persistRelayCredentials, generateRelayHostSecret, relayPairingForDevice, saveConfig } from "../src/pairing.js";
import { RelayServer } from "../../relay/src/relay.js";
import { readConfig } from "../../relay/src/config.js";
import { createLogger } from "../../relay/src/log.js";
import { MemoryEphemeralStore, MemoryRouteStore } from "../../relay/test/helpers.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
const wait = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { timeout: 5000, interval: 20 });

async function fixture(relayed: boolean, unreachableLan: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "prospero-desktop-e2e-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const shell = join(dir, "fixture-shell");
  writeFileSync(shell, "#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n"); chmodSync(shell, 0o700);
  vi.stubEnv("SHELL", shell); vi.stubEnv("PROSPERO_DEFAULT_RELAY_URL", "");
  const identity = loadIdentity(dir);
  let device = mintDevice(dir, { name: "desktop fixture", allowShell: true });
  let pairing;
  let relayUrl = "";
  if (relayed) {
    const relay = new RelayServer({ routes: new MemoryRouteStore(), ephemeral: new MemoryEphemeralStore(),
      logger: createLogger("silent"), config: { ...readConfig({}), host: "127.0.0.1", port: 0 }, shutdownGraceMs: 0 });
    await relay.listen(); cleanup.push(() => relay.close());
    relayUrl = `ws://127.0.0.1:${relay.address()!.port}`;
    const config = { port: 0, relay: { enabled: true, url: relayUrl, hostSecret: generateRelayHostSecret() } };
    saveConfig(dir, config);
    device = issueRelayCredentials(device); persistRelayCredentials(dir, device);
    pairing = { ...relayPairingForDevice(config, device)!, url: "wss://fixture-relay.example/v1" };
  }
  const daemon = await createDaemonServer({ home: dir, workspaceRoot: dir, port: 0, bindAddr: "127.0.0.1",
    structuredSupervisor: false, ptySupervisor: false, devMode: relayed,
    accountRunner: async () => ({ stdout: "Not logged in", stderr: "", exitCode: 0 }) });
  cleanup.push(() => daemon.close());
  if (relayed) await wait(() => daemon.relay.status().state === "online");
  const host = { id: "fixture", name: "fixture", addrs: relayed ? unreachableLan ? ["127.0.0.2"] : [] : ["127.0.0.1"],
    port: daemon.port, token: device.token, daemonPubKey: identity.publicKey, clientKeys: generateKeyPairB64(), ...(pairing ? { relay: pairing } : {}) };
  const sockets: WebSocket[] = [];
  const makeClient = () => new RemoteShellClient(host, (url) => {
    const ws = new WebSocket(url.replace("wss://fixture-relay.example", relayUrl));
    sockets.push(ws); return ws as unknown as RemoteSocket;
  });
  const events: RemoteShellEvent[] = [];
  let output = "";
  const manager = new RemoteShellManager({ get: () => host, markConnected: () => {} } as never, (event) => {
    events.push(event);
    const message = event.message;
    if (message.type === "term.output") output += Buffer.from(message.dataB64, "base64").toString("utf8");
    if (message.type === "term.snapshot") output += message.ansi;
  }, makeClient);
  cleanup.push(() => manager.close());
  return { manager, host, daemon, dir, sockets, events, text: () => output, makeClient };
}

describe.skipIf(process.platform === "win32")("desktop remote shell actual data path", () => {
  it.each([
    { label: "LAN", relayed: false, fallback: false },
    { label: "relay-only", relayed: true, fallback: false },
    { label: "LAN to relay fallback", relayed: true, fallback: true },
  ])("$label: create, output, resize, reconnect, restored identity and kill", async ({ relayed, fallback }) => {
    const f = await fixture(relayed, fallback);
    await f.manager.connect(f.host.id);
    const ids = await Promise.all([f.manager.createShell(f.host.id, f.dir), f.manager.createShell(f.host.id, f.dir)]);
    expect(ids[0]).toBe(ids[1]); expect(f.daemon.manager.list()).toHaveLength(1);
    const sid = ids[0]!;
    expect((await f.manager.listShells(f.host.id)).map((session) => session.id)).toContain(sid);
    await f.manager.attach(f.host.id, sid);
    await expect(f.manager.attach(f.host.id, "missing-session")).rejects.toThrow("不存在");
    await wait(() => f.events.some((e) => e.message.type === "term.snapshot"));
    f.manager.input(f.host.id, sid, Buffer.from("printf 'DESKTOP_%s\\n' 'E2E_OK'\n").toString("base64"));
    await wait(() => f.text().includes("DESKTOP_E2E_OK"));
    f.manager.resize(f.host.id, sid, 99, 28);
    await vi.waitFor(async () => expect(await f.daemon.manager.requirePty(sid).snapshot()).toMatchObject({ cols: 99, rows: 28 }));
    const connected = () => f.events.filter((e) => e.message.type === "remote.connected").length;
    // Kill the actual active network socket; the daemon's PTY must survive.
    for (const ws of f.sockets) if (ws.readyState === WebSocket.OPEN) ws.close();
    await wait(() => connected() >= 2);
    f.manager.input(f.host.id, sid, Buffer.from("printf 'RECOVER_%s\\n' 'OK'\n").toString("base64"));
    await wait(() => f.text().includes("RECOVER_OK"));
    expect(f.daemon.manager.list()).toHaveLength(1);
    f.manager.disconnect(f.host.id);
    const fresh = f.makeClient(); cleanup.push(() => fresh.close());
    const hello = await fresh.connect();
    expect(hello.sessions.some((s) => s.id === sid)).toBe(true);
    fresh.kill(sid);
    await wait(() => !f.daemon.manager.list().some((s) => s.id === sid && !["done", "died"].includes(s.status)));
  }, 15000);
});
