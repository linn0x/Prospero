import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  opencodeCatalogHasModel,
  opencodeEventStreamReady,
  opencodeLocationQuery,
  opencodeResolvedProvider,
  opencodeServerPoolKey,
  parseOpencodeStartupOutput,
  waitForOpencodePort,
} from "../src/adapters/opencode.js";

function fakeProcess(): ChildProcess {
  const process = new EventEmitter() as EventEmitter & Record<string, unknown>;
  process["stdout"] = new PassThrough();
  process["stderr"] = new PassThrough();
  process["exitCode"] = null;
  return process as unknown as ChildProcess;
}

describe("OpenCode adapter helpers", () => {
  it("bounds startup output and parses a split listening address", () => {
    const bounded = parseOpencodeStartupOutput("", "x".repeat(100_000));
    expect(bounded.buffer.length).toBeLessThanOrEqual(64 * 1024);
    expect(bounded.port).toBeNull();

    const first = parseOpencodeStartupOutput("", "server listening on http://127.0.0.1:");
    const second = parseOpencodeStartupOutput(first.buffer, "43123\nmore output");
    expect(second.port).toBe(43123);
    expect(new URLSearchParams(opencodeLocationQuery("/tmp/测试 project")).get("location[directory]"))
      .toBe("/tmp/测试 project");
  });

  it("removes startup listeners after success, failure, and timeout", async () => {
    const success = fakeProcess();
    const successPort = waitForOpencodePort(success, 100);
    success.stdout!.emit("data", Buffer.from("listening on http://127.0.0.1:41234\n"));
    await expect(successPort).resolves.toBe(41234);
    expect(success.stdout!.listenerCount("data")).toBe(0);
    expect(success.stderr!.listenerCount("data")).toBe(0);
    expect(success.listenerCount("error")).toBe(0);
    expect(success.listenerCount("exit")).toBe(0);
    expect(success.stdout!.readableFlowing).toBe(true);
    expect(success.stderr!.readableFlowing).toBe(true);

    const failed = fakeProcess();
    const failedPort = expect(waitForOpencodePort(failed, 100)).rejects.toThrow(/无法启动/);
    failed.emit("error", new Error("boom"));
    await failedPort;
    expect(failed.stdout!.listenerCount("data")).toBe(0);
    expect(failed.listenerCount("exit")).toBe(0);

    const timedOut = fakeProcess();
    await expect(waitForOpencodePort(timedOut, 5)).rejects.toThrow(/超时/);
    expect(timedOut.stdout!.listenerCount("data")).toBe(0);
    expect(timedOut.listenerCount("error")).toBe(0);
  });

  it("requires the configured provider and model instead of any catalog entry", () => {
    const catalog = [
      { providerID: "openai", id: "gpt-5" },
      { providerID: "prospero", id: "chat-coder" },
    ];
    expect(opencodeCatalogHasModel(catalog, "prospero/chat-coder")).toBe(true);
    expect(opencodeCatalogHasModel(catalog, "prospero/gpt-5")).toBe(false);
    expect(opencodeCatalogHasModel(catalog, "openai/chat-coder")).toBe(false);
    expect(opencodeCatalogHasModel({ data: catalog }, "prospero/chat-coder")).toBe(true);
    expect(opencodeCatalogHasModel({
      prospero: { models: { "chat-coder": { name: "Chat Coder" } } },
    }, "prospero/chat-coder")).toBe(true);
    expect(opencodeCatalogHasModel({ prospero: { models: {} } }, "prospero/constructor")).toBe(false);
    expect(opencodeResolvedProvider({ data: { id: "prospero" } }, "prospero")).toBe(true);
    expect(opencodeResolvedProvider({ data: { id: "openai" } }, "prospero")).toBe(false);
  });

  it("shares each isolated API Profile across workspaces without mixing profiles", () => {
    expect(opencodeServerPoolKey({}, "/first")).toBe(opencodeServerPoolKey({}, "/second"));
    const environment = {
      PROSPERO_API_PROFILE_CONFIG: "/profile/opencode.json",
      PROSPERO_API_PROFILE_FINGERPRINT: "fingerprint",
    };
    expect(opencodeServerPoolKey(environment, "/first"))
      .toBe(opencodeServerPoolKey(environment, "/second"));
    expect(opencodeServerPoolKey(environment, "/first"))
      .not.toBe(opencodeServerPoolKey({ ...environment, PROSPERO_API_PROFILE_FINGERPRINT: "other" }, "/first"));
  });

  it("accepts only successful SSE event responses as ready", () => {
    expect(opencodeEventStreamReady(200, "text/event-stream; charset=utf-8", true)).toBe(true);
    expect(opencodeEventStreamReady(404, "text/event-stream", true)).toBe(false);
    expect(opencodeEventStreamReady(200, "application/json", true)).toBe(false);
    expect(opencodeEventStreamReady(200, "text/event-stream", false)).toBe(false);
  });
});
