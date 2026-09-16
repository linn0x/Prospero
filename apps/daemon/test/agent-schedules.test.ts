import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@prospero/protocol";
import {
  nextRunAfter,
  ScheduledAgentService,
  type ScheduledAgentSessionManager,
} from "../src/agent-schedules.js";
import type { CreateSessionInput } from "../src/session-manager.js";

class FakeSessions implements ScheduledAgentSessionManager {
  readonly creates: CreateSessionInput[] = [];
  readonly messages: Array<{ sid: string; text: string; delivery?: string }> = [];
  private readonly sessions = new Map<string, SessionInfo>();

  async create(input: CreateSessionInput): Promise<SessionInfo> {
    this.creates.push(input);
    const session: SessionInfo = {
      id: `session-${this.creates.length}`,
      agent: input.agent,
      kind: input.kind ?? "structured",
      title: `${input.agent} scheduled`,
      cwd: input.cwd ?? os.homedir(),
      status: "completed",
      createdAt: Date.now(),
      cols: input.cols,
      rows: input.rows,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.model ? { agentControls: { compact: true, model: true, mode: true, currentModel: input.model, ...(input.effort ? { currentEffort: input.effort } : {}) } } : {}),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async chatSend(sid: string, text: string, _attachments?: never, delivery?: string): Promise<void> {
    this.messages.push({ sid, text, ...(delivery ? { delivery } : {}) });
  }

  infoOf(sid: string): SessionInfo {
    const session = this.sessions.get(sid);
    if (!session) throw new Error("missing");
    return session;
  }

  setStatus(sid: string, status: string): void {
    const session = this.sessions.get(sid);
    if (session) this.sessions.set(sid, { ...session, status });
  }
}

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "prospero-schedules-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("scheduled agent tasks", () => {
  it("stores tasks as Codex-compatible automation TOML", () => {
    let now = 1_000;
    const cwd = tempRoot();
    const service = new ScheduledAgentService({ root: path.join(cwd, "automations"), manager: new FakeSessions(), now: () => now });

    const task = service.create({
      id: "daily-check",
      name: "Daily check",
      prompt: "check status",
      rrule: "FREQ=MINUTELY;INTERVAL=10",
      agent: "claude",
      approvalPolicy: "yolo",
      cwd,
      model: "claude-sonnet-5",
      reasoningEffort: "high",
    });

    expect(task.nextRunAt).toBe(601_000);
    expect(readFileSync(path.join(cwd, "automations", "daily-check", "automation.toml"), "utf8")).toContain('status = "ENABLED"');
    now = task.nextRunAt;
    expect(service.list()[0]).toMatchObject({ id: "daily-check", agent: "claude", status: "ENABLED" });
  });

  it("triggers due tasks and reuses the last live session", async () => {
    let now = 1_000;
    const cwd = tempRoot();
    const sessions = new FakeSessions();
    const service = new ScheduledAgentService({ root: path.join(cwd, "automations"), manager: sessions, now: () => now });
    service.create({
      id: "monitor",
      name: "Monitor",
      prompt: "check",
      rrule: "FREQ=MINUTELY;INTERVAL=1",
      agent: "codex",
      cwd,
    });

    now = nextRunAfter("FREQ=MINUTELY;INTERVAL=1", now);
    await service.tick(now);
    expect(sessions.creates).toHaveLength(1);
    expect(sessions.messages).toEqual([{ sid: "session-1", text: "check", delivery: "queue" }]);

    now += 60_000;
    await service.tick(now);
    expect(sessions.creates).toHaveLength(1);
    expect(sessions.messages).toHaveLength(2);

    sessions.setStatus("session-1", "done");
    now += 60_000;
    await service.tick(now);
    expect(sessions.creates).toHaveLength(2);
    expect(sessions.messages.at(-1)?.sid).toBe("session-2");
  });

  it("does not trigger paused tasks", async () => {
    let now = 1_000;
    const cwd = tempRoot();
    const sessions = new FakeSessions();
    const service = new ScheduledAgentService({ root: path.join(cwd, "automations"), manager: sessions, now: () => now });
    service.create({
      id: "paused",
      name: "Paused",
      prompt: "check",
      rrule: "FREQ=MINUTELY;INTERVAL=1",
      status: "PAUSED",
      cwd,
    });

    now += 60_000;
    await service.tick(now);
    expect(sessions.creates).toHaveLength(0);
  });
});
