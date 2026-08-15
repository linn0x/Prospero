import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type CompilerSettings = {
  ExceptionHandling?: unknown;
  WarningLevel?: unknown;
  WarnAsError?: unknown;
  AdditionalOptions?: unknown;
};

type WindowsCondition = [condition: string, settings: {
  msvs_settings?: { VCCLCompilerTool?: CompilerSettings };
}];

type BindingTarget = {
  target_name?: unknown;
  sources?: unknown;
  conditions?: unknown;
};

type BindingGyp = { targets?: unknown };

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bindingGypPath = join(packageRoot, "binding.gyp");

function windowsCompilerSettings(binding: BindingGyp): CompilerSettings {
  expect(Array.isArray(binding.targets)).toBe(true);
  const target = (binding.targets as BindingTarget[]).find(
    (candidate) => candidate.target_name === "prospero_windows_native",
  );

  expect(target?.sources).toContain("native/src/addon.cc");
  expect(Array.isArray(target?.conditions)).toBe(true);
  const windowsCondition = (target?.conditions as WindowsCondition[]).find(
    ([condition]) => condition === "OS=='win'",
  );

  expect(windowsCondition).toBeDefined();
  return windowsCondition?.[1].msvs_settings?.VCCLCompilerTool ?? {};
}

describe("Windows native MSVC configuration", () => {
  it("emits /EHsc for the real addon target without weakening /W4 or /WX", async () => {
    const binding = JSON.parse(await readFile(bindingGypPath, "utf8")) as BindingGyp;
    const compiler = windowsCompilerSettings(binding);
    const additionalOptions = compiler.AdditionalOptions;

    // node-gyp's VCCLCompilerTool ExceptionHandling=1 maps to MSVC /EHsc.
    expect(compiler.ExceptionHandling).toBe(1);
    expect(compiler.WarningLevel).toBe(4);
    expect(compiler.WarnAsError).toBe("true");
    expect(additionalOptions).toEqual(expect.arrayContaining(["/WX"]));
    expect(additionalOptions).not.toEqual(expect.arrayContaining(["/WX-", "/W0", "/W1", "/W2", "/W3"]));
  });
});
