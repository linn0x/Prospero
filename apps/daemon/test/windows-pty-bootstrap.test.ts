import { describe, expect, it } from "vitest";
import { parseWindowsPtyProviderBootstrap } from "../src/windows-pty-host.js";

const bootstrap = {
  schemaVersion: 1,
  implementation: "windows-pty-provider",
  id: "windows-bootstrap-test",
  agent: "custom",
  title: "Bootstrap test",
  cwd: "C:\\work",
  createdAt: 1,
  cols: 80,
  rows: 24,
  executablePath: "C:\\Program Files\\nodejs\\node.exe",
  arguments: ["-e", "process.stdout.write('ok')"],
  environment: { SystemRoot: "C:\\Windows", API_TOKEN: "secret" },
} as const;

describe("Windows PTY provider bootstrap", () => {
  it("accepts only the exact one-shot schema with Windows absolute paths", () => {
    expect(parseWindowsPtyProviderBootstrap(bootstrap, bootstrap.id)).toEqual(bootstrap);
    expect(() => parseWindowsPtyProviderBootstrap({ ...bootstrap, extra: true }, bootstrap.id)).toThrow(/schema/i);
    expect(() => parseWindowsPtyProviderBootstrap({ ...bootstrap, cwd: ".\\work" }, bootstrap.id)).toThrow(/schema/i);
    expect(() => parseWindowsPtyProviderBootstrap({ ...bootstrap, executablePath: "node.exe" }, bootstrap.id)).toThrow(/schema/i);
  });

  it("fails closed for non-string or unsafe environment values", () => {
    expect(() => parseWindowsPtyProviderBootstrap({ ...bootstrap, environment: { API_TOKEN: 1 } }, bootstrap.id)).toThrow(/schema/i);
    expect(() => parseWindowsPtyProviderBootstrap({ ...bootstrap, environment: { "BAD=KEY": "value" } }, bootstrap.id)).toThrow(/schema/i);
    expect(() => parseWindowsPtyProviderBootstrap({ ...bootstrap, environment: { API_TOKEN: "secret\0suffix" } }, bootstrap.id)).toThrow(/schema/i);
  });
});
