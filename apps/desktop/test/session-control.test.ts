import { describe, expect, it } from "vitest";
import { sessionInfoFromControl } from "../src/main/session-control";

describe("desktop session control projection", () => {
  it("preserves account identity returned by create and history endpoints", () => {
    expect(sessionInfoFromControl({
      id: "session-1",
      agent: "codex",
      kind: "structured",
      title: "Work",
      cwd: "/repo",
      status: "running",
      accountId: "profile-1",
      accountName: "Work API",
    })).toMatchObject({
      id: "session-1",
      accountId: "profile-1",
      accountName: "Work API",
    });
  });

  it("keeps legacy sessions without account metadata compatible", () => {
    const session = sessionInfoFromControl({
      id: "legacy-session",
      agent: "codex",
      kind: "structured",
      title: "Legacy",
      cwd: "/repo",
      status: "done",
    });

    expect(session).not.toHaveProperty("accountId");
    expect(session).not.toHaveProperty("accountName");
  });
});
