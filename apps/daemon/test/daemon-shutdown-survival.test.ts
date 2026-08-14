/**
 * Isolated process probes, not experiments on an existing user daemon/session.
 * Each case uses a fresh temporary home + git repo and a fake/echo agent.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killSession, tmuxPath } from "../src/tmux.js";

const temporary: string[] = [];
const children: ChildProcess[] = [];
const sessions: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ProbeReady {
  ready: true;
  sessionId: string;
}

async function runProbe(mode: "pty" | "structured", signal: NodeJS.Signals): Promise<boolean> {
  const home = temp("prospero-shutdown-home-");
  const repo = temp("prospero-shutdown-repo-");
  const marker = path.join(home, `${mode}-${signal}.marker`);
  execFileSync("git", ["init", "--quiet", repo]);
  const fixture = path.join(import.meta.dirname, "fixtures", "daemon-shutdown-probe.mjs");
  const child = spawn(process.execPath, [fixture, mode, marker], {
    env: { ...process.env, PROSPERO_TEST_HOME: home, PROSPERO_TEST_REPO: repo },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const deadline = Date.now() + 5_000;
  while (!stdout.includes("\n") && child.exitCode === null && Date.now() < deadline) await delay(10);
  if (!stdout.includes("\n")) throw new Error(`probe did not become ready: ${stderr}`);
  const ready = JSON.parse(stdout.slice(0, stdout.indexOf("\n"))) as ProbeReady;
  sessions.push(ready.sessionId);
  child.kill(signal);
  await Promise.race([once(child, "exit"), delay(2_000)]);
  await delay(500);
  return existsSync(marker);
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([once(child, "exit"), delay(1_000)]);
    }
  }
  for (const id of sessions.splice(0)) killSession(id);
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const describeIfTmux = tmuxPath() ? describe : describe.skip;

describeIfTmux("daemon shutdown survival probe", () => {
  it("records graceful SIGTERM: tmux PTY continues, daemon-owned structured stdio is disposed", async () => {
    await expect(runProbe("pty", "SIGTERM")).resolves.toBe(true);
    await expect(runProbe("structured", "SIGTERM")).resolves.toBe(false);
  });

  it("records SIGKILL: tmux PTY continues, fake stdio agent loses its owner transport", async () => {
    await expect(runProbe("pty", "SIGKILL")).resolves.toBe(true);
    await expect(runProbe("structured", "SIGKILL")).resolves.toBe(false);
  });
});
