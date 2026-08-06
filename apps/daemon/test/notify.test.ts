import { describe, expect, it, vi } from "vitest";
import { Notifier, type Poster } from "../src/notify.js";

const session = { title: "claude · repo", agent: "claude" as const };

function makeNotifier(now = () => 1000) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const post: Poster = (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return Promise.resolve({ ok: true, status: 200 });
  };
  const n = new Notifier({ url: "https://api.day.app/testkey" }, post, now);
  return { n, calls };
}

describe("推送通道", () => {
  it("未配置时不推送且 enabled=false", async () => {
    const n = new Notifier(null);
    expect(n.enabled).toBe(false);
    expect(await n.notifyPermission("s1", session, "Write", "/tmp/a.txt")).toBe(false);
  });

  it("推送内容只含元数据(会话名 + 动作 + 资源摘要)", async () => {
    const { n, calls } = makeNotifier();
    expect(await n.notifyPermission("s1", session, "Write", "/tmp/a.txt")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.day.app/testkey");
    expect(calls[0]!.body["title"]).toContain("claude · repo");
    expect(calls[0]!.body["body"]).toBe("Write: /tmp/a.txt");
    // 点击回 App
    expect(calls[0]!.body["url"]).toBe("prospero://");
  });

  it("同时带 Bark 与 ntfy 的字段(两端都能用)", async () => {
    const { n, calls } = makeNotifier();
    await n.notifyPermission("s1", session, "Bash", "rm -rf build");
    const b = calls[0]!.body;
    expect(b["body"]).toBe(b["message"]); // Bark 用 body,ntfy 用 message
    expect(b["level"]).toBe("timeSensitive");
    expect(b["group"]).toBe("Prospero");
  });

  it("ntfy 点击链接可直达对应会话", async () => {
    const { n, calls } = makeNotifier();
    const link = "prospero://host/mac1/session/s1";
    await n.notifyPermission("s1", session, "Bash", "pwd", link);
    expect(calls[0]!.body["click"]).toBe(link);
    expect(calls[0]!.body["url"]).toBe(link);
  });

  it("用户配置的 deepLink 可覆盖自动生成的会话链接", async () => {
    const calls: Record<string, unknown>[] = [];
    const n = new Notifier(
      { url: "https://ntfy.sh/topic", deepLink: "prospero://" },
      (_url, init) => {
        calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Promise.resolve({ ok: true, status: 200 });
      },
    );
    await n.notifyPermission("s1", session, "Write", "a", "prospero://host/h/session/s1");
    expect(calls[0]!["click"]).toBe("prospero://");
  });

  it("静默期内同一会话不重复推送", async () => {
    let t = 1000;
    const { n, calls } = makeNotifier(() => t);
    expect(await n.notifyPermission("s1", session, "Write", "a")).toBe(true);
    t += 5_000;
    expect(await n.notifyPermission("s1", session, "Write", "b")).toBe(false);
    expect(calls).toHaveLength(1);
    // 超过 30s 默认静默期后可再推
    t += 30_000;
    expect(await n.notifyPermission("s1", session, "Write", "c")).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("不同会话互不节流", async () => {
    const { n, calls } = makeNotifier();
    await n.notifyPermission("s1", session, "Write", "a");
    await n.notifyPermission("s2", session, "Write", "b");
    expect(calls).toHaveLength(2);
  });

  it("审批被处理后清掉节流,下次可立即推", async () => {
    let t = 1000;
    const { n, calls } = makeNotifier(() => t);
    await n.notifyPermission("s1", session, "Write", "a");
    n.clear("s1");
    t += 100;
    expect(await n.notifyPermission("s1", session, "Write", "b")).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("端点报错不抛异常,只返回 false", async () => {
    const post: Poster = () => Promise.reject(new Error("network down"));
    const n = new Notifier({ url: "https://x" }, post);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await n.notifyPermission("s1", session, "Write", "a")).toBe(false);
    warn.mockRestore();
  });

  it("非 2xx 也不抛异常", async () => {
    const post: Poster = () => Promise.resolve({ ok: false, status: 404 });
    const n = new Notifier({ url: "https://x" }, post);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await n.send({ title: "t", body: "b" })).toBe(false);
    warn.mockRestore();
  });
});
