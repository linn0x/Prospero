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
import {
  getDeviceKeys,
  getHosts,
  RelayCredentialsMissingError,
  removeHost,
  setHostConnectionMode,
  upsertHostFromPairing,
} from "../src/lib/hosts";

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
    secrets.set("prospero.relayToken.v1.host123", "relay_token_0123456789");
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
    expect(secrets.has("prospero.relayToken.v1.host123")).toBe(false);
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

  it("把 relay ticket 存到不同 SecureStore key，地址簿只留下公开 route 元数据", async () => {
    storage.set("prospero.hosts.v1", JSON.stringify([{
      id: "host123",
      name: "MacBook",
      addrs: [],
      port: 7423,
      token: "0123456789abcdef",
      daemonPub: generateKeyPairB64().publicKey,
      pairedAt: 1,
      relay: {
        url: "wss://relay.example.com/v1",
        routeId: "route_0123456789",
        deviceId: "device_0123456789",
        token: "relay_token_0123456789",
      },
    }]));

    const hosts = await getHosts();
    expect(hosts[0]).toMatchObject({ connectionMode: "direct", relayToken: "relay_token_0123456789" });
    expect(secrets.get("prospero.hostToken.v1.host123")).toBe("0123456789abcdef");
    expect(secrets.get("prospero.relayToken.v1.host123")).toBe("relay_token_0123456789");
    const persisted = JSON.parse(storage.get("prospero.hosts.v1") ?? "[]") as Array<Record<string, unknown>>;
    expect(persisted[0]?.token).toBeUndefined();
    expect((persisted[0]?.relay as Record<string, unknown>).token).toBeUndefined();
    expect((persisted[0]?.relay as Record<string, unknown>).routeId).toBe("route_0123456789");
  });

  it("relay SecureStore 半迁移失败时保留旧 E2E 和 relay ticket", async () => {
    storage.set("prospero.hosts.v1", JSON.stringify([{
      id: "host123",
      name: "MacBook",
      addrs: [],
      port: 7423,
      token: "0123456789abcdef",
      daemonPub: generateKeyPairB64().publicKey,
      pairedAt: 1,
      relay: {
        url: "wss://relay.example.com/v1",
        routeId: "route_0123456789",
        deviceId: "device_0123456789",
        token: "relay_token_0123456789",
      },
    }]));
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key.includes("relayToken")) throw new Error("Keychain busy");
      secrets.set(key, value);
    });

    await getHosts();
    const persisted = JSON.parse(storage.get("prospero.hosts.v1") ?? "[]") as Array<{
      token?: string;
      relay?: { token?: string };
    }>;
    expect(persisted[0]?.token).toBe("0123456789abcdef");
    expect(persisted[0]?.relay?.token).toBe("relay_token_0123456789");
  });

  it("没有 QR ticket 时拒绝把主机保存为 relay 模式", async () => {
    secrets.set("prospero.hostToken.v1.host123", "0123456789abcdef");
    storage.set("prospero.hosts.v1", JSON.stringify([{
      id: "host123",
      name: "MacBook",
      addrs: ["192.168.1.8"],
      port: 7423,
      daemonPub: generateKeyPairB64().publicKey,
      pairedAt: 1,
      connectionMode: "direct",
      relay: {
        url: "wss://relay.example.com/v1",
        routeId: "route_0123456789",
        deviceId: "device_0123456789",
      },
    }]));

    await expect(setHostConnectionMode("host123", "relay")).rejects.toBeInstanceOf(
      RelayCredentialsMissingError,
    );
  });

  it("新的 relay QR 默认 auto，重新配对不覆盖用户已选的模式", async () => {
    const daemon = generateKeyPairB64().publicKey;
    const pairing = {
      v: 7,
      name: "MacBook",
      addrs: ["192.168.1.8"],
      port: 7423,
      token: "0123456789abcdef",
      pubKey: daemon,
      relay: {
        v: 1 as const,
        url: "wss://relay.example.com/v1",
        routeId: "route_0123456789",
        deviceId: "device_0123456789",
        token: "relay_token_0123456789",
      },
    };
    const first = await upsertHostFromPairing(pairing);
    expect(first.connectionMode).toBe("auto");

    await setHostConnectionMode(first.id, "direct");
    const again = await upsertHostFromPairing({ ...pairing, token: "fedcba9876543210" });
    expect(again.connectionMode).toBe("direct");
  });
});
