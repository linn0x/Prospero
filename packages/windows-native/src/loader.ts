import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  NATIVE_REQUIRED_CAPABILITIES,
  NATIVE_WINDOWS_ABI_VERSION,
  REQUIRED_NAPI_VERSION,
  type NativeCapabilityReport,
  type NativeCapabilities,
  type NativePrebuildManifest,
  type NativeWindowsBinding,
  type SupportedWindowsArchitecture,
} from "./contract.js";

export type NativeLoadErrorCode =
  | "unsupported-platform"
  | "unsupported-architecture"
  | "insufficient-napi"
  | "manifest-invalid"
  | "artifact-missing"
  | "hash-mismatch"
  | "unsigned"
  | "authenticode-invalid"
  | "addon-invalid"
  | "capability-missing";

export class NativeLoadError extends Error {
  constructor(
    readonly code: NativeLoadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NativeLoadError";
  }
}

interface AuthenticodeResult {
  readonly status: string;
  readonly thumbprintSha1: string | null;
}

/** Test seam; production callers must use the default runtime. */
export interface NativeLoaderRuntime {
  readonly platform: string;
  readonly arch: string;
  readonly napiVersion: string | undefined;
  readonly packageRoot: string;
  readonly fileExists: (path: string) => boolean;
  readonly readFile: (path: string) => Uint8Array;
  readonly sha256: (bytes: Uint8Array) => string;
  readonly verifyAuthenticode: (path: string) => AuthenticodeResult;
  readonly loadBinding: (path: string) => unknown;
}

function defaultPackageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function defaultAuthenticodeCheck(binaryPath: string): AuthenticodeResult {
  // The binary path is passed as an argument, not interpolated into PowerShell.
  const command = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
    "$thumbprint = if ($null -eq $signature.SignerCertificate) { '' } else { $signature.SignerCertificate.Thumbprint }",
    "[Console]::Out.Write($signature.Status.ToString() + '|' + $thumbprint)",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command, binaryPath],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) return { status: "command-failed", thumbprintSha1: null };
  const [status = "unknown", thumbprint = ""] = result.stdout.trim().split("|", 2);
  return { status, thumbprintSha1: thumbprint || null };
}

function defaultRuntime(): NativeLoaderRuntime {
  const require = createRequire(import.meta.url);
  return {
    platform: process.platform,
    arch: process.arch,
    napiVersion: process.versions.napi,
    packageRoot: defaultPackageRoot(),
    fileExists: existsSync,
    readFile: readFileSync,
    sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
    verifyAuthenticode: defaultAuthenticodeCheck,
    loadBinding: (path) => require(path),
  };
}

function loadError(code: NativeLoadErrorCode, message: string): never {
  throw new NativeLoadError(code, message);
}

function isSupportedArchitecture(value: string): value is SupportedWindowsArchitecture {
  return value === "x64" || value === "arm64";
}

function isCapabilities(value: unknown): value is NativeCapabilities {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return NATIVE_REQUIRED_CAPABILITIES.every((name) => typeof record[name] === "boolean");
}

function hasEveryCapability(capabilities: NativeCapabilities): boolean {
  return NATIVE_REQUIRED_CAPABILITIES.every((name) => capabilities[name]);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value);
}

function parseManifest(raw: Uint8Array, expectedArch: SupportedWindowsArchitecture): NativePrebuildManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return loadError("manifest-invalid", "Windows native prebuild manifest is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return loadError("manifest-invalid", "Windows native prebuild manifest must be an object");
  }
  const manifest = parsed as Record<string, unknown>;
  const artifact = manifest.artifact as Record<string, unknown> | undefined;
  const native = manifest.native as Record<string, unknown> | undefined;
  const authenticode = manifest.authenticode as Record<string, unknown> | undefined;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.platform !== "win32" ||
    manifest.arch !== expectedArch ||
    !artifact ||
    artifact.file !== "prospero_windows_native.node" ||
    !isSha256(artifact.sha256) ||
    !native ||
    native.abiVersion !== NATIVE_WINDOWS_ABI_VERSION ||
    native.napiVersion !== REQUIRED_NAPI_VERSION ||
    !isCapabilities(native.capabilities) ||
    !authenticode ||
    !["valid", "unsigned", "unverified", "invalid"].includes(String(authenticode.status))
  ) {
    return loadError("manifest-invalid", "Windows native prebuild manifest violates ABI metadata format");
  }
  if (authenticode.status === "valid" && !/^[a-fA-F0-9]{40}$/.test(String(authenticode.thumbprintSha1))) {
    return loadError("manifest-invalid", "Windows native prebuild signer thumbprint must be SHA-1 hex");
  }
  return parsed as NativePrebuildManifest;
}

function assertAuthenticode(
  runtime: NativeLoaderRuntime,
  manifest: NativePrebuildManifest,
  binaryPath: string,
): void {
  if (manifest.authenticode.status !== "valid") {
    loadError("unsigned", "Windows native prebuild is not an Authenticode-verified release artifact");
  }
  const verified = runtime.verifyAuthenticode(binaryPath);
  if (
    verified.status !== "Valid" ||
    verified.thumbprintSha1 === null ||
    verified.thumbprintSha1.replace(/\s/g, "").toLowerCase() !==
      manifest.authenticode.thumbprintSha1.toLowerCase()
  ) {
    loadError("authenticode-invalid", "Windows native prebuild Authenticode signature is invalid or untrusted");
  }
}

function assertBindingContract(
  candidate: unknown,
  expectedArch: SupportedWindowsArchitecture,
): asserts candidate is NativeWindowsBinding {
  if (typeof candidate !== "object" || candidate === null || typeof (candidate as { getAbiInfo?: unknown }).getAbiInfo !== "function") {
    loadError("addon-invalid", "Windows native addon does not expose getAbiInfo()");
  }
  const report = (candidate as { getAbiInfo(): unknown }).getAbiInfo();
  if (typeof report !== "object" || report === null) {
    loadError("addon-invalid", "Windows native addon returned an invalid ABI report");
  }
  const value = report as Partial<NativeCapabilityReport>;
  if (
    value.abiVersion !== NATIVE_WINDOWS_ABI_VERSION ||
    value.napiVersion !== REQUIRED_NAPI_VERSION ||
    value.platform !== "win32" ||
    value.arch !== expectedArch ||
    value.signatureVerified !== true ||
    !isCapabilities(value.capabilities)
  ) {
    loadError("addon-invalid", "Windows native addon ABI, platform, architecture, or signature report mismatches");
  }
  if (!hasEveryCapability(value.capabilities)) {
    loadError("capability-missing", "Windows native addon is missing required capabilities");
  }
  const binding = candidate as Partial<NativeWindowsBinding>;
  const methods: readonly (keyof NativeWindowsBinding)[] = [
    "getCurrentProcessIdentity",
    "createSecureNamedPipeServer",
    "closeSecureNamedPipeServer",
    "getSecureNamedPipePeerIdentity",
    "createJobObject",
    "assignProcessToJob",
    "terminateJobObject",
    "closeJobObject",
    "launchDetachedHost",
    "spawnConPty",
    "resizeConPty",
    "readConPty",
    "writeConPty",
    "killConPty",
    "closeConPty",
  ];
  if (methods.some((method) => typeof binding[method] !== "function")) {
    loadError("addon-invalid", "Windows native addon is missing a required ABI method");
  }
}

/**
 * Loads only a signed, complete, architecture-matched Windows prebuild.
 * It intentionally has no fallback to a source build, a generic JS shim, or a
 * partial feature set: callers get an error and must leave the feature disabled.
 */
export function loadWindowsNative(runtime: NativeLoaderRuntime = defaultRuntime()): NativeWindowsBinding {
  if (runtime.platform !== "win32") {
    return loadError("unsupported-platform", "Windows native module is unavailable outside win32");
  }
  if (!isSupportedArchitecture(runtime.arch)) {
    return loadError("unsupported-architecture", `Unsupported Windows native architecture: ${runtime.arch}`);
  }
  const napiVersion = Number.parseInt(runtime.napiVersion ?? "", 10);
  if (!Number.isSafeInteger(napiVersion) || napiVersion < REQUIRED_NAPI_VERSION) {
    return loadError("insufficient-napi", `Node-API ${REQUIRED_NAPI_VERSION}+ is required`);
  }
  const prebuildDirectory = join(runtime.packageRoot, "prebuilds", `win32-${runtime.arch}`);
  const manifestPath = join(prebuildDirectory, "manifest.json");
  const binaryPath = join(prebuildDirectory, "prospero_windows_native.node");
  if (!runtime.fileExists(manifestPath) || !runtime.fileExists(binaryPath)) {
    return loadError("artifact-missing", "Windows native prebuild manifest or binary is missing");
  }
  const manifest = parseManifest(runtime.readFile(manifestPath), runtime.arch);
  const binary = runtime.readFile(binaryPath);
  if (runtime.sha256(binary).toLowerCase() !== manifest.artifact.sha256.toLowerCase()) {
    return loadError("hash-mismatch", "Windows native prebuild SHA-256 does not match its manifest");
  }
  if (!hasEveryCapability(manifest.native.capabilities)) {
    return loadError("capability-missing", "Windows native prebuild manifest declares incomplete capabilities");
  }
  assertAuthenticode(runtime, manifest, binaryPath);
  let binding: unknown;
  try {
    binding = runtime.loadBinding(binaryPath);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    return loadError("addon-invalid", `Windows native addon could not be loaded${detail}`);
  }
  assertBindingContract(binding, runtime.arch);
  return binding;
}
