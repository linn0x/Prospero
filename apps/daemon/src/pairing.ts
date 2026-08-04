/**
 * 身份与配对存储(~/.prospero,可用 PROSPERO_HOME 覆盖,测试用):
 * - identity.json  daemon 静态 X25519 密钥对(0600)
 * - devices.json   已配对设备:token、TOFU 绑定的客户端公钥、allowShell(0600)
 * - config.json    { port }
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  PROTOCOL_VERSION,
  generateKeyPairB64,
  toB64Url,
  type C2SHello,
  type KeyPairB64,
  type PairingPayload,
} from "@prospero/protocol";
import { candidateAddrs, resolveBindAddr } from "./discovery.js";

export const DEFAULT_PORT = 7423;

export interface DeviceRecord {
  name: string;
  token: string;
  /** 首次 hello 时 TOFU 绑定;之后公钥变化即拒绝 */
  clientPubKey?: string;
  allowShell: boolean;
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

export function loadDevices(home: string): DeviceRecord[] {
  return readJson<DevicesFile>(path.join(home, "devices.json"))?.devices ?? [];
}

export function saveDevices(home: string, devices: DeviceRecord[]): void {
  ensureHome(home);
  writeJsonPrivate(path.join(home, "devices.json"), { devices });
}

export function mintDevice(
  home: string,
  opts: { name: string; allowShell: boolean },
): DeviceRecord {
  const device: DeviceRecord = {
    name: opts.name,
    token: toB64Url(randomBytes(24)),
    allowShell: opts.allowShell,
    createdAt: Date.now(),
  };
  const devices = loadDevices(home);
  devices.push(device);
  saveDevices(home, devices);
  return device;
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

/**
 * 校验 hello:token 匹配 + TOFU 公钥绑定。
 * 成功返回设备记录(已更新 lastSeen / 绑定公钥),失败返回 null。
 */
export function authenticate(home: string, hello: C2SHello): DeviceRecord | null {
  const devices = loadDevices(home);
  const device = devices.find((d) => tokenEqual(d.token, hello.token));
  if (!device) return null;
  if (device.clientPubKey && device.clientPubKey !== hello.clientPubKey) {
    return null; // 公钥变化:可能是 token 泄漏被他人使用
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
  },
): PairingPayload {
  const identity = loadIdentity(home);
  const bound = opts.bind && opts.bind !== "0.0.0.0" ? resolveBindAddr(opts.bind) : null;
  return {
    v: PROTOCOL_VERSION,
    name: opts.name ?? os.hostname(),
    addrs: bound ? [bound] : candidateAddrs(),
    port: opts.port,
    token: opts.token,
    pubKey: identity.publicKey,
  };
}
