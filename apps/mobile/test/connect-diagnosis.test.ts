import { describe, expect, it } from "vitest";
import { diagnose, type AttemptResult } from "../src/lib/connect-diagnosis";

const at = (addr: string, failure: AttemptResult["failure"], detail?: string): AttemptResult =>
  detail !== undefined ? { addr, failure, detail } : { addr, failure };

describe("连接失败诊断", () => {
  it("没有候选地址 → 需要重新配对,重试无意义", () => {
    const d = diagnose([], true);
    expect(d.fatal).toBe(true);
    expect(d.hint).toContain("重新扫码");
  });

  it("鉴权失败优先于其他原因,且不再重试", () => {
    const d = diagnose([at("10.0.0.1", "timeout"), at("10.0.0.2", "auth")], false);
    expect(d.fatal).toBe(true);
    expect(d.summary).toContain("配对已失效");
    expect(d.hint).toContain("prosperod pair");
  });

  it("首次连接全部不可达 → 指向本地网络权限", () => {
    const d = diagnose([at("192.168.1.5", "unreachable")], true);
    expect(d.fatal).toBe(false);
    expect(d.hint).toContain("本地网络");
  });

  it("曾连接成功过再全部不可达 → 指向网络/休眠而非权限", () => {
    const d = diagnose([at("192.168.1.5", "unreachable")], false);
    expect(d.hint).not.toContain("本地网络");
    expect(d.hint).toContain("同一网络");
  });

  it("超时 → 指向 daemon 未运行或防火墙", () => {
    const d = diagnose([at("10.8.0.2", "timeout")], false);
    expect(d.summary).toContain("无应答");
    expect(d.hint).toContain("prosperod");
  });

  it("协议版本不一致给出明确指引", () => {
    const d = diagnose([at("10.0.0.1", "handshake", "version")], false);
    expect(d.hint).toContain("协议版本");
  });

  it("混合失败时超时优先(说明至少有地址可达)", () => {
    const d = diagnose([at("a", "unreachable"), at("b", "timeout")], false);
    expect(d.summary).toContain("无应答");
  });

  it("诊断结论始终带可执行的下一步", () => {
    const cases: AttemptResult[][] = [
      [at("a", "unreachable")],
      [at("a", "timeout")],
      [at("a", "handshake")],
      [at("a", "auth")],
    ];
    for (const c of cases) {
      const d = diagnose(c, false);
      expect(d.summary.length).toBeGreaterThan(0);
      expect(d.hint.length).toBeGreaterThan(10);
    }
  });
});
