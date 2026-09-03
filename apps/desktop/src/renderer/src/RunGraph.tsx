import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus, Zap } from "lucide-react";
import type { JsonObject } from "../../shared/types";
import { array, number, text } from "./state";
import { useLocale } from "./locale";

/**
 * 一个 Run 的任务依赖图。
 *
 * 这里和 SwiftUI 的 RunGraphCanvas 共用同一套布局与交互语义：后继重心布局、
 * 拖动平移、锚点缩放、全图适配、低倍概览和小地图导航。
 */

const NODE_WIDTH = 178;
const NODE_HEIGHT = 70;
const H_GAP = 78;
const V_GAP = 26;
const MARGIN = 26;
const MIN_ZOOM = 0.001;
const MAX_ZOOM = 2.2;
const INITIAL_ZOOM_FLOOR = 0.8;

interface Point {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

interface Placed {
  id: string;
  x: number;
  y: number;
  deps: string[];
  parentId?: string;
}

interface FeedbackEdge {
  fromTaskId: string;
  toTaskId: string;
}

interface Edge {
  fromTaskId: string;
  toTaskId: string;
  from: Point;
  to: Point;
}

interface Layout {
  nodes: Placed[];
  edges: Edge[];
  feedbackEdges: FeedbackEdge[];
  width: number;
  height: number;
}

interface ViewTransform {
  zoom: number;
  pan: Point;
}

type NodeState = "ready" | "running" | "done" | "superseded" | "failed" | "blocked" | "cancelled" | "waiting";

function dependencies(task: JsonObject): string[] {
  return array(task["deps"]).map(String);
}

function structuralKey(tasks: JsonObject[]): string {
  return JSON.stringify(tasks.map((task) => ({
    id: text(task["id"]),
    deps: dependencies(task),
    parentId: text(task["parentId"]),
    createdAt: number(task["createdAt"]),
  })));
}

function lineageLabel(parentResult: unknown, t: (zh: string, en: string) => string): string {
  const signal = text(parentResult).toLocaleLowerCase();
  if (signal.includes("typed_feedback_replan") || signal.includes("feedback")) return t("反馈重规划", "Feedback replan");
  if (signal.includes("retry") || signal.includes("attempt")) return t("重试", "Retry");
  return t("派生任务", "Derived task");
}

/**
 * 通用分层 DAG 布局：x 是拓扑层级，y 是后继分支的重心。
 *
 * 叶子按稳定 DFS 顺序排列，父节点落在后继的平均高度。这样入口、分叉和合流
 * 都围绕内容中线展开，不会像逐列堆叠那样全部挤在画布左上角。
 */
export function layoutGraph(tasks: JsonObject[]): Layout {
  const byId = new Map(tasks.map((task) => [text(task["id"]), task]));
  const taskSort = (left: JsonObject, right: JsonObject): number => {
    const time = number(left["createdAt"]) - number(right["createdAt"]);
    return time || text(left["id"]).localeCompare(text(right["id"]));
  };
  const ancestors = (task: JsonObject): string[] => {
    const parentId = text(task["parentId"]);
    return [...new Set([...dependencies(task), ...(parentId ? [parentId] : [])])]
      .filter((id) => byId.has(id));
  };
  const upstreamById = new Map<string, string[]>();
  const successors = new Map<string, Set<string>>();
  for (const task of tasks) {
    const id = text(task["id"]);
    const upstream = ancestors(task);
    upstreamById.set(id, upstream);
    for (const ancestor of upstream) {
      const children = successors.get(ancestor) ?? new Set<string>();
      children.add(id);
      successors.set(ancestor, children);
    }
  }

  // 用 Kahn 拓扑遍历计算层级，避免几千节点的长链把 JavaScript 调用栈压爆。
  // 若快照意外含环，未出队节点统一放到第 0 层：会画得拥挤，但界面仍可用。
  const remainingAncestors = new Map([...upstreamById].map(([id, upstream]) => [id, upstream.length]));
  const levels = new Map<string, number>();
  const roots = tasks.filter((task) => (upstreamById.get(text(task["id"]))?.length ?? 0) === 0).sort(taskSort);
  const queue = roots.map((task) => text(task["id"]));
  queue.forEach((id) => levels.set(id, 0));
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index] ?? "";
    const nextLevel = (levels.get(id) ?? 0) + 1;
    for (const child of successors.get(id) ?? []) {
      levels.set(child, Math.max(levels.get(child) ?? 0, nextLevel));
      const remaining = (remainingAncestors.get(child) ?? 1) - 1;
      remainingAncestors.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }
  tasks.forEach((task) => {
    const id = text(task["id"]);
    if (!levels.has(id)) levels.set(id, 0);
  });

  const tasksByColumn = new Map<number, JsonObject[]>();
  for (const task of tasks) {
    const column = levels.get(text(task["id"])) ?? 0;
    const columnTasks = tasksByColumn.get(column);
    if (columnTasks) columnTasks.push(task);
    else tasksByColumn.set(column, [task]);
  }
  const columns = Math.max(...levels.values(), 0) + 1;
  const maxColumnCount = Math.max(...[...tasksByColumn.values()].map((column) => column.length), 1);

  const orderedLeaves: string[] = [];
  const visited = new Set<string>();
  const collectLeaves = (rootId: string): void => {
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop() ?? "";
      if (visited.has(id)) continue;
      visited.add(id);
      const children = [...(successors.get(id) ?? [])]
        .map((child) => byId.get(child))
        .filter((task): task is JsonObject => Boolean(task))
        .sort(taskSort);
      if (children.length === 0) {
        orderedLeaves.push(id);
        continue;
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const childId = text(children[index]?.["id"]);
        if (!visited.has(childId)) stack.push(childId);
      }
    }
  };
  roots.forEach((root) => collectLeaves(text(root["id"])));
  const orderedLeafIds = new Set(orderedLeaves);
  for (const task of [...tasks].sort(taskSort)) {
    const id = text(task["id"]);
    if ((successors.get(id)?.size ?? 0) === 0 && !orderedLeafIds.has(id)) {
      orderedLeafIds.add(id);
      orderedLeaves.push(id);
    }
  }

  const slotCount = Math.max(orderedLeaves.length, maxColumnCount, 1);
  const slotStep = NODE_HEIGHT + V_GAP;
  const contentHeight = slotCount * NODE_HEIGHT + Math.max(slotCount - 1, 0) * V_GAP;
  const leafContentHeight = Math.max(orderedLeaves.length, 1) * NODE_HEIGHT
    + Math.max(orderedLeaves.length - 1, 0) * V_GAP;
  const leafTop = MARGIN + Math.max(0, (contentHeight - leafContentHeight) / 2);
  const leafY = new Map(orderedLeaves.map((id, index) => [id, leafTop + NODE_HEIGHT / 2 + index * slotStep]));

  const desiredMemo = new Map(leafY);
  for (let column = columns - 1; column >= 0; column -= 1) {
    for (const task of tasksByColumn.get(column) ?? []) {
      const id = text(task["id"]);
      if (desiredMemo.has(id)) continue;
      const values = [...(successors.get(id) ?? [])]
        .map((child) => desiredMemo.get(child))
        .filter((value): value is number => value !== undefined);
      desiredMemo.set(
        id,
        values.length === 0
          ? MARGIN + contentHeight / 2
          : values.reduce((sum, current) => sum + current, 0) / values.length,
      );
    }
  }
  if (roots.length === 1) desiredMemo.set(text(roots[0]?.["id"]), MARGIN + contentHeight / 2);

  const canvasHeight = MARGIN * 2 + contentHeight;
  const canvasWidth = MARGIN * 2 + columns * NODE_WIDTH + Math.max(columns - 1, 0) * H_GAP;
  const positions = new Map<string, Point>();
  for (const [column, columnTasks] of tasksByColumn) {
    const ordered = [...columnTasks].sort((left, right) => {
      const desired = (desiredMemo.get(text(left["id"])) ?? 0) - (desiredMemo.get(text(right["id"])) ?? 0);
      return desired || taskSort(left, right);
    });
    const placed: number[] = [];
    for (const task of ordered) {
      const target = desiredMemo.get(text(task["id"])) ?? MARGIN + contentHeight / 2;
      const minimum = (placed.at(-1) ?? Number.NEGATIVE_INFINITY) + slotStep;
      placed.push(Math.max(target, minimum));
    }
    if (placed.length > 0) {
      const desiredAverage = ordered.reduce((sum, task) => sum + (desiredMemo.get(text(task["id"])) ?? 0), 0) / ordered.length;
      const placedAverage = placed.reduce((sum, value) => sum + value, 0) / placed.length;
      const lowerBound = MARGIN + NODE_HEIGHT / 2;
      const upperBound = canvasHeight - MARGIN - NODE_HEIGHT / 2;
      let shift = desiredAverage - placedAverage;
      if ((placed[0] ?? 0) + shift < lowerBound) shift = lowerBound - (placed[0] ?? 0);
      if ((placed.at(-1) ?? 0) + shift > upperBound) shift = upperBound - (placed.at(-1) ?? 0);
      for (let index = 0; index < placed.length; index += 1) placed[index] = (placed[index] ?? 0) + shift;
    }
    ordered.forEach((task, index) => {
      positions.set(text(task["id"]), {
        x: MARGIN + column * (NODE_WIDTH + H_GAP),
        y: (placed[index] ?? MARGIN + NODE_HEIGHT / 2) - NODE_HEIGHT / 2,
      });
    });
  }

  const edges: Edge[] = [];
  for (const task of tasks) {
    const toTaskId = text(task["id"]);
    const end = positions.get(toTaskId);
    if (!end) continue;
    for (const fromTaskId of dependencies(task)) {
      const start = positions.get(fromTaskId);
      if (!start) continue;
      edges.push({
        fromTaskId,
        toTaskId,
        from: { x: start.x + NODE_WIDTH, y: start.y + NODE_HEIGHT / 2 },
        to: { x: end.x, y: end.y + NODE_HEIGHT / 2 },
      });
    }
  }

  const feedbackGroups = new Map<string, JsonObject[]>();
  for (const task of tasks) {
    const parentId = text(task["parentId"]);
    if (!parentId || !byId.has(parentId)) continue;
    const children = feedbackGroups.get(parentId);
    if (children) children.push(task);
    else feedbackGroups.set(parentId, [task]);
  }
  const feedbackEdges: FeedbackEdge[] = [];
  for (const candidates of feedbackGroups.values()) {
    const target = [...candidates].sort((left, right) => {
      const column = (levels.get(text(left["id"])) ?? 0) - (levels.get(text(right["id"])) ?? 0);
      return column || taskSort(left, right);
    })[0];
    const parentId = text(target?.["parentId"]);
    if (target && parentId) feedbackEdges.push({ fromTaskId: parentId, toTaskId: text(target["id"]) });
  }

  return {
    nodes: tasks.map((task) => {
      const id = text(task["id"]);
      const position = positions.get(id) ?? { x: MARGIN, y: MARGIN };
      const parentId = text(task["parentId"]);
      return { id, ...position, deps: dependencies(task), ...(parentId ? { parentId } : {}) };
    }),
    edges,
    feedbackEdges,
    width: canvasWidth,
    height: canvasHeight,
  };
}

export function fitScale(layout: Pick<Layout, "width" | "height">, viewport: Size, maximum = MAX_ZOOM, minimum = MIN_ZOOM): number {
  if (layout.width <= 0 || layout.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
  return Math.min(maximum, Math.max(minimum, Math.min(viewport.width / layout.width, viewport.height / layout.height)));
}

function visibleRect(viewport: Size, transform: ViewTransform, overscan = 0) {
  return {
    left: -transform.pan.x / transform.zoom - overscan,
    top: -transform.pan.y / transform.zoom - overscan,
    right: (-transform.pan.x + viewport.width) / transform.zoom + overscan,
    bottom: (-transform.pan.y + viewport.height) / transform.zoom + overscan,
  };
}

function rectsIntersect(
  left: number,
  top: number,
  right: number,
  bottom: number,
  visible: ReturnType<typeof visibleRect>,
): boolean {
  return right >= visible.left && left <= visible.right && bottom >= visible.top && top <= visible.bottom;
}

function taskWasSuperseded(task: JsonObject, parentIds: Set<string>): boolean {
  const taskStatus = text(task["status"]);
  if (taskStatus !== "failed" && taskStatus !== "cancelled") return false;
  if (parentIds.has(text(task["id"]))) return true;
  const signal = text(task["result"]).toLocaleLowerCase();
  return signal.includes("superseded")
    || signal.includes("quiesced before applying typed feedback")
    || signal.includes("typed_feedback_replan");
}

function taskState(task: JsonObject, done: Set<string>, activeWorkers: Set<string>, parentIds: Set<string>): NodeState {
  const id = text(task["id"]);
  const taskStatus = text(task["status"]);
  if (taskWasSuperseded(task, parentIds)) return "superseded";
  if (["done", "completed", "succeeded"].includes(taskStatus)) return "done";
  if (["dispatched", "running", "starting"].includes(taskStatus) || activeWorkers.has(id)) return "running";
  if (taskStatus === "failed") return "failed";
  if (taskStatus === "blocked") return "blocked";
  if (taskStatus === "cancelled") return "cancelled";
  if (taskStatus === "pending" && dependencies(task).every((dependency) => done.has(dependency))) return "ready";
  return "waiting";
}

function cssColor(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

function drawArrow(context: CanvasRenderingContext2D, point: Point, color: string, alpha: number): void {
  context.save();
  context.fillStyle = color;
  context.globalAlpha = Math.min(1, alpha + 0.12);
  context.beginPath();
  context.moveTo(point.x, point.y);
  context.lineTo(point.x - 9, point.y - 5);
  context.lineTo(point.x - 9, point.y + 5);
  context.closePath();
  context.fill();
  context.restore();
}

export function RunGraph({ runId, tasks, dispatches }: { runId: string; tasks: JsonObject[]; dispatches: JsonObject[] }) {
  const { t, status } = useLocale();
  const graphKey = useMemo(() => structuralKey(tasks), [tasks]);
  const layoutCache = useRef<{ key: string; layout: Layout } | undefined>(undefined);
  if (!layoutCache.current || layoutCache.current.key !== graphKey) {
    layoutCache.current = { key: graphKey, layout: layoutGraph(tasks) };
  }
  const layout = layoutCache.current.layout;
  const taskById = useMemo(() => new Map(tasks.map((task) => [text(task["id"]), task])), [tasks]);
  const done = useMemo(
    () => new Set(tasks.filter((task) => ["done", "completed", "succeeded"].includes(text(task["status"]))).map((task) => text(task["id"]))),
    [tasks],
  );
  const parentIds = useMemo(() => new Set(tasks.map((task) => text(task["parentId"])).filter(Boolean)), [tasks]);
  const activeWorkers = useMemo(() => {
    const latest = new Map<string, { startedAt: number; state: string }>();
    for (const dispatch of dispatches) {
      const taskId = text(dispatch["taskId"]);
      const candidate = { startedAt: number(dispatch["startedAt"]), state: text(dispatch["state"]) };
      if (!latest.has(taskId) || candidate.startedAt >= (latest.get(taskId)?.startedAt ?? 0)) latest.set(taskId, candidate);
    }
    return new Set([...latest].filter(([, dispatch]) => ["starting", "running"].includes(dispatch.state)).map(([id]) => id));
  }, [dispatches]);
  const initialFocusId = useMemo(() => {
    const active = tasks.find((task) => activeWorkers.has(text(task["id"])) || ["dispatched", "running", "starting"].includes(text(task["status"])));
    if (active) return text(active["id"]);
    const ready = tasks.find((task) => text(task["status"]) === "pending" && dependencies(task).every((dependency) => done.has(dependency)));
    return text(ready?.["id"] ?? tasks.find((task) => dependencies(task).length === 0)?.["id"]);
  }, [activeWorkers, done, tasks]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const renderCanvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [transform, setTransform] = useState<ViewTransform>({ zoom: 1, pan: { x: 0, y: 0 } });
  const transformRef = useRef(transform);
  const pendingTransform = useRef<ViewTransform | undefined>(undefined);
  const transformFrame = useRef<number | undefined>(undefined);
  const [selected, setSelected] = useState<string>();
  const drag = useRef<{ pointerId: number; origin: Point; start: Point } | undefined>(undefined);
  const fitMode = useRef(false);
  const fitMaximum = useRef(1);
  const fitMinimum = useRef(INITIAL_ZOOM_FLOOR);
  const fitFocus = useRef<string | undefined>(undefined);
  const previousRunId = useRef<string | undefined>(undefined);
  const previousLayoutKey = useRef<string | undefined>(undefined);
  const previousViewport = useRef<Size>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  useLayoutEffect(() => () => {
    if (transformFrame.current !== undefined) cancelAnimationFrame(transformFrame.current);
  }, []);

  const commitTransform = useCallback((next: ViewTransform): void => {
    if (transformFrame.current !== undefined) cancelAnimationFrame(transformFrame.current);
    transformFrame.current = undefined;
    pendingTransform.current = undefined;
    transformRef.current = next;
    setTransform(next);
  }, []);

  const scheduleTransform = useCallback((update: (current: ViewTransform) => ViewTransform): void => {
    const current = pendingTransform.current ?? transformRef.current;
    const next = update(current);
    if (next.zoom === current.zoom && next.pan.x === current.pan.x && next.pan.y === current.pan.y) return;
    pendingTransform.current = next;
    if (transformFrame.current !== undefined) return;
    transformFrame.current = requestAnimationFrame(() => {
      transformFrame.current = undefined;
      const latest = pendingTransform.current;
      pendingTransform.current = undefined;
      if (!latest) return;
      transformRef.current = latest;
      setTransform(latest);
    });
  }, []);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = (): void => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setViewport((current) => current.width === next.width && current.height === next.height ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const applyFit = useCallback((maximum: number, minimum: number, focusId?: string): void => {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const zoom = fitScale(layout, viewport, maximum, minimum);
    const focus = layout.width * zoom > viewport.width || layout.height * zoom > viewport.height
      ? layout.nodes.find((node) => node.id === focusId)
      : undefined;
    const center = focus
      ? { x: focus.x + NODE_WIDTH / 2, y: focus.y + NODE_HEIGHT / 2 }
      : { x: layout.width / 2, y: layout.height / 2 };
    commitTransform({
      zoom,
      pan: {
        x: viewport.width / 2 - center.x * zoom,
        y: viewport.height / 2 - center.y * zoom,
      },
    });
  }, [commitTransform, layout, viewport]);

  useLayoutEffect(() => {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const firstLayout = previousLayoutKey.current === undefined;
    const runChanged = previousRunId.current !== runId;
    const layoutChanged = previousLayoutKey.current !== graphKey;
    const sizeChanged = previousViewport.current.width !== viewport.width || previousViewport.current.height !== viewport.height;
    previousRunId.current = runId;
    previousLayoutKey.current = graphKey;
    previousViewport.current = viewport;
    if (firstLayout || runChanged) {
      fitMode.current = true;
      fitMaximum.current = 1;
      fitMinimum.current = INITIAL_ZOOM_FLOOR;
      fitFocus.current = initialFocusId;
      setSelected(undefined);
      applyFit(1, INITIAL_ZOOM_FLOOR, initialFocusId);
    } else if ((layoutChanged || sizeChanged) && fitMode.current) {
      applyFit(fitMaximum.current, fitMinimum.current, fitFocus.current);
    }
  }, [applyFit, graphKey, initialFocusId, runId, viewport]);

  useLayoutEffect(() => {
    if (selected && !taskById.has(selected)) setSelected(undefined);
  }, [selected, taskById]);

  const fit = useCallback((): void => {
    fitMode.current = true;
    fitMaximum.current = MAX_ZOOM;
    fitMinimum.current = MIN_ZOOM;
    fitFocus.current = undefined;
    applyFit(MAX_ZOOM, MIN_ZOOM);
  }, [applyFit]);

  const reset = useCallback((): void => {
    fitMode.current = false;
    commitTransform({ zoom: 1, pan: { x: 0, y: 0 } });
  }, [commitTransform]);

  const zoomBy = useCallback((factor: number, anchor: Point): void => {
    fitMode.current = false;
    scheduleTransform((current) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * factor));
      if (zoom === current.zoom) return current;
      const ratio = zoom / current.zoom;
      return {
        zoom,
        pan: {
          x: anchor.x - (anchor.x - current.pan.x) * ratio,
          y: anchor.y - (anchor.y - current.pan.y) * ratio,
        },
      };
    });
  }, [scheduleTransform]);

  const center = useCallback((): Point => ({ x: viewport.width / 2, y: viewport.height / 2 }), [viewport]);

  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) {
      const box = viewportRef.current?.getBoundingClientRect();
      const anchor = box ? { x: event.clientX - box.left, y: event.clientY - box.top } : center();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 0.05 : 0.002;
      zoomBy(Math.exp(-event.deltaY * unit), anchor);
      return;
    }
    const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    fitMode.current = false;
    scheduleTransform((current) => ({
      ...current,
      pan: {
        x: current.pan.x - event.deltaX * multiplier,
        y: current.pan.y - event.deltaY * multiplier,
      },
    }));
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, .run-graph-minimap")) return;
    drag.current = { pointerId: event.pointerId, origin: { x: event.clientX, y: event.clientY }, start: transform.pan };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    fitMode.current = false;
    scheduleTransform((value) => ({
      ...value,
      pan: {
        x: current.start.x + event.clientX - current.origin.x,
        y: current.start.y + event.clientY - current.origin.y,
      },
    }));
  };
  const finishDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(1.25, center());
    } else if (event.key === "-") {
      event.preventDefault();
      zoomBy(1 / 1.25, center());
    } else if (event.key === "0") {
      event.preventDefault();
      reset();
    } else if (event.key.toLocaleLowerCase() === "f") {
      event.preventDefault();
      fit();
    }
  };

  const positions = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout]);
  const visibleNodes = useMemo(() => {
    // 节点始终按矢量绘制:它们在一个 scale(zoom) 的容器里,缩放本来就是矢量的,
    // 文字和描边跟着一起缩。视口裁剪保留 —— 那只影响 DOM 数量,不改变观感。
    const visible = visibleRect(viewport, transform, Math.max(NODE_WIDTH, NODE_HEIGHT));
    return layout.nodes.filter((node) => rectsIntersect(
      node.x,
      node.y,
      node.x + NODE_WIDTH,
      node.y + NODE_HEIGHT,
      visible,
    ));
  }, [layout, transform, viewport]);

  // 主画布只分配可视区大小，避免超大 DAG 创建几万像素的 bitmap。
  useLayoutEffect(() => {
    const canvas = renderCanvasRef.current;
    const host = viewportRef.current;
    if (!canvas || !host || viewport.width <= 0 || viewport.height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(viewport.width * dpr));
    const pixelHeight = Math.max(1, Math.round(viewport.height * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, pixelWidth, pixelHeight);
    context.setTransform(
      dpr * transform.zoom,
      0,
      0,
      dpr * transform.zoom,
      dpr * transform.pan.x,
      dpr * transform.pan.y,
    );

    const styles = getComputedStyle(host);
    const primary = cssColor(styles, "--primary", "#4c7dff");
    const muted = cssColor(styles, "--muted-foreground", "#66728a");
    const success = cssColor(styles, "--run-graph-done", "#318f73");
    const info = cssColor(styles, "--run-graph-superseded", "#3b70db");
    const running = cssColor(styles, "--run-graph-running", "#d97706");
    const blocked = cssColor(styles, "--run-graph-blocked", "#ca8a04");
    const danger = cssColor(styles, "--run-graph-failed", "#c7484f");
    const visible = visibleRect(viewport, transform, 40 / transform.zoom);

    const overviewMode = layout.nodes.length > 240 && transform.zoom < 0.14;
    if (overviewMode) {
      context.save();
      context.strokeStyle = muted;
      context.globalAlpha = 0.42;
      context.lineWidth = 1.2;
      context.beginPath();
      for (const edge of layout.edges) {
        if (!rectsIntersect(Math.min(edge.from.x, edge.to.x), Math.min(edge.from.y, edge.to.y), Math.max(edge.from.x, edge.to.x), Math.max(edge.from.y, edge.to.y), visible)) continue;
        context.moveTo(edge.from.x, edge.from.y);
        context.lineTo(edge.to.x, edge.to.y);
      }
      context.stroke();
      context.restore();
    } else {
      for (const edge of layout.edges) {
        const { from, to } = edge;
        if (!rectsIntersect(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.max(from.x, to.x), Math.max(from.y, to.y), visible)) continue;
        const touched = selected === edge.toTaskId || selected === edge.fromTaskId;
        const color = touched ? primary : done.has(edge.fromTaskId) ? success : muted;
        const alpha = touched ? 0.9 : done.has(edge.fromTaskId) ? 0.5 : 0.34;
        const bend = (from.x + to.x) / 2;
        context.save();
        context.strokeStyle = color;
        context.globalAlpha = alpha;
        context.lineWidth = touched ? 2.4 : 1.6;
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.bezierCurveTo(bend, from.y, bend, to.y, to.x, to.y);
        context.stroke();
        context.restore();
        drawArrow(context, to, color, alpha);
      }
    }

    if (!overviewMode) for (const feedback of layout.feedbackEdges) {
      const start = positions.get(feedback.fromTaskId);
      const end = positions.get(feedback.toTaskId);
      if (!start || !end) continue;
      const from = { x: start.x + NODE_WIDTH / 2, y: start.y + NODE_HEIGHT };
      const to = { x: end.x, y: end.y + NODE_HEIGHT / 2 };
      const loopY = Math.max(from.y, to.y) + 22;
      if (!rectsIntersect(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.max(from.x, to.x), loopY + 16, visible)) continue;
      const touched = selected === feedback.fromTaskId || selected === feedback.toTaskId;
      context.save();
      context.strokeStyle = primary;
      context.globalAlpha = touched ? 0.95 : 0.72;
      context.lineWidth = touched ? 2.5 : 1.8;
      context.lineCap = "round";
      context.setLineDash([7, 5]);
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.bezierCurveTo(from.x, loopY, to.x - 34, loopY, to.x, to.y);
      context.stroke();
      context.restore();
      drawArrow(context, to, primary, touched ? 0.83 : 0.6);
      if (transform.zoom >= 0.18) {
        context.save();
        context.fillStyle = primary;
        context.globalAlpha = 0.9;
        context.font = "600 9px system-ui, sans-serif";
        context.textAlign = "center";
        const parent = taskById.get(feedback.fromTaskId);
        context.fillText(lineageLabel(parent?.["result"], t), (from.x + to.x) / 2, loopY + 11);
        context.restore();
      }
    }

  }, [activeWorkers, done, layout, parentIds, positions, selected, t, taskById, transform, viewport]);

  useLayoutEffect(() => {
    const canvas = minimapCanvasRef.current;
    const host = minimapRef.current;
    if (!canvas || !host || viewport.width <= 0 || viewport.height <= 0) return;
    const width = host.clientWidth;
    const height = host.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const styles = getComputedStyle(host);
    const card = cssColor(styles, "--card", "#fff");
    const muted = cssColor(styles, "--muted-foreground", "#66728a");
    const primary = cssColor(styles, "--primary", "#4c7dff");
    const border = cssColor(styles, "--border", "#dce3ee");
    const scale = Math.min(width / Math.max(layout.width, 1), height / Math.max(layout.height, 1));
    const offset = { x: (width - layout.width * scale) / 2, y: (height - layout.height * scale) / 2 };
    const graphRect = { x: offset.x, y: offset.y, width: layout.width * scale, height: layout.height * scale };
    context.fillStyle = card;
    context.strokeStyle = border;
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(graphRect.x, graphRect.y, graphRect.width, graphRect.height, 4);
    context.fill();
    context.stroke();
    context.fillStyle = muted;
    context.globalAlpha = 0.72;
    context.beginPath();
    for (const node of layout.nodes) {
      context.arc(offset.x + (node.x + NODE_WIDTH / 2) * scale, offset.y + (node.y + NODE_HEIGHT / 2) * scale, 1.5, 0, Math.PI * 2);
    }
    context.fill();
    context.globalAlpha = 1;
    const visible = visibleRect(viewport, transform);
    const left = Math.max(0, visible.left);
    const top = Math.max(0, visible.top);
    const right = Math.min(layout.width, visible.right);
    const bottom = Math.min(layout.height, visible.bottom);
    if (right >= left && bottom >= top) {
      context.strokeStyle = primary;
      context.lineWidth = 1.5;
      context.strokeRect(offset.x + left * scale, offset.y + top * scale, (right - left) * scale, (bottom - top) * scale);
    }
  }, [layout, transform, viewport]);

  const recenterFromMinimap = (clientX: number, clientY: number): void => {
    const host = minimapRef.current;
    if (!host) return;
    const box = host.getBoundingClientRect();
    const scale = Math.min(box.width / Math.max(layout.width, 1), box.height / Math.max(layout.height, 1));
    if (scale <= 0) return;
    const offset = { x: (box.width - layout.width * scale) / 2, y: (box.height - layout.height * scale) / 2 };
    const target = { x: (clientX - box.left - offset.x) / scale, y: (clientY - box.top - offset.y) / scale };
    fitMode.current = false;
    scheduleTransform((current) => ({
      ...current,
      pan: { x: viewport.width / 2 - target.x * current.zoom, y: viewport.height / 2 - target.y * current.zoom },
    }));
  };
  const onMinimapPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    recenterFromMinimap(event.clientX, event.clientY);
  };
  const onMinimapPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.stopPropagation();
    recenterFromMinimap(event.clientX, event.clientY);
  };

  if (layout.nodes.length === 0) return null;

  const stateLabel = (state: NodeState, taskStatus: string): string => ({
    ready: t("就绪", "Ready"),
    running: t("运行中", "Running"),
    done: t("完成", "Done"),
    superseded: t("已回退", "Superseded"),
    failed: t("失败", "Failed"),
    blocked: t("阻塞", "Blocked"),
    cancelled: t("已取消", "Cancelled"),
    waiting: taskStatus === "pending" ? t("等待依赖", "Waiting") : status(taskStatus),
  })[state];
  const legend: Array<{ state: NodeState; label: string }> = [
    { state: "ready", label: t("就绪", "Ready") },
    { state: "running", label: t("运行中", "Running") },
    { state: "done", label: t("完成", "Done") },
    { state: "superseded", label: t("已回退", "Superseded") },
    { state: "failed", label: t("失败", "Failed") },
    { state: "blocked", label: t("阻塞", "Blocked") },
  ];

  return (
    <div className="run-graph">
      <div
        className="run-graph-viewport"
        ref={viewportRef}
        tabIndex={0}
        aria-label={t("任务依赖图。拖动平移，捏合或按加减号缩放，按 F 适应窗口。", "Task dependency graph. Drag to pan, pinch or press plus and minus to zoom, and press F to fit.")}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onDoubleClick={fit}
        onKeyDown={onKeyDown}
      >
        <canvas className="run-graph-render-layer" ref={renderCanvasRef} aria-hidden="true" />
        <div
          className="run-graph-canvas"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${String(transform.pan.x)}px, ${String(transform.pan.y)}px) scale(${String(transform.zoom)})`,
          }}
        >
          {visibleNodes.map((node) => {
            const task = taskById.get(node.id);
            if (!task) return null;
            const taskStatus = text(task["status"]);
            const visualState = taskState(task, done, activeWorkers, parentIds);
            return (
              <button
                type="button"
                key={node.id}
                className={`run-graph-node${selected === node.id ? " selected" : ""}`}
                data-state={visualState}
                style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                title={text(task["spec"], text(task["title"]))}
                aria-pressed={selected === node.id}
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={() => setSelected((current) => current === node.id ? undefined : node.id)}
              >
                <strong>{text(task["title"], t("未命名任务", "Untitled task"))}</strong>
                <span className="run-graph-node-meta">
                  <span className="run-graph-state-dot" />
                  {stateLabel(visualState, taskStatus)}
                  {activeWorkers.has(node.id) && <Zap size={11} className="run-graph-worker" />}
                  {taskStatus === "cancelled" && <span aria-hidden="true">↩</span>}
                  {node.deps.length > 0 && <em>{node.deps.length}↑</em>}
                </span>
              </button>
            );
          })}
        </div>
        <div
          className="run-graph-minimap"
          ref={minimapRef}
          title={t("全图导航：拖动以定位分支", "Graph overview: drag to navigate")}
          aria-label={t("任务图小地图", "Task graph minimap")}
          onPointerDown={onMinimapPointerDown}
          onPointerMove={onMinimapPointerMove}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <canvas ref={minimapCanvasRef} aria-hidden="true" />
        </div>
      </div>
      <div className="run-graph-controls">
        <div className="run-graph-legend" aria-label={t("任务状态图例", "Task status legend")}>{legend.map((item) => <span key={item.state}><i data-state={item.state} />{item.label}</span>)}<span><i className="lineage" />{t("反馈 / 重试", "Feedback / retry")}</span></div>
        <div className="run-graph-control-end">
          <span>{layout.nodes.length} {t("个任务", "tasks")}</span>
          <div className="run-graph-zoom">
            <button type="button" aria-label={t("缩小", "Zoom out")} disabled={transform.zoom <= MIN_ZOOM + 0.001}
              onClick={() => zoomBy(1 / 1.25, center())}><Minus size={12} /></button>
            <button type="button" title={t("复位：100% 并回到起点", "Reset to 100% and origin")}
              onClick={reset}>{transform.zoom < 0.01 ? "<1%" : `${String(Math.round(transform.zoom * 100))}%`}</button>
            <button type="button" aria-label={t("放大", "Zoom in")} disabled={transform.zoom >= MAX_ZOOM - 0.001}
              onClick={() => zoomBy(1.25, center())}><Plus size={12} /></button>
            <button type="button" title={t("适应窗口：缩放并居中整张图", "Fit and center the whole graph")}
              aria-label={t("适应窗口", "Fit to window")} onClick={fit}><Maximize2 size={12} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}
