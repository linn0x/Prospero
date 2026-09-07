import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import { decodePairingQR, encodePairingQR, generateKeyPairB64, hostIdForDaemonPublicKey, type PairingPayload } from "@prospero/protocol";
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
    return [...this.hosts.values()].map((host) => this.summary(host));
  }

  importPairing(uri: string): RemoteHostSummary {
    this.load();
    const payload = decodePairingQR(uri.trim());
    const record = this.recordFromPayload(payload);
    const previous = this.hosts.get(record.id);
    record.clientKeys = previous?.clientKeys ?? generateKeyPairB64();
    const next = new Map(this.hosts).set(record.id, record);
    this.save(next);
    this.hosts = next;
    return this.summary(record);
  }

  remove(id: string): boolean {
    this.load();
    const next = new Map(this.hosts);
    const removed = next.delete(id);
    if (removed) { this.save(next); this.hosts = next; }
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
    const next = new Map(this.hosts).set(id, { ...host, lastConnectedAt: at });
    this.save(next);
    this.hosts = next;
  }

  private summary(host: StoredRemoteHost): RemoteHostSummary {
    return { id: host.id, name: host.name, addrs: [...host.addrs], port: host.port,
      hasRelay: Boolean(host.relay), ...(host.lastConnectedAt === undefined ? {} : { lastConnectedAt: host.lastConnectedAt }) };
  }

  private recordFromPayload(payload: PairingPayload): StoredRemoteHost {
    return {
      id: hostIdForDaemonPublicKey(payload.pubKey),
      name: payload.name,
      addrs: payload.addrs,
      port: payload.port,
      token: payload.token,
      daemonPubKey: payload.pubKey,
      ...(payload.relay ? { relay: payload.relay } : {}),
    };
  }

  private load(): void {
    if (this.loaded) return;
    if (!existsSync(this.filePath)) { this.loaded = true; return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，请解锁后重试");
    try {
      const envelope = JSON.parse(readFileSync(this.filePath, "utf8")) as EncryptedFile;
      if (envelope.v !== 1) throw new Error("unsupported credential file");
      const records = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.data, "base64"))) as StoredRemoteHost[];
      if (!Array.isArray(records)) throw new Error("invalid credential file");
      const next = new Map<string, StoredRemoteHost>();
      let migrated = false;
      for (const record of records) {
        // Validate credentials without ever returning arbitrary disk fields to IPC.
        decodePairingQR(encodePairingQR({ v: 7, name: record.name, addrs: record.addrs, port: record.port,
          token: record.token, pubKey: record.daemonPubKey, ...(record.relay ? { relay: record.relay } : {}) }));
        if (record.id !== hostIdForDaemonPublicKey(record.daemonPubKey)) throw new Error("invalid host identity");
        if (!record.clientKeys) { record.clientKeys = generateKeyPairB64(); migrated = true; }
        if (Buffer.from(record.clientKeys.publicKey, "base64").length !== 32 || Buffer.from(record.clientKeys.secretKey, "base64").length !== 32) throw new Error("invalid client identity");
        next.set(record.id, record);
      }
      if (migrated) this.save(next);
      this.hosts = next;
      this.loaded = true;
    } catch {
      throw new Error("远程配对存储无法读取，原文件已保留，请检查系统钥匙串");
    }
  }

  private save(hosts: Map<string, StoredRemoteHost>): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，无法保存远程主机配对");
    mkdirSync(dirname(this.filePath), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify([...hosts.values()]));
    const envelope: EncryptedFile = { v: 1, data: encrypted.toString("base64") };
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(envelope) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.filePath);
    } finally { rmSync(temporary, { force: true }); }
  }
}
