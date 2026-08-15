import { createRequire } from "node:module";
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ARCHITECTURES = new Set(["x64", "arm64"]);
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
  if (argv.length !== 4 || argv[0] !== "--package-root" || argv[2] !== "--expect") {
    throw new Error("usage: smoke-loader.mjs --package-root <root> --expect <unsigned|valid>");
  }
  if (argv[3] !== "unsigned" && argv[3] !== "valid") throw new Error("expected unsigned or valid");
  return { packageRoot: resolve(argv[1]), expected: argv[3] };
}

async function importLoader(packageRoot) {
  return import(pathToFileURL(join(packageRoot, "dist", "loader.js")).href);
}

function assertRawAddonLoads(packageRoot) {
  const binaryPath = join(packageRoot, "prebuilds", `win32-${process.arch}`, "prospero_windows_native.node");
  const raw = createRequire(import.meta.url)(binaryPath);
  const report = raw?.getAbiInfo?.();
  if (!report || CAPABILITIES.some((capability) => report.capabilities?.[capability] !== true)) {
    throw new Error("Raw addon did not expose every implemented native capability");
  }
}

async function runTrustedLoaderInWorker(packageRoot) {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { packageRoot } });
    worker.once("error", reject);
    worker.once("message", (message) => {
      worker.terminate().catch(() => undefined);
      if (message?.error) reject(new Error(message.error));
      else resolvePromise(message);
    });
  });
}

if (!isMainThread) {
  try {
    const { loadWindowsNative } = await importLoader(workerData.packageRoot);
    const binding = loadWindowsNative();
    const identity = binding.getCurrentProcessIdentity();
    parentPort?.postMessage({ signatureVerified: binding.getAbiInfo().signatureVerified, identity });
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
} else {
  if (process.platform !== "win32") throw new Error("Windows loader smoke must run on Windows");
  if (!ARCHITECTURES.has(process.arch)) throw new Error(`Unsupported Windows architecture: ${process.arch}`);
  const { packageRoot, expected } = parseArguments(process.argv.slice(2));
  const { loadWindowsNative } = await importLoader(packageRoot);
  assertRawAddonLoads(packageRoot);

  if (expected === "unsigned") {
    try {
      loadWindowsNative();
      throw new Error("Production loader accepted an unsigned CI artifact");
    } catch (error) {
      if (error?.code !== "unsigned") throw error;
    }
    process.stdout.write("Unsigned artifact raw-load succeeded and production loader rejected it.\n");
  } else {
    const report = await runTrustedLoaderInWorker(packageRoot);
    if (report?.signatureVerified !== true || !/^\d+$/.test(report?.identity?.creationTime100ns ?? "")) {
      throw new Error("Signed production loader smoke did not return a trusted native identity");
    }
    process.stdout.write("Signed artifact passed the production loader and worker-thread native call.\n");
  }
}
