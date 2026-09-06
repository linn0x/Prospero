import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { runMemoryCase } from "../../../tools/base64-memory-regression.mjs";

it.skipIf(process.platform === "win32")("round trips 4 MiB within a 128 MiB child heap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prospero-b64-heap-"));
  try {
    // Compile the current source into an isolated fixture: this regression must
    // not accidentally pass against stale dist files or load TypeScript in the
    // memory-constrained child. No implementation is copied into the test.
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    for (const name of ["b64", "errors"]) {
      const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      });
      await writeFile(join(directory, `${name}.js`), outputText);
    }
    const result = runMemoryCase({
      mode: "base64",
      moduleUrl: pathToFileURL(join(directory, "b64.js")).href,
      sizeMiB: 4,
      heapMiB: 128,
    });
    // RSS and timings vary by Node/platform. Correct completion under the heap
    // budget is the behavioral assertion; OOM is confined to the child.
    expect(result, JSON.stringify(result)).toMatchObject({
      exitCode: 0, signal: null, oom: false,
      metrics: { roundtrip: "passed", encodedLength: 5_592_408 },
    });
    expect(result).not.toHaveProperty("processError");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 35_000);
