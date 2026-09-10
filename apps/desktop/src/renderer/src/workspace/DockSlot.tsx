import { useLayoutEffect, useRef } from "react";

/** Reparent the same portal host between the inline split and the Sheet. */
export function DockSlot({ container }: { container: HTMLDivElement | null }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = slot.current;
    if (!host || !container) return;
    host.appendChild(container);
    return () => { if (container.parentNode === host) container.remove(); };
  }, [container]);
  return <div className="workspace-dock-slot" ref={slot} />;
}
