/**
 * Synthetic, isolated heap regression; never reads user data or opens a socket.
 * Run after `npm run build -w @prospero/protocol`:
 *   node tools/base64-memory-regression.mjs
 *
 * The heap limit applies to V8's old space, not total process RSS. Memory and
 * elapsed time are observations, not portable pass thresholds or Hermes data.
 */
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIB = 1024 * 1024;
const scriptPath = fileURLToPath(import.meta.url);
const mib = (bytes) => Number((bytes / MIB).toFixed(1));

/** Run only the codec/crypto in a constrained child, not the test runner. */
export function runMemoryCase({ mode, moduleUrl, sizeMiB, heapMiB }) {
  if (process.platform === "win32") {
    throw new Error("This harness requires POSIX ulimit to disable child core dumps");
  }
  if (!["base64", "secure-channel"].includes(mode)
    || !Number.isInteger(sizeMiB) || sizeMiB < 1 || sizeMiB > 16
    || !Number.isInteger(heapMiB) || heapMiB < 32 || heapMiB > 512) {
    throw new Error("Invalid memory regression case");
  }
  // Positional arguments avoid shell interpolation. A failed core-dump guard
  // stops execution; the bounded child cannot abort the calling test process.
  const child = spawnSync("/bin/sh", [
    "-c", 'ulimit -c 0 || exit 125; exec "$@"', "prospero-memory-regression",
    process.execPath, "--expose-gc", `--max-old-space-size=${heapMiB}`,
    scriptPath, "--worker", mode, String(moduleUrl), String(sizeMiB),
  ], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
  });
  const outcome = {
    mode, sizeMiB, heapMiB, exitCode: child.status, signal: child.signal,
    oom: /heap out of memory/i.test(child.stderr ?? ""),
    ...(child.error ? { processError: child.error.code ?? "child_process_error" } : {}),
  };
  if (child.status !== 0 || child.error) return outcome;
  try {
    return { ...outcome, metrics: JSON.parse(child.stdout) };
  } catch {
    return { ...outcome, processError: "invalid_worker_output" };
  }
}

async function runWorker(mode, moduleUrl, sizeMiB) {
  const implementation = await import(moduleUrl);
  const size = sizeMiB * MIB;
  let before;
  let encodedMemory;
  let decodedMemory;
  let encodedLength;
  let started;
  if (mode === "base64") {
    const data = new Uint8Array(size).fill(65);
    global.gc?.();
    before = process.memoryUsage();
    started = performance.now();
    const encoded = implementation.toB64(data);
    encodedLength = encoded.length;
    encodedMemory = process.memoryUsage();
    const decoded = implementation.fromB64(encoded);
    decodedMemory = process.memoryUsage();
    if (encodedLength !== 4 * Math.ceil(size / 3) || decoded.length !== size) {
      throw new Error("Base64 roundtrip length mismatch");
    }
    for (let i = 0; i < size; i++) {
      if (decoded[i] !== data[i]) throw new Error("Base64 roundtrip content mismatch");
    }
  } else if (mode === "secure-channel") {
    // Fixed, synthetic key and ASCII payload; this is not a live connection.
    const key = new Uint8Array(32).fill(7);
    const sender = new implementation.SecureChannel(key, 1);
    const receiver = new implementation.SecureChannel(key, 2);
    const payload = { type: "chat.send", sid: "synthetic", text: "A".repeat(size) };
    global.gc?.();
    before = process.memoryUsage();
    started = performance.now();
    const encoded = sender.seal(payload);
    encodedLength = encoded.length;
    encodedMemory = process.memoryUsage();
    const decoded = receiver.open(encoded);
    decodedMemory = process.memoryUsage();
    if (decoded?.type !== payload.type || decoded?.sid !== payload.sid || decoded?.text !== payload.text) {
      throw new Error("SecureChannel roundtrip mismatch");
    }
  } else {
    throw new Error("Unknown memory worker mode");
  }
  return {
    nodeVersion: process.version,
    elapsedMs: Math.round(performance.now() - started),
    encodedLength,
    beforeRssMiB: mib(before.rss),
    encodedRssMiB: mib(encodedMemory.rss),
    encodedHeapMiB: mib(encodedMemory.heapUsed),
    decodedRssMiB: mib(decodedMemory.rss),
    decodedHeapMiB: mib(decodedMemory.heapUsed),
    peakRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(1)),
    roundtrip: "passed",
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === "--worker") {
    const metrics = await runWorker(process.argv[3], process.argv[4], Number(process.argv[5]));
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
  } else {
    const codec = new URL("../packages/protocol/dist/b64.js", import.meta.url).href;
    const crypto = new URL("../packages/protocol/dist/crypto.js", import.meta.url).href;
    const cases = [
      { mode: "base64", moduleUrl: codec, sizeMiB: 1, heapMiB: 128 },
      { mode: "base64", moduleUrl: codec, sizeMiB: 4, heapMiB: 128 },
      { mode: "secure-channel", moduleUrl: crypto, sizeMiB: 4, heapMiB: 256 },
    ].map(runMemoryCase);
    process.stdout.write(`${JSON.stringify(cases, null, 2)}\n`);
    if (cases.some((result) => result.metrics?.roundtrip !== "passed")) process.exitCode = 1;
  }
}
