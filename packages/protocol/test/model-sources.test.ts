import { describe, expect, it } from "vitest";
import { C2SModelSourceActionSchema, S2CModelSourceResultSchema, parseC2S, parseS2C } from "../src/index.js";

describe("model source protocol", () => {
  it("validates actions and does not accept arbitrary credential destinations", () => {
    const message = { type: "model.source.action", requestId: "request", action: { kind: "models", sourceId: "source", revision: 1, protocol: "openai_responses", credentialId: "credential" } };
    expect(parseC2S(message).type).toBe("model.source.action");
    expect(C2SModelSourceActionSchema.safeParse({ ...message, action: { ...message.action, baseUrl: "https://unexpected.invalid" } }).success).toBe(false);
    expect(C2SModelSourceActionSchema.safeParse({ ...message, action: { kind: "migration.apply", migrationId: "preview", name: "source", accountIds: ["unexpected"] } }).success).toBe(false);
  });
  it("strips secret fields from public responses", () => {
    const result = { type: "model.source.result", requestId: "request", ok: true, sources: [{ id: "source", name: "Source", revision: 1, enabled: true, endpoints: [{ protocol: "openai_responses", baseUrl: "https://models.invalid" }], credentials: [{ id: "credential", name: "Key", revision: 1, secret: "synthetic-private" }], routes: [], createdAt: 1, updatedAt: 1, secret: "synthetic-private" }], secret: "synthetic-private" };
    expect(parseS2C(result).type).toBe("model.source.result");
    expect(JSON.stringify(S2CModelSourceResultSchema.parse(result))).not.toContain("synthetic-private");
  });
  it("validates initial model routes and reported capability metadata", () => {
    const message = { type: "model.source.action", requestId: "request", action: { kind: "create", name: "Gateway", endpoints: [{ protocol: "openai_responses", baseUrl: "https://models.invalid" }], credential: { name: "Key", apiKey: "synthetic" }, routes: [{ name: "A", model: "a", protocol: "openai_responses", enabled: true, modelCapabilities: { tools: true } }] } };
    expect(parseC2S(message)).toEqual(message);
    expect(C2SModelSourceActionSchema.safeParse({ ...message, action: { ...message.action, routes: Array(101).fill(message.action.routes[0]) } }).success).toBe(false);
    const result = S2CModelSourceResultSchema.parse({ type: "model.source.result", requestId: "request", ok: true, models: [{ id: "a", modelCapabilities: { contextWindow: 128000, secret: "synthetic" } }] });
    expect(result.models).toEqual([{ id: "a", modelCapabilities: { contextWindow: 128000 } }]);
  });
});
