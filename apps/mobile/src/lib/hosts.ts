/** 主机地址簿 + 设备身份密钥(AsyncStorage 持久化) */
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  generateKeyPairB64,
  type KeyPairB64,
  type PairingPayload,
} from "@prospero/protocol";

const HOSTS_KEY = "prospero.hosts.v1";
const DEVICE_KEYS_KEY = "prospero.deviceKeys.v1";

export interface StoredHost {
  /** daemon 公钥前缀,同一台 Mac 重新配对会覆盖而非新增 */
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

export async function getHosts(): Promise<StoredHost[]> {
  const raw = await AsyncStorage.getItem(HOSTS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as StoredHost[];
  } catch {
    return [];
  }
}

async function saveHosts(hosts: StoredHost[]): Promise<void> {
  await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(hosts));
}

export function hostIdFor(daemonPub: string): string {
  return daemonPub.slice(0, 16).replace(/[^a-zA-Z0-9]/g, "");
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

/** 设备身份密钥:首次生成后固定(daemon 侧 TOFU 绑定,换了会被拒) */
export async function getDeviceKeys(): Promise<KeyPairB64> {
  const raw = await AsyncStorage.getItem(DEVICE_KEYS_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as KeyPairB64;
    } catch {
      // 损坏则重新生成
    }
  }
  const keys = generateKeyPairB64();
  await AsyncStorage.setItem(DEVICE_KEYS_KEY, JSON.stringify(keys));
  return keys;
}
