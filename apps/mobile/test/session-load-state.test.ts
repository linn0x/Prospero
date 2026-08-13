import { describe, expect, it } from "vitest";
import { sessionLoadState } from "../src/lib/session-load-state";

describe("深链会话冷启动占位状态", () => {
  it("连接中与重连中显示连接状态，而不是误报会话失败", () => {
    expect(sessionLoadState("connecting", null)).toMatchObject({
      title: "正在连接到主机",
      showSpinner: true,
    });
    expect(sessionLoadState("reconnecting", null).detail).toContain("正在恢复");
  });

  it("失败保留 daemon 的可读错误并给出安全重试", () => {
    expect(sessionLoadState("failed", "Mac 拒绝连接")).toEqual({
      title: "无法连接到主机",
      detail: "Mac 拒绝连接",
      retryLabel: "重试连接",
      showSpinner: false,
    });
  });

  it("连接成功但 sid 还没进入会话表时单独说明会话尚未取得", () => {
    expect(sessionLoadState("connected", null)).toMatchObject({
      title: "会话尚未取得",
      retryLabel: "重新读取",
      showSpinner: true,
    });
  });
});
