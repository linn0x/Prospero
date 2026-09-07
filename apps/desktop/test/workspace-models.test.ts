import { describe, expect, it, vi } from "vitest";
import type { AgentModelCatalog, SessionInfo } from "../src/shared/types";
import { cachedModelCatalog, loadModelCatalog, modelSwitchSupported, saveModelCatalog, supportedModelEffort } from "../src/renderer/src/workspace/model-catalog";

const catalog: AgentModelCatalog = { models: [{ id: "test/model", label: "Test model", supportedEfforts: ["low", "high"] }], currentModel: "test/model" };
const session: SessionInfo = { id: "s", cwd: "/repo", agent: "codex", kind: "structured", title: "Session", status: "running", agentControls: { model: true, mode: false, compact: false } };

describe("workspace model catalog", () => {
  it("requires explicit daemon and account capability, and never supports PTY", () => {
    expect(modelSwitchSupported(session)).toBe(true);
    expect(modelSwitchSupported({ ...session, kind: "pty" })).toBe(false);
    expect(modelSwitchSupported({ ...session, agentControls: { model: false, mode: false, compact: false } })).toBe(false);
    const legacy = { ...session };
    delete legacy.agentControls;
    expect(modelSwitchSupported(legacy)).toBe(false);
    expect(modelSwitchSupported(session, { capabilities: { modelSelection: false } })).toBe(false);
  });

  it("filters efforts against the chosen model and allows model default", () => {
    expect(supportedModelEffort(catalog.models[0], "high")).toBe("high");
    expect(supportedModelEffort(catalog.models[0], "xhigh")).toBeUndefined();
    expect(supportedModelEffort(catalog.models[0], "")).toBeUndefined();
    expect(supportedModelEffort({ ...catalog.models[0]!, supportedEfforts: [] }, "high")).toBeUndefined();
  });

  it("deduplicates loading and keeps responses isolated by session", async () => {
    let resolveA!: (value: AgentModelCatalog) => void;
    const api = { getAgentModels: vi.fn((id: string) => id === "async-a" ? new Promise<AgentModelCatalog>((resolve) => { resolveA = resolve; }) : Promise.resolve({ ...catalog, currentModel: "model-b" })) };
    const first = loadModelCatalog(api, "async-a");
    expect(loadModelCatalog(api, "async-a")).toBe(first);
    await loadModelCatalog(api, "async-b");
    resolveA(catalog);
    await first;
    expect(cachedModelCatalog("async-a")?.currentModel).toBe("test/model");
    expect(cachedModelCatalog("async-b")?.currentModel).toBe("model-b");
    expect(api.getAgentModels).toHaveBeenCalledTimes(2);
  });

  it("refreshes explicitly, preserves previous selection on failure, and can retry", async () => {
    saveModelCatalog("refresh", catalog);
    const api = { getAgentModels: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ models: [] }) };
    await expect(loadModelCatalog(api, "refresh", true)).rejects.toThrow("offline");
    expect(cachedModelCatalog("refresh")).toEqual(catalog);
    expect(await loadModelCatalog(api, "refresh", true)).toEqual({ models: [] });
  });

  it("bounds its cache and expires stale entries", () => {
    for (let index = 0; index < 50; index += 1) saveModelCatalog(`bounded-${index}`, catalog);
    expect(cachedModelCatalog("bounded-0")).toBeUndefined();
    expect(cachedModelCatalog("bounded-49")).toEqual(catalog);
    expect(cachedModelCatalog("bounded-49", Date.now() + 60_001)).toBeUndefined();
  });
});
