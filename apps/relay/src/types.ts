export interface RouteRecord {
  routeId: string;
  generation: number;
  disabledAt: Date | null;
  createdAt: Date;
  lastSeenAt: Date | null;
}

/** The stored value is the T1 domain-separated relay credential digest, never a token. */
export interface DeviceRecord {
  routeId: string;
  deviceId: string;
  credentialDigest: Buffer | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

export interface AuthenticatedDevice {
  route: RouteRecord;
  device: DeviceRecord;
}

export interface RouteSnapshot {
  route: RouteRecord;
  devices: DeviceRecord[];
}

export interface RouteInspection extends RouteRecord {
  devices: Array<Omit<DeviceRecord, "credentialDigest">>;
}

export interface StreamTicket {
  streamId: string;
  ticket: string;
  routeId: string;
  hostConnectionId: string;
  clientDeviceId: string;
  expiresAt: number;
}

export interface RelayEvent {
  type: "route.disabled" | "route.enabled" | "device.revoked";
  routeId: string;
  deviceId?: string;
}
