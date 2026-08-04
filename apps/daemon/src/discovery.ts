/**
 * 网卡枚举 + Bonjour 广播。
 * - 候选地址覆盖 en*(WiFi/有线)与 utun*(WireGuard);QR 配对载荷全量携带,
 *   客户端并发竞速 —— mDNS 组播不过 WG 隧道,WG 场景靠 QR 地址簿。
 * - macOS 15+ 本地网络 TCC 可能拦 Bonjour;失败仅降级为"无广播",不影响直连。
 */
import { createRequire } from "node:module";
import os from "node:os";
import type { Bonjour as BonjourType } from "bonjour-service";

const require = createRequire(import.meta.url);
const { Bonjour } = require("bonjour-service") as {
  Bonjour: typeof BonjourType;
};

/**
 * 手机连不上的地址。带进配对二维码只会让客户端在竞速时白试几条死路,
 * 还会把连接诊断搅浑(某个地址"超时"其实是它根本不该在列表里)。
 */
function unusable(addr: string): boolean {
  // 198.18/15 是 RFC2544 基准测试段,Surge/Clash 这类工具拿它做 TUN
  if (addr.startsWith("198.18.") || addr.startsWith("198.19.")) return true;
  // 169.254/16 link-local:没拿到 DHCP 时的自赋地址,不可路由
  if (addr.startsWith("169.254.")) return true;
  // 以 .0 结尾的通常是网段地址而非主机地址(/24 下必然如此)
  if (addr.endsWith(".0")) return true;
  return false;
}

export function candidateAddrs(): string[] {
  const en: string[] = [];
  const utun: string[] = [];
  const other: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== "IPv4") continue;
      if (unusable(a.address)) continue;
      if (name.startsWith("en")) en.push(a.address);
      else if (name.startsWith("utun")) utun.push(a.address);
      else other.push(a.address);
    }
  }
  return [...en, ...utun, ...other];
}

/**
 * 把 `--bind` 的值解析成一个 IPv4 地址。
 * 接受网卡名(`utun10`、`en0`)或地址本身;网卡名更好记,但 WireGuard 重连后
 * utun 编号会变,所以地址才是稳的 —— 两种都收。
 */
export function resolveBindAddr(spec: string): string {
  if (spec === "0.0.0.0" || spec === "::") return spec;

  const ifaces = os.networkInterfaces();
  const named = ifaces[spec];
  if (named) {
    const v4 = named.find((a) => a.family === "IPv4" && !a.internal);
    if (v4) return v4.address;
    throw new Error(`网卡 ${spec} 上没有可用的 IPv4 地址(没连上?)`);
  }

  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && a.address === spec) return spec;
    }
  }
  throw new Error(
    `本机没有地址或网卡叫 "${spec}"。当前可用:\n` +
      Object.entries(ifaces)
        .flatMap(([name, addrs]) =>
          (addrs ?? [])
            .filter((a) => a.family === "IPv4" && !a.internal)
            .map((a) => `  ${name.padEnd(8)} ${a.address}`),
        )
        .join("\n"),
  );
}

/** 广播 _prospero._tcp;返回停止函数。失败静默降级(仅日志)。 */
export function advertise(port: number, name: string): () => void {
  try {
    const bonjour = new Bonjour();
    const service = bonjour.publish({ name, type: "prospero", port });
    return () => {
      try {
        service.stop?.(() => {});
        bonjour.destroy();
      } catch {
        // 忽略停止时的错误
      }
    };
  } catch (e) {
    console.warn(
      `[prosperod] Bonjour 广播失败(不影响直连): ${e instanceof Error ? e.message : String(e)}`,
    );
    return () => {};
  }
}
