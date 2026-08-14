/**
 * 身份与配对存储(~/.prospero,可用 PROSPERO_HOME 覆盖,测试用):
 * - identity.json  daemon 静态 X25519 密钥对(0600)
 * - devices.json   已配对设备:token、TOFU 绑定的客户端公钥与能力(0600)
 * - config.json    { port }
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  PAIRING_FORMAT_VERSION,
  RELAY_PROTOCOL_VERSION,
  deriveRelayRouteId as deriveRelayRouteIdContract,
  generateKeyPairB64,
  toB64Url,
  type RelayPairing,
  type C2SHello,
  type KeyPairB64,
  type PairingPayload,
} from "@prospero/protocol";
import { candidateAddrs, resolveBindAddr } from "./discovery.js";

export const DEFAULT_PORT = 7423;

/** Published relay URL used when the local config has no explicit override. */
export function defaultRelayUrl(): string | undefined {
  return process.env["PROSPERO_DEFAULT_RELAY_URL"];
}

/** A 32-byte host secret is deliberately distinct from the daemon static identity key. */
export const RELAY_HOST_SECRET_BYTES = 32;

export interface DeviceRecord {
  name: string;
  token: string;
  /** 首次 hello 时 TOFU 绑定;之后公钥变化即拒绝 */
  clientPubKey?: string;
  allowShell: boolean;
  /** 省略表示沿用 allowShell，保证升级前已配对设备无需重新扫码。 */
  allowOrchestration?: boolean;
  /** Relay control-plane credentials. Missing fields mean this is a pre-relay pairing. */
  relayDeviceId?: string;
  relayToken?: string;
  createdAt: number;
  lastSeenAt?: number;
}

interface DevicesFile {
  devices: DeviceRecord[];
}

export interface DaemonConfig {
  port: number;
  /** 监听地址;省略 = 0.0.0.0(全部网卡)。可存网卡名或 IP */
  bind?: string;
  /** 推送通道(Bark / ntfy);未配置则不推送 */
  notify?: {
    url: string;
    deepLink?: string;
    throttleMs?: number;
  };
  /** Relay settings and its private per-host routing secret, all stored in 0600 config.json. */
  relay?: {
    enabled: boolean;
    /** Explicit full relay endpoint; omission uses PROSPERO_DEFAULT_RELAY_URL. */
    url?: string;
    /** base64url 32 bytes; never written to status/logs/QR. */
    hostSecret?: string;
  };
}

export interface RelayCredentials {
  deviceId: string;
  token: string;
}

export function prosperoHome(): string {
  return process.env["PROSPERO_HOME"] ?? path.join(os.homedir(), ".prospero");
}

export function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function writeJsonPrivate(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function loadIdentity(home: string): KeyPairB64 {
  ensureHome(home);
  const file = path.join(home, "identity.json");
  const existing = readJson<KeyPairB64>(file);
  if (existing) return existing;
  const kp = generateKeyPairB64();
  writeJsonPrivate(file, kp);
  return kp;
}

export function loadConfig(home: string): DaemonConfig {
  return readJson<DaemonConfig>(path.join(home, "config.json")) ?? { port: DEFAULT_PORT };
}

export function saveConfig(home: string, config: DaemonConfig): void {
  ensureHome(home);
  writeJsonPrivate(path.join(home, "config.json"), config);
}

/** Return the override first, then the deployment default. Empty strings are not useful URLs. */
export function effectiveRelayUrl(config: DaemonConfig): string | undefined {
  return config.relay?.url || defaultRelayUrl();
}

export function generateRelayHostSecret(): string {
  return toB64Url(randomBytes(RELAY_HOST_SECRET_BYTES));
}

/** Stable opaque selector; a leaked route ID never reveals the host secret. */
export function deriveRelayRouteId(hostSecret: string): string {
  return deriveRelayRouteIdContract(hostSecret);
}

export function deviceRelayCredentials(device: DeviceRecord): RelayCredentials | null {
  if (!device.relayDeviceId || !device.relayToken) return null;
  return { deviceId: device.relayDeviceId, token: device.relayToken };
}

export function loadDevices(home: string): DeviceRecord[] {
  return readJson<DevicesFile>(path.join(home, "devices.json"))?.devices ?? [];
}

export function saveDevices(home: string, devices: DeviceRecord[]): void {
  ensureHome(home);
  writeJsonPrivate(path.join(home, "devices.json"), { devices });
}

export function mintDevice(
  home: string,
  opts: { name: string; allowShell: boolean; allowOrchestration?: boolean },
): DeviceRecord {
  const device: DeviceRecord = {
    name: opts.name,
    token: toB64Url(randomBytes(24)),
    allowShell: opts.allowShell,
    allowOrchestration: opts.allowOrchestration ?? opts.allowShell,
    relayDeviceId: toB64Url(randomBytes(24)),
    relayToken: toB64Url(randomBytes(32)),
    createdAt: Date.now(),
  };
  const devices = loadDevices(home);
  devices.push(device);
  saveDevices(home, devices);
  return device;
}

/** 人工派发会在本机启动 agent，权限至少应与 shell 会话同级。 */
export function canDeviceOrchestrate(device: DeviceRecord): boolean {
  return device.allowShell && (device.allowOrchestration ?? device.allowShell);
}

/**
 * 换一把新的 daemon 身份密钥。
 *
 * 旧密钥能解开【已录下的】历史流量吗?不能 —— 协议 v1 起会话密钥来自双方临时密钥,
 * 静态密钥只做身份证明。所以轮换防的是另一件事:静态密钥泄漏后攻击者可以冒充这台
 * daemon 骗手机连上去。换掉即让泄漏的那把作废。
 *
 * 代价是所有设备的配对都失效(QR 里带的是旧公钥),所以一并清空设备表 ——
 * 留着它们只会让手机连上来后卡在"无法确认身份",还不如逼一次重新配对。
 */
export function rotateIdentity(home: string): KeyPairB64 {
  ensureHome(home);
  const fresh = generateKeyPairB64();
  writeJsonPrivate(path.join(home, "identity.json"), fresh);
  saveDevices(home, []);
  return fresh;
}

/**
 * 撤销设备。名字可能重复(mintDevice 不去重),所以全部同名一起撤 ——
 * 撤销要么彻底要么别做,留一条同名记录还能连上是最糟的结果。
 * 返回被撤掉的记录,便于 CLI 如实报告撤了几台。
 */
export function revokeDevices(home: string, name: string): DeviceRecord[] {
  const devices = loadDevices(home);
  const removed = devices.filter((d) => d.name === name);
  if (removed.length === 0) return [];
  saveDevices(
    home,
    devices.filter((d) => d.name !== name),
  );
  return removed;
}

function tokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** 认证失败的原因。两种情况处理方式完全不同,不能都笼统说"配对失效" */
export type AuthFailure =
  /** token 根本不在设备表里 —— 多半是配对码过期,或手机连的是另一台 daemon */
  | "unknown_token"
  /** token 对得上但公钥变了 —— 要么重装过 App,要么 token 被别人拿去用了 */
  | "key_mismatch";

/**
 * 校验 hello:token 匹配 + TOFU 公钥绑定。
 * 成功返回设备记录(已更新 lastSeen / 绑定公钥),失败返回 null。
 *
 * 失败原因通过 `onFail` 回调给出,而不是塞进返回值 —— 调用方拿到 null 就该拒绝,
 * 原因只用来记日志。发给客户端的错误文案仍然是模糊的:告诉对面"token 存在但
 * 公钥不对"就是在帮它猜。
 */
export function authenticate(
  home: string,
  hello: C2SHello,
  onFail?: (reason: AuthFailure) => void,
): DeviceRecord | null {
  const devices = loadDevices(home);
  const device = devices.find((d) => tokenEqual(d.token, hello.token));
  if (!device) {
    onFail?.("unknown_token");
    return null;
  }
  if (device.clientPubKey && device.clientPubKey !== hello.clientPubKey) {
    onFail?.("key_mismatch"); // 公钥变化:可能是 token 泄漏被他人使用
    return null;
  }
  device.clientPubKey = hello.clientPubKey;
  device.lastSeenAt = Date.now();
  saveDevices(home, devices);
  return device;
}

export function buildPairingPayload(
  home: string,
  opts: {
    token: string;
    port: number;
    name?: string | undefined;
    /** 已绑定到某个地址时,二维码只带这一个 —— 其余地址连不上,带了只会让客户端白试 */
    bind?: string | undefined;
    /** Relay credentials are separate from the E2E pairing token above. */
    relay?: RelayPairing | undefined;
  },
): PairingPayload {
  const identity = loadIdentity(home);
  const bound = opts.bind && opts.bind !== "0.0.0.0" ? resolveBindAddr(opts.bind) : null;
  return {
    v: PAIRING_FORMAT_VERSION,
    name: opts.name ?? os.hostname(),
    addrs: bound ? [bound] : candidateAddrs(),
    port: opts.port,
    token: opts.token,
    pubKey: identity.publicKey,
    ...(opts.relay ? { relay: opts.relay } : {}),
  };
}

/** Build the public relay portion of a QR without ever exposing hostSecret. */
export function relayPairingForDevice(
  config: DaemonConfig,
  device: DeviceRecord,
): RelayPairing | null {
  if (!config.relay?.enabled || !config.relay.hostSecret) return null;
  const url = effectiveRelayUrl(config);
  const credentials = deviceRelayCredentials(device);
  if (!url || !credentials) return null;
  return {
    v: RELAY_PROTOCOL_VERSION,
    url,
    routeId: deriveRelayRouteId(config.relay.hostSecret),
    deviceId: credentials.deviceId,
    token: credentials.token,
  };
}
