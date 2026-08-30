import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus, Zap } from "lucide-react";
import type { JsonObject } from "../../shared/types";
import { array, text } from "./state";
import { useLocale } from "./locale";

/**
 * 一个 Run 的任务依赖图。
 *
 * 列表和看板读不出 DAG 的形状:哪几个任务此刻能并行、整条链卡在谁身上、
 * 失败的那个下游还挂着多少。这些都是图里一眼的事,在列表里要靠人脑做拓扑排序。
 *
 * 这里是 macOS 原生壳 RunGraph.swift 的移植,保持同一套交互:拖动平移、
 * 滚轮/捏合缩放、适应窗口、点节点高亮它的进出边。
 */

const NODE_WIDTH = 178;
const NODE_HEIGHT = 70;
const H_GAP = 78;
const V_GAP = 26;
const MARGIN = 26;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.2;

interface Placed {
  id: string;
  task: JsonObject;
  x: number;
  y: number;
  deps: string[];
}

interface Layout {
  nodes: Placed[];
  width: number;
  height: number;
}

/**
 * 按依赖深度分层:x 是拓扑层级,y 是同层内的排队位次。
 *
 * 成环由 daemon 建图时就拒绝了,这里的 seen 只是防御 —— 快照里真出现环,
 * 也只是画得难看,不能让界面递归到爆栈。
 */
function layoutGraph(tasks: JsonObject[]): Layout {
  const byId = new Map(tasks.map((task) => [text(task["id"]), task]));
  const memo = new Map<string, number>();
  const level = (id: string, seen: Set<string>): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const task = byId.get(id);
    if (!task || seen.has(id)) return 0;
    const deps = array(task["deps"]).map(String);
    const next = new Set(seen).add(id);
    const value = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => level(dep, next))) + 1;
    memo.set(id, value);
    return value;
  };

  const rows = new Map<number, number>();
  const nodes = tasks.map((task) => {
    const id = text(task["id"]);
    const column = level(id, new Set());
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return {
      id,
      task,
      deps: array(task["deps"]).map(String),
      x: MARGIN + (NODE_WIDTH + H_GAP) * column,
      y: MARGIN + (NODE_HEIGHT + V_GAP) * row,
    };
  });

  const columns = Math.max(...[...memo.values(), 0]) + 1;
  const rowCount = Math.max(...[...rows.values(), 1]);
  return {
    nodes,
    width: MARGIN * 2 + columns * NODE_WIDTH + Math.max(columns - 1, 0) * H_GAP,
    height: MARGIN * 2 + rowCount * NODE_HEIGHT + Math.max(rowCount - 1, 0) * V_GAP,
  };
}

/**
 * "就绪"在 daemon 的 status 里没有对应值,是 pending 且依赖全部完成的那一刻
 * 由界面算出来的 —— 那正是看图的人最想知道的:现在可以派谁。
 */
function isReady(node: Placed, done: Set<string>): boolean {
  return text(node.task["status"]) === "pending" && node.deps.every((dep) => done.has(dep));
}

export function RunGraph({ tasks, dispatches }: { tasks: JsonObject[]; dispatches: JsonObject[] }) {
  const { t, status } = useLocale();
  const layout = useMemo(() => layoutGraph(tasks), [tasks]);
  const done = useMemo(
    () => new Set(tasks.filter((task) => text(task["status"]) === "done").map((task) => text(task["id"]))),
    [tasks],
  );
  const activeWorkers = useMemo(
    () => new Set(dispatches
      .filter((dispatch) => ["starting", "running"].includes(text(dispatch["state"])))
      .map((dispatch) => text(dispatch["taskId"]))),
    [dispatches],
  );

  const viewportRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<string>();
  const fittedRef = useRef(false);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || layout.width === 0 || layout.height === 0) return;
    const scale = Math.min(
      Math.max(Math.min(viewport.clientWidth / layout.width, viewport.clientHeight / layout.height), MIN_ZOOM),
      MAX_ZOOM,
    );
    setZoom(scale);
    setPan({
      x: (viewport.clientWidth - layout.width * scale) / 2,
      y: (viewport.clientHeight - layout.height * scale) / 2,
    });
  }, [layout.height, layout.width]);

  // 首次打开时图比可视区大就自动适应一次 —— 别让人一进来就先手动找图。
  useEffect(() => {
    if (fittedRef.current || layout.nodes.length === 0) return;
    const viewport = viewportRef.current;
    if (!viewport || viewport.clientWidth === 0) return;
    fittedRef.current = true;
    if (layout.width > viewport.clientWidth || layout.height > viewport.clientHeight) fit();
  }, [fit, layout.height, layout.nodes.length, layout.width]);

  /** 缩放时让锚点位置不动,否则放大就是"内容往右下跑",正在看的那块会被挤出去。 */
  const zoomAround = useCallback((next: number, anchor: { x: number; y: number }) => {
    setZoom((current) => {
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
      if (clamped === current) return current;
      const ratio = clamped / current;
      setPan((currentPan) => ({
        x: anchor.x - (anchor.x - currentPan.x) * ratio,
        y: anchor.y - (anchor.y - currentPan.y) * ratio,
      }));
      return clamped;
    });
  }, []);

  const center = (): { x: number; y: number } => {
    const viewport = viewportRef.current;
    return viewport
      ? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }
      : { x: 0, y: 0 };
  };

  const onWheel = (event: React.WheelEvent): void => {
    // 触控板捏合在浏览器里就是 ctrlKey + wheel;普通滚动直接当平移用。
    if (event.ctrlKey || event.metaKey) {
      const box = viewportRef.current?.getBoundingClientRect();
      const anchor = box
        ? { x: event.clientX - box.left, y: event.clientY - box.top }
        : center();
      zoomAround(zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08), anchor);
      return;
    }
    setPan((current) => ({ x: current.x - event.deltaX, y: current.y - event.deltaY }));
  };

  const onPointerDown = (event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    const origin = { x: event.clientX, y: event.clientY };
    const start = { ...pan };
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      setPan({ x: start.x + (moveEvent.clientX - origin.x), y: start.y + (moveEvent.clientY - origin.y) });
    };
    const finish = (): void => {
      target.releasePointerCapture(event.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  };

  if (layout.nodes.length === 0) return null;

  const positions = new Map(layout.nodes.map((node) => [node.id, node]));

  return (
    <div className="run-graph">
      <div
        className="run-graph-viewport"
        ref={viewportRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
      >
        <div
          className="run-graph-canvas"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${String(pan.x)}px, ${String(pan.y)}px) scale(${String(zoom)})`,
          }}
        >
          <svg className="run-graph-edges" width={layout.width} height={layout.height} aria-hidden="true">
            <defs>
              <marker id="run-graph-arrow" markerWidth="9" markerHeight="7" refX="9" refY="3.5" orient="auto">
                <polygon points="0 0, 9 3.5, 0 7" fill="currentColor" />
              </marker>
            </defs>
            {layout.nodes.flatMap((node) =>
              node.deps.map((dep) => {
                const from = positions.get(dep);
                if (!from) return null;
                const x1 = from.x + NODE_WIDTH;
                const y1 = from.y + NODE_HEIGHT / 2;
                const x2 = node.x;
                const y2 = node.y + NODE_HEIGHT / 2;
                const bend = (x1 + x2) / 2;
                const touched = selected === node.id || selected === dep;
                return (
                  <path
                    key={`${dep}->${node.id}`}
                    className={`run-graph-edge${touched ? " touched" : ""}${done.has(dep) ? " satisfied" : ""}`}
                    d={`M ${String(x1)} ${String(y1)} C ${String(bend)} ${String(y1)}, ${String(bend)} ${String(y2)}, ${String(x2)} ${String(y2)}`}
                    markerEnd="url(#run-graph-arrow)"
                  />
                );
              }),
            )}
          </svg>
          {layout.nodes.map((node) => {
            const taskStatus = text(node.task["status"]);
            const ready = isReady(node, done);
            return (
              <button
                type="button"
                key={node.id}
                className={`run-graph-node${selected === node.id ? " selected" : ""}${ready ? " ready" : ""}`}
                style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                title={text(node.task["spec"], text(node.task["title"]))}
                onClick={() => setSelected((current) => (current === node.id ? undefined : node.id))}
              >
                <strong>{text(node.task["title"], t("未命名任务", "Untitled task"))}</strong>
                <span className="run-graph-node-meta">
                  <span className={`status-dot ${taskStatus}`} />
                  {ready ? t("就绪", "Ready") : status(taskStatus)}
                  {activeWorkers.has(node.id) && <Zap size={11} className="run-graph-worker" />}
                  {node.deps.length > 0 && <em>{node.deps.length}↑</em>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="run-graph-controls">
        <span>{layout.nodes.length} {t("个任务", "tasks")}</span>
        <div className="run-graph-zoom">
          <button type="button" aria-label={t("缩小", "Zoom out")} disabled={zoom <= MIN_ZOOM + 0.001}
            onClick={() => zoomAround(zoom / 1.25, center())}><Minus size={12} /></button>
          {/* 百分比本身就是复位按钮 —— 拖远了、缩过头了,这里一下回到原点。 */}
          <button type="button" title={t("复位:100% 并回到起点", "Reset to 100% and origin")}
            onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>{Math.round(zoom * 100)}%</button>
          <button type="button" aria-label={t("放大", "Zoom in")} disabled={zoom >= MAX_ZOOM - 0.001}
            onClick={() => zoomAround(zoom * 1.25, center())}><Plus size={12} /></button>
          <button type="button" aria-label={t("适应窗口", "Fit to window")} onClick={fit}><Maximize2 size={12} /></button>
        </div>
      </div>
    </div>
  );
}
