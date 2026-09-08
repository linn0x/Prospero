export function normalizeDeviceOrder(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
}

/** Ignore deleted devices; newly paired devices follow the user's saved order. */
export function orderDevices<T extends { id: string }>(devices: readonly T[], order: readonly string[]): T[] {
  const remaining = new Map(devices.map((device) => [device.id, device]));
  const result: T[] = [];
  for (const id of order) {
    const device = remaining.get(id);
    if (device) { result.push(device); remaining.delete(id); }
  }
  return [...result, ...remaining.values()];
}

export function moveDevice(order: readonly string[], id: string, target: number): string[] {
  const from = order.indexOf(id);
  if (from < 0 || !Number.isFinite(target)) return [...order];
  const result = [...order];
  result.splice(from, 1);
  result.splice(Math.max(0, Math.min(result.length, Math.round(target))), 0, id);
  return result;
}

export function deviceDragIndex(top: number, stride: number, count: number): number {
  if (!Number.isFinite(top) || stride <= 0 || count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(top / stride)));
}

/** Pixels per second. Hold a dragged row near either edge to reach off-screen devices. */
export function deviceDragScrollSpeed(pointerY: number, top: number, height: number): number {
  const edge = Math.min(56, height / 4);
  if (edge <= 0) return 0;
  if (pointerY < top + edge) return -420 * Math.min(1, Math.max(0, (top + edge - pointerY) / edge));
  if (pointerY > top + height - edge) return 420 * Math.min(1, Math.max(0, (pointerY - top - height + edge) / edge));
  return 0;
}
