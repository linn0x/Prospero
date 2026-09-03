import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORCHESTRATION_ACTION_MIN_HIT_TARGET } from "../src/lib/orchestration-overview";

describe("编排 Run 当前态 UI", () => {
  it("keeps progress, direct Gate resolution, and task targeting in the orchestration screen", () => {
    const screen = readFileSync(
      join(import.meta.dirname, "..", "src", "app", "host", "[hostId]", "orchestration.tsx"),
      "utf8",
    );

    expect(screen).toContain("orchestrationRunCurrentState(selectedRun, snapshot)");
    expect(screen).toContain("进度 ${String(selectedRunState.done)}/${String(selectedRunState.total)} 已完成");
    expect(screen).toContain("conn.resolveOrchestrationGate(gateId, decision)");
    expect(screen).toContain("focusGateTask(task.id)");
    expect(screen).toContain("定位关联任务");
    expect(screen).toContain("定位任务：${task.title}");
    expect(screen).not.toContain("并在主机页处理 Gate");
  });

  it("gives every new compact Gate action a 44pt target and explicit accessibility state", () => {
    const screen = readFileSync(
      join(import.meta.dirname, "..", "src", "app", "host", "[hostId]", "orchestration.tsx"),
      "utf8",
    );

    expect(ORCHESTRATION_ACTION_MIN_HIT_TARGET).toBe(44);
    expect(screen).toMatch(
      /runCurrentTaskLink: \{[\s\S]*?minHeight: ORCHESTRATION_ACTION_MIN_HIT_TARGET/,
    );
    expect(screen).toMatch(
      /inlineGateTaskLink: \{[\s\S]*?minHeight: ORCHESTRATION_ACTION_MIN_HIT_TARGET/,
    );
    expect(screen).toMatch(
      /inlineGateOption: \{[\s\S]*?minHeight: ORCHESTRATION_ACTION_MIN_HIT_TARGET/,
    );
    expect(screen).toMatch(
      /inlineGateConfirm: \{[\s\S]*?minHeight: ORCHESTRATION_ACTION_MIN_HIT_TARGET/,
    );
    expect(screen).toContain('accessibilityLabel={`回答 Gate：${option}`}');
    expect(screen).toContain("accessibilityState={{ disabled: !canResolveGate }}");
    expect(screen).toContain('accessibilityLabel="确认 Gate 决定"');
  });

  it("keeps coordinator dispatch and manual dispatch copy distinct, while history is read-only", () => {
    const screen = readFileSync(
      join(import.meta.dirname, "..", "src", "app", "host", "[hostId]", "orchestration.tsx"),
      "utf8",
    );

    expect(screen).toContain("此 Run 由你手工派发");
    expect(screen).toContain("此 Run 由协调者派发并维护任务图");
    expect(screen).toContain("此 Run 已结束，只读。");
    expect(screen).toContain('canManage && selectedRun.status === "active"');
  });

  it("opens a coordinator Goal graph directly from its session", () => {
    const screen = readFileSync(
      join(import.meta.dirname, "..", "src", "app", "host", "[hostId]", "session", "[sid].tsx"),
      "utf8",
    );

    expect(screen).toContain("orchestrationRoute(hostId, coordinatorRun.id)");
    expect(screen).toContain('accessibilityLabel="打开 Goal 任务图"');
    expect(screen).toContain('label="打开 Goal 任务图"');
  });
});
