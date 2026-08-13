import type { EdgeInsets } from "react-native-safe-area-context";

const COMMIT_BAR_GUTTER = 10;

/**
 * The keyboard avoider owns IME displacement. This helper only applies the
 * system safe area, so closing the keyboard returns directly to the system-bar
 * inset instead of retaining keyboard-sized padding.
 */
export function getGitCommitBarPadding(
  insets: Pick<EdgeInsets, "bottom" | "left" | "right">,
): { paddingTop: number; paddingBottom: number; paddingLeft: number; paddingRight: number } {
  return {
    paddingTop: COMMIT_BAR_GUTTER,
    paddingBottom: COMMIT_BAR_GUTTER + insets.bottom,
    paddingLeft: COMMIT_BAR_GUTTER + insets.left,
    paddingRight: COMMIT_BAR_GUTTER + insets.right,
  };
}
