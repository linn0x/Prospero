import { describe, expect, it } from "vitest";
import {
  type NativeAddonBinding,
  type NativeAddonCapabilityReport,
  type NativeLoaderRuntime,
  type NativePrebuildManifest,
  NativeLoadError,
  loadWindowsNative,
} from "../src/index.js";

const allCapabilities = {
  processIdentity: true,
  secureNamedPipe: true,
  jobObject: true,
  parentJobCompatibility: true,
  detachedHost: true,
  conPty: true,
  dpapiCurrentUser: true,
  secureStateDirectory: true,
} as const;

function validManifest(): NativePrebuildManifest {
  return {
    schemaVersion: 2,
    platform: "win32",
    arch: "x64",
    artifact: { file: "prospero_windows_native.node", sha256: "a".repeat(64) },
    native: { abiVersion: 2, napiVersion: 8, capabilities: allCapabilities },
    authenticode: { status: "valid", thumbprintSha1: "b".repeat(40) },
  };
}

function completeAddon(report: NativeAddonCapabilityReport): NativeAddonBinding {
  const unavailable = () => undefined;
  return {
    getAbiInfo: () => report,
    getCurrentProcessIdentity: unavailable as NativeAddonBinding["getCurrentProcessIdentity"],
    getProcessIdentity: unavailable as NativeAddonBinding["getProcessIdentity"],
    matchesProcessIdentity: unavailable as NativeAddonBinding["matchesProcessIdentity"],
    createSecureNamedPipeServer: unavailable as NativeAddonBinding["createSecureNamedPipeServer"],
    acceptSecureNamedPipeConnection: unavailable as NativeAddonBinding["acceptSecureNamedPipeConnection"],
    closeSecureNamedPipeServer: unavailable as NativeAddonBinding["closeSecureNamedPipeServer"],
    readSecureNamedPipeConnection: unavailable as NativeAddonBinding["readSecureNamedPipeConnection"],
    writeSecureNamedPipeConnection: unavailable as NativeAddonBinding["writeSecureNamedPipeConnection"],
    getSecureNamedPipePeerIdentity: unavailable as NativeAddonBinding["getSecureNamedPipePeerIdentity"],
    disconnectSecureNamedPipeConnection: unavailable as NativeAddonBinding["disconnectSecureNamedPipeConnection"],
    closeSecureNamedPipeConnection: unavailable as NativeAddonBinding["closeSecureNamedPipeConnection"],
    createJobObject: unavailable as NativeAddonBinding["createJobObject"],
    assignProcessToJob: unavailable as NativeAddonBinding["assignProcessToJob"],
    terminateJobObject: unavailable as NativeAddonBinding["terminateJobObject"],
    closeJobObject: unavailable as NativeAddonBinding["closeJobObject"],
    getParentJobCompatibility: unavailable as NativeAddonBinding["getParentJobCompatibility"],
    launchDetachedHost: unavailable as NativeAddonBinding["launchDetachedHost"],
    spawnConPty: unavailable as NativeAddonBinding["spawnConPty"],
    resizeConPty: unavailable as NativeAddonBinding["resizeConPty"],
    readConPty: unavailable as NativeAddonBinding["readConPty"],
    writeConPty: unavailable as NativeAddonBinding["writeConPty"],
    killConPty: unavailable as NativeAddonBinding["killConPty"],
    closeConPty: unavailable as NativeAddonBinding["closeConPty"],
    dpapiProtectCurrentUser: unavailable as NativeAddonBinding["dpapiProtectCurrentUser"],
    dpapiUnprotectCurrentUser: unavailable as NativeAddonBinding["dpapiUnprotectCurrentUser"],
    openSecureStateDirectory: unavailable as NativeAddonBinding["openSecureStateDirectory"],
    writeSecureStateFileAtomically: unavailable as NativeAddonBinding["writeSecureStateFileAtomically"],
    closeSecureStateDirectory: unavailable as NativeAddonBinding["closeSecureStateDirectory"],
  };
}

function mockRuntime(
  manifest: NativePrebuildManifest,
  binding: unknown,
  overrides: Partial<NativeLoaderRuntime> = {},
): NativeLoaderRuntime {
  return {
    platform: "win32",
    arch: "x64",
    napiVersion: "10",
    packageRoot: "/package",
    fileExists: () => true,
    readFile: (path) =>
      new TextEncoder().encode(path.endsWith("manifest.json") ? JSON.stringify(manifest) : "binary"),
    sha256: () => "a".repeat(64),
    verifyAuthenticode: () => ({ status: "Valid", thumbprintSha1: "b".repeat(40) }),
    loadBinding: () => binding,
    isDedicatedWorkerThread: () => true,
    ...overrides,
  };
}

function addonReport(overrides: Partial<NativeAddonCapabilityReport> = {}): NativeAddonCapabilityReport {
  return {
    abiVersion: 2,
    napiVersion: 8,
    platform: "win32",
    arch: "x64",
    buildId: "test-build",
    capabilities: allCapabilities,
    ...overrides,
  };
}

function expectNativeLoadError(action: () => unknown, code: NativeLoadError["code"]): void {
  try {
    action();
    expect.unreachable("expected loadWindowsNative to fail closed");
  } catch (error) {
    expect(error).toBeInstanceOf(NativeLoadError);
    expect((error as NativeLoadError).code).toBe(code);
  }
}

describe("Windows native fail-closed loader", () => {
  it("does not attempt to load anything outside Windows", () => {
    expectNativeLoadError(() =>
      loadWindowsNative(
        mockRuntime(validManifest(), {}, { platform: "darwin", loadBinding: () => { throw new Error("must not run"); } }),
      ),
    "unsupported-platform");
  });

  it("rejects architectures and host Node-API levels outside the release contract", () => {
    const binding = completeAddon(addonReport());
    expectNativeLoadError(
      () => loadWindowsNative(mockRuntime(validManifest(), binding, { arch: "ia32" })),
      "unsupported-architecture",
    );
    expectNativeLoadError(
      () => loadWindowsNative(mockRuntime(validManifest(), binding, { napiVersion: "7" })),
      "insufficient-napi",
    );
  });

  it("wraps a complete signed addon and creates the trust report in the loader", () => {
    const addon = completeAddon(addonReport());
    const binding = loadWindowsNative(mockRuntime(validManifest(), addon));
    expect(binding).not.toBe(addon);
    expect(binding.getAbiInfo()).toMatchObject({ ...addonReport(), signatureVerified: true });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.getAbiInfo())).toBe(true);
  });

  it("rejects an addon that tries to self-attest signature verification", () => {
    const selfAttesting = completeAddon({
      ...addonReport(),
      signatureVerified: true,
    } as unknown as NativeAddonCapabilityReport);
    expectNativeLoadError(
      () => loadWindowsNative(mockRuntime(validManifest(), selfAttesting)),
      "addon-invalid",
    );
  });

  it("rejects the unsigned, capability-false skeleton manifest", () => {
    const skeleton: NativePrebuildManifest = {
      ...validManifest(),
      native: {
        abiVersion: 2,
        napiVersion: 8,
        capabilities: { ...allCapabilities, dpapiCurrentUser: false },
      },
      authenticode: { status: "unsigned" },
    };
    expectNativeLoadError(
      () => loadWindowsNative(mockRuntime(skeleton, completeAddon(addonReport()))),
      "capability-missing",
    );
  });

  it("rejects a signed prebuild whose addon omits a new contract capability", () => {
    const report = addonReport({ capabilities: { ...allCapabilities, secureStateDirectory: false } });
    expectNativeLoadError(
      () => loadWindowsNative(mockRuntime(validManifest(), completeAddon(report))),
      "capability-missing",
    );
  });

  it("rejects a pipe API without accept and connection operations", () => {
    const addon = completeAddon(addonReport()) as Partial<NativeAddonBinding>;
    delete addon.acceptSecureNamedPipeConnection;
    delete addon.closeSecureNamedPipeConnection;
    expectNativeLoadError(
      () => loadWindowsNative(mockRuntime(validManifest(), addon)),
      "addon-invalid",
    );
  });

  it("rejects manifest ABI mismatches before the binary can load", () => {
    const manifest = validManifest();
    const wrongAbi = {
      ...manifest,
      native: { ...manifest.native, abiVersion: 1 },
    } as unknown as NativePrebuildManifest;
    expectNativeLoadError(
      () => loadWindowsNative(mockRuntime(wrongAbi, completeAddon(addonReport()))),
      "manifest-invalid",
    );
  });

  it("rejects an Authenticode thumbprint mismatch before loading the addon", () => {
    expectNativeLoadError(() =>
      loadWindowsNative(
        mockRuntime(validManifest(), completeAddon(addonReport()), {
          verifyAuthenticode: () => ({ status: "Valid", thumbprintSha1: "c".repeat(40) }),
          loadBinding: () => { throw new Error("must not run"); },
        }),
      ),
    "authenticode-invalid");
  });

  it("refuses all synchronous native operations on the main thread", () => {
    const addon = completeAddon(addonReport());
    const binding = loadWindowsNative(
      mockRuntime(validManifest(), addon, { isDedicatedWorkerThread: () => false }),
    );
    expectNativeLoadError(() => binding.getProcessIdentity(42), "worker-thread-required");
  });
});
