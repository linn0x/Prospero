import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { AdapterContext } from "../src/adapters/types.js";

// Opt-in real installed CLI smoke. It never reads the user's CODEX_HOME/auth,
// sends a turn, calls a model, or changes the user's Codex installation.
it.skipIf(process.platform !== "win32" || process.env["PROSPERO_CODEX_STARTUP_SMOKE"] !== "1")(
  "starts the installed native Windows Codex, reads models, starts/resumes a thread, and closes each child",
  async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "prospero codex startup "));
    const children: ChildProcess[] = [];
    const adapters: CodexAdapter[] = [];
    const context: AdapterContext = {
      cwd,
      env: { CODEX_HOME: cwd },
      emit: () => {},
      registerProviderProcess: async proc => { children.push(proc); },
    };
    try {
      const catalog = new CodexAdapter();
      adapters.push(catalog);
      await catalog.start({ ...context, catalogOnly: true });
      expect((await catalog.listModels()).models.length).toBeGreaterThan(0);
      await catalog.dispose();

      let state: Record<string, unknown> | undefined;
      const first = new CodexAdapter();
      adapters.push(first);
      await first.start({ ...context, persistState: value => { state = value; } });
      expect(state?.["threadId"]).toBeTypeOf("string");
      await first.dispose();

      const resumed = new CodexAdapter({ resumeState: state });
      adapters.push(resumed);
      await resumed.start(context);
      await resumed.dispose();

      expect(children).toHaveLength(3);
      for (const proc of children) {
        expect(proc.spawnfile).toMatch(/codex\.exe$/i);
        expect({ exitCode: proc.exitCode, signal: proc.signalCode }).toEqual({ exitCode: 0, signal: null });
      }
    } finally {
      for (const adapter of adapters) await adapter.dispose();
      // cwd comes directly from mkdtemp in the OS temp directory.
      // Windows can briefly retain native handles after the exit notification.
      await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
);
