/**
 * 未配对首页只显示少量说明，因此应在常规字号时自然居中；但 Dynamic
 * Type 可以让同一份内容超过小屏的可用高度。这个策略始终使用纵向可滚动
 * 容器，`flexGrow` 只负责短内容的居中，不能再由不可滚动的 `flex: 1`
 * 空态容器承担两种互斥的职责。
 */
export const HOME_EMPTY_STATE_MIN_VIEWPORT = {
  width: 320,
  height: 548,
} as const;

/** iOS `accessibility-extra-extra-extra-large` 的 Body 相对默认字号比例。 */
export const HOME_EMPTY_STATE_MAX_FONT_SCALE = 3.125;

export const HOME_EMPTY_STATE_MIN_HIT_TARGET = 44;
export const HOME_EMPTY_STATE_MAX_CONTENT_WIDTH = 560;

const COMPACT_HORIZONTAL_PADDING = 16;
const REGULAR_HORIZONTAL_PADDING = 24;
const REGULAR_VERTICAL_PADDING = 24;
const LARGE_TYPE_VERTICAL_PADDING = 16;
const SAFE_AREA_BOTTOM_GAP = 12;

type HomeEmptyStateLayoutInput = {
  /** 当前连续可用面板的宽度；分离铰链时传入右面板宽度。 */
  viewportWidth: number;
  bottomInset: number;
  fontScale: number;
};

/**
 * 返回 ScrollView 与其唯一内容容器的布局。数值逻辑刻意不依赖 RN，
 * 让最小视口和最大辅助字号可以在 Vitest 中稳定覆盖。
 */
export function homeEmptyStateLayout({
  viewportWidth,
  bottomInset,
  fontScale,
}: HomeEmptyStateLayoutInput) {
  const horizontalPadding =
    viewportWidth <= HOME_EMPTY_STATE_MIN_VIEWPORT.width
      ? COMPACT_HORIZONTAL_PADDING
      : REGULAR_HORIZONTAL_PADDING;
  const verticalPadding =
    fontScale >= HOME_EMPTY_STATE_MAX_FONT_SCALE
      ? LARGE_TYPE_VERTICAL_PADDING
      : REGULAR_VERTICAL_PADDING;
  const contentWidth = Math.max(0, viewportWidth - horizontalPadding * 2);

  return {
    contentContainer: {
      flexGrow: 1,
      justifyContent: "center" as const,
      paddingHorizontal: horizontalPadding,
      paddingTop: verticalPadding,
      paddingBottom: Math.max(verticalPadding, bottomInset + SAFE_AREA_BOTTOM_GAP),
    },
    body: {
      width: "100%" as const,
      maxWidth: Math.min(contentWidth, HOME_EMPTY_STATE_MAX_CONTENT_WIDTH),
      alignSelf: "center" as const,
    },
  };
}
