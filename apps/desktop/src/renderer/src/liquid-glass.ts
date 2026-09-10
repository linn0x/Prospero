/** Attach pointer highlights without creating React updates or an animation loop. */
export function installLiquidGlass(root: Document = document): () => void {
  const view = root.defaultView;
  if (!view) return () => {};

  const mediaPreferences = [
    '(prefers-reduced-motion: reduce)',
    '(prefers-reduced-transparency: reduce)',
    '(prefers-contrast: more)',
    '(forced-colors: active)',
  ].map((query) => view.matchMedia(query));
  let active: HTMLElement | null = null;
  let pending: { element: HTMLElement; x: number; y: number } | null = null;
  let frame: number | null = null;
  let disposed = false;

  const disabled = (): boolean => disposed || root.hidden || root.documentElement.dataset.platform !== 'darwin' || root.documentElement.dataset.nativeGlass !== 'true' || mediaPreferences.some((preference) => preference.matches)
    || root.documentElement.dataset.reducedTransparency === 'true'
    || root.documentElement.dataset.highContrast === 'true';

  const clearActive = (): void => {
    if (!active) return;
    active.style.setProperty('--liquid-x', '50%');
    active.style.setProperty('--liquid-y', '50%');
    active.style.setProperty('--liquid-active', '0');
    active = null;
  };

  const reset = (): void => {
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    pending = null;
    clearActive();
  };

  const surface = (target: EventTarget | null): HTMLElement | null => {
    const element = target as Element | null;
    if (typeof element?.closest !== 'function') return null;
    const match = element.closest<HTMLElement>('[data-liquid-glass]');
    if (match?.getAttribute('data-liquid-glass') === 'tab' && match.closest('[data-liquid-glass-scope="plain"]')) return null;
    return match && 'style' in match && root.contains(match) ? match : null;
  };

  const render = (): void => {
    frame = null;
    const next = pending;
    pending = null;
    if (disabled() || !next || !root.contains(next.element)) {
      clearActive();
      return;
    }
    const rect = next.element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      clearActive();
      return;
    }
    if (active !== next.element) clearActive();
    active = next.element;
    const x = Math.max(0, Math.min(100, (next.x - rect.left) / rect.width * 100));
    const y = Math.max(0, Math.min(100, (next.y - rect.top) / rect.height * 100));
    active.style.setProperty('--liquid-x', `${x.toFixed(2)}%`);
    active.style.setProperty('--liquid-y', `${y.toFixed(2)}%`);
    active.style.setProperty('--liquid-active', '1');
  };

  const move = (event: PointerEvent): void => {
    if (disabled() || (event.pointerType !== 'mouse' && event.pointerType !== 'pen')) {
      reset();
      return;
    }
    const element = surface(event.target);
    if (!element) {
      reset();
      return;
    }
    pending = { element, x: event.clientX, y: event.clientY };
    if (frame === null) frame = view.requestAnimationFrame(render);
  };

  const leave = (event: PointerEvent): void => {
    const hovered = pending?.element ?? active;
    if (hovered && surface(event.relatedTarget) !== hovered) reset();
  };

  const preferencesChanged = (): void => {
    if (disabled()) reset();
  };
  const preferences = new view.MutationObserver(preferencesChanged);
  preferences.observe(root.documentElement, {
    attributes: true,
    attributeFilter: ['data-platform', 'data-native-glass', 'data-reduced-transparency', 'data-high-contrast'],
  });
  root.addEventListener('pointermove', move, { passive: true });
  root.addEventListener('pointerout', leave, { passive: true });
  root.addEventListener('pointercancel', reset, { passive: true });
  root.addEventListener('visibilitychange', preferencesChanged);
  view.addEventListener('blur', reset);
  for (const preference of mediaPreferences) preference.addEventListener('change', preferencesChanged);

  return () => {
    if (disposed) return;
    disposed = true;
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerout', leave);
    root.removeEventListener('pointercancel', reset);
    root.removeEventListener('visibilitychange', preferencesChanged);
    view.removeEventListener('blur', reset);
    for (const preference of mediaPreferences) preference.removeEventListener('change', preferencesChanged);
    preferences.disconnect();
    reset();
  };
}
