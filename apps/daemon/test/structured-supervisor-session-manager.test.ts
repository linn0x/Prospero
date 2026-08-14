import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AdapterContext } from "../src/adapters/types.js";
import { SessionManager } from "../src/session-manager.js";
import {
  RemoteStructuredSession,
  type LaunchStructuredSupervisorInput,
  type StructuredSupervisorManifest,
} from "../src/structured-supervisor-client.js";
import { StructuredSession } from "../src/structured-session.js";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  startStructuredSupervisor,
  type StructuredSupervisor,
} from "../src/structured-supervisor.js";

const homes: string[] = [];
const supervisors: StructuredSupervisor[] = [];
const counters = new Map<string, { disposed: number; killed: number }>();

function home(): string {
  // Keep a deliberately short Unix path; macOS rejects socket names beyond
  // sun_path even though the production runner handles that via chdir.
  const value = mkdtempSync("/tmp/p-sm-");
  homes.push(value);
  return value;
}

function privateJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function eventually(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function fakeLauncher(input: LaunchStructuredSupervisorInput): Promise<RemoteStructuredSession> {
  const dir = path.join(input.root, input.sessionId);
  const token = "t".repeat(48);
  // SessionManager has already generated this parent in production; the fake
  // launcher creates it too so this test only substitutes native adapters.
  mkdirSync(input.root, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(path.join(dir, "token"), `${token}\n`, { mode: 0o600 });
  chmodSync(path.join(dir, "token"), 0o600);

  const count = { disposed: 0, killed: 0 };
  counters.set(input.sessionId, count);
  let context: AdapterContext | null = null;
  const native: AgentAdapter = {
    async start(ctx) { context = ctx; },
    async send(text) {
      context?.recordOutput?.("tool-1", `full:${text}`);
      context?.emit({ kind: "text.delta", msgId: "fake", textId: "fake", delta: `echo:${text}` });
      if (text === "error") {
        context?.emit({ kind: "agent.error", message: "recoverable fake error" });
        return;
      }
      if (text === "ask") {
        context?.emit({ kind: "permission.request", reqId: "permit-1", action: "test", resources: ["fixture"], summary: "need approval" });
        return;
      }
      if (text === "pending-both") {
        context?.emit({ kind: "permission.request", reqId: "permit-2", action: "test", resources: ["fixture"], summary: "need approval" });
        context?.emit({ kind: "question.request", reqId: "question-2", questions: [{ id: "q", question: "continue?" }] });
        context?.emit({ kind: "turn.end", msgId: "fake", inputTokens: 1, outputTokens: 1 });
        return;
      }
      context?.emit({ kind: "turn.end", msgId: "fake", inputTokens: 1, outputTokens: 1 });
    },
    async respondPermission(reqId, reply) {
      context?.emit({ kind: "permission.resolved", reqId, reply });
      context?.emit({ kind: "turn.end", msgId: "fake", inputTokens: 1, outputTokens: 1 });
    },
    async respondQuestion(reqId, answers, cancelled) {
      context?.emit({ kind: "question.resolved", reqId, answers, ...(cancelled ? { cancelled } : {}) });
      context?.emit({ kind: "turn.end", msgId: "fake", inputTokens: 1, outputTokens: 1 });
    },
    async interrupt() {},
    async dispose() { count.disposed++; context = null; },
  };
  const session = new StructuredSession({
    id: input.sessionId, agent: input.agent, title: input.title, cwd: input.cwd,
    adapter: native, environment: input.environment, attachmentRoot: path.join(dir, "attachments"),
  });
  const persist = () => privateJson(path.join(dir, "session.json"), session.persistentState());
  session.on("persist", persist);
  session.on("state", persist);

  let supervisor: StructuredSupervisor;
  const socket = path.join(dir, "s.sock");
  supervisor = await startStructuredSupervisor({
    home: dir, socketPath: socket, tokenPath: path.join(dir, "token"), token,
  });
  supervisors.push(supervisor);
  await supervisor.createSession(input.sessionId, {
    async start(ctx) { session.on("event", (body) => ctx.emit(body)); await session.start(); persist(); },
    interrupt: () => session.interrupt(),
    async kill() {
      count.killed++;
      await session.dispose();
      persist();
      setTimeout(() => { void supervisor.close(); }, 20).unref();
    },
    async call(method, raw) {
      const params = raw as Record<string, unknown>;
      switch (method) {
        case "info": return session.info();
        case "snapshot": return session.snapshot();
        case "send": await session.send(String(params["text"] ?? "")); return { info: session.info() };
        case "respondPermission": await session.respondPermission(String(params["reqId"]), params["reply"] as "once"); return { info: session.info() };
        case "respondQuestion": await session.respondQuestion(String(params["reqId"]), [], params["cancelled"] === true); return { info: session.info() };
        case "usage": return session.usage();
        default: throw new Error(`fake does not support ${method}`);
      }
    },
  });
  const manifest: StructuredSupervisorManifest = {
    version: 1, protocolVersion: SUPERVISOR_PROTOCOL_VERSION, implementation: "supervisor",
    sessionId: input.sessionId, agent: input.agent, title: input.title, cwd: input.cwd,
    createdAt: input.createdAt, approvalPolicy: input.approvalPolicy ?? "standard",
    socket, tokenFile: "token", supervisorPid: process.pid,
    lifecycleEpoch: `fake-${input.sessionId}`,
  };
  privateJson(path.join(dir, "manifest.json"), manifest);
  return RemoteStructuredSession.attach(manifest);
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.close().catch(() => {});
  counters.clear();
  for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("SessionManager structured supervisor facade", () => {
  it("creates, reconnects after daemon client disposal, serves cached tool output, and only kill terminates the owner", async () => {
    const value = home();
    const first = new SessionManager({ home: value, supervisorLauncher: fakeLauncher });
    const info = await first.create({ agent: "codex", cwd: value, cols: 80, rows: 24, allowShell: false });
    expect(first.getStructured(info.id)).toBeInstanceOf(RemoteStructuredSession);
    await expect(first.requireStructured(info.id).models()).rejects.toThrow("supervisor 请求失败");
    // A normal control/RPC rejection must not permanently brick the transport.
    await first.chatSend(info.id, "error");
    expect(first.infoOf(info.id).status).toBe("completed");
    // agent.error ends only the failed turn; this remains a usable worker.
    await first.chatSend(info.id, "pending-both");
    expect(first.infoOf(info.id)).toEqual(expect.objectContaining({
      status: "waiting_approval", pendingPermissions: 1, pendingQuestions: 1,
    }));
    await first.requireStructured(info.id).respondPermission("permit-2", "once");
    await eventually(() => {
      const current = first.infoOf(info.id);
      return current.status === "waiting_input" && current.pendingPermissions === 0 && current.pendingQuestions === 1;
    }, "permission resolution while question remains pending");
    await first.requireStructured(info.id).respondQuestion("question-2", []);
    await eventually(() => {
      const current = first.infoOf(info.id);
      return current.status === "completed" && current.pendingPermissions === 0 && current.pendingQuestions === 0;
    }, "question resolution after turn end");
    await first.chatSend(info.id, "hello");
    expect(first.requireStructured(info.id).toolOutput("tool-1")).toEqual({ output: "full:hello", truncated: false });
    await eventually(() => {
      const current = first.infoOf(info.id);
      return current.preview?.includes("echo:hello") === true && (current.totals?.outputTokens ?? 0) >= 1;
    }, "runner preview and turn totals refresh");

    await first.disposeAll();
    expect(counters.get(info.id)?.disposed).toBe(0);

    const second = new SessionManager({ home: value, supervisorLauncher: fakeLauncher });
    const restored = await second.restoreStructured();
    expect(restored).toEqual([expect.objectContaining({ id: info.id })]);
    await second.chatSend(info.id, "ask");
    await second.requireStructured(info.id).respondPermission("permit-1", "once");
    await second.kill(info.id);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(counters.get(info.id)).toEqual({ disposed: 1, killed: 1 });
    // The explicit kill closes the fake supervisor endpoint; disposeAll above
    // intentionally did not. This guards test/daemon teardown leaks.
    expect(existsSync(path.join(value, "structured-supervisor", info.id, "s.sock"))).toBe(false);
    await second.disposeAll();
  });

  it("keeps a dead/stale supervisor visible as read-only history instead of starting a duplicate turn", async () => {
    const value = home();
    const first = new SessionManager({ home: value, supervisorLauncher: fakeLauncher });
    const info = await first.create({ agent: "codex", cwd: value, cols: 80, rows: 24, allowShell: false });
    await first.chatSend(info.id, "history");
    await first.disposeAll();
    const supervisor = supervisors[0];
    await supervisor?.close();

    const recovered = new SessionManager({ home: value, supervisorLauncher: fakeLauncher });
    const sessions = await recovered.restoreStructured();
    expect(sessions).toEqual([expect.objectContaining({ id: info.id, status: "died" })]);
    expect(recovered.requireStructured(info.id).toolOutput("tool-1")).toEqual({ output: "full:history", truncated: false });
    await expect(recovered.chatSend(info.id, "must not restart")).rejects.toThrow(/disconnected|unavailable/i);
    expect(counters.get(info.id)?.disposed).toBe(0);
    await recovered.disposeAll();
  });

  it("marks a live socket with a stale capability token read-only without touching its native adapter", async () => {
    const value = home();
    const first = new SessionManager({ home: value, supervisorLauncher: fakeLauncher });
    const info = await first.create({ agent: "codex", cwd: value, cols: 80, rows: 24, allowShell: false });
    await first.disposeAll();
    const token = path.join(value, "structured-supervisor", info.id, "token");
    writeFileSync(token, "bad-token\n", { mode: 0o600 });
    chmodSync(token, 0o600);

    const recovered = new SessionManager({ home: value, supervisorLauncher: fakeLauncher });
    const sessions = await recovered.restoreStructured();
    expect(sessions).toEqual([expect.objectContaining({ id: info.id, status: "died" })]);
    expect(counters.get(info.id)).toEqual({ disposed: 0, killed: 0 });
    await recovered.disposeAll();
  });
});
