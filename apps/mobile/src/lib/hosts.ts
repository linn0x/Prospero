/** 主机地址簿 + Keychain/Keystore 中的配对凭据。 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import {
  generateKeyPairB64,
  hostIdForDaemonPublicKey,
  validateRelayUrl,
  type KeyPairB64,
  type PairingPayload,
} from "@prospero/protocol";

const HOSTS_KEY = "prospero.hosts.v1";
const DEVICE_KEYS_KEY = "prospero.deviceKeys.v1";
const DEVICE_KEYS_SECURE_KEY = "prospero.deviceKeys.v2";
const HOST_TOKEN_PREFIX = "prospero.hostToken.v1.";
const HOST_RELAY_TOKEN_PREFIX = "prospero.relayToken.v1.";
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
  /** E2E pairing secret and relay ticket are intentionally never interchangeable. */
  relayToken?: string;
  daemonPub: string;
  pairedAt: number;
  /** New QR codes with relay start in auto; old records migrate to direct. */
  connectionMode: ConnectionMode;
  /** Route metadata is safe to put in AsyncStorage; its ticket is not. */
  relay?: RelayMetadata;
  /** 上次成功连上的地址,下次优先尝试(切网后通常仍是它) */
  lastGoodAddr?: string;
}

export type ConnectionMode = "auto" | "direct" | "relay";

export interface RelayMetadata {
  url: string;
  routeId: string;
  deviceId: string;
}

type PersistedRelay = RelayMetadata & { token?: string };
type PersistedHost = Omit<StoredHost, "token" | "relayToken" | "relay" | "connectionMode"> & {
  token?: string;
  relayToken?: string;
  relay?: PersistedRelay;
  connectionMode?: ConnectionMode;
};

export class RelayCredentialsMissingError extends Error {
  constructor() {
    super("中继凭证缺失，请重新扫码配对");
    this.name = "RelayCredentialsMissingError";
  }
}

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

function relayTokenKey(hostId: string): string {
  return `${HOST_RELAY_TOKEN_PREFIX}${hostId}`;
}

function withoutSecrets(host: StoredHost): PersistedHost {
  const { token: _token, relayToken: _relayToken, ...metadata } = host;
  return metadata;
}

function normalConnectionMode(value: unknown): ConnectionMode {
  return value === "auto" || value === "direct" || value === "relay" ? value : "direct";
}

function relayMetadata(value: PersistedRelay | undefined): RelayMetadata | undefined {
  if (!value) return undefined;
  if (
    typeof value.url !== "string" ||
    typeof value.routeId !== "string" ||
    typeof value.deviceId !== "string"
  ) return undefined;
  return { url: value.url, routeId: value.routeId, deviceId: value.deviceId };
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
  let migrateMetadata = false;
  for (const persisted of stored) {
    if (persisted.connectionMode === undefined) migrateMetadata = true;
    const legacyToken = typeof persisted.token === "string" ? persisted.token : null;
    const metadata = relayMetadata(persisted.relay);
    const legacyRelayToken = typeof persisted.relay?.token === "string"
      ? persisted.relay.token
      : typeof persisted.relayToken === "string"
        ? persisted.relayToken
        : null;
    let token: string | null = null;
    let relayToken: string | null = null;
    if (secure) {
      try {
        token = await SecureStore.getItemAsync(hostTokenKey(persisted.id), SECURE_OPTIONS);
        if (!token && legacyToken) {
          await SecureStore.setItemAsync(hostTokenKey(persisted.id), legacyToken, SECURE_OPTIONS);
          token = legacyToken;
        }
        if (metadata) {
          relayToken = await SecureStore.getItemAsync(relayTokenKey(persisted.id), SECURE_OPTIONS);
          if (!relayToken && legacyRelayToken) {
            await SecureStore.setItemAsync(
              relayTokenKey(persisted.id),
              legacyRelayToken,
              SECURE_OPTIONS,
            );
            relayToken = legacyRelayToken;
          }
        }
        if ((token && legacyToken) || (relayToken && legacyRelayToken)) stripLegacyTokens = true;
      } catch {
        // Keychain 暂时不可用时仍保留旧存储，绝不因一次读取失败覆盖凭据。
        token = legacyToken;
        relayToken = legacyRelayToken;
        if (legacyToken || legacyRelayToken) allLegacyTokensSecured = false;
      }
    } else {
      token = legacyToken;
      relayToken = legacyRelayToken;
    }
    if (token) {
      const { relay: _legacyRelay, relayToken: _legacyRelayToken, token: _legacyToken, ...rest } = persisted;
      hosts.push({
        ...rest,
        token,
        connectionMode: normalConnectionMode(persisted.connectionMode),
        ...(metadata ? { relay: metadata } : {}),
        ...(relayToken ? { relayToken } : {}),
      });
    }
  }
  if (secure && (stripLegacyTokens || migrateMetadata) && allLegacyTokensSecured) {
    const sanitized = stored.map(({ token: _token, relayToken: _relayToken, relay, ...metadata }) => ({
      ...metadata,
      connectionMode: normalConnectionMode(metadata.connectionMode),
      ...(relay ? { relay: relayMetadata(relay) } : {}),
    }));
    try {
      await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(sanitized));
    } catch {
      // Secure writes already succeeded; keeping the old address book is safe
      // and lets a later launch finish removing its legacy plaintext token.
    }
  }
  return hosts;
}

async function saveHosts(hosts: StoredHost[]): Promise<void> {
  if (!await secureAvailable()) {
    throw new Error("安全存储不可用，无法保存配对凭证");
  }
  // Do not write a new plaintext fallback. If either secure write or metadata
  // write fails, leave the previous address book untouched so a legacy token
  // remains recoverable on the next migration attempt.
  await Promise.all(
    hosts.flatMap((host) => [
      SecureStore.setItemAsync(hostTokenKey(host.id), host.token, SECURE_OPTIONS),
      ...(host.relayToken
        ? [SecureStore.setItemAsync(relayTokenKey(host.id), host.relayToken, SECURE_OPTIONS)]
        : []),
    ]),
  );
  await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(hosts.map(withoutSecrets)));
}

export function hostIdFor(daemonPub: string): string {
  return hostIdForDaemonPublicKey(daemonPub);
}

export async function upsertHostFromPairing(p: PairingPayload): Promise<StoredHost> {
  if (p.relay) {
    validateRelayUrl(p.relay.url, {
      allowInsecureLoopback: typeof __DEV__ !== "undefined" && __DEV__,
    });
  }
  const hosts = await getHosts();
  const id = hostIdFor(p.pubKey);
  const existing = hosts.find((h) => h.id === id);
  const host: StoredHost = {
    id,
    name: p.name,
    addrs: p.addrs,
    port: p.port,
    token: p.token,
    daemonPub: p.pubKey,
    pairedAt: Date.now(),
    connectionMode: existing?.connectionMode ?? (p.relay ? "auto" : "direct"),
    ...(p.relay
      ? {
          relay: {
            url: p.relay.url,
            routeId: p.relay.routeId,
            deviceId: p.relay.deviceId,
          },
          relayToken: p.relay.token,
        }
      : {}),
  };
  const i = hosts.findIndex((h) => h.id === id);
  if (i >= 0) hosts[i] = host;
  else hosts.push(host);
  await saveHosts(hosts);
  // A newer direct-only pairing intentionally revokes the obsolete local
  // relay ticket only after metadata has been persisted successfully.
  if (!p.relay && existing && await secureAvailable()) {
    await SecureStore.deleteItemAsync(relayTokenKey(id), SECURE_OPTIONS).catch(() => {});
  }
  return host;
}

export async function removeHost(id: string): Promise<void> {
  await saveHosts((await getHosts()).filter((h) => h.id !== id));
  if (await secureAvailable()) {
    await SecureStore.deleteItemAsync(hostTokenKey(id), SECURE_OPTIONS).catch(() => {});
    await SecureStore.deleteItemAsync(relayTokenKey(id), SECURE_OPTIONS).catch(() => {});
  }
}

/** Changing modes never invents a relay credential.  It must come from a QR. */
export async function setHostConnectionMode(hostId: string, mode: ConnectionMode): Promise<void> {
  const hosts = await getHosts();
  const h = hosts.find((x) => x.id === hostId);
  if (!h) return;
  if (mode === "relay" && (!h.relay || !h.relayToken)) throw new RelayCredentialsMissingError();
  h.connectionMode = mode;
  await saveHosts(hosts);
}

/** Relay tickets stay in SecureStore; settings may edit only the public URL. */
export async function setHostRelayUrl(hostId: string, url: string): Promise<void> {
  const hosts = await getHosts();
  const h = hosts.find((x) => x.id === hostId);
  if (!h) return;
  if (!h.relay || !h.relayToken) throw new RelayCredentialsMissingError();
  validateRelayUrl(url, { allowInsecureLoopback: typeof __DEV__ !== "undefined" && __DEV__ });
  h.relay = { ...h.relay, url };
  await saveHosts(hosts);
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
