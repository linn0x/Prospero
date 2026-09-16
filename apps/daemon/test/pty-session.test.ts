import { afterEach, describe, expect, it, vi } from "vitest";
import { PtySession } from "../src/pty-session.js";

const sessions: PtySession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  vi.restoreAllMocks();
});

describe("PtySession snapshot", () => {
  it("binds the cursor to the output rendered before its barrier", async () => {
    const session = new PtySession({
      id: "snapshot-cursor",
      agent: "custom",
      title: "snapshot-cursor",
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: { PATH: process.env.PATH ?? "" },
    });
    sessions.push(session);
    const internals = session as unknown as {
      onProcData(data: string): void;
      term: { write(data: string, callback?: () => void): void };
      serializer: { serialize(): string };
    };
    const writes: Array<() => void> = [];
    let rendered = "";
    vi.spyOn(internals.term, "write").mockImplementation((data, callback) => {
      writes.push(() => {
        rendered += data;
        callback?.();
      });
    });
    vi.spyOn(internals.serializer, "serialize").mockImplementation(() => rendered);

    internals.onProcData("first");
    const pending = session.snapshot();
    internals.onProcData("second");
    session.flushNow();
    writes.shift()?.();
    writes.shift()?.();

    await expect(pending).resolves.toMatchObject({ ansi: "first", seq: 1 });
    expect(session.ring.lastSeq).toBe(2);
  });

  it("includes scrollback in full snapshots", async () => {
    const session = new PtySession({
      id: "snapshot-scrollback",
      agent: "custom",
      title: "snapshot-scrollback",
      cwd: process.cwd(),
      cols: 80,
      rows: 5,
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: { PATH: process.env.PATH ?? "" },
    });
    sessions.push(session);
    const internals = session as unknown as {
      onProcData(data: string): void;
    };
    internals.onProcData(Array.from({ length: 20 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}\r\n`).join(""));

    const snapshot = await session.snapshot();

    expect(snapshot.ansi).toContain("line-01");
    expect(snapshot.ansi).toContain("line-20");
  });

  it("marks recent PTY activity and clears it after idle", () => {
    const session = new PtySession({
      id: "activity",
      agent: "custom",
      title: "activity",
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: { PATH: process.env.PATH ?? "" },
    });
    sessions.push(session);
    const internals = session as unknown as {
      onProcData(data: string): void;
      clearActivity(): void;
      visibleTailText(): string;
      term: { write(data: string, callback?: () => void): void };
    };
    vi.spyOn(internals.term, "write").mockImplementation((_data, callback) => callback?.());
    vi.spyOn(internals, "visibleTailText").mockReturnValue("Inspecting files (2s · esc to interrupt)");

    expect(session.info().busySince).toBeUndefined();
    internals.onProcData("output");
    expect(session.info().busySince).toBeTypeOf("number");
    internals.clearActivity();
    expect(session.info().busySince).toBeUndefined();
  });

  it("clears PTY activity after an idle prompt repaint", () => {
    const session = new PtySession({
      id: "idle-prompt",
      agent: "custom",
      title: "idle-prompt",
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: { PATH: process.env.PATH ?? "" },
    });
    sessions.push(session);
    const internals = session as unknown as {
      onProcData(data: string): void;
      visibleTailText(): string;
      term: { write(data: string, callback?: () => void): void };
    };
    vi.spyOn(internals.term, "write").mockImplementation((_data, callback) => callback?.());
    const tail = vi.spyOn(internals, "visibleTailText");

    tail.mockReturnValue("Inspecting files (2s · esc to interrupt)");
    internals.onProcData("work");
    expect(session.info().busySince).toBeTypeOf("number");
    tail.mockReturnValue("new task? /clear to save 1k tokens\n>");
    internals.onProcData("idle");
    expect(session.info().busySince).toBeUndefined();
    tail.mockReturnValue("");
    internals.onProcData("blank");
    expect(session.info().busySince).toBeUndefined();
  });
});
