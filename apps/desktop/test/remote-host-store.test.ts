import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { encodePairingQR, generateKeyPairB64 } from "@prospero/protocol";
const encryption = vi.hoisted(() => ({ available: true }));
vi.mock("electron", () => ({ safeStorage: {
  isEncryptionAvailable: () => encryption.available,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
} }));
import { RemoteHostStore } from "../src/main/remote-host-store";
const homes: string[] = [];
afterEach(() => { encryption.available = true; homes.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "prospero-host-store-")); homes.push(dir);
  const file = join(dir, "hosts.json");
  const uri = encodePairingQR({ v: 7, name: "Fixture", addrs: [], port: 1234, token: "test-token-0123456789", pubKey: generateKeyPairB64().publicKey,
    relay: { v: 1, url: "wss://relay.example.test/v1", routeId: "r".repeat(43), deviceId: "d".repeat(22), token: "s".repeat(43) } });
  return { file, uri, store: new RemoteHostStore(file) };
}
it("persists the same client identity across restarts and only exports a whitelist", () => {
  const { file, uri, store } = fixture();
  const summary = store.importPairing(uri);
  expect(Object.keys(summary).sort()).toEqual(["addrs", "hasRelay", "id", "name", "port"]);
  const keys = store.get(summary.id)!.clientKeys;
  expect(keys?.publicKey).toBeTruthy();
  const reloaded = new RemoteHostStore(file);
  expect(reloaded.get(summary.id)?.clientKeys).toEqual(keys);
  reloaded.importPairing(uri);
  expect(reloaded.get(summary.id)?.clientKeys).toEqual(keys);
  expect(JSON.stringify(reloaded.list())).not.toContain(keys!.secretKey);
  expect(JSON.stringify(reloaded.list())).not.toContain("test-token");
});
it("keeps the previous disk and in-memory records on a failed credential write", () => {
  const { file, uri, store } = fixture(); const host = store.importPairing(uri);
  const before = readFileSync(file, "utf8"); encryption.available = false;
  expect(() => store.remove(host.id)).toThrow();
  expect(store.list()).toHaveLength(1); expect(readFileSync(file, "utf8")).toBe(before);
});
it("does not silently overwrite an unreadable credentials file", () => {
  const { file, uri, store } = fixture(); writeFileSync(file, "broken");
  expect(() => store.importPairing(uri)).toThrow("原文件已保留");
  expect(readFileSync(file, "utf8")).toBe("broken");
});
