/**
 * The only JS/TS contract accepted by the Windows Node-API boundary.
 *
 * `FileTime100ns` is the unsigned decimal representation of a Windows FILETIME.
 * It deliberately is not a JavaScript `number`, which would lose precision.
 */
export const NATIVE_WINDOWS_ABI_VERSION = 2;
export const REQUIRED_NAPI_VERSION = 8;

export const NATIVE_REQUIRED_CAPABILITIES = [
  "processIdentity",
  "secureNamedPipe",
  "jobObject",
  "parentJobCompatibility",
  "detachedHost",
  "conPty",
  "dpapiCurrentUser",
  "secureStateDirectory",
] as const;

export type NativeCapability = (typeof NATIVE_REQUIRED_CAPABILITIES)[number];
export type SupportedWindowsArchitecture = "x64" | "arm64";

declare const fileTimeBrand: unique symbol;
/** Unsigned decimal FILETIME ticks since 1601-01-01 UTC. */
export type FileTime100ns = string & { readonly [fileTimeBrand]: "FILETIME_100NS" };

declare const pipeServerHandleBrand: unique symbol;
declare const pipeConnectionHandleBrand: unique symbol;
declare const jobObjectHandleBrand: unique symbol;
declare const conPtyHandleBrand: unique symbol;
declare const stateDirectoryHandleBrand: unique symbol;

/** Opaque native handle; only the native module can create it. */
export type SecureNamedPipeServerHandle = bigint & {
  readonly [pipeServerHandleBrand]: "secure-named-pipe-server";
};
/** Opaque native handle; only the native module can create it. */
export type SecureNamedPipeConnectionHandle = bigint & {
  readonly [pipeConnectionHandleBrand]: "secure-named-pipe-connection";
};
/** Opaque native handle; only the native module can create it. */
export type JobObjectHandle = bigint & { readonly [jobObjectHandleBrand]: "job-object" };
/** Opaque native handle; only the native module can create it. */
export type ConPtyHandle = bigint & { readonly [conPtyHandleBrand]: "conpty" };
/** Opaque native handle for a directory validated as current-user-only and reparse-free. */
export type SecureStateDirectoryHandle = bigint & {
  readonly [stateDirectoryHandleBrand]: "secure-state-directory";
};

export interface ProcessIdentity {
  readonly pid: number;
  readonly creationTime100ns: FileTime100ns;
}

export interface PipePeerIdentity {
  /** Both PID and creation time come from the connected client process. */
  readonly process: ProcessIdentity;
  /** Canonical string SID queried while impersonating the pipe client. */
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

export interface ParentJobCompatibility {
  /** Whether the current process has an enclosing Job Object. */
  readonly parentJobDetected: boolean;
  /** Whether the immediate Job grants BREAKAWAY_OK or SILENT_BREAKAWAY_OK. */
  readonly breakawayAllowed: boolean;
  /**
   * Immediate-job preflight result. A successful detached launch additionally
   * verifies the suspended child has escaped every ancestor Job.
   */
  readonly detachedLaunchAllowed: boolean;
}

export interface DetachedHostLaunchOptions {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly workingDirectory?: string;
  /** Environment values are passed to CreateProcessW; no shell is involved. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly job?: JobObjectHandle;
}

export type DetachedHostLaunchResult =
  | { readonly status: "launched"; readonly process: ProcessIdentity }
  | {
      readonly status: "parent_job_prevents_detach";
      readonly parentJob: ParentJobCompatibility;
    };

export interface ConPtySpawnOptions {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly columns: number;
  readonly rows: number;
  readonly workingDirectory?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly job?: JobObjectHandle;
}

export interface SecureStateDirectoryOptions {
  /** Absolute state path; every existing component must be reparse-point free. */
  readonly path: string;
}

export type NativeCapabilities = Readonly<Record<NativeCapability, boolean>>;

/**
 * Raw addon metadata. It deliberately has no signature/hash trust field: an
 * addon has no authority to attest to the bytes that loaded it.
 */
export interface NativeAddonCapabilityReport {
  readonly abiVersion: number;
  /** The N-API level used to compile the binary, not `process.versions.napi`. */
  readonly napiVersion: number;
  readonly platform: "win32";
  readonly arch: SupportedWindowsArchitecture;
  readonly buildId: string;
  readonly capabilities: NativeCapabilities;
}

/** Metadata returned only by the loader's frozen trusted-binding wrapper. */
export interface NativeCapabilityReport extends NativeAddonCapabilityReport {
  /** Always true here because the loader verified manifest, SHA-256, and Authenticode. */
  readonly signatureVerified: true;
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
  readonly schemaVersion: 2;
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
 * These APIs may synchronously block on the OS. The trusted loader wrapper
 * rejects them on Node's main thread; callers must invoke them only from a
 * scheduler-owned dedicated worker thread.
 */
export const NATIVE_SYNCHRONOUS_BLOCKING_METHODS = [
  "getCurrentProcessIdentity",
  "getProcessIdentity",
  "matchesProcessIdentity",
  "createSecureNamedPipeServer",
  "acceptSecureNamedPipeConnection",
  "closeSecureNamedPipeServer",
  "readSecureNamedPipeConnection",
  "writeSecureNamedPipeConnection",
  "getSecureNamedPipePeerIdentity",
  "disconnectSecureNamedPipeConnection",
  "closeSecureNamedPipeConnection",
  "createJobObject",
  "assignProcessToJob",
  "terminateJobObject",
  "closeJobObject",
  "getParentJobCompatibility",
  "launchDetachedHost",
  "spawnConPty",
  "resizeConPty",
  "readConPty",
  "writeConPty",
  "killConPty",
  "closeConPty",
  "dpapiProtectCurrentUser",
  "dpapiUnprotectCurrentUser",
  "openSecureStateDirectory",
  "writeSecureStateFileAtomically",
  "readSecureStateFile",
  "listSecureStateEntries",
  "removeSecureStateFile",
  "closeSecureStateDirectory",
] as const;

export type NativeSynchronousBlockingMethod = (typeof NATIVE_SYNCHRONOUS_BLOCKING_METHODS)[number];

interface NativeWindowsMethods {
  getCurrentProcessIdentity(): ProcessIdentity;
  /** Opens PID and reads its creation FILETIME. PID-only identity is prohibited. */
  getProcessIdentity(pid: number): ProcessIdentity;
  /** Returns true only if both the PID and creation FILETIME still match. */
  matchesProcessIdentity(identity: ProcessIdentity): boolean;

  createSecureNamedPipeServer(options: SecureNamedPipeServerOptions): SecureNamedPipeServerHandle;
  /** Blocks until one local client is accepted; remote clients are always rejected. */
  acceptSecureNamedPipeConnection(server: SecureNamedPipeServerHandle): SecureNamedPipeConnectionHandle;
  closeSecureNamedPipeServer(server: SecureNamedPipeServerHandle): void;
  readSecureNamedPipeConnection(connection: SecureNamedPipeConnectionHandle, maxBytes: number): Uint8Array;
  writeSecureNamedPipeConnection(connection: SecureNamedPipeConnectionHandle, data: Uint8Array): number;
  /**
   * Requires a successful first `readSecureNamedPipeConnection` authentication
   * frame. Windows impersonates the client represented by the last pipe read;
   * requesting identity before that frame is rejected.
   */
  getSecureNamedPipePeerIdentity(connection: SecureNamedPipeConnectionHandle): PipePeerIdentity;
  disconnectSecureNamedPipeConnection(connection: SecureNamedPipeConnectionHandle): void;
  closeSecureNamedPipeConnection(connection: SecureNamedPipeConnectionHandle): void;

  createJobObject(options: JobObjectOptions): JobObjectHandle;
  /** Assign succeeds only after strict PID+FILETIME revalidation. */
  assignProcessToJob(job: JobObjectHandle, process: ProcessIdentity): void;
  terminateJobObject(job: JobObjectHandle, exitCode: number): void;
  closeJobObject(job: JobObjectHandle): void;
  getParentJobCompatibility(): ParentJobCompatibility;

  /** Reports an enclosing Job policy instead of claiming a detached launch succeeded. */
  launchDetachedHost(options: DetachedHostLaunchOptions): DetachedHostLaunchResult;

  spawnConPty(options: ConPtySpawnOptions): ConPtyHandle;
  resizeConPty(terminal: ConPtyHandle, columns: number, rows: number): void;
  readConPty(terminal: ConPtyHandle, maxBytes: number): Uint8Array;
  writeConPty(terminal: ConPtyHandle, data: Uint8Array): number;
  killConPty(terminal: ConPtyHandle, exitCode: number): void;
  closeConPty(terminal: ConPtyHandle): void;

  /**
   * DPAPI CryptProtectData using current-user scope only. `sessionEpochEntropy`
   * must be a non-empty opaque encoding bound to the session and lifecycle
   * epoch; raw capabilities must never be used as the entropy value.
   */
  dpapiProtectCurrentUser(plaintext: Uint8Array, sessionEpochEntropy: Uint8Array): Uint8Array;
  /** Uses the same non-empty session/epoch entropy supplied during protection. */
  dpapiUnprotectCurrentUser(ciphertext: Uint8Array, sessionEpochEntropy: Uint8Array): Uint8Array;
  /** Creates/opens a current-user-only state directory after rejecting reparse points. */
  openSecureStateDirectory(options: SecureStateDirectoryOptions): SecureStateDirectoryHandle;
  /** Writes a single relative filename atomically without escaping the validated directory. */
  writeSecureStateFileAtomically(
    directory: SecureStateDirectoryHandle,
    fileName: string,
    data: Uint8Array,
  ): void;
  /**
   * Reads one state file from the validated directory. `fileName` must be one
   * non-empty relative path segment: no dot segments, separators, ADS colon,
   * reserved DOS device name, or reparse-point traversal is accepted.
   */
  readSecureStateFile(directory: SecureStateDirectoryHandle, fileName: string): Uint8Array;
  /** Returns the direct, reparse-free state-file names held by this directory. */
  listSecureStateEntries(directory: SecureStateDirectoryHandle): readonly string[];
  /** Deletes one state file using the same strict filename and reparse checks as reads/writes. */
  removeSecureStateFile(directory: SecureStateDirectoryHandle, fileName: string): void;
  closeSecureStateDirectory(directory: SecureStateDirectoryHandle): void;
}

/** Untrusted object returned by `require()` before loader verification. */
export interface NativeAddonBinding extends NativeWindowsMethods {
  getAbiInfo(): NativeAddonCapabilityReport;
}

/** Stable binding exposed by the loader after release-artifact verification. */
export interface NativeWindowsBinding extends NativeWindowsMethods {
  getAbiInfo(): NativeCapabilityReport;
}
