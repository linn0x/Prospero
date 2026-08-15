/**
 * The only JS/TS contract accepted by the Windows Node-API boundary.
 *
 * `FileTime100ns` is the unsigned decimal representation of a Windows FILETIME.
 * It deliberately is not a JavaScript `number`, which would lose precision.
 */
export const NATIVE_WINDOWS_ABI_VERSION = 1;
export const REQUIRED_NAPI_VERSION = 8;

export const NATIVE_REQUIRED_CAPABILITIES = [
  "processIdentity",
  "secureNamedPipe",
  "jobObject",
  "detachedHost",
  "conPty",
] as const;

export type NativeCapability = (typeof NATIVE_REQUIRED_CAPABILITIES)[number];
export type SupportedWindowsArchitecture = "x64" | "arm64";

declare const fileTimeBrand: unique symbol;
/** Unsigned decimal FILETIME ticks since 1601-01-01 UTC. */
export type FileTime100ns = string & { readonly [fileTimeBrand]: "FILETIME_100NS" };

declare const pipeServerHandleBrand: unique symbol;
declare const jobObjectHandleBrand: unique symbol;
declare const conPtyHandleBrand: unique symbol;
/** Opaque native handle; only the native module can create it. */
export type SecureNamedPipeServerHandle = bigint & {
  readonly [pipeServerHandleBrand]: "secure-named-pipe-server";
};
/** Opaque native handle; only the native module can create it. */
export type JobObjectHandle = bigint & { readonly [jobObjectHandleBrand]: "job-object" };
/** Opaque native handle; only the native module can create it. */
export type ConPtyHandle = bigint & { readonly [conPtyHandleBrand]: "conpty" };

export interface ProcessIdentity {
  readonly pid: number;
  readonly creationTime100ns: FileTime100ns;
}

export interface PipePeerIdentity {
  readonly process: ProcessIdentity;
  /** Canonical string SID returned by the token queried from the connected pipe client. */
  readonly userSid: string;
  readonly sessionId: number;
}

export interface SecureNamedPipeServerOptions {
  /** Full \\.\pipe\ name; caller owns collision avoidance. */
  readonly pipeName: string;
  /** Canonical owner/user SID which must be the only permitted client identity. */
  readonly allowedUserSid: string;
  readonly maxInstances: number;
  readonly inboundBufferBytes: number;
  readonly outboundBufferBytes: number;
}

export interface JobObjectOptions {
  /** Kill all assigned processes when the final job handle closes. */
  readonly killOnClose: boolean;
  readonly activeProcessLimit?: number;
}

export interface DetachedHostLaunchOptions {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly workingDirectory?: string;
  /** Environment values are passed to CreateProcessW; no shell is involved. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly job?: JobObjectHandle;
}

export interface ConPtySpawnOptions {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly columns: number;
  readonly rows: number;
  readonly workingDirectory?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly job?: JobObjectHandle;
}

export type NativeCapabilities = Readonly<Record<NativeCapability, boolean>>;

export interface NativeCapabilityReport {
  readonly abiVersion: number;
  /** The N-API level used to compile the binary, not `process.versions.napi`. */
  readonly napiVersion: number;
  readonly platform: "win32";
  readonly arch: SupportedWindowsArchitecture;
  readonly buildId: string;
  /** Set by native code only after it has observed the verified prebuild path. */
  readonly signatureVerified: boolean;
  readonly capabilities: NativeCapabilities;
}

export interface ValidAuthenticodeMetadata {
  readonly status: "valid";
  /** Upper/lower-case-insensitive SHA-1 certificate thumbprint, 40 hex chars. */
  readonly thumbprintSha1: string;
}

export interface UnsignedAuthenticodeMetadata {
  readonly status: "unsigned" | "unverified" | "invalid";
}

/** JSON format stored beside every prebuilt `.node` binary. */
export interface NativePrebuildManifest {
  readonly schemaVersion: 1;
  readonly platform: "win32";
  readonly arch: SupportedWindowsArchitecture;
  readonly artifact: {
    readonly file: "prospero_windows_native.node";
    readonly sha256: string;
  };
  readonly native: {
    readonly abiVersion: number;
    readonly napiVersion: number;
    readonly capabilities: NativeCapabilities;
  };
  readonly authenticode: ValidAuthenticodeMetadata | UnsignedAuthenticodeMetadata;
}

/**
 * Stable Node-API C ABI binding. Methods are intentionally direct and synchronous
 * at this boundary; higher-level async scheduling belongs in the daemon.
 */
export interface NativeWindowsBinding {
  getAbiInfo(): NativeCapabilityReport;
  getCurrentProcessIdentity(): ProcessIdentity;

  createSecureNamedPipeServer(options: SecureNamedPipeServerOptions): SecureNamedPipeServerHandle;
  closeSecureNamedPipeServer(server: SecureNamedPipeServerHandle): void;
  getSecureNamedPipePeerIdentity(server: SecureNamedPipeServerHandle): PipePeerIdentity;

  createJobObject(options: JobObjectOptions): JobObjectHandle;
  assignProcessToJob(job: JobObjectHandle, process: ProcessIdentity): void;
  terminateJobObject(job: JobObjectHandle, exitCode: number): void;
  closeJobObject(job: JobObjectHandle): void;

  launchDetachedHost(options: DetachedHostLaunchOptions): ProcessIdentity;

  spawnConPty(options: ConPtySpawnOptions): ConPtyHandle;
  resizeConPty(terminal: ConPtyHandle, columns: number, rows: number): void;
  readConPty(terminal: ConPtyHandle, maxBytes: number): Uint8Array;
  writeConPty(terminal: ConPtyHandle, data: Uint8Array): number;
  killConPty(terminal: ConPtyHandle, exitCode: number): void;
  closeConPty(terminal: ConPtyHandle): void;
}
