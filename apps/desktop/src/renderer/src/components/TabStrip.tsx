import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { useLocale } from "../locale";
import { cn } from "../lib/utils";
import { moveTabBefore, tabReorderKey } from "./tab-strip-state";
import "./tab-strip.css";

export type TabStripItem = { id: string; label: string; onSelect: () => void; onClose?: () => void };
export type DocumentTabs = { items: TabStripItem[]; activeId: string | undefined };
type Drag = { id: string; pointer: number; x: number; startX: number; scroll: number; started: boolean; before: string | null; keys: string; element: HTMLElement };

/** Shared rail for sessions, documents and tools. Sorting never remounts a panel. */
export function TabStrip({ items, activeId, onReorder, label, className, listClassName, children }: {
  items: TabStripItem[]; activeId: string | undefined; onReorder: (ids: string[]) => void;
  label: string; className?: string; listClassName?: string; children: ReactNode;
}) {
  const { t } = useLocale();
  const description = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const revealTarget = useRef(activeId);
  const previousActive = useRef(activeId);
  if (previousActive.current !== activeId) { previousActive.current = activeId; revealTarget.current = activeId; }
  const latest = useRef({ items, onReorder }); latest.current = { items, onReorder };
  const drag = useRef<Drag | undefined>(undefined);
  const suppressClick = useRef(0);
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false });
  const [announcement, setAnnouncement] = useState("");
  const keys = JSON.stringify(items.map(item => item.id));
  const tabElements = () => [...viewport.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? []];
  const elementFor = (id: string) => tabElements().find(element => element.dataset.tabId === id);
  const reveal = (id: string) => {
    const host = viewport.current, element = elementFor(id);
    if (!host || !element || !host.getClientRects().length || drag.current?.started) return;
    const outer = host.getBoundingClientRect(), inner = element.getBoundingClientRect();
    if (inner.left < outer.left) host.scrollLeft -= outer.left - inner.left + 2;
    else if (inner.right > outer.right) host.scrollLeft += inner.right - outer.right + 2;
  };
  const focus = (id: string) => {
    revealTarget.current = id;
    requestAnimationFrame(() => { reveal(id); elementFor(id)?.querySelector<HTMLElement>("[role=tab]")?.focus({ preventScroll: true }); });
  };
  useLayoutEffect(() => {
    const host = viewport.current;
    if (!host) return;
    // Documents are portaled into this rail. CSS order also allows a terminal
    // to move between documents without changing either React component tree.
    for (const element of tabElements()) element.style.order = String(items.findIndex(item => item.id === element.dataset.tabId));
    const measure = () => {
      const next = { overflow: host.scrollWidth > host.clientWidth + 1, left: host.scrollLeft > 1, right: host.scrollLeft + host.clientWidth < host.scrollWidth - 1 };
      setEdges(current => Object.keys(next).every(key => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    };
    const observer = new ResizeObserver(() => { measure(); if (revealTarget.current) reveal(revealTarget.current); });
    observer.observe(host);
    host.addEventListener("scroll", measure, { passive: true });
    const wheel = (event: WheelEvent) => {
      // Preserve native horizontal trackpad gestures and pinch-to-zoom on macOS.
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || host.scrollWidth <= host.clientWidth) return;
      const previous = host.scrollLeft;
      host.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientWidth : 1);
      if (host.scrollLeft !== previous) event.preventDefault();
    };
    host.addEventListener("wheel", wheel, { passive: false });
    measure(); if (revealTarget.current) reveal(revealTarget.current);
    return () => { observer.disconnect(); host.removeEventListener("scroll", measure); host.removeEventListener("wheel", wheel); };
  }, [keys, activeId]);

  useLayoutEffect(() => {
    const host = viewport.current;
    if (!host) return;
    let frame = 0;
    const finish = (cancel: boolean) => {
      const current = drag.current;
      drag.current = undefined;
      cancelAnimationFrame(frame);
      if (!current) return;
      current.element.style.removeProperty("transform");
      delete current.element.dataset.dragging;
      delete host.dataset.sorting;
      if (host.hasPointerCapture(current.pointer)) host.releasePointerCapture(current.pointer);
      if (!current.started) return;
      suppressClick.current = performance.now() + 250;
      const ids = latest.current.items.map(item => item.id);
      if (!cancel && JSON.stringify(ids) === current.keys) {
        const target = tabElements().filter(element => element !== current.element).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).find(element => { const rect = element.getBoundingClientRect(); return current.x < rect.left + rect.width / 2; });
        current.before = target?.dataset.tabId ?? null;
        const next = moveTabBefore(ids, current.id, current.before);
        latest.current.onReorder(next);
        const item = latest.current.items.find(item => item.id === current.id);
        setAnnouncement(t(`${item?.label}，第 ${next.indexOf(current.id) + 1} 个，共 ${next.length} 个`, `${item?.label}, position ${next.indexOf(current.id) + 1} of ${next.length}`));
        focus(current.id);
      }
    };
    const paint = () => {
      const current = drag.current;
      if (!current?.started) return;
      const outer = host.getBoundingClientRect();
      const edge = Math.min(36, outer.width / 4);
      const speed = current.x < outer.left + edge ? -Math.min(12, (outer.left + edge - current.x) / 3) : current.x > outer.right - edge ? Math.min(12, (current.x - outer.right + edge) / 3) : 0;
      host.scrollLeft += speed;
      current.element.style.transform = `translateX(${current.x - current.startX + host.scrollLeft - current.scroll}px)`;
      const others = tabElements().filter(element => element !== current.element).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      const target = others.find(element => { const rect = element.getBoundingClientRect(); return current.x < rect.left + rect.width / 2; });
      current.before = target?.dataset.tabId ?? null;
      const marker = target?.getBoundingClientRect().left ?? others.at(-1)?.getBoundingClientRect().right ?? outer.left;
      host.style.setProperty("--tab-drop-x", `${Math.max(1, Math.min(outer.width - 2, marker - outer.left)) + host.scrollLeft}px`);
      frame = requestAnimationFrame(paint);
    };
    const move = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || current.pointer !== event.pointerId) return;
      current.x = event.clientX;
      if (!current.started && Math.abs(event.clientX - current.startX) >= 6) {
        current.started = true;
        host.setPointerCapture(event.pointerId);
        current.element.dataset.dragging = "true";
        host.dataset.sorting = "true";
        frame = requestAnimationFrame(paint);
      }
      if (current.started) event.preventDefault();
    };
    const up = (event: PointerEvent) => { if (event.pointerId === drag.current?.pointer) { drag.current.x = event.clientX; finish(event.type !== "pointerup"); } };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); finish(true); } };
    const blur = () => finish(true);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", escape, true); window.addEventListener("blur", blur);
    host.addEventListener("lostpointercapture", blur);
    return () => {
      finish(true); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", escape, true); window.removeEventListener("blur", blur); host.removeEventListener("lostpointercapture", blur);
    };
  }, []);

  // Native capture includes documents portaled from ProjectToolsProvider.
  // React events would bubble through that provider instead of this rail.
  useLayoutEffect(() => {
    const host = viewport.current;
    if (!host) return;
    const down = (event: PointerEvent) => {
        suppressClick.current = 0;
        if (event.button !== 0 || !event.isPrimary || event.ctrlKey && window.prospero.platform === "darwin") return;
        const handle = (event.target as HTMLElement).closest("[data-tab-handle]");
        const element = handle?.closest<HTMLElement>("[data-tab-id]");
        if (!element?.dataset.tabId) return;
        drag.current = { id: element.dataset.tabId, pointer: event.pointerId, startX: event.clientX, x: event.clientX, scroll: host.scrollLeft, started: false, before: null, keys, element };
    };
    const click = (event: MouseEvent) => { if (performance.now() < suppressClick.current) { suppressClick.current = 0; event.preventDefault(); event.stopPropagation(); } };
    const keydown = (event: KeyboardEvent) => {
        const handle = (event.target as HTMLElement).closest("[role=tab]");
        const id = handle?.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
        const index = items.findIndex(item => item.id === id);
        if (index < 0 || !id) return;
        if (tabReorderKey(event, window.prospero.platform)) {
          event.preventDefault(); event.stopPropagation();
          const to = Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)));
          const ids = items.map(item => item.id);
          if (to !== index) onReorder(moveTabBefore(ids, id, to < index ? ids[to]! : ids[to + 1] ?? null));
          focus(id); return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowLeft" ? (index - 1 + items.length) % items.length : event.key === "ArrowRight" ? (index + 1) % items.length : undefined;
        if (next !== undefined) { event.preventDefault(); event.stopPropagation(); items[next]!.onSelect(); focus(items[next]!.id); }
        if (event.key === "Delete" && items[index]?.onClose) {
          event.preventDefault(); event.stopPropagation(); items[index]!.onClose!();
          requestAnimationFrame(() => { const neighbor = items[index + 1] ?? items[index - 1]; if (elementFor(id)) focus(id); else if (neighbor) focus(neighbor.id); });
        }
    };
    host.addEventListener("pointerdown", down, true); host.addEventListener("click", click, true); host.addEventListener("keydown", keydown, true);
    return () => { host.removeEventListener("pointerdown", down, true); host.removeEventListener("click", click, true); host.removeEventListener("keydown", keydown, true); };
  }, [items, keys, onReorder]);

  return <div className={cn("tab-strip", className)} data-overflow={edges.overflow || undefined}>
    <div ref={viewport} className={cn("tab-strip-viewport", listClassName)} role="tablist" aria-label={label} aria-describedby={description}>
      {children}
    </div>
    {edges.overflow && <div className="tab-strip-overflow">
      <Button size="icon-xs" variant="ghost" aria-label={t("向前滚动标签", "Scroll tabs back")} disabled={!edges.left} onClick={() => viewport.current?.scrollBy({ left: -Math.max(140, viewport.current.clientWidth * .7) })}><ChevronLeft /></Button>
      <Button size="icon-xs" variant="ghost" aria-label={t("向后滚动标签", "Scroll tabs forward")} disabled={!edges.right} onClick={() => viewport.current?.scrollBy({ left: Math.max(140, viewport.current.clientWidth * .7) })}><ChevronRight /></Button>
      <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={t("所有标签", "All tabs")} />}><ChevronDown /></DropdownMenuTrigger><DropdownMenuContent align="end" className="tab-strip-menu"><DropdownMenuGroup>{items.map(item => <DropdownMenuItem key={item.id} onClick={() => { item.onSelect(); focus(item.id); }}><Check className={item.id === activeId ? "" : "invisible"} /><span className="truncate">{item.label}</span></DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
    </div>}
    <span id={description} className="sr-only">{t("拖拽排序；按住 Control 或 Command 和 Shift，再按左右方向键移动标签。", "Drag to reorder, or hold Control (Command on Mac) and Shift with the arrow keys.")}</span>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </div>;
}
