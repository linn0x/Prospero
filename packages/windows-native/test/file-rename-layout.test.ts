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
const sourcePath = join(packageRoot, "native", "test", "file_rename_layout_test.cc");

describe("FILE_RENAME_INFORMATION allocation layout", () => {
  it.skipIf(process.platform === "win32")(
    "regresses the Windows x64/arm64 SDK-size rule with portable strict C++",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "prospero-file-rename-layout-"));
      const executablePath = join(directory, "file-rename-layout-test");
      const compiler = process.env.CXX ?? "c++";
      try {
        const compiled = await execFileAsync(compiler, [
          "-std=c++17",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-Wpedantic",
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
