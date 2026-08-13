import type { FoldingFeatureInfo } from "../../modules/prospero-window-layout/src/ProsperoWindowLayout.types";

export type WindowWidthClass = "compact" | "medium" | "expanded";

export interface VerticalPaneLayout {
  start: number;
  gap: number;
  endStart: number;
  end: number;
}

const MIN_USABLE_PANE = 240;

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
