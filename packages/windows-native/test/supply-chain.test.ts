import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const stageScript = join(repositoryRoot, "packages/windows-native/scripts/stage-prebuild.mjs");
const prepareDaemonScript = join(repositoryRoot, "apps/daemon/scripts/prepare-windows-native-prebuilds.mjs");
const verifyPackScript = join(repositoryRoot, "packages/windows-native/scripts/verify-release-pack.mjs");
const thumbprint = "A".repeat(40);
const temporaryRoots: string[] = [];

function runNode(script: string, arguments_: string[], expectedStatus = 0): string {
  const result = spawnSync(process.execPath, [script, ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(expectedStatus);
  return result.stdout;
}

async function makePackage(path: string, name: string, files: string[]): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(path + "/package.json", `${JSON.stringify({ name, version: "1.0.0", files }, null, 2)}\n`);
}

describe("Windows native release supply-chain scripts", () => {
  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("stages only signed verified prebuilds and proves both npm tarballs carry them", async () => {
    const root = await mkdtemp(join(tmpdir(), "prospero-native-supply-chain-"));
    temporaryRoots.push(root);
    const nativeRoot = join(root, "windows-native");
    const daemonRoot = join(root, "daemon");
    const outputRoot = join(root, "pack-output");
    await makePackage(nativeRoot, "@prospero/windows-native-fixture", ["prebuilds"]);
    await makePackage(daemonRoot, "@prospero/daemon-fixture", ["windows-native"]);

    for (const arch of ["x64", "arm64"]) {
      const source = join(root, `prospero-${arch}.node`);
      await writeFile(source, `fixture native artifact for ${arch}`);
      runNode(stageScript, [
        "--source", source,
        "--destination", nativeRoot,
        "--arch", arch,
        "--authenticode-status", "valid",
        "--thumbprint", thumbprint,
      ]);
    }
    runNode(prepareDaemonScript, ["--source", nativeRoot, "--target-root", daemonRoot]);
    const output = runNode(verifyPackScript, [
      "--native-root", nativeRoot,
      "--daemon-root", daemonRoot,
      "--output-dir", outputRoot,
    ]);
    const report = JSON.parse(output) as { packages: { windowsNative: { integrity: string }; daemon: { integrity: string } } };
    expect(report.packages.windowsNative.integrity).toMatch(/^sha512-/);
    expect(report.packages.daemon.integrity).toMatch(/^sha512-/);
    const evidence = JSON.parse(await readFile(join(outputRoot, "npm-pack-integrity.json"), "utf8"));
    expect(evidence.nativePrebuilds).toHaveLength(2);
  }, 30_000);

  it("refuses to embed an unsigned CI artifact in a daemon distribution", async () => {
    const root = await mkdtemp(join(tmpdir(), "prospero-native-unsigned-"));
    temporaryRoots.push(root);
    const nativeRoot = join(root, "windows-native");
    const daemonRoot = join(root, "daemon");
    await makePackage(nativeRoot, "@prospero/windows-native-fixture", ["prebuilds"]);
    await makePackage(daemonRoot, "@prospero/daemon-fixture", ["windows-native"]);
    const source = join(root, "prospero-x64.node");
    await writeFile(source, "unsigned fixture native artifact");
    runNode(stageScript, [
      "--source", source,
      "--destination", nativeRoot,
      "--arch", "x64",
      "--authenticode-status", "unsigned",
    ]);
    runNode(prepareDaemonScript, ["--source", nativeRoot, "--target-root", daemonRoot], 1);
  });
});
