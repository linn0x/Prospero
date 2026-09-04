import { afterEach, describe, expect, it, vi } from "vitest";
import { PtySession } from "../src/pty-session.js";

const sessions: PtySession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
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
});
