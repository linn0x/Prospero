import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, string>());
const secrets = vi.hoisted(() => new Map<string, string>());

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { storage.delete(key); }),
  },
}));

vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  isAvailableAsync: vi.fn(async () => true),
  getItemAsync: vi.fn(async (key: string) => secrets.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string) => { secrets.delete(key); }),
}));

import { generateKeyPairB64 } from "@prospero/protocol";
import * as SecureStore from "expo-secure-store";
import { getDeviceKeys, getHosts, removeHost } from "../src/lib/hosts";

beforeEach(() => {
  storage.clear();
  secrets.clear();
  vi.mocked(SecureStore.isAvailableAsync).mockResolvedValue(true);
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => secrets.get(key) ?? null);
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    secrets.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    secrets.delete(key);
  });
});

describe("配对凭据安全迁移", () => {
  it("把旧设备私钥迁到 Keychain/Keystore 后删除 AsyncStorage 副本", async () => {
    const keys = generateKeyPairB64();
    storage.set("prospero.deviceKeys.v1", JSON.stringify(keys));

    expect(await getDeviceKeys()).toEqual(keys);
    expect(storage.has("prospero.deviceKeys.v1")).toBe(false);
    expect(JSON.parse(secrets.get("prospero.deviceKeys.v2") ?? "null")).toEqual(keys);
  });

  it("把每台主机的 token 迁出地址簿，同时保留现有配对可用", async () => {
    storage.set("prospero.hosts.v1", JSON.stringify([{
      id: "host123",
      name: "MacBook",
      addrs: ["192.168.1.8"],
      port: 7423,
      token: "0123456789abcdef",
      daemonPub: generateKeyPairB64().publicKey,
      pairedAt: 1,
    }]));

    const hosts = await getHosts();
    expect(hosts[0]?.token).toBe("0123456789abcdef");
    expect(secrets.get("prospero.hostToken.v1.host123")).toBe("0123456789abcdef");
    const metadata = JSON.parse(storage.get("prospero.hosts.v1") ?? "[]") as Array<Record<string, unknown>>;
    expect(metadata[0]?.["token"]).toBeUndefined();
  });

  it("删除主机时也删除对应安全存储 token", async () => {
    secrets.set("prospero.hostToken.v1.host123", "0123456789abcdef");
    storage.set("prospero.hosts.v1", JSON.stringify([{
      id: "host123",
      name: "MacBook",
      addrs: ["192.168.1.8"],
      port: 7423,
      daemonPub: generateKeyPairB64().publicKey,
      pairedAt: 1,
    }]));

    await removeHost("host123");
    expect(await getHosts()).toEqual([]);
    expect(secrets.has("prospero.hostToken.v1.host123")).toBe(false);
  });

  it("多主机迁移有一项写入失败时保留全部旧 token，避免半迁移丢配对", async () => {
    const base = {
      name: "MacBook",
      addrs: ["192.168.1.8"],
      port: 7423,
      daemonPub: generateKeyPairB64().publicKey,
      pairedAt: 1,
    };
    storage.set("prospero.hosts.v1", JSON.stringify([
      { ...base, id: "host1", token: "token-one" },
      { ...base, id: "host2", token: "token-two" },
    ]));
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key.endsWith("host2")) throw new Error("Keychain busy");
      secrets.set(key, value);
    });

    expect(await getHosts()).toHaveLength(2);
    const persisted = JSON.parse(storage.get("prospero.hosts.v1") ?? "[]") as Array<{
      token?: string;
    }>;
    expect(persisted.map((host) => host.token)).toEqual(["token-one", "token-two"]);
  });
});
