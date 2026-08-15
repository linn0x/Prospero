import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const includeDirectory = join(packageRoot, "native", "include");
const sourcePath = join(packageRoot, "native", "test", "cancellable_operation_state_test.cc");

describe("cancellable overlapped-operation state", () => {
  it.skipIf(process.platform === "win32")(
    "models the cancel-before-issue race with portable strict C++",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "prospero-cancellable-operation-state-"));
      const executablePath = join(directory, "cancellable-operation-state-test");
      const compiler = process.env.CXX ?? "c++";
      try {
        const compiled = await execFileAsync(compiler, [
          "-std=c++17",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-Wpedantic",
          "-pthread",
          "-I",
          includeDirectory,
          sourcePath,
          "-o",
          executablePath,
        ], { cwd: packageRoot });
        expect(compiled.stdout).toBe("");
        expect(compiled.stderr).toBe("");

        const result = await execFileAsync(executablePath, [], { cwd: packageRoot });
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
