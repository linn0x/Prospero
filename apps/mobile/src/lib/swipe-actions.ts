export interface AccessibleSwipeAction {
  /** A stable, custom action name used by VoiceOver and TalkBack. */
  id: string;
  /** The localized label announced by assistive technology. */
  label: string;
}

/**
 * React Native requires a machine-readable action name as well as the label
 * that is announced to a screen-reader user. Keeping this mapping separate
 * makes the swipe, menu, and accessibility entry points share one action.
 */
export function toAccessibilityActions(
  actions: readonly AccessibleSwipeAction[],
): { name: string; label: string }[] {
  return actions.map((action) => ({ name: action.id, label: action.label }));
}

export function findAccessibilityAction<T extends AccessibleSwipeAction>(
  actions: readonly T[],
  actionName: string,
): T | undefined {
  return actions.find((action) => action.id === actionName);
}
