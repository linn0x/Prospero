import type { SessionInfo } from "./types";

export type NativeBindingStateName =
  | "unbound"
  | "binding"
  | "resuming"
  | "running"
  | "archiving"
  | "archived"
  | "failed";

export type NativeBindingPhase =
  | { kind: "not_applicable" }
  | { kind: "unbound"; requiresLinkBeforeArchive: boolean }
  | { kind: "transitioning"; state: "binding" | "resuming" | "archiving"; nativeId?: string }
  | { kind: "bound"; state: "running" | "archived"; nativeId: string; managed: boolean }
  | { kind: "failed"; error: string; nativeId?: string };

export type SessionLifecyclePhase =
  | { phase: "starting" }
  | { phase: "running"; busySince?: number }
  | { phase: "waiting_user"; reason: "permission" | "input" }
  | { phase: "idle" }
  | { phase: "ended"; outcome: "completed" | "failed" | "cancelled" };

const ENDED_SESSION_STATUSES = new Set([
  "completed",
  "done",
  "died",
  "failed",
  "error",
  "cancelled",
  "exited",
  "killed",
  "stopped",
]);

const READ_ONLY_TERMINAL_STATUSES = new Set([
  "idle",
  ...ENDED_SESSION_STATUSES,
]);

const NATIVE_BINDABLE_AGENTS = new Set(["claude", "codex", "agy"]);

export function isSessionEndedStatus(status: string | undefined): boolean {
  if (!status) return false;
  return ENDED_SESSION_STATUSES.has(status.trim().toLowerCase());
}

export function isReadOnlyTerminalStatus(status: string | undefined): boolean {
  if (!status) return true;
  return READ_ONLY_TERMINAL_STATUSES.has(status.trim().toLowerCase());
}

export function deriveSessionLifecyclePhase(
  session: Pick<SessionInfo, "status" | "busySince">,
): SessionLifecyclePhase {
  const normalized = session.status.trim().toLowerCase();
  switch (normalized) {
    case "starting":
      return { phase: "starting" };
    case "running":
      return {
        phase: "running",
        ...(typeof session.busySince === "number" ? { busySince: session.busySince } : {}),
      };
    case "waiting_permission":
    case "waiting_approval":
      return { phase: "waiting_user", reason: "permission" };
    case "waiting_input":
      return { phase: "waiting_user", reason: "input" };
    case "idle":
      return { phase: "idle" };
    case "completed":
    case "done":
      return { phase: "ended", outcome: "completed" };
    case "cancelled":
    case "stopped":
    case "killed":
      return { phase: "ended", outcome: "cancelled" };
    default:
      if (ENDED_SESSION_STATUSES.has(normalized)) {
        return { phase: "ended", outcome: "failed" };
      }
      return { phase: "idle" };
  }
}

export function parseNativeBindingState(raw: string | undefined): NativeBindingStateName {
  switch (raw?.trim().toLowerCase()) {
    case "binding":
      return "binding";
    case "resuming":
      return "resuming";
    case "running":
      return "running";
    case "archiving":
      return "archiving";
    case "archived":
      return "archived";
    case "failed":
      return "failed";
    default:
      return "unbound";
  }
}

export function deriveNativeBindingPhase(
  session: Pick<SessionInfo, "title" | "kind" | "agent" | "nativeSession">,
): NativeBindingPhase {
  if (session.title?.endsWith(" · 登录")) {
    return { kind: "not_applicable" };
  }
  const native = session.nativeSession;
  if (!native) {
    const requiresLink = session.kind === "pty" && NATIVE_BINDABLE_AGENTS.has(session.agent);
    return requiresLink
      ? { kind: "unbound", requiresLinkBeforeArchive: true }
      : { kind: "not_applicable" };
  }
  const state = parseNativeBindingState(native.state);
  const nativeId = native.nativeId ?? undefined;
  if (state === "failed") {
    return {
      kind: "failed",
      error: native.error ?? "Native session binding failed",
      ...(nativeId ? { nativeId } : {}),
    };
  }
  if (state === "binding" || state === "resuming" || state === "archiving") {
    return {
      kind: "transitioning",
      state,
      ...(nativeId ? { nativeId } : {}),
    };
  }
  if (nativeId) {
    return {
      kind: "bound",
      state: state === "archived" ? "archived" : "running",
      nativeId,
      managed: Boolean(native.managed),
    };
  }
  const requiresLink =
    session.kind === "pty" && NATIVE_BINDABLE_AGENTS.has(session.agent) && !native.managed;
  return {
    kind: "unbound",
    requiresLinkBeforeArchive: requiresLink,
  };
}

export function needsNativeBinding(
  session: Pick<SessionInfo, "title" | "kind" | "agent" | "nativeSession">,
): boolean {
  const phase = deriveNativeBindingPhase(session);
  return phase.kind === "unbound" && phase.requiresLinkBeforeArchive;
}
