/** Recovery serialization is synchronous. Never start it during a user gesture. */
export function scheduleTerminalCache(
  root: Document,
  save: () => boolean,
): { schedule: () => void; dispose: () => void } {
  const view = root.defaultView!;
  let disposed = false;
  let timer: number | undefined;
  let idle: number | undefined;
  let dirty = false;
  let quietUntil = 0;
  const pointers = new Set<number>();
  const cancel = () => {
    if (timer !== undefined) view.clearTimeout(timer);
    if (idle !== undefined) view.cancelIdleCallback(idle);
    timer = idle = undefined;
  };
  const arm = () => {
    if (disposed || !dirty || timer !== undefined || idle !== undefined) return;
    timer = view.setTimeout(() => {
      timer = undefined;
      if (pointers.size || Date.now() < quietUntil) { arm(); return; }
      const run = () => {
        idle = undefined;
        if (disposed) return;
        if (pointers.size || Date.now() < quietUntil) { arm(); return; }
        dirty = !save();
        if (dirty) arm();
      };
      // Do not force a long synchronous checkpoint into a busy frame via timeout.
      if (view.requestIdleCallback) idle = view.requestIdleCallback(run);
      else run();
    }, 2_000);
  };
  const interact = () => { quietUntil = Date.now() + 1_000; };
  const down = (event: PointerEvent) => { pointers.add(event.pointerId); interact(); };
  const up = (event: PointerEvent) => { pointers.delete(event.pointerId); interact(); };
  const blur = () => { pointers.clear(); interact(); };
  root.addEventListener("pointerdown", down, { capture: true, passive: true });
  root.addEventListener("pointerup", up, { capture: true, passive: true });
  root.addEventListener("pointercancel", up, { capture: true, passive: true });
  root.addEventListener("keydown", interact, { capture: true, passive: true });
  root.addEventListener("wheel", interact, { capture: true, passive: true });
  view.addEventListener("blur", blur);
  return {
    schedule: () => { dirty = true; arm(); },
    dispose: () => {
      disposed = true;
      cancel();
      root.removeEventListener("pointerdown", down, true);
      root.removeEventListener("pointerup", up, true);
      root.removeEventListener("pointercancel", up, true);
      root.removeEventListener("keydown", interact, true);
      root.removeEventListener("wheel", interact, true);
      view.removeEventListener("blur", blur);
    },
  };
}
