import type {
  DeviceDisplayInfo,
  FoldingFeatureInfo,
} from "../../modules/prospero-window-layout/src/ProsperoWindowLayout.types";

export type WindowWidthClass = "compact" | "medium" | "expanded";

export interface VerticalPaneLayout {
  start: number;
  gap: number;
  endStart: number;
  end: number;
}

export interface SplitPaneOptions {
  minWidth?: number;
  minHeight?: number;
  startRatio?: number;
  /** User-dragged ratio; overrides default clamping and non-occluded creases. */
  customRatio?: number;
  minStart?: number;
  maxStart?: number;
}

const MIN_USABLE_PANE = 240;
const MIN_DRAGGABLE_START = 220;
const MIN_DRAGGABLE_END = 256;

export function splitPaneBounds(
  width: number,
  gap = 1,
): { minStart: number; maxStart: number } {
  if (!Number.isFinite(width) || width <= 0) {
    return { minStart: MIN_DRAGGABLE_START, maxStart: MIN_DRAGGABLE_START };
  }
  const available = Math.max(0, width - Math.max(1, gap));
  const minStart = Math.min(MIN_DRAGGABLE_START, Math.floor(available * 0.45));
  const maxStart = Math.max(minStart, available - MIN_DRAGGABLE_END);
  return { minStart, maxStart };
}

export function windowWidthClass(width: number): WindowWidthClass {
  if (width < 600) return "compact";
  if (width < 840) return "medium";
  return "expanded";
}

/** Returns two continuous surfaces only when neither side is too small to use. */
export function verticalPaneLayout(
  width: number,
  feature: FoldingFeatureInfo | null,
  height?: number,
): VerticalPaneLayout | null {
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    feature === null ||
    feature.orientation !== "vertical" ||
    (!feature.isSeparating && feature.occlusionType !== "full")
  ) {
    return null;
  }

  // WindowManager can briefly retain the previous rotation's feature while
  // React Native has already published the new window dimensions. Never size
  // columns from that mismatched frame: on an unfolded device it makes the
  // first column visibly narrower until the next configuration change.
  if (
    height !== undefined &&
    Number.isFinite(height) &&
    height > 0 &&
    (feature.bounds.y < -8 ||
      feature.bounds.y + feature.bounds.height > height + 8)
  ) {
    return null;
  }

  const start = Math.max(0, Math.min(width, feature.bounds.x));
  const physicalGap = Math.max(0, feature.bounds.width);
  // A zero-width separating crease is still a semantic boundary. Keeping a
  // small gutter stops press targets and text from sitting directly on it.
  const gap = Math.max(8, physicalGap);
  const endStart = Math.min(width, start + gap);
  const end = Math.max(0, width - endStart);
  if (start < MIN_USABLE_PANE || end < MIN_USABLE_PANE) return null;
  return { start, gap, endStart, end };
}

/**
 * Unified dual-pane geometry for foldables (both flat unfolded Z Fold where
 * `isSeparating === false` and half-opened separating hinges) and tablets.
 * Compact phones and narrow foldable cover screens (<600dp or <420dp tall) return `null`.
 */
export function splitPaneLayout(
  width: number,
  height: number,
  feature: FoldingFeatureInfo | null,
  options?: SplitPaneOptions,
): VerticalPaneLayout | null {
  const customRatio = options?.customRatio;
  const hasCustomRatio = customRatio !== undefined && Number.isFinite(customRatio);
  const physical = verticalPaneLayout(width, feature, height);
  // Only a physically occluded dual-screen hinge forces fixed hardware columns;
  // continuous flexible OLED panels (Galaxy Z Fold) stay freely resizable.
  if (physical !== null && (!hasCustomRatio || feature?.occlusionType === "full")) {
    return physical;
  }

  const minWidth = options?.minWidth ?? 600;
  const minHeight = options?.minHeight ?? 420;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < minWidth ||
    height < minHeight
  ) {
    return null;
  }

  const gap = physical ? physical.gap : 1;
  if (hasCustomRatio) {
    const bounds = splitPaneBounds(width, gap);
    const start = Math.round(
      Math.min(bounds.maxStart, Math.max(bounds.minStart, width * customRatio)),
    );
    const endStart = start + gap;
    const end = Math.max(0, width - endStart);
    if (start < MIN_DRAGGABLE_START || end < MIN_USABLE_PANE) return null;
    return { start, gap, endStart, end };
  }

  const ratio = options?.startRatio ?? 0.38;
  const minStart = options?.minStart ?? 256;
  const maxStart = options?.maxStart ?? 380;
  const start = Math.round(Math.min(maxStart, Math.max(minStart, width * ratio)));
  const endStart = start + gap;
  const end = width - endStart;
  if (start < MIN_USABLE_PANE || end < MIN_USABLE_PANE) return null;
  return { start, gap, endStart, end };
}

/**
 * A separating vertical fold is a physical boundary, not a column gap that
 * content may flow through. Screens that are designed as one task at a time
 * use the leading continuous surface; otherwise they retain the full window.
 */
export function primaryPaneWidth(
  width: number,
  panes: VerticalPaneLayout | null,
): number {
  return panes?.start ?? width;
}

export type FoldPosture = "folded" | "unfolded" | "half-opened" | "none";
export type WindowOrientation = "portrait" | "landscape";

export interface DevicePosture {
  /** none = 不是折叠机(或拿不到原生信息)。 */
  fold: FoldPosture;
  orientation: WindowOrientation;
}

// 外屏(Fold 系列约 360–480dp)和内屏(≥ 600dp)之间的分界,沿用 Android 平板断点。
const UNFOLDED_MIN_DISPLAY_WIDTH = 600;

/**
 * 判定「合上/展开 × 横屏/竖屏」。
 *
 * - 方向看窗口宽高比，不看系统 rotation:Fold 内屏的自然方向是横向,
 *   rotation 0 在那里是横屏。
 * - 有 FoldingFeature 一定是展开(平展或半折)。没有时不能直接当作合上:
 *   内屏分屏/小窗同样没有,所以再看当前显示屏的最短边。
 */
export function devicePosture(
  width: number,
  height: number,
  feature: FoldingFeatureInfo | null,
  device: DeviceDisplayInfo | undefined,
): DevicePosture {
  const orientation: WindowOrientation = width > height ? "landscape" : "portrait";
  let fold: FoldPosture = "none";
  if (feature !== null) {
    fold = feature.state === "half-opened" ? "half-opened" : "unfolded";
  } else if (device?.isFoldable) {
    fold = device.displaySmallestWidth < UNFOLDED_MIN_DISPLAY_WIDTH ? "folded" : "unfolded";
  }
  return { fold, orientation };
}
