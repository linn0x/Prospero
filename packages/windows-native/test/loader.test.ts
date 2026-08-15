import { describe, expect, it } from "vitest";
import {
  type NativeCapabilityReport,
  type NativeLoaderRuntime,
  type NativePrebuildManifest,
  type NativeWindowsBinding,
  NativeLoadError,
  loadWindowsNative,
} from "../src/index.js";

const allCapabilities = {
  processIdentity: true,
  secureNamedPipe: true,
  jobObject: true,
  detachedHost: true,
  conPty: true,
} as const;

function validManifest(): NativePrebuildManifest {
  return {
    schemaVersion: 1,
    platform: "win32",
    arch: "x64",
    artifact: { file: "prospero_windows_native.node", sha256: "a".repeat(64) },
    native: { abiVersion: 1, napiVersion: 8, capabilities: allCapabilities },
    authenticode: { status: "valid", thumbprintSha1: "b".repeat(40) },
  };
}

function completeBinding(report: NativeCapabilityReport): NativeWindowsBinding {
  const unavailable = () => undefined;
  return {
    getAbiInfo: () => report,
    getCurrentProcessIdentity: unavailable as NativeWindowsBinding["getCurrentProcessIdentity"],
    createSecureNamedPipeServer: unavailable as NativeWindowsBinding["createSecureNamedPipeServer"],
    closeSecureNamedPipeServer: unavailable as NativeWindowsBinding["closeSecureNamedPipeServer"],
    getSecureNamedPipePeerIdentity: unavailable as NativeWindowsBinding["getSecureNamedPipePeerIdentity"],
    createJobObject: unavailable as NativeWindowsBinding["createJobObject"],
    assignProcessToJob: unavailable as NativeWindowsBinding["assignProcessToJob"],
    terminateJobObject: unavailable as NativeWindowsBinding["terminateJobObject"],
    closeJobObject: unavailable as NativeWindowsBinding["closeJobObject"],
    launchDetachedHost: unavailable as NativeWindowsBinding["launchDetachedHost"],
    spawnConPty: unavailable as NativeWindowsBinding["spawnConPty"],
    resizeConPty: unavailable as NativeWindowsBinding["resizeConPty"],
    readConPty: unavailable as NativeWindowsBinding["readConPty"],
    writeConPty: unavailable as NativeWindowsBinding["writeConPty"],
    killConPty: unavailable as NativeWindowsBinding["killConPty"],
    closeConPty: unavailable as NativeWindowsBinding["closeConPty"],
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
    ...overrides,
  };
}

function nativeReport(overrides: Partial<NativeCapabilityReport> = {}): NativeCapabilityReport {
  return {
    abiVersion: 1,
    napiVersion: 8,
    platform: "win32",
    arch: "x64",
    buildId: "signed-test-build",
    signatureVerified: true,
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
    const binding = completeBinding(nativeReport());
    expectNativeLoadError(
      () => loadWindowsNative(mockRuntime(validManifest(), binding, { arch: "ia32" })),
      "unsupported-architecture",
    );
    expectNativeLoadError(
      () => loadWindowsNative(mockRuntime(validManifest(), binding, { napiVersion: "7" })),
      "insufficient-napi",
    );
  });

  it("accepts a complete signed mock binding", () => {
    const report = nativeReport();
    const binding = completeBinding(report);
    expect(loadWindowsNative(mockRuntime(validManifest(), binding))).toBe(binding);
  });

  it("rejects the unsigned, capability-false skeleton manifest", () => {
    const skeleton: NativePrebuildManifest = {
      ...validManifest(),
      native: {
        abiVersion: 1,
        napiVersion: 8,
        capabilities: { ...allCapabilities, conPty: false },
      },
      authenticode: { status: "unsigned" },
    };
    expectNativeLoadError(
      () => loadWindowsNative(mockRuntime(skeleton, completeBinding(nativeReport()))),
      "capability-missing",
    );
  });

  it("rejects a signed prebuild whose addon reports an incomplete capability", () => {
    const report = nativeReport({ capabilities: { ...allCapabilities, secureNamedPipe: false } });
    expectNativeLoadError(
      () => loadWindowsNative(mockRuntime(validManifest(), completeBinding(report))),
      "capability-missing",
    );
  });

  it("rejects manifest ABI mismatches before the binary can load", () => {
    const manifest = validManifest();
    const wrongAbi = {
      ...manifest,
      native: { ...manifest.native, abiVersion: 2 },
    } as unknown as NativePrebuildManifest;
    expectNativeLoadError(
      () => loadWindowsNative(mockRuntime(wrongAbi, completeBinding(nativeReport()))),
      "manifest-invalid",
    );
  });

  it("rejects an Authenticode thumbprint mismatch before loading the addon", () => {
    expectNativeLoadError(() =>
      loadWindowsNative(
        mockRuntime(validManifest(), completeBinding(nativeReport()), {
          verifyAuthenticode: () => ({ status: "Valid", thumbprintSha1: "c".repeat(40) }),
          loadBinding: () => { throw new Error("must not run"); },
        }),
      ),
    "authenticode-invalid");
  });
});
