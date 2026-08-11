import { describe, expect, it } from "vitest";
import { diagnose, type AttemptResult } from "../src/lib/connect-diagnosis";

const at = (addr: string, failure: AttemptResult["failure"], detail?: string): AttemptResult =>
  detail !== undefined ? { addr, failure, detail } : { addr, failure };

describe("连接失败诊断", () => {
  it("没有候选地址 → 编辑地址但保留配对,重试无意义", () => {
    const d = diagnose([], true);
    expect(d.fatal).toBe(true);
    expect(d.hint).toContain("无需重新扫码");
    expect(d.hint).toContain("连接设置");
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

  it("Android 首次不可达不误导用户寻找不存在的本地网络权限开关", () => {
    const d = diagnose([at("192.168.1.5", "unreachable")], true, "android");
    expect(d.hint).toContain("不需要单独");
    expect(d.hint).toContain("同一网络");
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

  it("超出兼容窗口时升级旧端但保留配对", () => {
    const d = diagnose([at("10.0.0.1", "version")], false);
    expect(d.summary).toContain("无共同协议版本");
    expect(d.hint).toContain("build-ipa");
    expect(d.hint).toContain("不要重新扫码");
    expect(d.fatal).toBe(true);
  });

  it("Android 版本不符时指向 APK 构建脚本", () => {
    const d = diagnose([at("10.0.0.1", "version")], false, "android");
    expect(d.hint).toContain("build-apk.sh");
  });

  it("设备被撤销时说清要重新配对,而不是含糊的握手失败", () => {
    const d = diagnose([at("10.0.0.1", "revoked")], false);
    expect(d.summary).toContain("已被移除");
    expect(d.hint).toContain("pair");
    expect(d.fatal).toBe(true);
  });

  it("身份证明失败优先于网络问题呈现,并提示先别连", () => {
    const d = diagnose(
      [at("a", "unreachable"), at("b", "untrusted"), at("c", "timeout")],
      false,
    );
    expect(d.summary).toContain("身份");
    expect(d.hint).toContain("冒充");
    expect(d.fatal).toBe(true);
  });

  it("撤销与版本不符都排在普通鉴权失败之前", () => {
    expect(diagnose([at("a", "auth"), at("b", "revoked")], false).summary).toContain("已被移除");
    expect(diagnose([at("a", "auth"), at("b", "version")], false).summary).toContain("无共同协议版本");
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
      [at("a", "version")],
      [at("a", "revoked")],
      [at("a", "untrusted")],
    ];
    for (const c of cases) {
      const d = diagnose(c, false);
      expect(d.summary.length).toBeGreaterThan(0);
      expect(d.hint.length).toBeGreaterThan(10);
    }
  });
});
