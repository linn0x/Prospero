/** 主机地址簿 + Keychain/Keystore 中的配对凭据。 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import {
  generateKeyPairB64,
  hostIdForDaemonPublicKey,
  type KeyPairB64,
  type PairingPayload,
} from "@prospero/protocol";

const HOSTS_KEY = "prospero.hosts.v1";
const DEVICE_KEYS_KEY = "prospero.deviceKeys.v1";
const DEVICE_KEYS_SECURE_KEY = "prospero.deviceKeys.v2";
const HOST_TOKEN_PREFIX = "prospero.hostToken.v1.";
const SECURE_OPTIONS = {
  // 不随整机备份复制到另一台设备；同一 bundle id 重装时 iOS Keychain 仍可恢复。
  // 不启用 requireAuthentication，避免用户增删 Face ID 后配对密钥被系统作废。
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  keychainService: "com.linn0x.prospero.remote.credentials",
};

export interface StoredHost {
/** daemon 公钥前缀,同一台电脑重新配对会覆盖而非新增 */
  id: string;
  name: string;
  addrs: string[];
  port: number;
  token: string;
  daemonPub: string;
  pairedAt: number;
  /** 上次成功连上的地址,下次优先尝试(切网后通常仍是它) */
  lastGoodAddr?: string;
}

type PersistedHost = Omit<StoredHost, "token"> & { token?: string };

async function secureAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

function hostTokenKey(hostId: string): string {
  return `${HOST_TOKEN_PREFIX}${hostId}`;
}

function withoutToken(host: StoredHost): PersistedHost {
  const { token: _token, ...metadata } = host;
  return metadata;
}

function parseKeyPair(raw: string | null): KeyPairB64 | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<KeyPairB64>;
    return typeof value.publicKey === "string" && typeof value.secretKey === "string"
      ? { publicKey: value.publicKey, secretKey: value.secretKey }
      : null;
  } catch {
    return null;
  }
}

export async function getHosts(): Promise<StoredHost[]> {
  const raw = await AsyncStorage.getItem(HOSTS_KEY);
  if (!raw) return [];
  let stored: PersistedHost[];
  try {
    stored = JSON.parse(raw) as PersistedHost[];
  } catch {
    return [];
  }
  const secure = await secureAvailable();
  const hosts: StoredHost[] = [];
  let stripLegacyTokens = false;
  let allLegacyTokensSecured = true;
  for (const persisted of stored) {
    const legacyToken = typeof persisted.token === "string" ? persisted.token : null;
    let token: string | null = null;
    if (secure) {
      try {
        token = await SecureStore.getItemAsync(hostTokenKey(persisted.id), SECURE_OPTIONS);
        if (!token && legacyToken) {
          await SecureStore.setItemAsync(hostTokenKey(persisted.id), legacyToken, SECURE_OPTIONS);
          token = legacyToken;
        }
        if (token && legacyToken) stripLegacyTokens = true;
      } catch {
        // Keychain 暂时不可用时仍保留旧存储，绝不因一次读取失败覆盖凭据。
        token = legacyToken;
        if (legacyToken) allLegacyTokensSecured = false;
      }
    } else {
      token = legacyToken;
    }
    if (token) hosts.push({ ...persisted, token });
  }
  if (secure && stripLegacyTokens && allLegacyTokensSecured) {
    const sanitized = stored.map(({ token: _token, ...metadata }) => metadata);
    await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(sanitized));
  }
  return hosts;
}

async function saveHosts(hosts: StoredHost[]): Promise<void> {
  if (await secureAvailable()) {
    try {
      await Promise.all(
        hosts.map((host) =>
          SecureStore.setItemAsync(hostTokenKey(host.id), host.token, SECURE_OPTIONS),
        ),
      );
      await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(hosts.map(withoutToken)));
      return;
    } catch {
      // 写安全存储失败时退回旧格式，宁可下次再迁移，也不能把可用 token 弄丢。
    }
  }
  await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(hosts));
}

export function hostIdFor(daemonPub: string): string {
  return hostIdForDaemonPublicKey(daemonPub);
}

export async function upsertHostFromPairing(p: PairingPayload): Promise<StoredHost> {
  const hosts = await getHosts();
  const id = hostIdFor(p.pubKey);
  const host: StoredHost = {
    id,
    name: p.name,
    addrs: p.addrs,
    port: p.port,
    token: p.token,
    daemonPub: p.pubKey,
    pairedAt: Date.now(),
  };
  const i = hosts.findIndex((h) => h.id === id);
  if (i >= 0) hosts[i] = host;
  else hosts.push(host);
  await saveHosts(hosts);
  return host;
}

export async function removeHost(id: string): Promise<void> {
  await saveHosts((await getHosts()).filter((h) => h.id !== id));
  if (await secureAvailable()) {
    await SecureStore.deleteItemAsync(hostTokenKey(id), SECURE_OPTIONS).catch(() => {});
  }
}

/** 地址学习:记住成功连上的地址,并把它并入候选表 */
export async function rememberGoodAddr(hostId: string, addr: string): Promise<void> {
  const hosts = await getHosts();
  const h = hosts.find((x) => x.id === hostId);
  if (!h || h.lastGoodAddr === addr) return;
  h.lastGoodAddr = addr;
  if (!h.addrs.includes(addr)) h.addrs = [addr, ...h.addrs];
  await saveHosts(hosts);
}

/** 发现或手动添加的新地址并入候选(如 mDNS 发现到的新 IP) */
export async function addHostAddr(hostId: string, addr: string): Promise<void> {
  const hosts = await getHosts();
  const h = hosts.find((x) => x.id === hostId);
  if (!h || h.addrs.includes(addr)) return;
  h.addrs = [...h.addrs, addr];
  await saveHosts(hosts);
}

/**
 * 删除一个候选地址。
 * 允许删到空 —— 用户可能想只留 WireGuard 那一条,或者先清空再重填。
 * 真删空了连接层会给出"没有可用地址"的诊断,不会静默失败。
 */
export async function removeHostAddr(hostId: string, addr: string): Promise<void> {
  const hosts = await getHosts();
  const h = hosts.find((x) => x.id === hostId);
  if (!h) return;
  h.addrs = h.addrs.filter((a) => a !== addr);
  if (h.lastGoodAddr === addr) delete h.lastGoodAddr;
  await saveHosts(hosts);
}

/** 改端口。换端口不该要求重新配对 —— token 和公钥都没变。 */
export async function setHostPort(hostId: string, port: number): Promise<void> {
  const hosts = await getHosts();
  const h = hosts.find((x) => x.id === hostId);
  if (!h) return;
  h.port = port;
  await saveHosts(hosts);
}

/** 设备身份密钥:首次生成后固定(daemon 侧 TOFU 绑定,换了会被拒) */
export async function getDeviceKeys(): Promise<KeyPairB64> {
  const secure = await secureAvailable();
  if (secure) {
    try {
      const saved = parseKeyPair(
        await SecureStore.getItemAsync(DEVICE_KEYS_SECURE_KEY, SECURE_OPTIONS),
      );
      if (saved) return saved;
    } catch {
      // 继续尝试迁移旧值；只有两处都没有才生成新身份。
    }
  }

  const legacy = parseKeyPair(await AsyncStorage.getItem(DEVICE_KEYS_KEY));
  if (legacy) {
    if (secure) {
      try {
        await SecureStore.setItemAsync(
          DEVICE_KEYS_SECURE_KEY,
          JSON.stringify(legacy),
          SECURE_OPTIONS,
        );
        await AsyncStorage.removeItem(DEVICE_KEYS_KEY);
      } catch {
        // 保留 AsyncStorage 副本，下次启动继续迁移。
      }
    }
    return legacy;
  }

  const keys = generateKeyPairB64();
  if (secure) {
    try {
      await SecureStore.setItemAsync(
        DEVICE_KEYS_SECURE_KEY,
        JSON.stringify(keys),
        SECURE_OPTIONS,
      );
      return keys;
    } catch {
      // 极少数设备的 Keychain/Keystore 不可写，仍保持旧行为。
    }
  }
  await AsyncStorage.setItem(DEVICE_KEYS_KEY, JSON.stringify(keys));
  return keys;
}
