import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isMainThread } from "node:worker_threads";
import {
  NATIVE_REQUIRED_CAPABILITIES,
  NATIVE_SYNCHRONOUS_BLOCKING_METHODS,
  NATIVE_WINDOWS_ABI_VERSION,
  REQUIRED_NAPI_VERSION,
  type NativeAddonBinding,
  type NativeAddonCapabilityReport,
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
  | "capability-missing"
  | "worker-thread-required";

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

function writeLoaderTestDiagnostic(stage: string): void {
  const diagnosticPath = process.env["PROSPERO_WINDOWS_SESSION_HOST_TEST_DIAGNOSTIC"];
  if (typeof diagnosticPath !== "string" || diagnosticPath.length === 0) return;
  try { writeFileSync(diagnosticPath, JSON.stringify({ version: 1, stage })); }
  catch { /* CI-only diagnostic must not change loader behavior */ }
}

const SYSTEM_POWERSHELL_RELATIVE_PATH = [
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
];

/**
 * Returns only the inbox PowerShell path beneath an absolute, normalized
 * SystemRoot. This intentionally never performs PATH resolution: invoking a
 * same-named executable found through PATH would undermine the verification
 * decision. `null` is a fail-closed result for a missing or malformed root.
 */
export function resolveSystemPowerShellPath(
  systemRoot: string | undefined,
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  if (
    typeof systemRoot !== "string" ||
    systemRoot.length === 0 ||
    systemRoot !== systemRoot.trim()
  ) {
    return null;
  }
  // SystemRoot must be a drive-rooted Win32 path. UNC, device, relative, and
  // forward-slash paths are intentionally excluded from this trust boundary.
  if (
    !/^[A-Za-z]:\\/.test(systemRoot) ||
    systemRoot.includes("/") ||
    systemRoot.includes("\0")
  ) {
    return null;
  }
  const normalized = win32.normalize(systemRoot);
  const root = normalized.endsWith("\\") ? normalized.slice(0, -1) : normalized;
  if (root.length < 4 || root !== systemRoot.replace(/\\+$/, "") || !win32.isAbsolute(root)) {
    return null;
  }
  const components = root.slice(3).split("\\");
  if (
    components.length === 0 ||
    components.some(
      (component) => component.length === 0 || component === "." || component === "..",
    )
  ) {
    return null;
  }
  if (!fileExists(root)) return null;
  const powershellPath = win32.join(root, ...SYSTEM_POWERSHELL_RELATIVE_PATH);
  return fileExists(powershellPath) ? powershellPath : null;
}

/**
 * Worker-thread environment copies are case-sensitive even on Windows. Accept
 * the platform's case-insensitive spelling while rejecting ambiguous copies.
 */
export function resolveSystemRootEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const matches = Object.entries(environment).filter(
    ([name, value]) => name.toLowerCase() === "systemroot" && typeof value === "string",
  );
  return matches.length === 1 ? matches[0]?.[1] : undefined;
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
  /** True only in the scheduler-owned worker allowed to run blocking native calls. */
  readonly isDedicatedWorkerThread: () => boolean;
}

function defaultPackageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function defaultAuthenticodeCheck(binaryPath: string): AuthenticodeResult {
  writeLoaderTestDiagnostic("authenticode_resolving_powershell");
  let powershellPath: string | null;
  try {
    powershellPath = resolveSystemPowerShellPath(resolveSystemRootEnvironmentValue(process.env));
  } catch {
    return { status: "systemroot-unavailable", thumbprintSha1: null };
  }
  if (powershellPath === null) {
    writeLoaderTestDiagnostic("authenticode_powershell_unavailable");
    return { status: "systemroot-unavailable", thumbprintSha1: null };
  }
  // Windows PowerShell treats every token following a string-valued -Command
  // as part of that command. Pass the path as child-process data instead of
  // interpolating it or relying on $args, so spaces and metacharacters cannot
  // alter the verification command.
  const binaryPathEnvironmentVariable = "PROSPERO_WINDOWS_NATIVE_AUTHENTICODE_PATH";
  const diagnosticPathEnvironmentVariable = "PROSPERO_WINDOWS_SESSION_HOST_TEST_DIAGNOSTIC";
  const diagnosticCommands = typeof process.env[diagnosticPathEnvironmentVariable] === "string"
    ? [
        `$diagnosticPath = [Environment]::GetEnvironmentVariable('${diagnosticPathEnvironmentVariable}', 'Process')`,
        "function Write-ProsperoDiagnostic([string]$Stage) { if (-not [string]::IsNullOrWhiteSpace($diagnosticPath)) { [IO.File]::WriteAllText($diagnosticPath, ('{\"version\":1,\"stage\":\"' + $Stage + '\"}')) } }",
        "Write-ProsperoDiagnostic 'powershell_started'",
      ]
    : [];
  const command = [
    ...diagnosticCommands,
    "$securityModule = Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'",
    "Import-Module -Name $securityModule -ErrorAction Stop",
    ...(diagnosticCommands.length > 0 ? ["Write-ProsperoDiagnostic 'powershell_module_imported'"] : []),
    `$binaryPath = [Environment]::GetEnvironmentVariable('${binaryPathEnvironmentVariable}', 'Process')`,
    ...(diagnosticCommands.length > 0 ? ["Write-ProsperoDiagnostic 'powershell_signature_checking'"] : []),
    "$signature = Get-AuthenticodeSignature -LiteralPath $binaryPath",
    ...(diagnosticCommands.length > 0 ? ["Write-ProsperoDiagnostic 'powershell_signature_checked'"] : []),
    "$thumbprint = if ($null -eq $signature.SignerCertificate) { '' } else { $signature.SignerCertificate.Thumbprint }",
    "[Console]::Out.Write($signature.Status.ToString() + '|' + $thumbprint)",
  ].join("; ");
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"),
  );
  childEnvironment.PSModulePath = win32.join(win32.dirname(powershellPath), "Modules");
  childEnvironment[binaryPathEnvironmentVariable] = binaryPath;
  try {
    writeLoaderTestDiagnostic("authenticode_spawning_powershell");
    const result = spawnSync(
      powershellPath,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
      {
        encoding: "utf8",
        windowsHide: true,
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    writeLoaderTestDiagnostic("authenticode_powershell_returned");
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      const detail = [
        result.error?.message,
        `exit=${result.status ?? "none"}`,
        typeof result.stderr === "string" ? result.stderr : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .replace(/[\r\n|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 320);
      return { status: `command-failed:${detail || "unknown"}`, thumbprintSha1: null };
    }
    const [status = "unknown", thumbprint = ""] = result.stdout.trim().split("|", 2);
    return { status, thumbprintSha1: thumbprint || null };
  } catch {
    return { status: "command-failed", thumbprintSha1: null };
  }
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
    isDedicatedWorkerThread: () => !isMainThread,
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
    manifest.schemaVersion !== 2 ||
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
  let verifierResult: unknown;
  try {
    verifierResult = runtime.verifyAuthenticode(binaryPath);
  } catch {
    loadError("authenticode-invalid", "Windows native prebuild Authenticode verification failed unexpectedly");
  }
  if (
    typeof verifierResult !== "object" ||
    verifierResult === null ||
    typeof (verifierResult as Partial<AuthenticodeResult>).status !== "string" ||
    !(
      typeof (verifierResult as Partial<AuthenticodeResult>).thumbprintSha1 === "string" ||
      (verifierResult as Partial<AuthenticodeResult>).thumbprintSha1 === null
    )
  ) {
    loadError("authenticode-invalid", "Windows native prebuild Authenticode verifier returned invalid data");
  }
  const verified = verifierResult as AuthenticodeResult;
  if (
    verified.status !== "Valid" ||
    verified.thumbprintSha1 === null ||
    verified.thumbprintSha1.replace(/\s/g, "").toLowerCase() !==
      manifest.authenticode.thumbprintSha1.toLowerCase()
  ) {
    const signer = verified.thumbprintSha1?.replace(/\s/g, "") || "none";
    loadError(
      "authenticode-invalid",
      `Windows native prebuild Authenticode signature is invalid or untrusted (status=${verified.status}, signer=${signer})`,
    );
  }
}

function assertAddonContract(
  candidate: unknown,
  expectedArch: SupportedWindowsArchitecture,
): asserts candidate is NativeAddonBinding {
  if (typeof candidate !== "object" || candidate === null || typeof (candidate as { getAbiInfo?: unknown }).getAbiInfo !== "function") {
    loadError("addon-invalid", "Windows native addon does not expose getAbiInfo()");
  }
  const report = (candidate as { getAbiInfo(): unknown }).getAbiInfo();
  if (typeof report !== "object" || report === null) {
    loadError("addon-invalid", "Windows native addon returned an invalid ABI report");
  }
  const value = report as Partial<NativeAddonCapabilityReport> & Record<string, unknown>;
  if (
    value.abiVersion !== NATIVE_WINDOWS_ABI_VERSION ||
    value.napiVersion !== REQUIRED_NAPI_VERSION ||
    value.platform !== "win32" ||
    value.arch !== expectedArch ||
    "signatureVerified" in value ||
    !isCapabilities(value.capabilities)
  ) {
    loadError("addon-invalid", "Windows native addon ABI/platform/architecture report mismatches or self-attests trust");
  }
  if (!hasEveryCapability(value.capabilities)) {
    loadError("capability-missing", "Windows native addon is missing required capabilities");
  }
  const binding = candidate as Partial<NativeAddonBinding>;
  const methods = NATIVE_SYNCHRONOUS_BLOCKING_METHODS;
  if (methods.some((method) => typeof binding[method] !== "function")) {
    loadError("addon-invalid", "Windows native addon is missing a required ABI method");
  }
}

/**
 * Turns a byte-verified addon into the only binding exposed to callers. The
 * addon can describe its ABI but cannot assert that it was signed; that fact is
 * created here after manifest, SHA-256, and Authenticode validation.
 */
function wrapTrustedBinding(
  addon: NativeAddonBinding,
  runtime: NativeLoaderRuntime,
): NativeWindowsBinding {
  const rawReport = addon.getAbiInfo();
  const trustedReport = Object.freeze({
    ...rawReport,
    capabilities: Object.freeze({ ...rawReport.capabilities }),
    signatureVerified: true as const,
  });
  const wrapped: Record<string, unknown> = {
    getAbiInfo: () => trustedReport,
  };
  for (const method of NATIVE_SYNCHRONOUS_BLOCKING_METHODS) {
    wrapped[method] = (...args: unknown[]) => {
      if (!runtime.isDedicatedWorkerThread()) {
        return loadError(
          "worker-thread-required",
          `Windows native ${method}() may block and must run on a dedicated worker thread`,
        );
      }
      const fn = addon[method] as (...nativeArgs: unknown[]) => unknown;
      return fn.apply(addon, args);
    };
  }
  return Object.freeze(wrapped) as unknown as NativeWindowsBinding;
}

/**
 * Loads only a signed, complete, architecture-matched Windows prebuild.
 * It intentionally has no fallback to a source build, a generic JS shim, or a
 * partial feature set: callers get an error and must leave the feature disabled.
 */
export function loadWindowsNative(runtime: NativeLoaderRuntime = defaultRuntime()): NativeWindowsBinding {
  writeLoaderTestDiagnostic("native_loader_started");
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
  writeLoaderTestDiagnostic("native_loader_authenticode_verified");
  let binding: unknown;
  try {
    writeLoaderTestDiagnostic("native_loader_binding_loading");
    binding = runtime.loadBinding(binaryPath);
    writeLoaderTestDiagnostic("native_loader_binding_loaded");
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    return loadError("addon-invalid", `Windows native addon could not be loaded${detail}`);
  }
  assertAddonContract(binding, runtime.arch);
  return wrapTrustedBinding(binding, runtime);
}
