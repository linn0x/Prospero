import { describe, expect, it } from "vitest";
import type { AgentEventBody } from "@prospero/protocol";

import {
  applyOverlayApprovalEvents,
  overlayApprovalKey,
  removeOverlayApproval,
} from "../src/lib/pending-overlay-approvals";

const request = {
  kind: "permission.request",
  reqId: "req-1",
  action: "bash",
  summary: "运行测试命令",
  resources: ["npm test"],
} satisfies AgentEventBody;

describe("悬浮窗审批状态", () => {
  it("从事件流保存请求，并在 resolved 后移除", () => {
    const pending = applyOverlayApprovalEvents(new Map(), "host", "session", [request], false, 10);
    expect(pending.get(overlayApprovalKey("host", "session", "req-1"))).toMatchObject({
      action: "bash",
      summary: "运行测试命令",
      resource: "npm test",
      receivedAt: 10,
    });

    const resolved = applyOverlayApprovalEvents(pending, "host", "session", [{
      kind: "permission.resolved",
      reqId: "req-1",
      reply: "once",
    }]);
    expect(resolved.size).toBe(0);
  });

  it("快照只重置对应会话，不会清掉其他设备的审批", () => {
    const first = applyOverlayApprovalEvents(new Map(), "host-a", "session-a", [request]);
    const second = applyOverlayApprovalEvents(first, "host-b", "session-b", [
      { ...request, reqId: "req-2" },
    ]);
    const reset = applyOverlayApprovalEvents(second, "host-a", "session-a", [], true);
    expect(reset.has(overlayApprovalKey("host-a", "session-a", "req-1"))).toBe(false);
    expect(reset.has(overlayApprovalKey("host-b", "session-b", "req-2"))).toBe(true);
  });

  it("本地提交后立即移除，避免用户连续点击两次", () => {
    const pending = applyOverlayApprovalEvents(new Map(), "host", "session", [request]);
    expect(removeOverlayApproval(pending, "host", "session", "req-1").size).toBe(0);
  });
});
