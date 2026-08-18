import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterContext, AgentAdapter } from "../src/adapters/types.js";
import { createDaemonServer, type DaemonServer } from "../src/ws-server.js";

interface StructuredView {
  kind: "structured";
  mode: "snapshot" | "delta";
  evSeq: number;
  baseSeq?: number;
  seq?: number;
  events: Array<{ kind: string }>;
}

class ControlViewAdapter implements AgentAdapter {
  private context: AdapterContext | null = null;

  async start(context: AdapterContext): Promise<void> {
    this.context = context;
  }

  async send(text: string): Promise<void> {
    const context = this.context;
    if (!context) throw new Error("adapter is not started");
    if (text === "overflow") {
      // StructuredSession only retains 4,000 events. This deliberately
      // crosses that boundary so the HTTP endpoint must return a snapshot.
      for (let index = 0; index < 4_001; index++) {
        context.emit({
          kind: "text.delta",
          msgId: "overflow",
          textId: "overflow",
          delta: String(index),
        });
      }
    } else {
      const callId = text === "large" ? "tool-large" : "tool-alpha";
      const output = text === "large" ? "x".repeat(200_001) : `full:${text}`;
      context.recordOutput?.(callId, output);
      context.emit({
        kind: "text.delta",
        msgId: text,
        textId: text,
        delta: `echo:${text}`,
      });
    }
    context.emit({ kind: "turn.end", msgId: text, inputTokens: 1, outputTokens: 1 });
  }

  async respondPermission(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {
    this.context = null;
  }
}

describe("Mac control session views", () => {
  it("serves structured events and a snapshot-then-delta PTY stream", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "prospero-control-view-"));
    let server: DaemonServer | undefined;
    try {
      server = await createDaemonServer({
        home,
        port: 0,
        workspaceRoot: home,
        structuredSupervisor: false,
        ptySupervisor: false,
        adapterFactory: () => new ControlViewAdapter(),
      });
      const status = JSON.parse(readFileSync(path.join(home, "status.json"), "utf8")) as {
        controlToken: string;
      };
      const base = `http://127.0.0.1:${String(server.port)}`;
      const headers = { authorization: `Bearer ${status.controlToken}` };
      const request = (pathname: string, init: RequestInit = {}): Promise<Response> =>
        fetch(`${base}${pathname}`, {
          ...init,
          headers: { ...headers, ...(init.headers ?? {}) },
        });
      const create = async (body: Record<string, unknown>): Promise<{ id: string }> => {
        const response = await request("/_prospero/control/session/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(201);
        return response.json() as Promise<{ id: string }>;
      };
      const interact = async (sid: string, text: string): Promise<void> => {
        const response = await request(`/_prospero/control/session/${sid}/interact`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "chat.send", text }),
        });
        expect(response.status).toBe(204);
      };

      const structured = await create({ agent: "codex", kind: "structured", cwd: home });
      const viewPath = `/_prospero/control/session/${structured.id}/view`;
      const toolPath = `/_prospero/control/session/${structured.id}/tool-output`;

      // Control-token authorization applies to the newly added read endpoints.
      expect((await fetch(`${base}${viewPath}`)).status).toBe(401);
      expect((await fetch(`${base}${toolPath}?callId=tool-alpha`)).status).toBe(401);

      const initial = await request(viewPath);
      expect(initial.status).toBe(200);
      expect(await initial.json()).toEqual({
        kind: "structured",
        mode: "snapshot",
        seq: 0,
        evSeq: 0,
        events: [],
      });
      // knownSeq remains the legacy no-change probe.
      expect((await request(`${viewPath}?knownSeq=0`)).status).toBe(204);
      expect((await request(`${viewPath}?afterSeq=not-a-sequence`)).status).toBe(400);

      const ahead = await request(`${viewPath}?afterSeq=1`);
      expect(ahead.status).toBe(200);
      expect(await ahead.json()).toMatchObject({
        kind: "structured",
        mode: "snapshot",
        evSeq: 0,
        events: [],
      });
      expect((await request(`${viewPath}?afterSeq=0`)).status).toBe(204);

      await interact(structured.id, "alpha");
      const deltaResponse = await request(`${viewPath}?afterSeq=0`);
      expect(deltaResponse.status).toBe(200);
      const delta = await deltaResponse.json() as StructuredView;
      expect(delta).toMatchObject({
        kind: "structured",
        mode: "delta",
        baseSeq: 0,
      });
      expect(delta.evSeq).toBeGreaterThan(0);
      expect(delta.events).toHaveLength(delta.evSeq);
      expect((await request(`${viewPath}?afterSeq=${String(delta.evSeq)}`)).status).toBe(204);

      const output = await request(`${toolPath}?callId=tool-alpha`);
      expect(output.status).toBe(200);
      expect(await output.json()).toEqual({ output: "full:alpha", truncated: false });
      const missing = await request(`${toolPath}?callId=no-such-call`);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe("tool output not found");
      expect((await request(toolPath)).status).toBe(400);

      await interact(structured.id, "large");
      const large = await request(`${toolPath}?callId=tool-large`);
      expect(large.status).toBe(200);
      const largeOutput = await large.json() as { output: string; truncated: boolean };
      expect(largeOutput).toMatchObject({ truncated: true });
      expect(largeOutput.output).toHaveLength(200_000);

      await interact(structured.id, "overflow");
      const gapResponse = await request(`${viewPath}?afterSeq=0`);
      expect(gapResponse.status).toBe(200);
      const gap = await gapResponse.json() as StructuredView;
      expect(gap).toMatchObject({ kind: "structured", mode: "snapshot" });
      expect(gap.events).toHaveLength(4_000);
      const latest = await request(`${viewPath}?afterSeq=${String(gap.evSeq - 1)}`);
      expect(latest.status).toBe(200);
      expect(await latest.json()).toMatchObject({
        kind: "structured",
        mode: "delta",
        baseSeq: gap.evSeq - 1,
        evSeq: gap.evSeq,
        events: [{ kind: "turn.end" }],
      });

      // afterSeq is structured-only and remains ignored for PTY compatibility.
      // The Mac-specific outputAfterSeq cursor upgrades PTY rendering without
      // changing knownSeq clients.
      const pty = await create({
        agent: "custom",
        kind: "pty",
        cwd: home,
        // Keep the process stable across both view requests. An immediate
        // exit can legitimately advance the PTY sequence between snapshots,
        // turning the no-change probe into a racy 200 response on Windows.
        command: process.platform === "win32"
          ? "ping -n 31 127.0.0.1 >NUL"
          : "sleep 30",
      });
      const ptyViewPath = `/_prospero/control/session/${pty.id}/view`;
      const ptyView = await request(`${ptyViewPath}?afterSeq=not-a-sequence`);
      expect(ptyView.status).toBe(200);
      const ptySnapshot = await ptyView.json() as { kind: string; seq: number };
      expect(ptySnapshot.kind).toBe("pty");
      expect((await request(`${ptyViewPath}?knownSeq=${String(ptySnapshot.seq)}`)).status).toBe(204);
      expect((await request(`${ptyViewPath}?outputAfterSeq=nope`)).status).toBe(400);
      expect((await request(`${ptyViewPath}?outputAfterSeq=0&waitMs=25001`)).status).toBe(400);

      const terminal = server.manager.requirePty(pty.id);
      const firstBytes = new TextEncoder().encode("first-delta");
      const firstSeq = terminal.ring.push(firstBytes);
      const firstDeltaResponse = await request(
        `${ptyViewPath}?outputAfterSeq=${String(ptySnapshot.seq)}`,
      );
      expect(firstDeltaResponse.status).toBe(200);
      expect(await firstDeltaResponse.json()).toEqual({
        kind: "pty",
        mode: "delta",
        baseSeq: ptySnapshot.seq,
        seq: firstSeq,
        dataB64: Buffer.from(firstBytes).toString("base64"),
      });

      // A long poll registers before rechecking the ring, then wakes as soon
      // as SessionManager publishes output instead of adding a fixed UI poll.
      const waiting = request(`${ptyViewPath}?outputAfterSeq=${String(firstSeq)}&waitMs=2000`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const secondBytes = new TextEncoder().encode("second-delta");
      const secondSeq = terminal.ring.push(secondBytes);
      server.manager.emit("output", pty.id, Buffer.from(secondBytes).toString("base64"), secondSeq);
      const secondDeltaResponse = await waiting;
      expect(secondDeltaResponse.status).toBe(200);
      expect(await secondDeltaResponse.json()).toMatchObject({
        mode: "delta",
        baseSeq: firstSeq,
        seq: secondSeq,
        dataB64: Buffer.from(secondBytes).toString("base64"),
      });

      expect((await request(
        `${ptyViewPath}?outputAfterSeq=${String(secondSeq)}&waitMs=5`,
      )).status).toBe(204);
      const repaired = await request(`${ptyViewPath}?outputAfterSeq=${String(secondSeq + 100)}`);
      expect(repaired.status).toBe(200);
      expect(await repaired.json()).toMatchObject({ kind: "pty", mode: "snapshot", seq: secondSeq });
    } finally {
      await server?.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
