export const DEVICE_RAIL_VISIBLE_LIMIT = 6;
export const DEVICE_QUICK_SWITCH_STEP = 34;
export const DEVICE_QUICK_SWITCH_CANCEL_Y = 52;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Keep the active device visible without allowing the compact rail to grow forever. */
export function deviceRailWindow(
  deviceCount: number,
  activeIndex: number,
  limit = DEVICE_RAIL_VISIBLE_LIMIT,
): number[] {
  if (deviceCount <= 0 || limit <= 0) return [];
  const windowSize = Math.min(deviceCount, Math.max(1, Math.floor(limit)));
  const safeActiveIndex = clamp(Math.floor(activeIndex), 0, deviceCount - 1);
  const preferredStart = safeActiveIndex - Math.floor(windowSize / 2);
  const start = clamp(preferredStart, 0, deviceCount - windowSize);
  return Array.from({ length: windowSize }, (_, offset) => start + offset);
}

/** Map travel along the switcher's primary axis while keeping either end reachable. */
export function deviceIndexForTranslation(
  startIndex: number,
  translation: number,
  deviceCount: number,
  step = DEVICE_QUICK_SWITCH_STEP,
): number {
  if (deviceCount <= 0) return -1;
  const safeStep = Math.max(1, step);
  return clamp(
    Math.floor(startIndex) + Math.round(translation / safeStep),
    0,
    deviceCount - 1,
  );
}

export function quickSwitchShouldCancel(
  translationY: number,
  threshold = DEVICE_QUICK_SWITCH_CANCEL_Y,
): boolean {
  return Math.abs(translationY) >= Math.max(1, threshold);
}

/** Resolve the centered card after a paged horizontal swipe settles. */
export function deviceIndexForCarouselOffset(
  offsetX: number,
  itemStride: number,
  deviceCount: number,
): number {
  if (deviceCount <= 0) return -1;
  return clamp(Math.round(Math.max(0, offsetX) / Math.max(1, itemStride)), 0, deviceCount - 1);
}

/** Map a pointer moving across the scrollable OS rail to its device slot. */
export function deviceIndexForRailPosition(
  contentOffsetX: number,
  pointerX: number,
  deviceCount: number,
  itemWidth = 50,
  leadingPadding = 8,
): number {
  if (deviceCount <= 0) return -1;
  const center = Math.max(0, contentOffsetX) + Math.max(0, pointerX) - leadingPadding;
  return clamp(Math.floor(center / Math.max(1, itemWidth)), 0, deviceCount - 1);
}
