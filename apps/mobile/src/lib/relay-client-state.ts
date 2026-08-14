/** Relay v1's control-plane state machine, independent of WebSocket. */
import {
  RELAY_PROTOCOL_VERSION,
  type RelayControlMessage,
  type RelayPairing,
} from "@prospero/protocol";
import type { AttemptFailure } from "./connect-diagnosis";

export type RelayClientState = "opening" | "awaiting_ready" | "e2e" | "failed";

export type RelayClientAction =
  | { type: "send_connect"; frame: string }
  | { type: "start_e2e" }
  | { type: "fail"; failure: AttemptFailure; detail?: string };

export function relayConnectFrame(relay: RelayPairing): string {
  // The relay accepts this only as the first frame on /v1/client.  It replies
  // with client.status(pending) and finally stream.ready on that same socket.
  return JSON.stringify({
    type: "client.open",
    v: RELAY_PROTOCOL_VERSION,
    routeId: relay.routeId,
    deviceId: relay.deviceId,
    token: relay.token,
  });
}

export function relayFailureFromControl(message: RelayControlMessage): RelayClientAction | null {
  if (message.type === "error") {
    switch (message.code) {
      case "unauthorized":
      case "device_revoked":
        return { type: "fail", failure: "relay_auth", detail: message.message };
      case "route_not_found":
      case "route_unavailable":
      case "stream_not_found":
      case "ticket_invalid":
      case "ticket_expired":
      case "ticket_used":
      case "stream_not_ready":
        return { type: "fail", failure: "relay_offline", detail: message.message };
      case "rate_limited":
        return { type: "fail", failure: "relay_rate_limit", detail: message.message };
      case "unsupported_version":
        return { type: "fail", failure: "relay_version", detail: message.message };
      case "internal":
        return { type: "fail", failure: "relay_overload", detail: message.message };
      case "bad_frame":
        return { type: "fail", failure: "relay_protocol", detail: message.message };
    }
  }
  if (message.type === "stream.close") {
    return { type: "fail", failure: "relay_offline", detail: message.code };
  }
  return null;
}

export function advanceRelayClient(
  state: RelayClientState,
  event: "opened" | RelayControlMessage,
  relay: RelayPairing,
): { state: RelayClientState; action: RelayClientAction | null } {
  if (state === "opening" && event === "opened") {
    return { state: "awaiting_ready", action: { type: "send_connect", frame: relayConnectFrame(relay) } };
  }
  if (typeof event !== "string") {
    const failure = relayFailureFromControl(event);
    if (failure) return { state: "failed", action: failure };
    if (state === "awaiting_ready" && event.type === "client.status" && event.status === "pending") {
      return { state, action: null };
    }
    if (state === "awaiting_ready" && event.type === "stream.ready") {
      return { state: "e2e", action: { type: "start_e2e" } };
    }
  }
  return {
    state: "failed",
    action: { type: "fail", failure: "relay_protocol", detail: "unexpected relay control frame" },
  };
}
