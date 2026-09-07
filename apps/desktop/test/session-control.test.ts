import { describe, expect, it } from "vitest";
import { sessionAgentControls, sessionInfoFromControl } from "../src/main/session-control";

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
    expect(session).not.toHaveProperty("agentControls");
  });

  it("preserves supported controls and the current model selection", () => {
    const controls = { compact: false, model: true, mode: false, currentModel: "provider/model", currentEffort: "high" };
    expect(sessionInfoFromControl({ id: "modeled-session", agentControls: controls }).agentControls).toEqual(controls);
    expect(sessionAgentControls({ ...controls, model: "true" })).toBeUndefined();
    expect(sessionAgentControls({ ...controls, currentModel: "a".repeat(400), currentEffort: "b".repeat(200) })).toMatchObject({
      currentModel: "a".repeat(300), currentEffort: "b".repeat(100),
    });
  });
});
