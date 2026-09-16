import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { controlRequest } from "../src/control-socket.js";
import { PluginServiceSupervisor } from "../src/plugins/service-supervisor.js";
import { createDaemonServer, type DaemonServer } from "../src/ws-server.js";

const exec = promisify(execFile);
const homes: string[] = [];
const servers: DaemonServer[] = [];

function tempHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "prospero-plugin-service-"));
  homes.push(home);
  return home;
}

function writePlugin(
  home: string,
  mode: "auto" | "manual" = "auto",
  command: string[] = ["node", "service.mjs"],
): void {
  const root = path.join(home, "plugins", "prospero-botmux");
  const runtime = path.join(root, "runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path.join(runtime, "service.mjs"), `
import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.PORT);
const startsFile = "starts.txt";
const starts = fs.existsSync(startsFile) ? Number(fs.readFileSync(startsFile, "utf8")) : 0;
fs.writeFileSync(startsFile, String(starts + 1));
fs.writeFileSync("env.json", JSON.stringify({
  home: process.env.PROSPERO_HOME,
  plugin: process.env.PROSPERO_PLUGIN_ID,
  runtime: process.env.PROSPERO_PLUGIN_RUNTIME,
  tokenPath: process.env.PROSPERO_CONTROL_TOKEN_PATH,
  controlHttp: process.env.PROSPERO_CONTROL_HTTP,
  apiKey: process.env.API_KEY ?? null
}));

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404).end("not found");
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
  writeFileSync(path.join(root, "prospero-plugin.json"), `${JSON.stringify({
    schema_version: "prospero-plugin/v1",
    name: "prospero-botmux",
    version: "0.1.0",
    runtime_root: "runtime",
    services: [{
      id: "bridge",
      mode,
      command,
      cwd: "runtime",
      env: { FEATURE_FLAG: "1" },
      port_env: "PORT",
      health_path: "/health",
    }],
  }, null, 2)}\n`);
}

async function auth(home: string, server: DaemonServer, pathName: string, init?: RequestInit): Promise<Response> {
  const token = readFileSync(path.join(home, "control.token"), "utf8").trim();
  return await fetch(`http://127.0.0.1:${String(server.port)}${pathName}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
}

async function waitFor<T>(read: () => T, check: (value: T) => boolean): Promise<T> {
  const start = Date.now();
  let last: T;
  while (Date.now() - start < 5_000) {
    last = read();
    if (check(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  last = read();
  throw new Error(`condition was not met: ${JSON.stringify(last)}`);
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Prospero plugin service supervisor", () => {
  it("starts auto services, exposes control status, checks health, and stops processes", async () => {
    const home = tempHome();
    writePlugin(home);
    const server = await createDaemonServer({
      home,
      port: 0,
      workspaceRoot: home,
      structuredSupervisor: false,
      ptySupervisor: false,
      windowsSessionHost: false,
    });
    servers.push(server);

    const listResponse = await auth(home, server, "/_prospero/control/plugins");
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      items: [expect.objectContaining({
        name: "prospero-botmux",
        services: [expect.objectContaining({ id: "bridge", mode: "auto" })],
      })],
      errors: [],
    });

    const status = await waitFor(
      () => JSON.parse(readFileSync(path.join(home, "plugin-services", "state.json"), "utf8")) as {
        items: Record<string, { status: string; port: number | null; pid: number | null }>;
      },
      (value) => value.items["prospero-botmux/bridge"]?.status === "running",
    );
    const state = status.items["prospero-botmux/bridge"]!;
    expect(state.pid).toEqual(expect.any(Number));
    expect(state.port).toEqual(expect.any(Number));
    const envFile = path.join(home, "plugins", "prospero-botmux", "runtime", "env.json");
    await waitFor(() => existsSync(envFile), Boolean);
    const env = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, unknown>;
    expect(env).toMatchObject({
      home,
      plugin: "prospero-botmux",
      runtime: path.join(home, "plugins", "prospero-botmux", "runtime"),
      tokenPath: path.join(home, "control.token"),
      controlHttp: `http://127.0.0.1:${String(server.port)}`,
      apiKey: null,
    });

    const health = await auth(home, server, "/_prospero/control/plugin/prospero-botmux/service/bridge/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      pluginId: "prospero-botmux",
      serviceId: "bridge",
      status: "running",
      health: "healthy",
    });

    const stopped = await auth(home, server, "/_prospero/control/plugin/prospero-botmux/service/bridge/stop", { method: "POST" });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ status: "stopped", pid: null, port: null });
  });

  it("uses the same control socket path for manual start and restart", async () => {
    const home = tempHome();
    writePlugin(home, "manual");
    const server = await createDaemonServer({
      home,
      port: 0,
      workspaceRoot: home,
      structuredSupervisor: false,
      ptySupervisor: false,
      windowsSessionHost: false,
    });
    servers.push(server);
    const token = readFileSync(server.controlSocket.tokenPath, "utf8").trim();

    const started = await controlRequest<{ status: string; pid: number | null; port: number | null }>(
      { socketPath: server.controlSocket.path, token },
      "plugin.service.start",
      { pluginId: "prospero-botmux", serviceId: "bridge" },
    );
    expect(started).toMatchObject({ status: "running", pid: expect.any(Number), port: expect.any(Number) });

    const restarted = await controlRequest<{ status: string; pid: number | null; port: number | null }>(
      { socketPath: server.controlSocket.path, token },
      "plugin.service.restart",
      { pluginId: "prospero-botmux", serviceId: "bridge" },
    );
    expect(restarted).toMatchObject({ status: "running", pid: expect.any(Number), port: expect.any(Number) });

    const status = await controlRequest<{ items: Array<{ pluginId: string; serviceId: string; status: string }> }>(
      { socketPath: server.controlSocket.path, token },
      "plugin.service.status",
    );
    expect(status.items).toContainEqual(expect.objectContaining({
      pluginId: "prospero-botmux",
      serviceId: "bridge",
      status: "running",
    }));
  });

  it("keeps concurrent starts idempotent for one plugin service", async () => {
    const home = tempHome();
    writePlugin(home, "manual");
    const server = await createDaemonServer({
      home,
      port: 0,
      workspaceRoot: home,
      structuredSupervisor: false,
      ptySupervisor: false,
      windowsSessionHost: false,
    });
    servers.push(server);
    const token = readFileSync(server.controlSocket.tokenPath, "utf8").trim();

    const results = await Promise.all(Array.from({ length: 5 }, () =>
      controlRequest<{ status: string; pid: number | null }>(
        { socketPath: server.controlSocket.path, token },
        "plugin.service.start",
        { pluginId: "prospero-botmux", serviceId: "bridge" },
      ),
    ));

    expect(new Set(results.map((result) => result.pid)).size).toBe(1);
    expect(results.every((result) => result.status === "running")).toBe(true);
    const startsFile = path.join(home, "plugins", "prospero-botmux", "runtime", "starts.txt");
    await waitFor(() => existsSync(startsFile) ? readFileSync(startsFile, "utf8") : "", (value) => value === "1");
  });

  it("can stop a running service after its manifest disappears", async () => {
    const home = tempHome();
    writePlugin(home, "manual");
    const server = await createDaemonServer({
      home,
      port: 0,
      workspaceRoot: home,
      structuredSupervisor: false,
      ptySupervisor: false,
      windowsSessionHost: false,
    });
    servers.push(server);
    const token = readFileSync(server.controlSocket.tokenPath, "utf8").trim();
    const started = await controlRequest<{ pid: number | null }>(
      { socketPath: server.controlSocket.path, token },
      "plugin.service.start",
      { pluginId: "prospero-botmux", serviceId: "bridge" },
    );

    renameSync(
      path.join(home, "plugins", "prospero-botmux", "prospero-plugin.json"),
      path.join(home, "plugins", "prospero-botmux", "prospero-plugin.json.bak"),
    );
    const stopped = await controlRequest<{ status: string; configured: boolean; pid: number | null }>(
      { socketPath: server.controlSocket.path, token },
      "plugin.service.stop",
      { pluginId: "prospero-botmux", serviceId: "bridge" },
    );
    expect(stopped).toMatchObject({ status: "stopped", configured: false, pid: null });
    await waitFor(() => started.pid === null || !processAlive(started.pid), Boolean);
  });

  it("reuses a live persisted service after daemon restart and closes it with the new daemon", async () => {
    const home = tempHome();
    writePlugin(home, "manual");
    const first = new PluginServiceSupervisor({
      home,
      daemonPort: 7424,
      controlSocketPath: path.join(home, "control.sock"),
      controlTokenPath: path.join(home, "control.token"),
    });
    const started = await first.start("prospero-botmux", "bridge");
    expect(started.pid).toEqual(expect.any(Number));

    const second = new PluginServiceSupervisor({
      home,
      daemonPort: 7424,
      controlSocketPath: path.join(home, "control.sock"),
      controlTokenPath: path.join(home, "control.token"),
    });
    const reused = await second.start("prospero-botmux", "bridge");

    expect(reused).toMatchObject({ status: "running", pid: started.pid });
    await second.stopAll();
    await waitFor(() => started.pid === null || !processAlive(started.pid), Boolean);
  });

  it("does not report a quickly failing service as running", async () => {
    const home = tempHome();
    writePlugin(home, "manual", ["node", "missing.mjs"]);
    const server = await createDaemonServer({
      home,
      port: 0,
      workspaceRoot: home,
      structuredSupervisor: false,
      ptySupervisor: false,
      windowsSessionHost: false,
    });
    servers.push(server);
    const token = readFileSync(server.controlSocket.tokenPath, "utf8").trim();

    const started = await controlRequest<{ status: string; pid: number | null }>(
      { socketPath: server.controlSocket.path, token },
      "plugin.service.start",
      { pluginId: "prospero-botmux", serviceId: "bridge" },
    );
    expect(started.status).not.toBe("running");
    expect(started.pid).toBeNull();
  });

  it("exposes prosperod plugin service status", async () => {
    const home = tempHome();
    writePlugin(home, "manual");
    const server = await createDaemonServer({
      home,
      port: 0,
      workspaceRoot: home,
      structuredSupervisor: false,
      ptySupervisor: false,
      windowsSessionHost: false,
    });
    servers.push(server);

    const { stdout } = await exec(process.execPath, [
      path.join(process.cwd(), "dist", "cli.js"),
      "plugin", "service", "status",
      "--home", home,
    ], {
      env: {
        ...process.env,
        PATH: [path.dirname(process.execPath), process.env["PATH"] ?? ""].join(path.delimiter),
      },
    });
    expect(JSON.parse(stdout)).toMatchObject({
      items: [expect.objectContaining({
        pluginId: "prospero-botmux",
        serviceId: "bridge",
        status: "stopped",
      })],
      errors: [],
    });
  });
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
