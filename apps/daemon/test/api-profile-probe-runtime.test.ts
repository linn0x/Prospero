import { existsSync, readdirSync } from "node:fs";
import type { ExecFileOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountBinding } from "../src/agent-accounts.js";
import { probeApiProfile } from "../src/api-profile-probe.js";
import { programCommandFor } from "../src/agents.js";

const runtime = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: (...args: unknown[]) => runtime.run(...args) }));
afterEach(() => { vi.unstubAllEnvs(); runtime.run.mockReset(); });

const binding: AccountBinding = {
  id: "synthetic", agent: "codex", name: "Synthetic", managed: true,
  apiProfile: { provider: "openai_compatible", protocol: "openai_responses", baseUrl: "http://127.0.0.1:1/v1", model: "synthetic-model" },
  environment: { OPENAI_API_KEY: "synthetic-key", CODEX_HOME: "/do-not-read-account-settings" },
};

describe("API Profile CLI runtime isolation", () => {
  it("runs only --version in an empty temporary workspace without credentials or global settings, then cleans up", async () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-global-key");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "synthetic-global-token");
    vi.stubEnv("NODE_OPTIONS", "--synthetic-disallowed-node-option");
    vi.stubEnv("OPENCODE_CONFIG", "/do-not-read-global-settings");
    let probeRoot = "";
    runtime.run.mockImplementation((file: string, args: string[], options: ExecFileOptions, callback: (error: Error | null) => void) => {
      const command = programCommandFor("codex", ["--version"]);
      expect(file).toBe(command.file);
      expect(args).toEqual(command.args);
      expect(readdirSync(String(options.cwd))).toEqual([]);
      const env = options.env!;
      probeRoot = env["HOME"]!;
      expect(probeRoot).not.toBe(process.env["HOME"]);
      expect(String(options.cwd)).toContain(probeRoot);
      expect(env["CODEX_HOME"]).toContain(probeRoot);
      expect(env["CLAUDE_CONFIG_DIR"]).toContain(probeRoot);
      expect(readdirSync(env["CODEX_HOME"]!)).toEqual([]);
      for (const name of ["OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "NODE_OPTIONS", "OPENCODE_CONFIG"]) expect(env[name]).toBeUndefined();
      expect(options.timeout).toBe(5000);
      expect(options.killSignal).toBe("SIGKILL");
      callback(null);
    });
    const fetch = vi.fn(async () => { throw new Error("synthetic network failure"); });
    expect(await probeApiProfile(binding, { fetch })).toMatchObject({ status: "failed", checks: { runtime: "passed", streaming: "failed" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(existsSync(probeRoot)).toBe(false);
  });

  it("cleans up runtime failure without sending upstream credentials", async () => {
    let probeRoot = "";
    runtime.run.mockImplementation((_file: string, _args: string[], options: ExecFileOptions, callback: (error: Error | null) => void) => {
      probeRoot = options.env!["HOME"]!;
      callback(new Error("SECRET process stderr"));
    });
    const fetch = vi.fn();
    const result = await probeApiProfile(binding, { fetch });
    expect(result).toMatchObject({ code: "runtime_unavailable", checks: { runtime: "failed", streaming: "not_tested", tools: "not_tested" } });
    expect(result.detail).not.toContain("SECRET");
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(probeRoot)).toBe(false);
  });

  it("aborts runtime startup at the total deadline and cleans its isolated directory", async () => {
    let probeRoot = "";
    runtime.run.mockImplementation((_file: string, _args: string[], options: ExecFileOptions, callback: (error: Error | null) => void) => {
      probeRoot = options.env!["HOME"]!;
      options.signal!.addEventListener("abort", () => callback(new Error("cancelled")), { once: true });
    });
    const fetch = vi.fn();
    expect(await probeApiProfile(binding, { fetch, timeoutMs: 40 })).toMatchObject({ code: "timeout" });
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(probeRoot)).toBe(false);
  });
});
