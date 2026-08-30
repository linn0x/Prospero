import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonServer, type DaemonServer } from "../src/ws-server.js";

describe("desktop daemon shutdown control", () => {
  let server: DaemonServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    await server?.close();
    if (home) rmSync(home, { recursive: true, force: true });
    server = undefined;
    home = undefined;
  });

  it("requires the loopback control token and schedules a graceful shutdown", async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "prospero-control-shutdown-"));
    let requested = 0;
    server = await createDaemonServer({
      home,
      workspaceRoot: home,
      port: 0,
      fullAccess: true,
      structuredSupervisor: false,
      ptySupervisor: false,
      windowsSessionHost: false,
      requestShutdown: () => { requested += 1; },
    });
    const status = JSON.parse(readFileSync(path.join(home, "status.json"), "utf8")) as {
      controlToken: string;
      fullAccess: boolean;
    };
    const url = `http://127.0.0.1:${String(server.port)}/_prospero/control/shutdown`;

    expect(status.fullAccess).toBe(true);
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    expect((await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${status.controlToken}` },
    })).status).toBe(202);
    await expect.poll(() => requested).toBe(1);
  });
});
