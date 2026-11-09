import { isReadOnlyTerminalStatus } from "../../shared/session-state";
import type { NativeTerminalState } from "../../shared/types";

export type TerminalViewPhase =
  | "probing"
  | "fallback"
  | "connecting"
  | "observing"
  | "controlling"
  | "disconnected"
  | "exited";

export function deriveTerminalViewPhase(input: {
  mode: "pending" | "native" | "fallback";
  sessionStatus: string;
  state: Pick<
    NativeTerminalState,
    "connected" | "syncing" | "controller" | "readOnly" | "exited"
  >;
}): TerminalViewPhase {
  if (input.mode === "fallback") return "fallback";
  if (input.state.exited || isReadOnlyTerminalStatus(input.sessionStatus)) {
    return "exited";
  }
  if (input.mode === "pending" || input.state.syncing) {
    return input.mode === "pending" ? "probing" : "connecting";
  }
  if (!input.state.connected) {
    return "disconnected";
  }
  if (input.state.readOnly || !input.state.controller) {
    return "observing";
  }
  return "controlling";
}

export function canPasteIntoTerminal(input: {
  active: boolean;
  focused: boolean;
  phase: TerminalViewPhase;
}): boolean {
  return input.active && input.focused && input.phase === "controlling";
}

export function isNativeDisconnectedBannerVisible(
  phase: TerminalViewPhase,
  nativeIdValue: number | undefined,
): boolean {
  return phase === "disconnected" && nativeIdValue === undefined;
}

export function terminalViewHostStateAttr(
  phase: TerminalViewPhase,
): "connected" | "syncing" | "exited" | "disconnected" {
  switch (phase) {
    case "controlling":
    case "observing":
      return "connected";
    case "probing":
    case "connecting":
      return "syncing";
    case "exited":
      return "exited";
    case "disconnected":
    case "fallback":
      return "disconnected";
  }
}
