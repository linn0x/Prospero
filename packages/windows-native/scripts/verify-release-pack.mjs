import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ARCHITECTURES = ["x64", "arm64"];
const ARTIFACT_NAME = "prospero_windows_native.node";
const CAPABILITIES = [
  "processIdentity",
  "secureNamedPipe",
  "jobObject",
  "parentJobCompatibility",
  "detachedHost",
  "conPty",
  "dpapiCurrentUser",
  "secureStateDirectory",
];

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new Error("usage: verify-release-pack.mjs --native-root <root> --daemon-root <root> --output-dir <dir>");
    }
    values.set(key, value);
  }
  const nativeRoot = values.get("--native-root");
  const daemonRoot = values.get("--daemon-root");
  const outputDir = values.get("--output-dir");
  if (!nativeRoot || !daemonRoot || !outputDir) {
    throw new Error("usage: verify-release-pack.mjs --native-root <root> --daemon-root <root> --output-dir <dir>");
  }
  return { nativeRoot: resolve(nativeRoot), daemonRoot: resolve(daemonRoot), outputDir: resolve(outputDir) };
}

async function verifyPrebuild(root, prefix, arch) {
  const directory = resolve(root, prefix, "prebuilds", `win32-${arch}`);
  const binaryPath = resolve(directory, ARTIFACT_NAME);
  const manifestPath = resolve(directory, "manifest.json");
  const [binary, rawManifest, binaryStat] = await Promise.all([
    readFile(binaryPath),
    readFile(manifestPath, "utf8"),
    stat(binaryPath),
  ]);
  if (!binaryStat.isFile() || binary.byteLength === 0) throw new Error(`${prefix || "native"}/${arch}: missing native binary`);
  let manifest;
  try {
    manifest = JSON.parse(rawManifest);
  } catch {
    throw new Error(`${prefix || "native"}/${arch}: invalid manifest JSON`);
  }
  const sha256 = createHash("sha256").update(binary).digest("hex");
  if (
    manifest?.schemaVersion !== 2 ||
    manifest.platform !== "win32" ||
    manifest.arch !== arch ||
    manifest.artifact?.file !== ARTIFACT_NAME ||
    manifest.artifact?.sha256?.toLowerCase() !== sha256 ||
    manifest.native?.abiVersion !== 2 ||
    manifest.native?.napiVersion !== 8 ||
    CAPABILITIES.some((capability) => manifest.native?.capabilities?.[capability] !== true) ||
    manifest.authenticode?.status !== "valid" ||
    !/^[a-fA-F0-9]{40}$/.test(manifest.authenticode?.thumbprintSha1 ?? "")
  ) {
    throw new Error(`${prefix || "native"}/${arch}: artifact does not meet signed release policy`);
  }
  return {
    arch,
    sha256,
    signerThumbprintSha1: manifest.authenticode.thumbprintSha1.toUpperCase(),
  };
}

function isExistingFile(path, statFile) {
  try {
    return statFile(path).isFile();
  } catch {
    return false;
  }
}

/**
 * `npm.cmd` cannot be spawned by Node without a shell on Windows. Resolve the
 * JavaScript CLI instead and execute it with the current Node executable, so
 * package roots and output paths remain individual arguments all the way to
 * npm. npm_execpath is supplied by npm itself; the adjacent installation is a
 * deliberately narrow fallback for direct Node invocations in CI.
 */
export function resolveNpmInvocation({
  platform = process.platform,
  npmExecPath = process.env.npm_execpath,
  execPath = process.execPath,
  statFile = statSync,
} = {}) {
  if (platform !== "win32") return { command: "npm", arguments: [] };

  if (!isAbsolute(execPath) || !isExistingFile(execPath, statFile)) {
    throw new Error("Windows npm invocation requires a validated absolute Node executable");
  }

  const adjacentNpmCli = join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  for (const candidate of [npmExecPath, adjacentNpmCli]) {
    if (typeof candidate !== "string" || !isAbsolute(candidate)) continue;
    const npmCli = resolve(candidate);
    if (isExistingFile(npmCli, statFile)) {
      return { command: execPath, arguments: [npmCli] };
    }
  }

  throw new Error("Windows npm invocation requires a validated absolute npm CLI path");
}

async function packPackage(root, outputDir) {
  const npm = resolveNpmInvocation();
  const raw = execFileSync(
    npm.command,
    [...npm.arguments, "pack", "--json", "--ignore-scripts", "--pack-destination", outputDir],
    { cwd: root, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "inherit"] },
  );
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error(`npm pack did not emit JSON for ${root}`);
  }
  if (!Array.isArray(entries) || entries.length !== 1) throw new Error(`Unexpected npm pack result for ${root}`);
  const entry = entries[0];
  const tarball = resolve(outputDir, entry.filename ?? "");
  const bytes = await readFile(tarball);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (entry.integrity !== integrity) throw new Error(`npm pack integrity mismatch for ${entry.filename}`);
  if (!Array.isArray(entry.files)) throw new Error(`npm pack did not list files for ${entry.filename}`);
  return {
    filename: entry.filename,
    integrity,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    files: entry.files.map((file) => file.path),
  };
}

function assertPackedFiles(pack, required, label) {
  for (const file of required) {
    if (!pack.files.includes(file)) throw new Error(`${label} npm tarball does not carry ${file}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  await mkdir(options.outputDir, { recursive: true });
  const nativePrebuilds = await Promise.all(ARCHITECTURES.map((arch) => verifyPrebuild(options.nativeRoot, "", arch)));
  const daemonPrebuilds = await Promise.all(ARCHITECTURES.map((arch) => verifyPrebuild(options.daemonRoot, "windows-native", arch)));
  for (const arch of ARCHITECTURES) {
    const native = nativePrebuilds.find((entry) => entry.arch === arch);
    const daemon = daemonPrebuilds.find((entry) => entry.arch === arch);
    if (!native || !daemon || native.sha256 !== daemon.sha256 || native.signerThumbprintSha1 !== daemon.signerThumbprintSha1) {
      throw new Error(`Daemon embedded prebuild for ${arch} differs from its signed native package artifact`);
    }
  }
  const [nativePack, daemonPack] = await Promise.all([
    packPackage(options.nativeRoot, options.outputDir),
    packPackage(options.daemonRoot, options.outputDir),
  ]);
  assertPackedFiles(
    nativePack,
    ARCHITECTURES.flatMap((arch) => [
      `prebuilds/win32-${arch}/${ARTIFACT_NAME}`,
      `prebuilds/win32-${arch}/manifest.json`,
    ]),
    "windows-native",
  );
  assertPackedFiles(
    daemonPack,
    ARCHITECTURES.flatMap((arch) => [
      `windows-native/prebuilds/win32-${arch}/${ARTIFACT_NAME}`,
      `windows-native/prebuilds/win32-${arch}/manifest.json`,
    ]),
    "daemon",
  );
  const evidence = {
    schemaVersion: 1,
    nativePrebuilds,
    packages: {
      windowsNative: { filename: nativePack.filename, integrity: nativePack.integrity, shasum: nativePack.shasum },
      daemon: { filename: daemonPack.filename, integrity: daemonPack.integrity, shasum: daemonPack.shasum },
    },
  };
  const evidencePath = join(options.outputDir, "npm-pack-integrity.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ evidencePath, ...evidence })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
