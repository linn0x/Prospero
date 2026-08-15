import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

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
      throw new Error("usage: prepare-windows-native-prebuilds.mjs [--source <signed native package root>] [--target-root <daemon root>]");
    }
    values.set(key, value);
  }
  const supplied = values.get("--source") ?? process.env.PROSPERO_WINDOWS_NATIVE_PREBUILD_SOURCE;
  if (typeof supplied !== "string" || supplied.length === 0 || supplied !== supplied.trim()) {
    throw new Error("PROSPERO_WINDOWS_NATIVE_PREBUILD_SOURCE is required to pack the daemon");
  }
  const target = values.get("--target-root");
  return {
    sourceRoot: resolve(supplied),
    targetRoot: target === undefined ? resolve(import.meta.dirname, "..") : resolve(target),
  };
}

async function validatePrebuild(sourceRoot, arch) {
  const directory = resolve(sourceRoot, "prebuilds", `win32-${arch}`);
  const binaryPath = resolve(directory, ARTIFACT_NAME);
  const manifestPath = resolve(directory, "manifest.json");
  const [binary, rawManifest, binaryStat] = await Promise.all([
    readFile(binaryPath),
    readFile(manifestPath, "utf8"),
    stat(binaryPath),
  ]);
  if (!binaryStat.isFile() || binary.byteLength === 0) throw new Error(`${arch}: native artifact is missing or empty`);
  let manifest;
  try {
    manifest = JSON.parse(rawManifest);
  } catch {
    throw new Error(`${arch}: native manifest is invalid JSON`);
  }
  const actualHash = createHash("sha256").update(binary).digest("hex");
  if (
    manifest?.schemaVersion !== 2 ||
    manifest.platform !== "win32" ||
    manifest.arch !== arch ||
    manifest.artifact?.file !== ARTIFACT_NAME ||
    manifest.artifact?.sha256?.toLowerCase() !== actualHash ||
    manifest.native?.abiVersion !== 2 ||
    manifest.native?.napiVersion !== 8 ||
    CAPABILITIES.some((capability) => manifest.native?.capabilities?.[capability] !== true) ||
    manifest.authenticode?.status !== "valid" ||
    !/^[a-fA-F0-9]{40}$/.test(manifest.authenticode?.thumbprintSha1 ?? "")
  ) {
    throw new Error(`${arch}: refusing to embed an unsigned, partial, or unverified native prebuild`);
  }
  return { arch, sha256: actualHash, thumbprintSha1: manifest.authenticode.thumbprintSha1.toUpperCase() };
}

const { sourceRoot, targetRoot } = parseArguments(process.argv.slice(2));
const sourcePrebuilds = resolve(sourceRoot, "prebuilds");
const targetPrebuilds = resolve(targetRoot, "windows-native", "prebuilds");
if (sourceRoot === targetRoot || sourcePrebuilds === targetPrebuilds) {
  throw new Error("Daemon staging source must be a separate signed windows-native package root");
}

const evidence = await Promise.all(ARCHITECTURES.map((arch) => validatePrebuild(sourceRoot, arch)));
await rm(targetPrebuilds, { recursive: true, force: true });
await mkdir(resolve(targetRoot, "windows-native"), { recursive: true });
await cp(sourcePrebuilds, targetPrebuilds, { recursive: true, force: false, errorOnExist: true });
process.stdout.write(`${JSON.stringify({ embeddedPrebuilds: evidence })}\n`);
