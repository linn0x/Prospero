import { beforeEach, describe, expect, it, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";

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

const HOSTS_KEY = "prospero.hosts.v1";

function relayPairing(pubKey = generateKeyPairB64().publicKey) {
  return {
    v: 7,
    name: "MacBook",
    addrs: ["192.168.1.8"],
    port: 7423,
    token: "0123456789abcdef",
    pubKey,
    relay: {
      v: 1 as const,
      url: "wss://relay.example.com/v1",
      routeId: "route_0123456789",
      deviceId: "device_0123456789",
      token: "relay_token_0123456789",
    },
  };
}

function directPairing(pubKey: string) {
  const { relay: _relay, ...pairing } = relayPairing(pubKey);
  return pairing;
}

function relaySecretKeys(hostId: string) {
  return {
    e2e: `prospero.hostToken.v1.${hostId}`,
    relay: `prospero.relayToken.v1.${hostId}`,
  };
}

beforeEach(() => {
  storage.clear();
  secrets.clear();
  vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => storage.get(key) ?? null);
  vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
    storage.set(key, value);
  });
  vi.mocked(AsyncStorage.removeItem).mockImplementation(async (key) => {
    storage.delete(key);
  });
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

    const hosts = await getHosts();
    expect(hosts[0]).toMatchObject({
      token: "0123456789abcdef",
      relayToken: "relay_token_0123456789",
    });
    const persisted = JSON.parse(storage.get("prospero.hosts.v1") ?? "[]") as Array<{
      token?: string;
      relay?: { token?: string };
    }>;
    expect(persisted[0]?.token).toBe("0123456789abcdef");
    expect(persisted[0]?.relay?.token).toBe("relay_token_0123456789");
  });

  it("已有 relay 主机重新配对时，地址簿失败会恢复两把旧凭据与旧 route 元数据", async () => {
    const firstPairing = relayPairing();
    const first = await upsertHostFromPairing(firstPairing);
    await setHostConnectionMode(first.id, "relay");
    const keys = relaySecretKeys(first.id);
    const oldMetadata = storage.get(HOSTS_KEY);
    let failMetadataOnce = true;
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
      if (key === HOSTS_KEY && failMetadataOnce) {
        failMetadataOnce = false;
        throw new Error("address book full");
      }
      storage.set(key, value);
    });

    const replacement = {
      ...firstPairing,
      token: "fedcba9876543210",
      relay: {
        ...firstPairing.relay,
        routeId: "route_replacement_0123456789",
        deviceId: "device_replacement_0123456789",
        token: "relay_replacement_0123456789",
      },
    };
    await expect(upsertHostFromPairing(replacement)).rejects.toThrow("address book full");

    expect(secrets.get(keys.e2e)).toBe(firstPairing.token);
    expect(secrets.get(keys.relay)).toBe(firstPairing.relay.token);
    expect(storage.get(HOSTS_KEY)).toBe(oldMetadata);
    expect(storage.get(HOSTS_KEY)).not.toContain(replacement.token);
    expect(storage.get(HOSTS_KEY)).not.toContain(replacement.relay.token);
    expect(storage.get(HOSTS_KEY)).not.toContain(replacement.relay.routeId);
    expect(storage.get(HOSTS_KEY)).not.toContain(replacement.relay.deviceId);
    expect(JSON.parse(storage.get(HOSTS_KEY) ?? "[]")[0]?.connectionMode).toBe("relay");
  });

  it("旧 relay ticket 原本不存在时，地址簿失败会删除刚写入的新 ticket", async () => {
    const firstPairing = relayPairing();
    const first = await upsertHostFromPairing(firstPairing);
    const keys = relaySecretKeys(first.id);
    const oldMetadata = storage.get(HOSTS_KEY);
    secrets.delete(keys.relay);
    let failMetadataOnce = true;
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
      if (key === HOSTS_KEY && failMetadataOnce) {
        failMetadataOnce = false;
        throw new Error("address book full");
      }
      storage.set(key, value);
    });

    await expect(upsertHostFromPairing({
      ...firstPairing,
      token: "fedcba9876543210",
      relay: { ...firstPairing.relay, token: "relay_replacement_0123456789" },
    })).rejects.toThrow("address book full");

    expect(secrets.get(keys.e2e)).toBe(firstPairing.token);
    expect(secrets.has(keys.relay)).toBe(false);
    expect(storage.get(HOSTS_KEY)).toBe(oldMetadata);
  });

  it("首个 SecureStore 写入失败时不会改变已有 relay 主机", async () => {
    const firstPairing = relayPairing();
    const first = await upsertHostFromPairing(firstPairing);
    const keys = relaySecretKeys(first.id);
    const oldMetadata = storage.get(HOSTS_KEY);
    let writes = 0;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      writes += 1;
      if (writes === 1) throw new Error("first secure write failed");
      secrets.set(key, value);
    });

    await expect(upsertHostFromPairing({
      ...firstPairing,
      token: "fedcba9876543210",
      relay: { ...firstPairing.relay, token: "relay_replacement_0123456789" },
    })).rejects.toThrow("first secure write failed");

    expect(secrets.get(keys.e2e)).toBe(firstPairing.token);
    expect(secrets.get(keys.relay)).toBe(firstPairing.relay.token);
    expect(storage.get(HOSTS_KEY)).toBe(oldMetadata);
  });

  it("第二个 SecureStore 写入失败时会回滚已经更新的 E2E 与 relay ticket", async () => {
    const firstPairing = relayPairing();
    const first = await upsertHostFromPairing(firstPairing);
    const keys = relaySecretKeys(first.id);
    const oldMetadata = storage.get(HOSTS_KEY);
    let writes = 0;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      writes += 1;
      if (writes === 2) throw new Error("second secure write failed");
      secrets.set(key, value);
    });

    await expect(upsertHostFromPairing({
      ...firstPairing,
      token: "fedcba9876543210",
      relay: { ...firstPairing.relay, token: "relay_replacement_0123456789" },
    })).rejects.toThrow("second secure write failed");

    expect(secrets.get(keys.e2e)).toBe(firstPairing.token);
    expect(secrets.get(keys.relay)).toBe(firstPairing.relay.token);
    expect(storage.get(HOSTS_KEY)).toBe(oldMetadata);
  });

  it("补偿写入也失败时保守地保留旧地址簿与仍可用的旧凭据，并报告恢复失败", async () => {
    const firstPairing = relayPairing();
    const first = await upsertHostFromPairing(firstPairing);
    const keys = relaySecretKeys(first.id);
    const oldMetadata = storage.get(HOSTS_KEY);
    let writes = 0;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      writes += 1;
      if (writes === 2 || writes === 3) throw new Error("secure store unavailable");
      secrets.set(key, value);
    });

    await expect(upsertHostFromPairing({
      ...firstPairing,
      token: "fedcba9876543210",
      relay: { ...firstPairing.relay, token: "relay_replacement_0123456789" },
    })).rejects.toThrow("回滚未完全完成");

    expect(secrets.get(keys.e2e)).toBe(firstPairing.token);
    expect(secrets.get(keys.relay)).toBe(firstPairing.relay.token);
    expect(storage.get(HOSTS_KEY)).toBe(oldMetadata);
  });

  it("正常配对的 AsyncStorage 元数据绝不包含 E2E 或 relay secret", async () => {
    const pairing = relayPairing();
    await upsertHostFromPairing(pairing);

    const metadata = storage.get(HOSTS_KEY) ?? "";
    expect(metadata).not.toContain(pairing.token);
    expect(metadata).not.toContain(pairing.relay.token);
    expect(JSON.parse(metadata)[0]).toMatchObject({
      relay: {
        routeId: pairing.relay.routeId,
        deviceId: pairing.relay.deviceId,
      },
    });
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

  it("显式 relay 主机扫 direct-only QR 时会在任何写入前拒绝，并保留全部旧配对状态", async () => {
    const firstPairing = relayPairing();
    const first = await upsertHostFromPairing(firstPairing);
    await setHostConnectionMode(first.id, "relay");
    const keys = relaySecretKeys(first.id);
    const oldMetadata = storage.get(HOSTS_KEY);

    vi.mocked(AsyncStorage.setItem).mockClear();
    vi.mocked(AsyncStorage.removeItem).mockClear();
    vi.mocked(SecureStore.setItemAsync).mockClear();
    vi.mocked(SecureStore.deleteItemAsync).mockClear();

    await expect(upsertHostFromPairing({
      ...directPairing(firstPairing.pubKey),
      token: "fedcba9876543210",
    })).rejects.toBeInstanceOf(RelayCredentialsMissingError);

    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(storage.get(HOSTS_KEY)).toBe(oldMetadata);
    expect(secrets.get(keys.e2e)).toBe(firstPairing.token);
    expect(secrets.get(keys.relay)).toBe(firstPairing.relay.token);
    expect(JSON.parse(oldMetadata ?? "[]")[0]).toMatchObject({
      connectionMode: "relay",
      relay: {
        routeId: firstPairing.relay.routeId,
        deviceId: firstPairing.relay.deviceId,
      },
    });
  });

  it.each(["direct", "auto"] as const)(
    "保留 %s 主机扫 direct-only QR 的兼容重配行为",
    async (mode) => {
      const firstPairing = relayPairing();
      const first = await upsertHostFromPairing(firstPairing);
      if (mode === "direct") await setHostConnectionMode(first.id, mode);
      const keys = relaySecretKeys(first.id);

      const updated = await upsertHostFromPairing({
        ...directPairing(firstPairing.pubKey),
        token: "fedcba9876543210",
      });

      expect(updated).toMatchObject({
        connectionMode: mode,
        token: "fedcba9876543210",
      });
      expect(updated.relay).toBeUndefined();
      expect(updated.relayToken).toBeUndefined();
      expect(secrets.get(keys.e2e)).toBe("fedcba9876543210");
      expect(secrets.has(keys.relay)).toBe(false);
      expect(JSON.parse(storage.get(HOSTS_KEY) ?? "[]")[0]).toMatchObject({
        connectionMode: mode,
      });
    },
  );

  it("显式 relay 主机扫新 relay QR 时原子更新凭证和 route，同时保持 relay 模式", async () => {
    const firstPairing = relayPairing();
    const first = await upsertHostFromPairing(firstPairing);
    await setHostConnectionMode(first.id, "relay");
    const keys = relaySecretKeys(first.id);
    const replacement = {
      ...relayPairing(firstPairing.pubKey),
      token: "fedcba9876543210",
      relay: {
        ...firstPairing.relay,
        routeId: "route_replacement_0123456789",
        deviceId: "device_replacement_0123456789",
        token: "relay_replacement_0123456789",
      },
    };

    const updated = await upsertHostFromPairing(replacement);

    expect(updated).toMatchObject({
      connectionMode: "relay",
      token: replacement.token,
      relay: {
        routeId: replacement.relay.routeId,
        deviceId: replacement.relay.deviceId,
      },
      relayToken: replacement.relay.token,
    });
    expect(secrets.get(keys.e2e)).toBe(replacement.token);
    expect(secrets.get(keys.relay)).toBe(replacement.relay.token);
    expect(JSON.parse(storage.get(HOSTS_KEY) ?? "[]")[0]).toMatchObject({
      connectionMode: "relay",
      relay: {
        routeId: replacement.relay.routeId,
        deviceId: replacement.relay.deviceId,
      },
    });
  });
});
