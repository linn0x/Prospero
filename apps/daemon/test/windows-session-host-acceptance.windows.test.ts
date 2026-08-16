/**
 * Real Windows acceptance, deliberately kept separate from mock transport
 * tests.  It runs only after CI has built and Authenticode-verified the
 * x64/arm64 addon: every Session Host/native operation below goes through the
 * production loader and the actual named-pipe, DPAPI, Job Object, ConPTY and
 * PID+FILETIME boundaries.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessIdentity } from "@prospero/windows-native";
import { attachWindowsSessionHost } from "../src/windows-session-host-client.js";
import { WindowsSessionHostNativeWorker } from "../src/windows-session-host-native.js";
import { launchDetachedWindowsSessionHost } from "../src/windows-session-host-runner.js";
import { launchWindowsPtySession, reconnectWindowsPtySessions } from "../src/windows-pty-session.js";

const describeWindows = process.platform === "win32" && process.env["PROSPERO_WINDOWS_SIGNED_SESSION_HOST_TEST"] === "1"
  ? describe
  : describe.skip;

const temporary: string[] = [];
const daemonChildren: ChildProcess[] = [];

interface AcceptanceLayout {
  readonly root: string;
  readonly home: string;
  readonly localAppData: string;
  readonly repo: string;
}

interface FakeAgentResult {
  readonly providerPid: number;
  readonly grandchildPid: number;
  readonly pendingPermission: string;
  readonly pendingQuestion: string;
  readonly environment: { readonly home: string; readonly localAppData: string; readonly repo: string };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function layout(): AcceptanceLayout {
  const root = mkdtempSync(path.join(os.tmpdir(), "prospero-windows-session-host-acceptance-"));
  temporary.push(root);
  const home = path.join(root, "home");
  const localAppData = path.join(root, "local-app-data");
  const repo = path.join(root, "repo");
  mkdirSync(home);
  mkdirSync(localAppData);
  // git init is an intentional part of the harness: a real daemon always
  // receives a repository and never a process-global developer directory.
  execFileSync("git", ["init", "--quiet", repo]);
  return { root, home, localAppData, repo };
}

function testEnvironment(value: AcceptanceLayout): Record<string, string> {
  return {
    HOME: value.home,
    LOCALAPPDATA: value.localAppData,
    PROSPERO_TEST_REPO: value.repo,
  };
}

function processEnvironment(extra: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    ...extra,
  };
}

async function waitFor<T>(label: string, check: () => Promise<T | null> | T | null, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(40);
  }
  throw new Error(`${label} did not become ready${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function waitForIdentity(native: WindowsSessionHostNativeWorker, identity: ProcessIdentity, alive: boolean): Promise<void> {
  await waitFor(alive ? `PID ${identity.pid} alive` : `PID ${identity.pid} exit`, async () => {
    try { return (await native.matchesIdentity(identity)) === alive ? true : null; }
    catch { return alive ? null : true; }
  });
}

async function firstJsonLine(child: ChildProcess): Promise<Record<string, unknown>> {
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  let stderr = "";
  child.stdout?.on("data", (chunk: string) => { output += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  return waitFor("daemon probe", () => {
    const newline = output.indexOf("\n");
    if (newline < 0) {
      if (child.exitCode !== null) throw new Error(`daemon probe exited before ready: ${stderr}`);
      return null;
    }
    const parsed: unknown = JSON.parse(output.slice(0, newline));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("daemon probe emitted an invalid JSON envelope");
    return parsed as Record<string, unknown>;
  });
}

async function startDaemonProbe(
  manifest: unknown,
  value: AcceptanceLayout,
  operation: "send" | "observe",
  exitMode: "graceful" | "hold",
): Promise<{ readonly child: ChildProcess; readonly ready: Record<string, unknown> }> {
  const fixture = fileURLToPath(new URL("./fixtures/windows-session-host-daemon-client.mjs", import.meta.url));
  const clientModule = pathToFileURL(fileURLToPath(new URL("../dist/windows-session-host-client.js", import.meta.url))).href;
  const child = spawn(process.execPath, [fixture], {
    env: processEnvironment({
      ...testEnvironment(value),
      PROSPERO_SESSION_HOST_CLIENT_MODULE: clientModule,
      PROSPERO_SESSION_HOST_MANIFEST: JSON.stringify(manifest),
      PROSPERO_SESSION_HOST_DAEMON_OPERATION: operation,
      PROSPERO_SESSION_HOST_DAEMON_EXIT_MODE: exitMode,
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  daemonChildren.push(child);
  return { child, ready: await firstJsonLine(child) };
}

function resultFromProbe(value: Record<string, unknown>): FakeAgentResult {
  const result = value.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("daemon probe has no fake-agent result");
  const fake = result as Partial<FakeAgentResult>;
  if (!Number.isSafeInteger(fake.providerPid) || !Number.isSafeInteger(fake.grandchildPid) ||
    typeof fake.pendingPermission !== "string" || typeof fake.pendingQuestion !== "string" ||
    !fake.environment || typeof fake.environment.home !== "string" || typeof fake.environment.localAppData !== "string" ||
    typeof fake.environment.repo !== "string") {
    throw new Error("daemon probe fake-agent result is invalid");
  }
  return fake as FakeAgentResult;
}

async function forceStopHost(native: WindowsSessionHostNativeWorker, identity: ProcessIdentity | undefined): Promise<void> {
  if (!identity) return;
  await native.terminateIdentityAndWait(identity).catch(() => false);
}

afterEach(async () => {
  for (const child of daemonChildren.splice(0)) {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, "exit"), delay(1_000)]);
    }
  }
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describeWindows.sequential("Windows daemon force-kill and Session Host full-process acceptance", () => {
  it("keeps the same structured host/agent after graceful and exact daemon termination, replays contiguous output, preserves offline interactions, and explicitly Job-kills its tree", async () => {
    const value = layout();
    const native = await WindowsSessionHostNativeWorker.create();
    let hostIdentity: ProcessIdentity | undefined;
    try {
      const sessionId = `accept-structured-${randomUUID()}`;
      const manifest = await launchDetachedWindowsSessionHost({
        sessionId,
        epoch: `accept-structured-${randomUUID()}`,
        pipeName: `\\\\.\\pipe\\prospero.acceptance.${randomUUID()}`,
        stateDirectory: path.join(value.localAppData, sessionId),
        handlerModule: pathToFileURL(fileURLToPath(new URL("./fixtures/windows-structured-fake-adapter-host.mjs", import.meta.url))).href,
        // The short lease makes daemon crash hand-off deterministic without
        // weakening production's longer default.
        leaseDurationMs: 1_000,
        handlerOptions: { agentEnvironment: testEnvironment(value) },
      });
      hostIdentity = manifest.owner;

      const graceful = await startDaemonProbe(manifest, value, "send", "graceful");
      const fake = resultFromProbe(graceful.ready);
      await once(graceful.child, "exit");
      expect(graceful.child.exitCode).toBe(0);
      expect(fake.environment).toEqual({
        home: value.home,
        localAppData: value.localAppData,
        repo: value.repo,
      });

      // Let the first daemon's short mutation lease lapse before handing the
      // pipe to another daemon identity. The host is intentionally not using
      // socket close as a mutation-lease revocation signal.
      await delay(1_100);

      const providerIdentity = await native.processIdentity(fake.providerPid);
      const grandchildIdentity = await native.processIdentity(fake.grandchildPid);
      await waitForIdentity(native, manifest.owner, true);
      await waitForIdentity(native, providerIdentity, true);
      await waitForIdentity(native, grandchildIdentity, true);

      // A second daemon only observes, then is killed by its exact native
      // identity. A host must treat this as a detach, never a provider kill.
      const forced = await startDaemonProbe(manifest, value, "observe", "hold");
      const daemonIdentity = await native.processIdentity(forced.child.pid!);
      expect(await native.terminateIdentityAndWait(daemonIdentity)).toBe(true);
      await Promise.race([once(forced.child, "exit"), delay(5_000)]);
      await delay(100);
      await waitForIdentity(native, manifest.owner, true);
      await waitForIdentity(native, providerIdentity, true);
      await waitForIdentity(native, grandchildIdentity, true);

      const reconnected = await attachWindowsSessionHost(manifest);
      try {
        const replay = await reconnected.replay(0);
        const seq = replay.events.map((event) => event.seq);
        expect(seq).toEqual(Array.from({ length: replay.lastSeq }, (_value, index) => index + 1));
        const bodies = replay.events
          .map((event) => event.payload)
          .filter((payload): payload is { type: string; body?: { kind?: string; reqId?: string } } =>
            !!payload && typeof payload === "object" && (payload as { type?: unknown }).type === "structured.event",
          )
          .map((payload) => payload.body);
        expect(bodies).toContainEqual(expect.objectContaining({ kind: "permission.request", reqId: fake.pendingPermission }));
        expect(bodies).toContainEqual(expect.objectContaining({ kind: "question.request", reqId: fake.pendingQuestion }));

        await reconnected.acquireMutationLease();
        await reconnected.command("structured.respondPermission", { reqId: fake.pendingPermission, reply: "once" }, true, "resolve-offline-approval");
        await reconnected.command("structured.respondQuestion", {
          reqId: fake.pendingQuestion,
          answers: [{ questionId: "continue", values: ["yes"] }],
        }, true, "resolve-offline-question");
        await reconnected.command("structured.kill", {}, true, "explicit-job-kill");
      } finally {
        await reconnected.dispose().catch(() => {});
      }
      await waitForIdentity(native, manifest.owner, false);
      await waitForIdentity(native, providerIdentity, false);
      await waitForIdentity(native, grandchildIdentity, false);
      hostIdentity = undefined;
    } finally {
      await forceStopHost(native, hostIdentity);
      await native.close();
    }
  });

  it("continues a real PTY across daemon detach with snapshot/input/resize and Job-kills its full tree", async () => {
    const value = layout();
    const native = await WindowsSessionHostNativeWorker.create();
    let hostIdentity: ProcessIdentity | undefined;
    try {
      const script = [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(`PTY_READY:${process.pid}:${child.pid}\\n`);",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (data) => process.stdout.write(`PTY_INPUT:${JSON.stringify(data)}\\n`));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const session = await launchWindowsPtySession({
        root: value.localAppData,
        id: `accept-pty-${randomUUID()}`,
        agent: "custom",
        title: "Session Host PTY acceptance",
        cwd: value.repo,
        createdAt: Date.now(),
        file: process.execPath,
        args: ["-e", script],
        cols: 80,
        rows: 24,
        env: processEnvironment(testEnvironment(value)),
      });
      hostIdentity = session.manifest.owner;
      const initial = await waitFor("PTY initial output", async () => {
        const replay = await session.subscribe(0);
        const text = replay.events.map((event) => Buffer.from(event.dataB64, "base64").toString()).join("");
        const match = text.match(/PTY_READY:(\d+):(\d+)/);
        return match ? { replay, providerPid: Number(match[1]), grandchildPid: Number(match[2]) } : null;
      });
      const providerIdentity = await native.processIdentity(initial.providerPid);
      const grandchildIdentity = await native.processIdentity(initial.grandchildPid);
      const beforeDetach = await session.snapshot();
      expect(beforeDetach.seq).toBeGreaterThan(0);

      // This is the graceful daemon path: facade transport is disposed while
      // the durable host, ConPTY and provider Job keep running.
      await session.dispose();
      await waitForIdentity(native, session.manifest.owner, true);
      await waitForIdentity(native, providerIdentity, true);

      const [reconnected] = await reconnectWindowsPtySessions(value.localAppData);
      expect(reconnected).toBeDefined();
      if (!reconnected) throw new Error("Windows PTY Session Host did not reconnect");
      try {
        await reconnected.resize(120, 40);
        await reconnected.writeInput("after-reconnect\r");
        const output = await waitFor("PTY post-reconnect output", async () => {
          const replay = await reconnected.subscribe(0);
          const text = replay.events.map((event) => Buffer.from(event.dataB64, "base64").toString()).join("");
          return text.includes("PTY_INPUT:\"after-reconnect\\\\r\\\\n\"") ? replay : null;
        });
        const outputSeq = output.events.map((event) => event.seq);
        expect(outputSeq).toEqual(Array.from({ length: output.lastSeq }, (_value, index) => index + 1));
        const afterReconnect = await reconnected.snapshot();
        expect(afterReconnect).toMatchObject({ cols: 120, rows: 40 });

        await reconnected.kill();
      } finally {
        await reconnected.dispose().catch(() => {});
      }
      await waitForIdentity(native, providerIdentity, false);
      await waitForIdentity(native, grandchildIdentity, false);
    } finally {
      await forceStopHost(native, hostIdentity);
      await native.close();
    }
  });

  it("closing the detached host process closes KILL_ON_JOB_CLOSE and cannot terminate a stale PID identity", async () => {
    const value = layout();
    const native = await WindowsSessionHostNativeWorker.create();
    let hostIdentity: ProcessIdentity | undefined;
    try {
      const sessionId = `accept-host-force-kill-${randomUUID()}`;
      const manifest = await launchDetachedWindowsSessionHost({
        sessionId,
        epoch: `accept-host-force-kill-${randomUUID()}`,
        pipeName: `\\\\.\\pipe\\prospero.acceptance.${randomUUID()}`,
        stateDirectory: path.join(value.localAppData, sessionId),
        handlerModule: pathToFileURL(fileURLToPath(new URL("./fixtures/windows-structured-fake-adapter-host.mjs", import.meta.url))).href,
        handlerOptions: { agentEnvironment: testEnvironment(value) },
      });
      hostIdentity = manifest.owner;
      const daemon = await startDaemonProbe(manifest, value, "send", "hold");
      const fake = resultFromProbe(daemon.ready);
      const providerIdentity = await native.processIdentity(fake.providerPid);
      const grandchildIdentity = await native.processIdentity(fake.grandchildPid);

      // A PID with a mismatched FILETIME is read-only evidence of stale/reused
      // state: terminateProcessIfIdentity returns false and the real host/tree
      // remain untouched.
      expect(await native.terminateIdentityAndWait({
        pid: manifest.owner.pid,
        creationTime100ns: manifest.owner.creationTime100ns === "1" ? "2" : "1",
      })).toBe(false);
      await waitForIdentity(native, manifest.owner, true);
      await waitForIdentity(native, providerIdentity, true);

      expect(await native.terminateIdentityAndWait(manifest.owner)).toBe(true);
      await waitForIdentity(native, manifest.owner, false);
      await waitForIdentity(native, providerIdentity, false);
      await waitForIdentity(native, grandchildIdentity, false);
      hostIdentity = undefined;
    } finally {
      await forceStopHost(native, hostIdentity);
      await native.close();
    }
  });
});
