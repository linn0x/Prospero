import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/shared/types";
import { fitScale, layoutGraph, nextGraphOverviewTaskId } from "../src/renderer/src/RunGraph";
import { graphNeighborhood, groupParallelTasks } from "../src/renderer/src/run-graph-projection";

function task(id: string, deps: string[] = [], createdAt = 0, parentId?: string): JsonObject {
  return { id, deps, createdAt, ...(parentId ? { parentId } : {}) };
}

describe("Electron run graph layout", () => {
  it("collapses equivalent parallel branches while preserving dependencies and expansion", () => {
    const tasks = [task('root'), task('a', ['root']), task('b', ['root']), task('c', ['root']), task('join', ['a', 'b', 'c']), task('other', ['root'])];
    const grouped = groupParallelTasks(tasks, new Set());
    expect(grouped.groups.size).toBe(1);
    const id = [...grouped.groups.keys()][0]!;
    expect(grouped.tasks.find(task => task.id === 'join')?.deps).toEqual([id]);
    expect(grouped.tasks.find(task => task.id === 'other')?.deps).toEqual(['root']);
    expect(groupParallelTasks(tasks, new Set([id])).tasks).toEqual(tasks);
  });
  it("focuses ancestors and descendants without pulling in sibling branches", () => {
    const tasks = [task("a"), task("b", ["a"]), task("c", ["b"]), task("d", ["c"]), task("e", ["d"]), task("f", ["e"]), task("sibling", ["b"])];
    expect(graphNeighborhood(tasks, "c").map(item => item.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(graphNeighborhood(tasks, undefined)).toBe(tasks);
    expect(graphNeighborhood(tasks, "missing")).toBe(tasks);
  });

  it("orders crossing branches by their dependencies and keeps nodes apart", () => {
    const graph = layoutGraph([task("a"), task("b"), task("c", ["b"], 1), task("d", ["a"], 2)]);
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    expect((nodes.get("a")!.y - nodes.get("b")!.y) * (nodes.get("d")!.y - nodes.get("c")!.y)).toBeGreaterThan(0);
    expect(Math.abs(nodes.get("c")!.y - nodes.get("d")!.y)).toBeGreaterThanOrEqual(70);
  });
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

  it("keeps lineage separate from execution levels", () => {
    const layout = layoutGraph([
      task("original", [], 0),
      task("replacement", [], 1, "original"),
    ]);
    const original = layout.nodes.find((node) => node.id === "original");
    const replacement = layout.nodes.find((node) => node.id === "replacement");

    expect(replacement?.x).toBe(original?.x);
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

  it("keeps automatic framing readable while explicit fit can show the whole graph", () => {
    const layout = { nodes: [], feedbackEdges: [], width: 48_000, height: 96_000 };
    const viewport = { width: 1_200, height: 600 };

    expect(fitScale(layout, viewport, 1, 0.8)).toBe(0.8);
    expect(fitScale(layout, viewport)).toBe(0.00625);
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

  it("navigates every overview task without mounting every node", () => {
    const ids = ["first", "second", "third"];

    expect(nextGraphOverviewTaskId(ids, undefined, "second", 0)).toBe("second");
    expect(nextGraphOverviewTaskId(ids, "second", undefined, 1)).toBe("third");
    expect(nextGraphOverviewTaskId(ids, "third", undefined, 1)).toBe("first");
    expect(nextGraphOverviewTaskId(ids, "first", undefined, -1)).toBe("third");
    expect(nextGraphOverviewTaskId([], undefined, undefined, 0)).toBeUndefined();
  });
});
