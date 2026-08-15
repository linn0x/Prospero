import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_WINDOWS_ABI_VERSION } from "@prospero/windows-native";
import { terminateUnregisteredProviderProcess, type AdapterContext, type AgentAdapter } from "../src/adapters/types.js";
import {
  WindowsRemoteStructuredSession,
  readWindowsStructuredOfflineTerminalState,
} from "../src/windows-structured-session-client.js";
import { createWindowsStructuredSessionHostHandler } from "../src/windows-structured-session-host.js";
import { WindowsSessionHostClientError } from "../src/windows-session-host-client.js";
import {
  WindowsSessionHostJournal,
  parseWindowsSessionHostManifest,
  type SessionHostReplayReply,
  type WindowsSessionHostJournalEvent,
} from "../src/windows-session-host-protocol.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { GrokAdapter } from "../src/adapters/grok.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";

const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null) continue;
    child.kill();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
});

function event(seq: number, payload: unknown): WindowsSessionHostJournalEvent {
  return { schemaVersion: 2, sessionId: "structured-host-test", epoch: "structured-host-epoch-0001", seq, kind: "event", payload };
}

function persistentState(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    version: 1 as const, id: "structured-host-test", agent: "codex" as const, title: "fake", cwd: process.cwd(),
    createdAt: 1, approvalPolicy: "standard" as const, events: [], evSeq: 0,
    preview: "", previewRaw: "", previewMsgId: "", totals: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
    toolOutputs: [["tool-1", "full durable output"]] as [string, string][], adapterState: { threadId: "thread-1" }, messageQueue: [],
    ...overrides,
  };
}

describe("Windows structured Session Host vertical", () => {
  it("keeps all four structured adapters durable through host-in-Job inheritance", () => {
    expect([
      new CodexAdapter().durableProviderJobCompatible,
      new ClaudeAdapter().durableProviderJobCompatible,
      new GrokAdapter().durableProviderJobCompatible,
      new OpencodeAdapter().durableProviderJobCompatible,
    ]).toEqual([true, true, true, true]);
  });

  it("keeps a fake provider callback pending while daemon-side transport is absent and resolves the original reqId only when commanded", async () => {
    let adapterContext: AdapterContext | null = null;
    let resolved: { reqId: string; reply: string } | null = null;
    let answered: { reqId: string; answer: string } | null = null;
    const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    children.push(provider);
    const adapter: AgentAdapter = {
      durableProviderJobCompatible: true,
      async start(context) { adapterContext = context; },
      async send() {
        await adapterContext?.registerProviderProcess?.(provider);
        // Model a native callback which remains unresolved while no daemon is
        // connected. The adapter does not choose a default allow/reject.
        adapterContext?.emit({
          kind: "permission.request", reqId: "approval-original", action: "fake", resources: ["fixture"], summary: "await phone",
        });
        adapterContext?.emit({
          kind: "question.request", reqId: "question-original", questions: [{ id: "q", question: "continue?" }],
        });
      },
      async respondPermission(reqId, reply) {
        resolved = { reqId, reply };
        adapterContext?.emit({ kind: "permission.resolved", reqId, reply });
      },
      async respondQuestion(reqId, answers) {
        answered = { reqId, answer: String(answers[0]?.values[0] ?? "") };
        adapterContext?.emit({ kind: "question.resolved", reqId, answers });
      },
      async interrupt() {},
      async dispose() { shutdown.push("adapter.dispose"); },
    };
    const journal: unknown[] = [];
    let registered = 0;
    let terminated = 0;
    let closed = 0;
    const shutdown: string[] = [];
    let sequence = 0;
    const handler = await createWindowsStructuredSessionHostHandler({
      sessionId: "structured-host-test",
      epoch: "structured-host-epoch-0001",
      stateDirectory: "C:\\fake-state",
      handlerOptions: {
        version: 1, agent: "codex", title: "fake", cwd: process.cwd(), createdAt: 1, environment: {},
      },
      async appendEvent(payload) { return event(++sequence, payload); },
      async emit(payload) {
        journal.push(payload);
        return event(++sequence, payload);
      },
      async createProviderJob() {
        return {
          async registerProcess(process) { expect(process.pid).toBe(provider.pid); registered++; },
          get registeredProcessCount() { return registered; },
          async terminate() { terminated++; shutdown.push("job.terminate"); },
          async close() { closed++; shutdown.push("job.close"); },
        };
      },
    }, adapter);

    await handler.handleCommand({ commandId: "send-once", method: "structured.send", params: { text: "hello" } });
    expect(registered).toBe(1);
    expect(resolved).toBeNull();
    expect(journal).toContainEqual(expect.objectContaining({
      type: "structured.event",
      body: expect.objectContaining({ kind: "permission.request", reqId: "approval-original" }),
    }));
    expect(journal).toContainEqual(expect.objectContaining({
      type: "structured.event",
      body: expect.objectContaining({ kind: "question.request", reqId: "question-original" }),
    }));

    await handler.handleCommand({ commandId: "resolve-once", method: "structured.respondPermission", params: { reqId: "approval-original", reply: "once" } });
    expect(resolved).toEqual({ reqId: "approval-original", reply: "once" });
    await handler.handleCommand({ commandId: "answer-once", method: "structured.respondQuestion", params: {
      reqId: "question-original", answers: [{ questionId: "q", values: ["yes"] }],
    } });
    expect(answered).toEqual({ reqId: "question-original", answer: "yes" });
    const killed = await handler.handleCommand({ commandId: "kill-once", method: "structured.kill", params: {} });
    expect(killed).toMatchObject({ ok: true, terminal: true });
    expect(shutdown).toEqual(["adapter.dispose"]);
    await killed.afterReply?.();
    expect(terminated).toBe(1);
    expect(closed).toBe(1);
    expect(shutdown).toEqual(["adapter.dispose", "job.terminate", "job.close"]);
  });

  it("replays original event reqId/seq and retries a disconnected mutation with the same commandId", async () => {
    const host = parseWindowsSessionHostManifest({
      schemaVersion: 2, protocolVersion: 2, implementation: "windows-session-host", sessionId: "structured-host-test",
      epoch: "structured-host-epoch-0001", pipeName: "\\\\.\\pipe\\prospero-structured-host-test", stateDirectory: "C:\\state",
      aclProfile: "current-logon-token-v1", owner: { pid: 41001, creationTime100ns: "111111111111111" },
      nativeAbiVersion: NATIVE_WINDOWS_ABI_VERSION, credentialFile: "credential.dpapi", journalFile: "journal.psj2",
      snapshotFile: "snapshot.psj2.json", status: "active", createdAt: 1, updatedAt: 1,
    });
    const manifest = {
      schemaVersion: 1 as const, implementation: "windows-structured-session-host" as const, sessionId: host.sessionId,
      agent: "codex" as const, title: "fake", cwd: process.cwd(), createdAt: 1, approvalPolicy: "standard" as const,
      registryDirectory: "C:\\registry", host, status: "active" as const,
    };
    const commandIds: string[] = [];
    let attachment = 0;
    let leaseRequests = 0;
    const replay = (afterSeq: number): SessionHostReplayReply => ({
      version: 2, type: "replay", sessionId: host.sessionId, epoch: host.epoch, afterSeq, lastSeq: 1,
      gap: false, terminal: false, snapshot: null,
      events: afterSeq === 0 ? [event(1, {
        type: "structured.event", evSeq: 1,
        body: { kind: "permission.request", reqId: "approval-original", action: "fake", resources: ["fixture"], summary: "pending" },
      })] : [],
    });
    const attach = async () => {
      const attempt = attachment++;
      return {
        async acquireMutationLease() { leaseRequests++; return "lease"; },
        async replay(afterSeq = 0) { return replay(afterSeq); },
        async command(method: string, _params: unknown, _mutation: boolean, commandId = "") {
          if (method === "structured.persistentState") {
            return persistentState({
              events: [{ kind: "permission.request", reqId: "approval-original", action: "fake", resources: ["fixture"], summary: "pending" }],
              evSeq: 1,
            });
          }
          commandIds.push(commandId);
          if (attempt === 0) throw new WindowsSessionHostClientError("pipe lost");
          return { info: { id: host.sessionId } };
        },
        async dispose() {},
      };
    };
    const session = await WindowsRemoteStructuredSession.attach(manifest, attach);
    expect(session.snapshot().evSeq).toBe(1);
    expect(session.snapshot().events.at(-1)).toMatchObject({ kind: "permission.request", reqId: "approval-original" });
    expect(session.info().pendingPermissions).toBe(1);
    expect(leaseRequests).toBe(0); // attach/replay is read-only
    expect(session.toolOutput("tool-1")).toEqual({ output: "full durable output", truncated: false });
    expect(session.resumeState).toEqual({ threadId: "thread-1" });
    await session.send("retry safely");
    expect(leaseRequests).toBe(2); // the retry reconnects and obtains only mutation leases
    expect(commandIds).toHaveLength(2);
    expect(commandIds[0]).toBe(commandIds[1]);
    await session.dispose();
    expect(session.toolOutput("tool-1")).toEqual({ output: "full durable output", truncated: false });
  });

  it("persists a terminal failed-kill outcome and closes the host Job only after reply", async () => {
    const shutdown: string[] = [];
    const adapter: AgentAdapter = {
      durableProviderJobCompatible: true,
      async start() {}, async send() {}, async respondPermission() {}, async interrupt() {},
      async dispose() { shutdown.push("adapter.dispose"); throw new Error("dispose failed"); },
    };
    const handler = await createWindowsStructuredSessionHostHandler({
      sessionId: "structured-host-test", epoch: "structured-host-epoch-0001", stateDirectory: "C:\\fake-state",
      handlerOptions: { version: 1, agent: "codex", title: "fake", cwd: process.cwd(), createdAt: 1, environment: {} },
      async appendEvent(payload) { return event(1, payload); }, async emit(payload) { return event(1, payload); },
      async createProviderJob() {
        return {
          async registerProcess() {}, get registeredProcessCount() { return 1; },
          async terminate() { shutdown.push("job.terminate"); }, async close() { shutdown.push("job.close"); },
        };
      },
    }, adapter);
    const killed = await handler.handleCommand({ commandId: "kill-dispose-failure", method: "structured.kill", params: {} });
    expect(killed).toMatchObject({ ok: false, code: "kill_dispose_failed", terminal: true });
    expect(shutdown).toEqual(["adapter.dispose"]);
    await killed.afterReply?.();
    expect(shutdown).toEqual(["adapter.dispose", "job.terminate", "job.close"]);
  });

  it("bounds a failed provider registration, kills only the unregistered child, clears its adapter reference, and preserves the original error", async () => {
    let context: AdapterContext | null = null;
    let adapterChild: ChildProcess | null = null;
    const registrationError = new Error("AssignProcessToJobObject failed");
    const shutdown: string[] = [];
    const adapter: AgentAdapter = {
      durableProviderJobCompatible: true,
      async start(value) { context = value; },
      async send() {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
        adapterChild = child;
        try { await context?.registerProviderProcess?.(child); }
        catch (error) {
          adapterChild = null;
          await terminateUnregisteredProviderProcess(child);
          throw error;
        }
      },
      async respondPermission() {}, async interrupt() {}, async dispose() {},
    };
    const handler = await createWindowsStructuredSessionHostHandler({
      sessionId: "structured-host-test", epoch: "structured-host-epoch-0001", stateDirectory: "C:\\fake-state",
      handlerOptions: { version: 1, agent: "codex", title: "fake", cwd: process.cwd(), createdAt: 1, environment: {} },
      async appendEvent(payload) { return event(1, payload); }, async emit(payload) { return event(1, payload); },
      async createProviderJob() {
        return {
          async registerProcess() { throw registrationError; }, get registeredProcessCount() { return 0; },
          async terminate() { shutdown.push("job.terminate"); }, async close() { shutdown.push("job.close"); },
        };
      },
    }, adapter);
    await expect(handler.handleCommand({ commandId: "send-registration-failure", method: "structured.send", params: { text: "hello" } })).rejects.toBe(registrationError);
    expect(adapterChild).toBeNull();
    // Host-in-Job registration is an audit rather than a post-spawn assign;
    // the adapter's exact-child cleanup owns this exceptional direct child.
    expect(shutdown).toEqual([]);
  });

  it("reconnects an explicitly killed owner as done/read-only without acquiring a lease", async () => {
    const host = parseWindowsSessionHostManifest({
      schemaVersion: 2, protocolVersion: 2, implementation: "windows-session-host", sessionId: "structured-host-test",
      epoch: "structured-host-epoch-0001", pipeName: "\\\\.\\pipe\\prospero-structured-terminal", stateDirectory: "C:\\state",
      aclProfile: "current-logon-token-v1", owner: { pid: 41001, creationTime100ns: "111111111111111" },
      nativeAbiVersion: NATIVE_WINDOWS_ABI_VERSION, credentialFile: "credential.dpapi", journalFile: "journal.psj2",
      snapshotFile: "snapshot.psj2.json", status: "active", createdAt: 1, updatedAt: 1,
    });
    const manifest = {
      schemaVersion: 1 as const, implementation: "windows-structured-session-host" as const, sessionId: host.sessionId,
      agent: "codex" as const, title: "fake", cwd: process.cwd(), createdAt: 1, approvalPolicy: "standard" as const,
      registryDirectory: "C:\\registry", host, status: "active" as const,
    };
    let leases = 0;
    const session = await WindowsRemoteStructuredSession.attach(manifest, async () => ({
      async acquireMutationLease() { leases++; return "must-not-be-used"; },
      async replay(afterSeq = 0) {
        return { version: 2 as const, type: "replay" as const, sessionId: host.sessionId, epoch: host.epoch, afterSeq,
          lastSeq: 0, gap: false, terminal: true, snapshot: null, events: [] };
      },
      async command(method: string) {
        if (method === "structured.persistentState") return persistentState({ terminal: true });
        throw new Error("terminal host received an unexpected command");
      },
      async dispose() {},
    }));
    expect(session.info().status).toBe("done");
    expect(session.toolOutput("tool-1")).toEqual({ output: "full durable output", truncated: false });
    expect(leases).toBe(0);
    await expect(session.send("must not mutate")).rejects.toMatchObject({ code: "terminal_fence" });
    expect(leases).toBe(0);
    await session.dispose();
  });

  it("recovers an owner-gone terminal facade only from the exact secure terminal manifest, snapshot, and kill ledger", async () => {
    const host = parseWindowsSessionHostManifest({
      schemaVersion: 2, protocolVersion: 2, implementation: "windows-session-host", sessionId: "structured-host-test",
      epoch: "structured-host-epoch-0001", pipeName: "\\\\.\\pipe\\prospero-structured-terminal-offline", stateDirectory: "C:\\state",
      aclProfile: "current-logon-token-v1", owner: { pid: 41001, creationTime100ns: "111111111111111" },
      nativeAbiVersion: NATIVE_WINDOWS_ABI_VERSION, credentialFile: "credential.dpapi", journalFile: "journal.psj2",
      snapshotFile: "snapshot.psj2.json", status: "terminal", createdAt: 1, updatedAt: 2,
    });
    const manifest = {
      schemaVersion: 1 as const, implementation: "windows-structured-session-host" as const, sessionId: host.sessionId,
      agent: "codex" as const, title: "fake", cwd: process.cwd(), createdAt: 1, approvalPolicy: "standard" as const,
      registryDirectory: "C:\\registry", host: { ...host, status: "active" as const }, status: "active" as const,
    };
    const files = new Map<string, Uint8Array>();
    files.set("manifest.json", new TextEncoder().encode(JSON.stringify(host)));
    const native = {
      async openState() {},
      async read(name: string) { return files.get(name) ?? null; },
      async writeAtomic(name: string, bytes: Uint8Array) { files.set(name, Uint8Array.from(bytes)); },
      async close() {},
    };
    const journal = new WindowsSessionHostJournal(native, host.sessionId, host.epoch);
    await journal.append({ kind: "terminal", commandId: "kill-lost-reply", payload: { ok: true, result: { killed: true } } });
    const reply = { version: 2 as const, type: "reply" as const, commandId: "kill-lost-reply", ok: true, result: { killed: true }, seq: 1 };
    const fullState = persistentState({ terminal: true, messageQueue: [{ id: "queued", displayText: "later", kind: "queue", createdAt: 1, attachments: [] }] });
    await journal.compact({
      structured: fullState,
      info: {
        id: manifest.sessionId, agent: manifest.agent, kind: "structured", title: manifest.title, cwd: manifest.cwd,
        status: "done", createdAt: manifest.createdAt, cols: 80, rows: 24, approvalPolicy: manifest.approvalPolicy,
      },
    }, [{ commandId: "kill-lost-reply", reply }]);

    const terminal = await readWindowsStructuredOfflineTerminalState(manifest, { async create() { return native; } });
    expect(terminal?.commands.get("kill-lost-reply")).toEqual(reply);
    expect(terminal?.persistent.adapterState).toEqual({ threadId: "thread-1" });
    const facade = WindowsRemoteStructuredSession.offlineTerminal(manifest, terminal!);
    expect(facade.info().status).toBe("done");
    expect(facade.snapshot().events).toEqual([]);
    expect(facade.toolOutput("tool-1")).toEqual({ output: "full durable output", truncated: false });
    expect(facade.persistentState().messageQueue).toHaveLength(1);
    await expect(facade.send("must not mutate")).rejects.toMatchObject({ code: "terminal_fence" });
    await facade.dispose();
  });

  it("rejects unknown provider bootstrap fields before allocating a Job", async () => {
    let jobs = 0;
    await expect(createWindowsStructuredSessionHostHandler({
      sessionId: "structured-host-test", epoch: "structured-host-epoch-0001", stateDirectory: "C:\\fake-state",
      handlerOptions: { version: 1, agent: "codex", title: "fake", cwd: process.cwd(), createdAt: 1, environment: {}, unexpected: true },
      async appendEvent(payload) { return event(1, payload); }, async emit(payload) { return event(1, payload); },
      async createProviderJob() { jobs++; throw new Error("must not allocate"); },
    })).rejects.toThrow(/bootstrap/i);
    expect(jobs).toBe(0);
  });
});
