import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import { decodePairingQR, hostIdForDaemonPublicKey, type PairingPayload } from "@prospero/protocol";
import type { RemoteHostSummary } from "../shared/types";
import type { RemoteShellHost } from "./remote-shell-client";

type StoredRemoteHost = RemoteShellHost & { lastConnectedAt?: number };
type EncryptedFile = { v: 1; data: string };

/** Main-process store; pairing tokens never cross the preload bridge. */
export class RemoteHostStore {
  private hosts = new Map<string, StoredRemoteHost>();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  list(): RemoteHostSummary[] {
    this.load();
    return [...this.hosts.values()].map(({ token: _token, daemonPubKey: _key, ...summary }) => ({ ...summary }));
  }

  importPairing(uri: string): RemoteHostSummary {
    this.load();
    const payload = decodePairingQR(uri.trim());
    const record = this.recordFromPayload(payload);
    this.hosts.set(record.id, record);
    this.save();
    const { token: _token, daemonPubKey: _key, ...summary } = record;
    return { ...summary };
  }

  remove(id: string): boolean {
    this.load();
    const removed = this.hosts.delete(id);
    if (removed) this.save();
    return removed;
  }

  get(id: string): StoredRemoteHost | undefined {
    this.load();
    const value = this.hosts.get(id);
    return value ? { ...value } : undefined;
  }

  markConnected(id: string, at = Date.now()): void {
    this.load();
    const host = this.hosts.get(id);
    if (!host) return;
    host.lastConnectedAt = at;
    this.save();
  }

  private recordFromPayload(payload: PairingPayload): StoredRemoteHost {
    return {
      id: hostIdForDaemonPublicKey(payload.pubKey),
      name: payload.name,
      addrs: payload.addrs,
      port: payload.port,
      token: payload.token,
      daemonPubKey: payload.pubKey,
    };
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.filePath)) return;
    try {
      const envelope = JSON.parse(readFileSync(this.filePath, "utf8")) as EncryptedFile;
      if (envelope.v !== 1 || !safeStorage.isEncryptionAvailable()) return;
      const records = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.data, "base64"))) as StoredRemoteHost[];
      if (!Array.isArray(records)) return;
      for (const record of records) {
        if (record && typeof record.id === "string" && typeof record.token === "string" && typeof record.daemonPubKey === "string") {
          this.hosts.set(record.id, record);
        }
      }
    } catch {
      // Corrupt or unavailable credentials fail closed; the user can re-pair.
    }
  }

  private save(): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，无法保存远程主机配对");
    mkdirSync(dirname(this.filePath), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify([...this.hosts.values()]));
    const envelope: EncryptedFile = { v: 1, data: encrypted.toString("base64") };
    writeFileSync(this.filePath, JSON.stringify(envelope) + "\n", { mode: 0o600 });
  }
}
