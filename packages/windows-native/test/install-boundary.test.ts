import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = join(repositoryRoot, "packages/windows-native");
const temporaryRoots: string[] = [];
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function runNpmInstall(cwd: string, arguments_: string[], environment: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync(npmCommand, arguments_, {
    cwd,
    encoding: "utf8",
    env: environment,
    shell: process.platform === "win32",
  });
}

describe("Windows native install boundary", () => {
  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("pins node-gyp 13.0.1 whose declared engine accepts Node 22.23.2", async () => {
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const packageLock = JSON.parse(await readFile(join(repositoryRoot, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string; engines?: { node?: string } }>;
    };
    const lockedNodeGyp = packageLock.packages["node_modules/node-gyp"];

    expect(packageJson.devDependencies["node-gyp"]).toBe("13.0.1");
    expect(lockedNodeGyp?.version).toBe("13.0.1");
    expect(lockedNodeGyp?.engines?.node).toBe("^22.22.2 || ^24.15.0 || >=26.0.0");
  });

  it("runs npm install offline without node-gyp, downloads, or generated native binaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "prospero-native-install-boundary-"));
    temporaryRoots.push(root);
    const source = join(root, "source");
    const consumer = join(root, "consumer");
    const cache = join(root, "empty-npm-cache");
    const trapDirectory = join(root, "node-gyp-trap");
    const trapMarker = join(root, "node-gyp-invoked");
    const sourceScripts = join(source, "scripts");

    await mkdir(sourceScripts, { recursive: true });
    await mkdir(consumer, { recursive: true });
    await mkdir(trapDirectory, { recursive: true });
    await Promise.all([
      copyFile(join(packageRoot, "package.json"), join(source, "package.json")),
      copyFile(join(packageRoot, "binding.gyp"), join(source, "binding.gyp")),
      copyFile(join(packageRoot, "scripts/install-noop.mjs"), join(sourceScripts, "install-noop.mjs")),
      writeFile(join(consumer, "package.json"), "{\"name\":\"install-boundary-consumer\",\"version\":\"1.0.0\",\"private\":true}\n"),
    ]);

    if (process.platform === "win32") {
      await writeFile(join(trapDirectory, "node-gyp.cmd"), "@echo invoked > \"%PROSPERO_NODE_GYP_MARKER%\"\r\n@exit /b 91\r\n");
    } else {
      await writeFile(join(trapDirectory, "node-gyp"), "#!/bin/sh\nprintf invoked > \"$PROSPERO_NODE_GYP_MARKER\"\nexit 91\n", { mode: 0o755 });
    }

    const result = runNpmInstall(consumer, [
      "install",
      "--offline",
      "--ignore-scripts=false",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--cache", cache,
      source,
    ], {
      ...process.env,
      PATH: [trapDirectory, process.env.PATH].filter(Boolean).join(delimiter),
      PROSPERO_NODE_GYP_MARKER: trapMarker,
      npm_config_registry: "http://127.0.0.1:9",
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const installedPackage = join(consumer, "node_modules/@prospero/windows-native");

    expect(result.status, output).toBe(0);
    expect(output).not.toMatch(/node-gyp/i);
    expect(await exists(trapMarker)).toBe(false);
    expect(await exists(join(installedPackage, "build"))).toBe(false);
    expect(await exists(join(installedPackage, "prospero_windows_native.node"))).toBe(false);
  }, 30_000);
});
