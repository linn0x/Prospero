import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { installLiquidGlass } from '../src/renderer/src/liquid-glass.js';

class Surface extends EventTarget {
  readonly values = new Map<string, string>();
  readonly style = { setProperty: (key: string, value: string) => this.values.set(key, value) };
  constructor(readonly parent: Surface | null = null) { super(); }
  closest(): Surface { return this.parent ?? this; }
  getBoundingClientRect() { return { left: 10, top: 20, width: 200, height: 100 }; }
}

function fixture() {
  const callbacks = new Map<number, FrameRequestCallback>();
  const motion = Object.assign(new EventTarget(), { matches: false });
  const media = new Map<string, typeof motion>([['(prefers-reduced-motion: reduce)', motion]]);
  const surfaces = new Set<Surface>();
  let nextFrame = 0;
  let preferenceCallback: (() => void) | undefined;
  let observerDisconnected = false;
  const view = Object.assign(new EventTarget(), {
    matchMedia: (query: string) => {
      if (!media.has(query)) media.set(query, Object.assign(new EventTarget(), { matches: false }));
      return media.get(query)!;
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callbacks.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => { callbacks.delete(id); },
    MutationObserver: class {
      constructor(callback: () => void) { preferenceCallback = callback; }
      observe() {}
      disconnect() { observerDisconnected = true; preferenceCallback = undefined; }
    },
  });
  const root = Object.assign(new EventTarget(), {
    defaultView: view,
    hidden: false,
    documentElement: { dataset: { platform: "darwin", nativeGlass: "true" } as Record<string, string> },
    contains: (element: Surface) => surfaces.has(element),
  });
  const addSurface = (parent: Surface | null = null) => {
    const element = new Surface(parent);
    surfaces.add(element);
    return element;
  };
  const pointer = (type: string, target: EventTarget, fields = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerType: 'mouse', clientX: 110, clientY: 70, relatedTarget: null, ...fields,
    });
    Object.defineProperty(event, 'target', { value: target });
    root.dispatchEvent(event);
    return event;
  };
  const flush = () => {
    const batch = [...callbacks.values()];
    callbacks.clear();
    for (const callback of batch) callback(0);
  };
  return {
    root, view, motion, media, surfaces, addSurface, pointer, flush, callbacks,
    preferencesChanged: () => preferenceCallback?.(),
    observerDisconnected: () => observerDisconnected,
    install: () => installLiquidGlass(root as unknown as Document),
  };
}

describe('liquid glass pointer lifecycle', () => {
  it.each(['win32', 'linux'])('does not animate native glass on %s', (platform) => {
    const f = fixture(); f.root.documentElement.dataset.platform = platform;
    const target = f.addSurface(); const cleanup = f.install();
    f.pointer('pointermove', target); f.flush();
    expect(f.callbacks.size).toBe(0); expect(target.values.size).toBe(0); cleanup();
  });
  it('delegates through child elements and coalesces movement into the latest local coordinates', () => {
    const f = fixture();
    const target = f.addSurface();
    const child = f.addSurface(target);
    const unrelated = f.addSurface();
    const cleanup = f.install();
    f.pointer('pointermove', child);
    const event = f.pointer('pointermove', child, { clientX: 160, clientY: 45 });
    expect(f.callbacks.size).toBe(1);
    expect(target.values.size).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    f.flush();
    expect(target.values.get('--liquid-x')).toBe('75.00%');
    expect(target.values.get('--liquid-y')).toBe('25.00%');
    expect(target.values.get('--liquid-active')).toBe('1');
    expect(unrelated.values.size).toBe(0);
    expect(f.callbacks.size).toBe(0);
    cleanup();
  });

  it('preserves internal hover, resets the previous surface, and cancels a frame when leaving', () => {
    const f = fixture();
    const first = f.addSurface();
    const child = f.addSurface(first);
    const second = f.addSurface();
    const cleanup = f.install();
    f.pointer('pointermove', first);
    f.flush();
    f.pointer('pointerout', first, { relatedTarget: child });
    expect(first.values.get('--liquid-active')).toBe('1');
    f.pointer('pointermove', second, { pointerType: 'pen', clientX: -100, clientY: 900 });
    f.flush();
    expect(first.values.get('--liquid-active')).toBe('0');
    expect(second.values.get('--liquid-x')).toBe('0.00%');
    expect(second.values.get('--liquid-y')).toBe('100.00%');
    f.pointer('pointermove', second);
    f.pointer('pointerout', second);
    expect(f.callbacks.size).toBe(0);
    f.flush();
    expect(second.values.get('--liquid-active')).toBe('0');
    cleanup();
  });

  it.each(['motion', 'hidden', 'reducedTransparency', 'highContrast'] as const)(
    'stops immediately for %s and only resumes on a new movement', (preference) => {
      const f = fixture();
      const target = f.addSurface();
      const setDisabled = (value: boolean) => {
        if (preference === 'motion') {
          f.motion.matches = value;
          f.motion.dispatchEvent(new Event('change'));
        } else if (preference === 'hidden') {
          f.root.hidden = value;
          f.root.dispatchEvent(new Event('visibilitychange'));
        } else {
          f.root.documentElement.dataset[preference] = String(value);
          f.preferencesChanged();
        }
      };
      const cleanup = f.install();
      f.pointer('pointermove', target);
      f.flush();
      f.pointer('pointermove', target);
      setDisabled(true);
      expect(f.callbacks.size).toBe(0);
      expect(target.values.get('--liquid-active')).toBe('0');
      f.pointer('pointermove', target);
      expect(f.callbacks.size).toBe(0);
      setDisabled(false);
      expect(f.callbacks.size).toBe(0);
      f.pointer('pointermove', target);
      f.flush();
      expect(target.values.get('--liquid-active')).toBe('1');
      cleanup();
    },
  );

  it('ignores touch and detached surfaces and clears on pointer cancellation or window blur', () => {
    const f = fixture();
    const target = f.addSurface();
    const cleanup = f.install();
    f.pointer('pointermove', target, { pointerType: 'touch' });
    expect(f.callbacks.size).toBe(0);
    f.pointer('pointermove', target);
    f.surfaces.delete(target);
    f.flush();
    expect(target.values.size).toBe(0);
    f.surfaces.add(target);
    for (const stop of [
      () => f.pointer('pointercancel', target),
      () => f.view.dispatchEvent(new Event('blur')),
    ]) {
      f.pointer('pointermove', target);
      f.flush();
      stop();
      expect(target.values.get('--liquid-active')).toBe('0');
    }
    cleanup();
  });

  it.each(['(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)'])(
    'stops tracking immediately when %s changes without a native appearance update', (query) => {
      const f = fixture();
      const target = f.addSurface();
      const cleanup = f.install();
      f.pointer('pointermove', target);
      f.flush();
      f.pointer('pointermove', target);
      const preference = f.media.get(query)!;
      preference.matches = true;
      preference.dispatchEvent(new Event('change'));
      expect(f.callbacks.size).toBe(0);
      expect(target.values.get('--liquid-active')).toBe('0');
      f.pointer('pointermove', target);
      expect(f.callbacks.size).toBe(0);
      preference.matches = false;
      preference.dispatchEvent(new Event('change'));
      expect(f.callbacks.size).toBe(0);
      f.pointer('pointermove', target);
      f.flush();
      expect(target.values.get('--liquid-active')).toBe('1');
      cleanup();
      for (const media of f.media.values()) expect(getEventListeners(media, 'change')).toHaveLength(0);
    },
  );

  it('cleans up listeners, the preference observer, pending frames and active styles idempotently', () => {
    const f = fixture();
    const target = f.addSurface();
    const cleanup = f.install();
    f.pointer('pointermove', target);
    f.flush();
    f.pointer('pointermove', target);
    cleanup();
    cleanup();
    expect(f.callbacks.size).toBe(0);
    expect(f.observerDisconnected()).toBe(true);
    for (const event of ['pointermove', 'pointerout', 'pointercancel', 'visibilitychange']) {
      expect(getEventListeners(f.root, event)).toHaveLength(0);
    }
    expect(getEventListeners(f.view, 'blur')).toHaveLength(0);
    expect(getEventListeners(f.motion, 'change')).toHaveLength(0);
    expect(Object.fromEntries(target.values)).toEqual({
      '--liquid-x': '50%', '--liquid-y': '50%', '--liquid-active': '0',
    });
    f.pointer('pointermove', target);
    expect(f.callbacks.size).toBe(0);
  });
});
