import { useEffect, useRef, useState } from "react";

/** Record committed destinations, including navigation via shortcuts and sidebar. */
export function useNavigationHistory<T>(location: T, restore: (location: T) => void) {
  const history = useRef<{ key: string; location: T }[]>([]);
  const cursor = useRef(-1);
  const [, refresh] = useState(0);
  const key = JSON.stringify(location);
  useEffect(() => {
    if (history.current[cursor.current]?.key === key) return;
    history.current = [...history.current.slice(0, cursor.current + 1), { key, location }].slice(-60);
    cursor.current = history.current.length - 1;
    refresh((value) => value + 1);
  }, [key]);
  const move = (direction: number): void => {
    const next = cursor.current + direction;
    const entry = history.current[next];
    if (!entry) return;
    cursor.current = next;
    restore(entry.location);
    refresh((value) => value + 1);
  };
  return { canBack: cursor.current > 0, canForward: cursor.current < history.current.length - 1, back: () => move(-1), forward: () => move(1) };
}
