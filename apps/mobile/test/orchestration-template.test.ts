import { describe, expect, it } from "vitest";

import {
  createOrchestrationTemplatePayload,
  decodeOrchestrationTemplatePayload,
  instantiateOrchestrationTemplate,
} from "../src/lib/orchestration-template";

describe("orchestration templates", () => {
  it("uses stable template keys while preserving dependencies", () => {
    const payload = createOrchestrationTemplatePayload("  Ship mobile  ", [
      { id: "runtime-a", title: " Plan ", spec: " Decide scope ", deps: [] },
      { id: "runtime-b", title: "Build", spec: "Implement", deps: ["runtime-a", "gone"] },
    ]);

    expect(payload).toEqual({
      schemaVersion: 1,
      objective: "Ship mobile",
      nodes: [
        { key: "node-1", title: "Plan", spec: "Decide scope", dependencyKeys: [] },
        { key: "node-2", title: "Build", spec: "Implement", dependencyKeys: ["node-1"] },
      ],
    });
  });

  it("creates fresh runtime ids when loading a template", () => {
    let sequence = 0;
    const draft = instantiateOrchestrationTemplate({
      schemaVersion: 1,
      objective: "Ship mobile",
      nodes: [
        { key: "node-1", title: "Plan", spec: "Decide", dependencyKeys: [] },
        { key: "node-2", title: "Build", spec: "Implement", dependencyKeys: ["node-1"] },
      ],
    }, () => `fresh-${String(++sequence)}`);

    expect(draft.nodes.map((node) => node.id)).toEqual(["fresh-1", "fresh-2"]);
    expect(draft.nodes[1]?.deps).toEqual(["fresh-1"]);
  });

  it("rejects malformed or unsupported persisted JSON", () => {
    expect(decodeOrchestrationTemplatePayload("not-json")).toBeNull();
    expect(decodeOrchestrationTemplatePayload(JSON.stringify({
      schemaVersion: 2,
      objective: "future",
      nodes: [],
    }))).toBeNull();
    expect(decodeOrchestrationTemplatePayload(JSON.stringify({
      schemaVersion: 1,
      objective: "broken dependency",
      nodes: [{ key: "a", title: "A", spec: "A", dependencyKeys: ["missing"] }],
    }))).toBeNull();
  });
});
