import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const ARCHITECTURES = new Set(["x64", "arm64"]);
const CAPABILITIES = Object.freeze({
  processIdentity: true,
  secureNamedPipe: true,
  jobObject: true,
  parentJobCompatibility: true,
  detachedHost: true,
  conPty: true,
  dpapiCurrentUser: true,
  secureStateDirectory: true,
});
const ARTIFACT_NAME = "prospero_windows_native.node";

function usage() {
  throw new Error(
    "usage: stage-prebuild.mjs --source <built .node> --destination <package root> --arch <x64|arm64> --authenticode-status <unsigned|valid> [--thumbprint <SHA-1>]",
  );
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) usage();
    values.set(key, value);
  }
  const source = values.get("--source");
  const destination = values.get("--destination");
  const arch = values.get("--arch");
  const status = values.get("--authenticode-status");
  const thumbprint = values.get("--thumbprint");
  if (
    !source ||
    !destination ||
    !ARCHITECTURES.has(arch) ||
    (status !== "unsigned" && status !== "valid") ||
    (status === "valid" && !/^[a-fA-F0-9]{40}$/.test(thumbprint ?? "")) ||
    (status === "unsigned" && thumbprint !== undefined)
  ) {
    usage();
  }
  return { source: resolve(source), destination: resolve(destination), arch, status, thumbprint };
}

async function writeAtomically(path, contents) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

const options = parseArguments(process.argv.slice(2));
const sourceMetadata = await stat(options.source);
if (!sourceMetadata.isFile()) throw new Error(`Native build artifact is not a regular file: ${options.source}`);

const binary = await readFile(options.source);
if (binary.byteLength === 0) throw new Error("Refusing to stage an empty native build artifact");
const sha256 = createHash("sha256").update(binary).digest("hex");
const targetDirectory = resolve(options.destination, "prebuilds", `win32-${options.arch}`);
const targetBinary = resolve(targetDirectory, ARTIFACT_NAME);
const targetManifest = resolve(targetDirectory, "manifest.json");
await mkdir(targetDirectory, { recursive: true });
if (options.source !== targetBinary) await copyFile(options.source, targetBinary);

const authenticode = options.status === "valid"
  ? { status: "valid", thumbprintSha1: options.thumbprint.toUpperCase() }
  : { status: "unsigned" };
const manifest = {
  schemaVersion: 2,
  platform: "win32",
  arch: options.arch,
  artifact: { file: ARTIFACT_NAME, sha256 },
  native: { abiVersion: 3, napiVersion: 8, capabilities: CAPABILITIES },
  authenticode,
};
await writeAtomically(targetManifest, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ arch: options.arch, binary: targetBinary, manifest: targetManifest, sha256, authenticode })}\n`);
