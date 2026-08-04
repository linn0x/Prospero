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

export function candidateAddrs(): string[] {
  const en: string[] = [];
  const utun: string[] = [];
  const other: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== "IPv4") continue;
      if (name.startsWith("en")) en.push(a.address);
      else if (name.startsWith("utun")) utun.push(a.address);
      else other.push(a.address);
    }
  }
  return [...en, ...utun, ...other];
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
