import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeApiProfileEngine } from "../src/api-profile-engine-probe.js";
import { engineUpstream } from "./api-profile-engine-fixtures.js";

function installed(engine: string): string | undefined {
  for (const directory of (process.env["PATH"] ?? "").split(path.delimiter)) {
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd"] : [""]) {
      const candidate = path.join(directory, engine + suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const fixtures: Awaited<ReturnType<typeof engineUpstream>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

describe("Actual installed engines with synthetic local upstreams", () => {
  for (const [engine, protocol] of [["codex", "openai_responses"], ["claude", "anthropic"], ["opencode", "openai_chat_completions"]] as const) {
    const executable = installed(engine);
    it.skipIf(!executable)(`${engine} loads isolated configuration and executes exactly one real native tool roundtrip`, async () => {
      const fixture = await engineUpstream(protocol); fixtures.push(fixture);
      const result = await probeApiProfileEngine(fixture.binding, { executable, timeoutMs: 15000 });
      expect(result).toMatchObject({ status: "passed", engine, checks: { runtime: "passed", configuration: "passed", streaming: "passed", tools: "passed" } });
      expect(result.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(fixture.requests).toHaveLength(2);
      expect(JSON.stringify(fixture.requests[0])).not.toContain("synthetic-engine-upstream-key");
      expect(JSON.stringify(fixture.requests[1])).toContain("prospero-engine-ok-");
      for (const request of fixture.requests) {
        expect(request.model).toBe("synthetic-model");
        expect(request[protocol === "openai_responses" ? "max_output_tokens" : "max_tokens"]).toBeLessThanOrEqual(512);
        if (engine === "codex") { expect(request.reasoning?.summary).toBeUndefined(); expect(request.reasoning?.effort).toBeUndefined(); }
      }
    }, 20000);
  }
});
