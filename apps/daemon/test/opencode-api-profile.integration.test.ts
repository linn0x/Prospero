import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAccountManager } from "../src/agent-accounts.js";
import { OpencodeAdapter, stopOpencodeServer } from "../src/adapters/opencode.js";

let opencodeAvailable = true;
try { execFileSync("opencode", ["--version"], { stdio: "ignore", timeout: 10_000 }); }
catch { opencodeAvailable = false; }

const homes: string[] = [];

afterEach(() => {
  stopOpencodeServer();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("OpenCode API Profile", () => {
  it.skipIf(!opencodeAvailable)("reaches the configured Chat Completions endpoint immediately after readiness", async () => {
    let acceptRequest!: (value: { url: string; authorization: string; body: Record<string, unknown> }) => void;
    const requestReceived = new Promise<{ url: string; authorization: string; body: Record<string, unknown> }>((resolve) => {
      acceptRequest = resolve;
    });
    let mainRequestCount = 0;
    const upstream = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: "probe-model", object: "model" }] }));
        return;
      }
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { raw += chunk; });
      request.on("end", () => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch {}
        if (Array.isArray(body["tools"]) && body["tools"].length > 0) {
          mainRequestCount += 1;
          acceptRequest({
            url: request.url ?? "",
            authorization: String(request.headers.authorization ?? ""),
            body,
          });
        }
        if (body["stream"] === true) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(`data: ${JSON.stringify({ id: "chatcmpl-probe", object: "chat.completion.chunk", created: 1, model: "probe-model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
          response.write(`data: ${JSON.stringify({ id: "chatcmpl-probe", object: "chat.completion.chunk", created: 1, model: "probe-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
          response.end("data: [DONE]\n\n");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "chatcmpl-probe",
          object: "chat.completion",
          created: 1,
          model: "probe-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing upstream port");

    const home = mkdtempSync(path.join(os.tmpdir(), "prospero-opencode-profile-"));
    homes.push(home);
    const project = path.join(home, "项目 workspace");
    mkdirSync(project);
    writeFileSync(path.join(project, "opencode.json"), JSON.stringify({
      model: "malicious/override",
      provider: { malicious: { models: { override: {} } } },
    }));
    const accounts = new AgentAccountManager(home, async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const binding = await accounts.createApi("codex", "Local Chat", {
      provider: "openai_compatible",
      protocol: "openai_chat_completions",
      baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
      model: "probe-model",
      apiKey: "local-probe-key",
    });
    const adapter = new OpencodeAdapter();
    const events: unknown[] = [];
    let nativeSessionId = "";
    try {
      await adapter.start({
        cwd: project,
        env: binding.environment,
        emit: (event) => { events.push(event); },
        persistState: (state) => { nativeSessionId = String(state["sessionId"] ?? ""); },
      });
      expect(nativeSessionId).not.toBe("");
      const sending = adapter.send("reply with ok");
      await sending;
      let requestTimer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        requestTimer = setTimeout(() => reject(new Error(`chat request timeout: ${JSON.stringify(events)}`)), 5_000);
        requestTimer.unref?.();
      });
      const request = await Promise.race([
        requestReceived,
        timeout,
      ]).finally(() => {
        if (requestTimer) clearTimeout(requestTimer);
      });
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.authorization).toBe("Bearer local-probe-key");
      expect(request.body["model"]).toBe("probe-model");
      expect(request.body["tools"]).toEqual(expect.any(Array));
      expect((request.body["tools"] as unknown[]).length).toBeGreaterThan(0);
      expect([undefined, "auto"]).toContain(request.body["tool_choice"]);
      const eventDeadline = Date.now() + 2_000;
      while (Date.now() < eventDeadline && !events.some((event) => (
        event && typeof event === "object" && (event as { kind?: unknown }).kind === "turn.end"
      ))) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "text.delta", delta: "ok" }),
        expect.objectContaining({ kind: "turn.end" }),
      ]));
      expect(events.filter((event) => (
        event && typeof event === "object" && (event as { kind?: unknown }).kind === "text.delta"
      ))).toHaveLength(1);
      expect(mainRequestCount).toBe(1);
      await expect(adapter.interrupt()).resolves.toBeUndefined();

      const secondProject = path.join(home, "第二个 project");
      mkdirSync(secondProject);
      const secondEvents: unknown[] = [];
      const secondAdapter = new OpencodeAdapter();
      let secondSessionId = "";
      try {
        await secondAdapter.start({
          cwd: secondProject,
          env: binding.environment,
          emit: (event) => { secondEvents.push(event); },
          persistState: (state) => { secondSessionId = String(state["sessionId"] ?? ""); },
        });
        await secondAdapter.send("reply with ok again");
        const secondDeadline = Date.now() + 5_000;
        while (Date.now() < secondDeadline && (
          mainRequestCount < 2 || !secondEvents.some((event) => (
            event && typeof event === "object" && (event as { kind?: unknown }).kind === "turn.end"
          ))
        )) await new Promise((resolve) => setTimeout(resolve, 20));
        expect(mainRequestCount).toBe(2);
        expect(secondEvents).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "text.delta", delta: "ok" }),
          expect.objectContaining({ kind: "turn.end" }),
        ]));
        await expect(secondAdapter.interrupt()).resolves.toBeUndefined();
      } finally {
        await secondAdapter.dispose();
      }
      expect(secondSessionId).not.toBe("");
      const resumedAdapter = new OpencodeAdapter({ resumeState: { sessionId: secondSessionId } });
      try {
        await resumedAdapter.start({ cwd: secondProject, env: binding.environment, emit: () => {} });
      } finally {
        await resumedAdapter.dispose();
      }
    } finally {
      await adapter.dispose();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  }, 60_000);
});
