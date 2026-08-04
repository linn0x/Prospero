import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { resolveBindAddr } from "../src/discovery.js";

/** 造一份网卡表:en0 有地址,utun10 是 WG,lo0 是回环,utun99 只有 IPv6。 */
function fakeInterfaces(): ReturnType<typeof os.networkInterfaces> {
  const v4 = (address: string, internal = false) =>
    ({
      address,
      netmask: "255.255.255.0",
      family: "IPv4" as const,
      mac: "00:00:00:00:00:00",
      internal,
      cidr: `${address}/24`,
    });
  const v6 = {
    address: "fe80::1",
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6" as const,
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: "fe80::1/64",
    scopeid: 1,
  };
  return {
    lo0: [v4("127.0.0.1", true)],
    en0: [v4("192.168.31.101")],
    utun10: [v4("10.0.0.2")],
    utun99: [v6],
  };
}

describe("resolveBindAddr", () => {
  it("0.0.0.0 原样返回(代表不绑定)", () => {
    expect(resolveBindAddr("0.0.0.0")).toBe("0.0.0.0");
  });

  it("网卡名解析成该网卡的 IPv4", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue(fakeInterfaces());
    expect(resolveBindAddr("utun10")).toBe("10.0.0.2");
    expect(resolveBindAddr("en0")).toBe("192.168.31.101");
    vi.restoreAllMocks();
  });

  it("地址本身直接通过", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue(fakeInterfaces());
    expect(resolveBindAddr("10.0.0.2")).toBe("10.0.0.2");
    vi.restoreAllMocks();
  });

  it("只有 IPv6 的网卡报错(WG 没连上时就是这样)", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue(fakeInterfaces());
    expect(() => resolveBindAddr("utun99")).toThrow(/没有可用的 IPv4/);
    vi.restoreAllMocks();
  });

  it("不存在的网卡/地址报错,并列出当前可用的,不含回环", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue(fakeInterfaces());
    try {
      resolveBindAddr("utun404");
      expect.unreachable("应该抛错");
    } catch (e) {
      const msg = String(e);
      expect(msg).toContain("utun404");
      expect(msg).toContain("10.0.0.2"); // 列出了可用的
      expect(msg).not.toContain("127.0.0.1"); // 回环不该出现在建议里
    }
    vi.restoreAllMocks();
  });
});
