import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { parentPort, threadId, workerData } from "node:worker_threads";
import {
  createLegacyDesktopProjection,
} from "./orchestration-projection";

type Input = {
  sourcePath: string;
  targetPath: string;
  sourceMtimeNs: bigint;
};

function modifiedAt(path: string): bigint | undefined {
  try {
    return statSync(path, { bigint: true }).mtimeNs;
  } catch {
    return undefined;
  }
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

function run(): void {
  const input = workerData as Input;
  if (
    typeof input?.sourcePath !== "string" ||
    typeof input?.targetPath !== "string" ||
    typeof input?.sourceMtimeNs !== "bigint"
  )
    throw new Error("invalid projection worker input");
  const targetBefore = modifiedAt(input.targetPath);
  const sourceHandle = openSync(input.sourcePath, "r");
  let sourceText: string;
  let sourceMtimeNs: bigint;
  try {
    const sourceBefore = fstatSync(sourceHandle, { bigint: true });
    sourceText = readFileSync(sourceHandle, "utf8");
    const sourceAfter = fstatSync(sourceHandle, { bigint: true });
    if (sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeNs !== sourceAfter.mtimeNs) {
      parentPort?.postMessage({ written: false, retry: true });
      return;
    }
    sourceMtimeNs = sourceAfter.mtimeNs;
  } finally {
    closeSync(sourceHandle);
  }
  const source = JSON.parse(sourceText) as unknown;
  const projection = JSON.stringify(createLegacyDesktopProjection(source, sourceMtimeNs));
  const temporaryPath = `${input.targetPath}.legacy.${String(process.pid)}.${String(threadId)}`;
  mkdirSync(dirname(input.targetPath), { recursive: true });
  remove(temporaryPath);
  try {
    writeFileSync(temporaryPath, projection, { encoding: "utf8", mode: 0o600 });
    if (modifiedAt(input.targetPath) !== targetBefore) {
      parentPort?.postMessage({ written: false });
      return;
    }
    renameSync(temporaryPath, input.targetPath);
    const sourceCurrent = modifiedAt(input.sourcePath);
    parentPort?.postMessage({ written: true, retry: sourceCurrent !== undefined && sourceCurrent > sourceMtimeNs });
  } finally {
    remove(temporaryPath);
  }
}

try {
  run();
} catch (error) {
  parentPort?.postMessage({
    written: false,
    retry: true,
    error: error instanceof Error ? error.message : String(error),
  });
}
