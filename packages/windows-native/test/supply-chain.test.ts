import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNpmInvocation } from "../scripts/verify-release-pack.mjs";

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

  it("uses a validated Windows npm CLI through Node without shell parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "prospero npm & shell-meta-"));
    temporaryRoots.push(root);
    const npmCli = join(root, "npm cli & $(not-a-command).mjs");
    const tracePath = join(root, "trace.json");
    const shellArgument = join(root, "pack output & $(not-a-command)");
    await mkdir(shellArgument);
    await writeFile(
      npmCli,
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.env.PROSPERO_NPM_TRACE, JSON.stringify(process.argv.slice(2)));',
      ].join("\n"),
    );

    const invocation = resolveNpmInvocation({ platform: "win32", npmExecPath: npmCli, execPath: process.execPath });
    const result = spawnSync(invocation.command, [...invocation.arguments, "pack", "--pack-destination", shellArgument], {
      encoding: "utf8",
      env: { ...process.env, PROSPERO_NPM_TRACE: tracePath },
      shell: false,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(await readFile(tracePath, "utf8"))).toEqual(["pack", "--pack-destination", shellArgument]);
  });

  it("rejects Windows pack execution when neither npm CLI path is a validated file", async () => {
    const root = await mkdtemp(join(tmpdir(), "prospero-missing-npm-cli-"));
    temporaryRoots.push(root);
    const nodeExecutable = join(root, "node.exe");
    await writeFile(nodeExecutable, "fixture executable");

    expect(() => resolveNpmInvocation({
      platform: "win32",
      npmExecPath: join(root, "missing npm-cli.js"),
      execPath: nodeExecutable,
    })).toThrow("validated absolute npm CLI path");
  });

  it("uses the Node-adjacent npm CLI when npm_execpath is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "prospero-adjacent-npm-cli-"));
    temporaryRoots.push(root);
    const nodeExecutable = join(root, "node", "node.exe");
    const adjacentNpmCli = join(root, "node", "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(dirname(adjacentNpmCli), { recursive: true });
    await Promise.all([
      writeFile(nodeExecutable, "fixture executable"),
      writeFile(adjacentNpmCli, "fixture npm cli"),
    ]);

    expect(resolveNpmInvocation({
      platform: "win32",
      npmExecPath: "relative/npm-cli.js",
      execPath: nodeExecutable,
    })).toEqual({ command: nodeExecutable, arguments: [adjacentNpmCli] });
  });

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
