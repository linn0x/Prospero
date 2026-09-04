import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/shared/types";
import { projectCurrentGraph, projectGraphView, taskWasSuperseded } from "../src/renderer/src/run-graph-projection";

function task(
  id: string,
  status: string,
  deps: string[] = [],
  result?: string,
  parentId?: string,
): JsonObject {
  return { id, status, deps, result, parentId };
}

function ids(tasks: JsonObject[]): string[] {
  return tasks.map((item) => String(item["id"]));
}

describe("Electron run graph current revision projection", () => {
  it("retains a superseded failed parent as the replacement connection point", () => {
    const original = task("original", "failed");
    const replacement = task("replacement", "pending", [], undefined, "original");
    const tasks = [original, replacement];
    const parentIds = new Set(["original"]);

    expect(taskWasSuperseded(original, parentIds)).toBe(true);
    expect(projectCurrentGraph(tasks)).toEqual({ tasks, hiddenCount: 0 });
    expect(replacement["parentId"]).toBe("original");
  });

  it("hides a quiesced cancelled leaf from an old branch", () => {
    const current = task("replacement", "pending", [], undefined, "source");
    const projection = projectCurrentGraph([
      task("source", "failed"),
      task("old-leaf", "cancelled", ["source"], "Quiesced before applying typed feedback"),
      current,
    ]);

    expect(ids(projection.tasks)).toEqual(["source", "replacement"]);
    expect(projection.hiddenCount).toBe(1);
  });

  it.each(["pending", "running"])("retains a %s replacement node", (status) => {
    const projection = projectCurrentGraph([
      task("source", "failed"),
      task("replacement", status, [], undefined, "source"),
    ]);

    expect(ids(projection.tasks)).toEqual(["source", "replacement"]);
  });

  it("retains a genuine failed leaf as failed", () => {
    const failed = task("failed", "failed", [], "Assertion mismatch");
    const parentIds = new Set<string>();

    expect(taskWasSuperseded(failed, parentIds)).toBe(false);
    expect(projectCurrentGraph([failed])).toEqual({ tasks: [failed], hiddenCount: 0 });
  });

  it("retains the latest successful verdict leaf and its dependencies", () => {
    const tasks = [
      task("prepare", "done"),
      task("execute", "done", ["prepare"]),
      task("verdict", "done", ["execute"]),
    ];

    expect(projectCurrentGraph(tasks)).toEqual({ tasks, hiddenCount: 0 });
  });

  it("does not mutate or truncate the full history input", () => {
    const tasks = [
      task("source", "failed"),
      task("old-leaf", "cancelled", ["source"], "superseded"),
      task("replacement", "done", [], undefined, "source"),
    ];
    const snapshot = structuredClone(tasks);

    const history = projectGraphView(tasks, "history");

    expect(projectCurrentGraph(tasks).tasks).toHaveLength(2);
    expect(history.tasks).toBe(tasks);
    expect(history.tasks).toHaveLength(3);
    expect(history.hiddenCount).toBe(0);
    expect(tasks).toEqual(snapshot);
  });

  it("projects a 5,000-node chain without recursive stack overflow", () => {
    const tasks = Array.from({ length: 5_000 }, (_, index) => task(
      `task-${String(index)}`,
      "done",
      index === 0 ? [] : [`task-${String(index - 1)}`],
    ));

    expect(projectCurrentGraph(tasks)).toEqual({ tasks, hiddenCount: 0 });
  });
});
