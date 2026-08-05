import os from "node:os";
import { describe, expect, it } from "vitest";
import { availableMemory, osIdentity } from "../src/host-stats.js";

describe("机器状态", () => {
  it("系统名是人能读的,不是 process.platform", () => {
    const { platform, version } = osIdentity();
    expect(platform).not.toBe("darwin");
    expect(platform).not.toBe("win32");
    if (process.platform === "darwin") {
      expect(platform).toBe("macOS");
      // sw_vers 给的是 macOS 版本(26.x),不是 Darwin 内核号(25.x)
      expect(version).not.toBe(os.release());
      expect(version).toMatch(/^\d+\./);
    }
    expect(version.length).toBeGreaterThan(0);
  });

  it("重复调用走缓存,不会每次握手都 fork 一个 sw_vers", () => {
    // 同一个对象引用 —— 值相等不足以证明没重新执行
    expect(osIdentity()).toBe(osIdentity());
  });

  it("可用内存落在合理区间,而不是 macOS 上恒等于 0", () => {
    const avail = availableMemory();
    expect(avail).toBeGreaterThan(0);
    expect(avail).toBeLessThanOrEqual(os.totalmem());
    if (process.platform === "darwin") {
      // 关键回归:os.freemem() 在 macOS 上只数完全空闲的页,占比常年个位数,
      // 照它画进度条会让每台正常的 Mac 都显示"内存快满了"
      expect(avail / os.totalmem()).toBeGreaterThan(0.05);
    }
  });
});
