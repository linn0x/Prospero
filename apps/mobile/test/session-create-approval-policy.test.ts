import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(import.meta.dirname, "..", "src", "app", "host", "[hostId]", "index.tsx"),
  "utf8",
);

describe("新建会话审批策略", () => {
  it("默认保持逐条批准，并提供三档可访问选择", () => {
    expect(source).toContain('useState<ApprovalPolicy>("strict")');
    expect(source).toContain('{ value: "strict", label: "逐条"');
    expect(source).toContain('{ value: "standard", label: "半自动"');
    expect(source).toContain('{ value: "yolo", label: "YOLO"');
    expect(source).toContain('accessibilityRole="radiogroup"');
    expect(source).toContain('accessibilityRole="radio"');
  });

  it("把选择写入普通、Goal 和恢复会话的创建参数", () => {
    expect(source.match(/approvalPolicy,/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(source).toContain("conn.createSession(agent, projectPath");
  });

  it("创建期间防重复提交并保留失败后的设置", () => {
    expect(source).toContain("runtime.status !== \"connected\" || pendingCreateRef.current");
    expect(source).toContain("const result = conn.createSession(agent, projectPath");
    expect(source).toContain("sessionCreateFailureText(result)");
    expect(source).toContain("setCreateDelivery(result.disposition)");
    expect(source).toContain("busy: createDelivery !== null");
  });

  it("紧凑屏可从目录错误态切换到完整路径输入", () => {
    expect(source).toContain("manualCwdOpen");
    expect(source).toContain("手动输入完整路径");
    expect(source).toContain("onManualInput={() =>");
  });

  it("YOLO 在选中前要求二次确认并说明完整访问风险", () => {
    expect(source).toContain('title="新会话使用 YOLO？"');
    expect(source).toContain('label="我明白，选择 YOLO"');
    expect(source).toContain("Codex 沙箱也会切到完整访问");
  });
});
