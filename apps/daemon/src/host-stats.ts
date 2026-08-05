import { execFileSync } from "node:child_process";
import os from "node:os";

/**
 * 机器状态。
 *
 * 直接把 node 的 os.* 发给手机看过一版,结果是"darwin 25.5.0"和"内存 23.8/24 GB
 * 常年 99% 飘红" —— 前者是给程序看的,后者干脆是错的:macOS 上 os.freemem()
 * 只数完全空闲的页,被文件缓存和可回收内存占着的部分一律算"已用",所以任何一台
 * 正常运行的 Mac 看上去都像要爆了。用户会照着这个数去关东西,而其实什么事都没有。
 */

/** 缓存系统版本 —— 它在 daemon 活着的时候不会变,不必每次握手都 fork 一个进程 */
let cachedOs: { platform: string; version: string } | null = null;

function sh(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 2000 }).trim();
  } catch {
    return null;
  }
}

/** 人能读的系统名与版本。取不到就退回内核版本,总比空着强 */
export function osIdentity(): { platform: string; version: string } {
  if (cachedOs) return cachedOs;
  let platform = process.platform as string;
  let version = os.release();
  if (process.platform === "darwin") {
    platform = "macOS";
    // Darwin 内核号(25.5.0)和 macOS 版本号(26.x)对不上,只能问 sw_vers
    version = sh("sw_vers", ["-productVersion"]) ?? version;
  } else if (process.platform === "linux") {
    platform = "Linux";
  } else if (process.platform === "win32") {
    platform = "Windows";
  }
  cachedOs = { platform, version };
  return cachedOs;
}

/**
 * 可用内存,字节。
 *
 * macOS 上按活动监视器的口径算:已用 = 活跃 + 联动(wired)+ 已压缩,
 * 其余(空闲、非活跃、可清除、文件缓存)都是随时能拿回来的,算可用。
 * 这样得出的数和用户在活动监视器里看到的对得上 —— 对不上的数字没人会信。
 */
export function availableMemory(): number {
  if (process.platform !== "darwin") return os.freemem();
  const out = sh("vm_stat", []);
  if (out === null) return os.freemem();

  const pageSize = /page size of (\d+) bytes/.exec(out)?.[1];
  const pages = (label: string): number => {
    const m = new RegExp(`${label}:\\s+(\\d+)`).exec(out);
    return m ? Number(m[1]) : 0;
  };
  const size = pageSize !== undefined ? Number(pageSize) : 4096;
  const used =
    pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor");
  const avail = os.totalmem() - used * size;
  // vm_stat 的口径和 totalmem 偶尔会打架(比如跑在虚拟机里),算出负数就退回去
  return avail > 0 && avail <= os.totalmem() ? avail : os.freemem();
}
