import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, needsApproval, policyLabel } from "../src/approval-policy.js";
import { StructuredSession } from "../src/structured-session.js";
import type { AdapterContext, AgentAdapter } from "../src/adapters/types.js";
import type { PermissionReply } from "@prospero/protocol";

describe("审批策略", () => {
  it("默认是每次询问 —— 放宽必须是用户主动选的", () => {
    expect(DEFAULT_POLICY).toBe("strict");
  });

  it("strict:任何工具都要问,包括只读的", () => {
    for (const tool of ["Read", "Bash", "Write", "Grep"]) {
      expect(needsApproval("strict", tool)).toBe(true);
    }
  });

  it("yolo:任何工具都不问", () => {
    for (const tool of ["Read", "Bash", "Write", "什么未知工具"]) {
      expect(needsApproval("yolo", tool)).toBe(false);
    }
  });

  describe("standard", () => {
    it("只读工具放行", () => {
      for (const tool of ["Read", "Grep", "Glob", "LS", "git_status"]) {
        expect(needsApproval("standard", tool)).toBe(false);
      }
    });

    it("写入 / 执行 / 编辑仍然要问 —— 这才是审批真正要拦的", () => {
      for (const tool of ["Write", "Edit", "Bash", "NotebookEdit", "WebFetch"]) {
        expect(needsApproval("standard", tool)).toBe(true);
      }
    });

    it("不认识的工具按需要审批处理(失败时保守)", () => {
      // agent 生态在变,明天冒出来的新工具默认必须被拦住。
      // 反过来默认放行的话,任何未知工具都能悄悄跑掉 —— 那是不可接受的失败方向。
      expect(needsApproval("standard", "SomeFutureTool")).toBe(true);
      expect(needsApproval("standard", "")).toBe(true);
    });

    it("工具名大小写与空白不影响判定", () => {
      expect(needsApproval("standard", "  read  ")).toBe(false);
      expect(needsApproval("standard", "READ")).toBe(false);
      expect(needsApproval("standard", "Grep")).toBe(false);
    });

    it("名字里含 read 但会改东西的,不能被误放行", () => {
      // 防止把判定写成 includes("read") 之类的模糊匹配
      expect(needsApproval("standard", "ReadAndWrite")).toBe(true);
      expect(needsApproval("standard", "unread_delete")).toBe(true);
    });
  });

  it("每档都有给人看的说明", () => {
    for (const p of ["strict", "standard", "yolo"] as const) {
      expect(policyLabel(p).length).toBeGreaterThan(0);
    }
    expect(policyLabel("yolo")).toContain("全部");
  });

  it("切到 YOLO 会立即放行已经卡住的审批", async () => {
    class PendingAdapter implements AgentAdapter {
      private ctx: AdapterContext | null = null;
      readonly replies: { reqId: string; reply: PermissionReply }[] = [];

      async start(ctx: AdapterContext): Promise<void> {
        this.ctx = ctx;
      }
      ask(reqId: string): void {
        this.ctx?.emit({
          kind: "permission.request",
          reqId,
          action: "修改文件",
          resources: ["src/app.ts"],
          summary: "修改文件:src/app.ts",
        });
      }
      async respondPermission(reqId: string, reply: PermissionReply): Promise<void> {
        this.replies.push({ reqId, reply });
        this.ctx?.emit({ kind: "permission.resolved", reqId, reply });
      }
      async send(): Promise<void> {}
      async interrupt(): Promise<void> {}
      async dispose(): Promise<void> {}
    }

    const adapter = new PendingAdapter();
    const session = new StructuredSession({
      id: "policy-test",
      agent: "codex",
      title: "codex · test",
      cwd: "/tmp",
      adapter,
    });
    await session.start();
    adapter.ask("pending-1");
    expect(session.info()).toMatchObject({
      approvalPolicy: "strict",
      pendingPermissions: 1,
      status: "waiting_approval",
    });

    await session.setApprovalPolicy("yolo");

    expect(adapter.replies).toEqual([{ reqId: "pending-1", reply: "once" }]);
    expect(session.info()).toMatchObject({
      approvalPolicy: "yolo",
      pendingPermissions: 0,
      status: "running",
    });
    await session.dispose();
  });
});
