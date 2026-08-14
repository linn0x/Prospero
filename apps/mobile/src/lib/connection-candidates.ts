/**
 * Connection candidate selection is deliberately pure.  Apart from making it
 * easy to test, this keeps the policy (which paths may be tried) separate
 * from WebSocket lifetime management (how they are raced).
 */
import type { StoredHost } from "./hosts";

export type ConnectionPath = "direct" | "relay";

export interface DirectCandidate {
  path: "direct";
  addr: string;
}

export interface RelayCandidate {
  path: "relay";
  url: string;
  routeId: string;
  deviceId: string;
  token: string;
}

export type ConnectionCandidate = DirectCandidate | RelayCandidate;

export interface CandidateSelection {
  candidates: ConnectionCandidate[];
  /** relay was explicitly requested, but a QR-provided credential is missing */
  relayCredentialsMissing: boolean;
}

function directCandidates(host: StoredHost): DirectCandidate[] {
  const seen = new Set<string>();
  const ordered = host.lastGoodAddr
    ? [host.lastGoodAddr, ...host.addrs]
    : host.addrs;
  return ordered.flatMap((addr) => {
    if (seen.has(addr)) return [];
    seen.add(addr);
    return [{ path: "direct", addr }];
  });
}

function relayCandidate(host: StoredHost): RelayCandidate | null {
  if (!host.relay || !host.relayToken) return null;
  return {
    path: "relay",
    url: host.relay.url,
    routeId: host.relay.routeId,
    deviceId: host.relay.deviceId,
    token: host.relayToken,
  };
}

/**
 * `auto` starts every available candidate in the same turn.  In particular it
 * must not wait for local addresses to time out before opening the relay.
 */
export function selectConnectionCandidates(host: StoredHost): CandidateSelection {
  const direct = directCandidates(host);
  const relay = relayCandidate(host);

  switch (host.connectionMode) {
    case "direct":
      return { candidates: direct, relayCredentialsMissing: false };
    case "relay":
      return relay
        ? { candidates: [relay], relayCredentialsMissing: false }
        : { candidates: [], relayCredentialsMissing: true };
    case "auto":
      return {
        candidates: relay ? [...direct, relay] : direct,
        // A direct path can still make auto useful.  Only surface this as the
        // final diagnosis when it was the sole possible path.
        relayCredentialsMissing: relay === null && direct.length === 0 && host.relay !== undefined,
      };
  }
}
