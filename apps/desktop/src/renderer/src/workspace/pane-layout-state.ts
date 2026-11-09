export const SPLIT_RATIO_MIN = 25;
export const SPLIT_RATIO_MAX = 75;
export const SPLIT_RATIO_DEFAULT = 50;
export const SPLIT_STACKED_BREAKPOINT = 900;

export interface WorkspaceSplitLayoutState {
  activeId: string | undefined;
  splitId: string | undefined;
  focusedId: string | undefined;
  ratio: number;
  stacked: boolean;
}

export type WorkspaceSplitLayoutAction =
  | { type: "sync_active"; activeId: string | undefined }
  | { type: "open_split"; splitId: string | undefined }
  | { type: "close_split" }
  | { type: "focus_session"; sessionId: string | undefined }
  | { type: "reconcile_visible"; splitSessionId: string | undefined }
  | { type: "set_ratio"; ratio: number }
  | { type: "set_stacked"; stacked: boolean };

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return SPLIT_RATIO_DEFAULT;
  return Math.max(SPLIT_RATIO_MIN, Math.min(SPLIT_RATIO_MAX, ratio));
}

export function initialSplitLayoutState(
  activeId: string | undefined,
): WorkspaceSplitLayoutState {
  return {
    activeId,
    splitId: undefined,
    focusedId: activeId,
    ratio: SPLIT_RATIO_DEFAULT,
    stacked: false,
  };
}

export function resolveSplitPeerId(
  state: Pick<WorkspaceSplitLayoutState, "activeId" | "splitId">,
  nextActiveId: string | undefined,
): string | undefined {
  if (state.splitId === undefined) return undefined;
  if (state.splitId === nextActiveId) {
    return state.activeId !== nextActiveId ? state.activeId : undefined;
  }
  return state.splitId;
}

export function resolveEffectiveFocusedSessionId(input: {
  active: boolean;
  activeId: string | undefined;
  focusedId: string | undefined;
  splitSessionId: string | undefined;
}): string | undefined {
  if (!input.active) return undefined;
  if (
    input.splitSessionId !== undefined &&
    input.focusedId === input.splitSessionId
  ) {
    return input.splitSessionId;
  }
  return input.activeId;
}

export function reduceSplitLayout(
  state: WorkspaceSplitLayoutState,
  action: WorkspaceSplitLayoutAction,
): WorkspaceSplitLayoutState {
  switch (action.type) {
    case "sync_active": {
      if (state.activeId === action.activeId) return state;
      const nextSplitId = resolveSplitPeerId(state, action.activeId);
      return {
        ...state,
        activeId: action.activeId,
        splitId: nextSplitId,
        focusedId: action.activeId,
      };
    }
    case "open_split": {
      const nextSplitId =
        action.splitId && action.splitId !== state.activeId
          ? action.splitId
          : undefined;
      if (state.splitId === nextSplitId) return state;
      return {
        ...state,
        splitId: nextSplitId,
      };
    }
    case "close_split": {
      if (state.splitId === undefined && state.focusedId === state.activeId) {
        return state;
      }
      return {
        ...state,
        splitId: undefined,
        focusedId: state.activeId,
      };
    }
    case "focus_session": {
      if (state.focusedId === action.sessionId) return state;
      return {
        ...state,
        focusedId: action.sessionId,
      };
    }
    case "reconcile_visible": {
      if (
        state.focusedId === state.activeId ||
        (action.splitSessionId !== undefined &&
          state.focusedId === action.splitSessionId)
      ) {
        return state;
      }
      const nextFocusedId = action.splitSessionId ?? state.activeId;
      if (state.focusedId === nextFocusedId) return state;
      return {
        ...state,
        focusedId: nextFocusedId,
      };
    }
    case "set_ratio": {
      const nextRatio = clampSplitRatio(action.ratio);
      if (state.ratio === nextRatio) return state;
      return {
        ...state,
        ratio: nextRatio,
      };
    }
    case "set_stacked": {
      if (state.stacked === action.stacked) return state;
      return {
        ...state,
        stacked: action.stacked,
      };
    }
  }
}
