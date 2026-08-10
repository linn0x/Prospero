/**
 * 局域网发现(Bonjour / mDNS,_prospero._tcp)。
 *
 * 用途有二:
 * 1. 配对前:让用户看到"附近有哪台 Mac 在跑 prosperod",确认不是白扫码;
 * 2. 配对后:Mac 换了 IP(换网/DHCP 续约)时自动学到新地址 —— 否则地址簿会过期。
 *
 * 注意:mDNS 组播不穿 WireGuard 隧道,所以 WG 场景永远发现不到,
 * 那条路径靠 QR 里带的静态地址。这也是发现只是"锦上添花"、不是必需品的原因。
 */
import { useEffect, useState } from "react";
import { Platform } from "react-native";

const SCAN_TIMEOUT_MS = 8_000;

export interface DiscoveredHost {
  name: string;
  addresses: string[];
  port: number;
}

type ZeroconfService = {
  name?: string;
  port?: number;
  addresses?: string[];
  host?: string;
};

interface ZeroconfLike {
  scan(type: string, protocol: string, domain: string): void;
  stop(): void;
  removeAllListeners?: () => void;
  on(event: string, cb: (service: ZeroconfService) => void): void;
}

/**
 * 扫描同网段的 prosperod。
 * 原生模块缺失(Expo Go / 未重新构建)时静默返回空列表,不影响手动配对。
 */
export function useDiscovery(enabled: boolean): {
  hosts: DiscoveredHost[];
  scanning: boolean;
  unavailable: boolean;
  timedOut: boolean;
} {
  const [hosts, setHosts] = useState<DiscoveredHost[]>([]);
  const [scanning, setScanning] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let found = false;
    let zc: ZeroconfLike | null = null;
    let scanTimer: ReturnType<typeof setTimeout> | null = null;

    // 扫描会立即清空旧结果并设置 loading；在 effect 完成后启动，避免同步
    // setState 造成额外渲染。cleanup 会拦住因 enabled 切换而过期的启动任务。
    queueMicrotask(() => {
      if (cancelled) return;
      setHosts([]);
      setUnavailable(false);
      setTimedOut(false);

      try {
        // 动态 require:模块不存在时不至于让整个屏幕崩掉
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Expo Go 可缺少该原生模块。
        const Zeroconf = require("react-native-zeroconf").default as new () => ZeroconfLike;
        zc = new Zeroconf();
      } catch {
        setUnavailable(true);
        return;
      }

      const onResolved = (service: ZeroconfService): void => {
        if (cancelled) return;
        const addresses = (service.addresses ?? []).filter((a) => a.includes("."));
        if (addresses.length === 0 || typeof service.port !== "number") return;
        found = true;
        setHosts((prev) => {
          const name = service.name ?? service.host ?? addresses[0]!;
          const rest = prev.filter((h) => h.name !== name);
          return [...rest, { name, addresses, port: service.port! }];
        });
      };

      zc.on("resolved", onResolved);
      zc.on("error", () => {
        if (!cancelled) {
          setUnavailable(true);
          setScanning(false);
        }
      });

      try {
        setScanning(true);
        zc.scan("prospero", "tcp", "local.");
        scanTimer = setTimeout(() => {
          if (cancelled) return;
          setScanning(false);
          if (!found) setTimedOut(true);
          try {
            zc?.stop();
          } catch {
            // 已停止或 ROM 的 NSD 实现抛错都不影响手动配对路径
          }
        }, SCAN_TIMEOUT_MS);
      } catch {
        setUnavailable(true);
        setScanning(false);
      }
    });

    return () => {
      cancelled = true;
      setScanning(false);
      if (scanTimer !== null) clearTimeout(scanTimer);
      try {
        zc?.stop();
        zc?.removeAllListeners?.();
      } catch {
        // 忽略清理错误
      }
    };
  }, [enabled]);

  return {
    hosts,
    scanning,
    unavailable: unavailable || Platform.OS === "web",
    timedOut,
  };
}
