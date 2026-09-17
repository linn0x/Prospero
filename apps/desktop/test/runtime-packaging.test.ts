import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const runtimeCheck = require("../scripts/check-runtime-architecture.cjs") as {
  default?: unknown;
  (context: unknown): void;
  windowsExecutableArchitecture(file: string): string | undefined;
  machoArchitecture(file: string): string | undefined;
};

function pe(machine: number): Buffer {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}

function macho(cpu: number): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpu, 4);
  return bytes;
}

function context(projectDir: string, platform: "darwin" | "win32", arch: number): unknown {
  return { electronPlatformName: platform, arch, packager: { projectDir } };
}

describe("runtime packaging guard", () => {
  it("rejects packaged Rust backend when the Rust binary is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "prospero-runtime-"));
    mkdirSync(join(root, ".runtime", "node"), { recursive: true });
    writeFileSync(join(root, ".runtime", "package.json"), JSON.stringify({ prosperoRuntime: { architecture: "x64" } }));
    writeFileSync(join(root, ".runtime", "node", "node.exe"), pe(0x8664));
    expect(() => runtimeCheck(context(root, "win32", 1))).toThrow(/Rust daemon binary is missing/);
  });

  it("checks Windows and macOS Rust binary architectures", () => {
    const root = mkdtempSync(join(tmpdir(), "prospero-runtime-"));
    mkdirSync(join(root, ".runtime", "node"), { recursive: true });
    writeFileSync(join(root, ".runtime", "package.json"), JSON.stringify({ prosperoRuntime: { architecture: "x64" } }));
    writeFileSync(join(root, ".runtime", "node", "node.exe"), pe(0x8664));
    writeFileSync(join(root, ".runtime", "prosperod-rs.exe"), pe(0x8664));
    writeFileSync(join(root, ".runtime", "prospero.exe"), pe(0x8664));
    expect(() => runtimeCheck(context(root, "win32", 1))).not.toThrow();
    writeFileSync(join(root, ".runtime", "prosperod-rs.exe"), pe(0xaa64));
    expect(() => runtimeCheck(context(root, "win32", 1))).toThrow(/matching prosperod-rs.exe/);
    writeFileSync(join(root, ".runtime", "prosperod-rs.exe"), pe(0x8664));
    writeFileSync(join(root, ".runtime", "prospero.exe"), pe(0xaa64));
    expect(() => runtimeCheck(context(root, "win32", 1))).toThrow(/matching prospero.exe/);

    writeFileSync(join(root, ".runtime", "prosperod-rs"), macho(0x0100000c));
    writeFileSync(join(root, ".runtime", "prospero"), macho(0x0100000c));
    writeFileSync(join(root, ".runtime", "install-rust-daemon-launchagent.sh"), "");
    expect(runtimeCheck.machoArchitecture(join(root, ".runtime", "prosperod-rs"))).toBe("arm64");
    expect(() => runtimeCheck(context(root, "darwin", 3))).not.toThrow();
    expect(() => runtimeCheck(context(root, "darwin", 1))).toThrow(/matching prosperod-rs/);
  });
});
