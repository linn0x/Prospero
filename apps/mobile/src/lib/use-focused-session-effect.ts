import { useCallback } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { subscribeWhileAppActive } from "./focused-session-stream";

/** Unlike freezing renders, this releases listeners and timers on blur/background. */
export function useFocusedSessionEffect(start: () => () => void): void {
  useFocusEffect(useCallback(() => subscribeWhileAppActive({
    currentState: AppState.currentState,
    onChange(listener) {
      const subscription = AppState.addEventListener("change", listener);
      return () => subscription.remove();
    },
  }, start), [start]));
}
