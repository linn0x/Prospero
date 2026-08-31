import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/shared/types";
import { fitScale, layoutGraph } from "../src/renderer/src/RunGraph";

function task(id: string, deps: string[] = [], createdAt = 0, parentId?: string): JsonObject {
  return { id, deps, createdAt, ...(parentId ? { parentId } : {}) };
}

describe("Electron run graph layout", () => {
  it("centers a single root between its successor branches", () => {
    const layout = layoutGraph([
      task("root", [], 0),
      task("upper", ["root"], 1),
      task("lower", ["root"], 2),
    ]);
    const root = layout.nodes.find((node) => node.id === "root");
    const upper = layout.nodes.find((node) => node.id === "upper");
    const lower = layout.nodes.find((node) => node.id === "lower");

    expect(root).toBeDefined();
    expect(upper).toBeDefined();
    expect(lower).toBeDefined();
    expect((root?.y ?? 0) + 35).toBe(layout.height / 2);
    expect((upper?.y ?? 0) + 70).toBeLessThanOrEqual(lower?.y ?? 0);
  });

  it("treats generic parent lineage as a separate graph edge and level", () => {
    const layout = layoutGraph([
      task("original", [], 0),
      task("replacement", [], 1, "original"),
    ]);
    const original = layout.nodes.find((node) => node.id === "original");
    const replacement = layout.nodes.find((node) => node.id === "replacement");

    expect(replacement?.x).toBeGreaterThan(original?.x ?? Number.POSITIVE_INFINITY);
    expect(layout.feedbackEdges).toEqual([{ fromTaskId: "original", toTaskId: "replacement" }]);
  });

  it("precomputes dependency edges for the canvas renderer", () => {
    const layout = layoutGraph([
      task("root", [], 0),
      task("left", ["root"], 1),
      task("right", ["root"], 2),
    ]);

    expect(layout.edges.map((edge) => [edge.fromTaskId, edge.toTaskId])).toEqual([
      ["root", "left"],
      ["root", "right"],
    ]);
  });

  it("lays out a 5,000-task chain without recursive stack overflow", () => {
    const tasks = Array.from({ length: 5_000 }, (_, index) => task(
      `task-${String(index)}`,
      index === 0 ? [] : [`task-${String(index - 1)}`],
      index,
    ));

    const layout = layoutGraph(tasks);

    expect(layout.nodes).toHaveLength(5_000);
    expect(layout.nodes.at(-1)?.x).toBeGreaterThan(layout.nodes[0]?.x ?? Number.POSITIVE_INFINITY);
  });

  it("fits a very large graph below the old 35 percent zoom floor", () => {
    const scale = fitScale(
      { nodes: [], feedbackEdges: [], width: 48_000, height: 96_000 },
      { width: 1_200, height: 600 },
    );

    expect(scale).toBe(0.00625);
    expect(96_000 * scale).toBe(600);
  });

  it("degrades safely if an invalid snapshot contains a cycle", () => {
    const layout = layoutGraph([
      task("left", ["right"]),
      task("right", ["left"]),
    ]);

    expect(layout.nodes).toHaveLength(2);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });
});
