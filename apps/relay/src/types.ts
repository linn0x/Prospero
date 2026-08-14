export type DeviceRole = "host" | "client";

export interface RouteRecord {
  routeId: string;
  disabledAt: Date | null;
  createdAt: Date;
  lastSeenAt: Date | null;
}

export interface DeviceRecord {
  routeId: string;
  deviceId: string;
  role: DeviceRole;
  tokenDigest: Buffer;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

export interface AuthenticatedDevice {
  route: RouteRecord;
  device: DeviceRecord;
}

export interface RouteSnapshot extends AuthenticatedDevice {
  devices: DeviceRecord[];
}

export interface RouteInspection extends RouteRecord {
  devices: Array<Omit<DeviceRecord, "tokenDigest">>;
}

export interface StreamTicket {
  streamId: string;
  routeId: string;
  hostConnectionId: string;
  clientDeviceId: string;
}

export interface RelayEvent {
  type: "route.disabled" | "route.enabled" | "device.revoked";
  routeId: string;
  deviceId?: string;
}
