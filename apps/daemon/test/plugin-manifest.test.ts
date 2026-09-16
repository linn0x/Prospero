import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProsperoPlugins } from "../src/plugins/discovery.js";

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "prospero-plugin-manifest-"));
  homes.push(home);
  return home;
}

function writePlugin(home: string, name: string, manifest: Record<string, unknown>): void {
  const root = path.join(home, "plugins", name);
  mkdirSync(path.join(root, "runtime"), { recursive: true });
  writeFileSync(path.join(root, "prospero-plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Prospero plugin manifest discovery", () => {
  it("parses standalone plugin services and resolves paths inside plugin root", () => {
    const home = tempHome();
    writePlugin(home, "prospero-botmux", {
      schema_version: "prospero-plugin/v1",
      name: "prospero-botmux",
      version: "0.1.0",
      skills_root: "skills",
      agents_root: "agents",
      runtime_root: "runtime",
      bootstrap: "scripts/bootstrap.py",
      services: [{
        id: "bridge",
        mode: "manual",
        command: ["node", "service.mjs"],
        cwd: "runtime",
        env: { FEATURE_FLAG: "1" },
        port_env: "PORT",
        health_path: "/health",
      }],
    });

    const result = discoverProsperoPlugins(home);
    expect(result.errors).toEqual([]);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]).toMatchObject({
      name: "prospero-botmux",
      version: "0.1.0",
      services: [expect.objectContaining({
        id: "bridge",
        mode: "manual",
        cwd: path.join(home, "plugins", "prospero-botmux", "runtime"),
        command: ["node", path.join(home, "plugins", "prospero-botmux", "runtime", "service.mjs")],
        env: { FEATURE_FLAG: "1" },
        portEnv: "PORT",
        healthPath: "/health",
      })],
    });
  });

  it("rejects shell command strings, secret material, and paths outside plugin root", () => {
    const home = tempHome();
    writePlugin(home, "bad-shell", {
      schema_version: "prospero-plugin/v1",
      name: "bad-shell",
      services: [{ id: "bridge", command: "node service.mjs" }],
    });
    writePlugin(home, "bad-cred", {
      schema_version: "prospero-plugin/v1",
      name: "bad-cred",
      services: [{ id: "bridge", command: ["node", "service.mjs"], env: { API_SECRET: "value" } }],
    });
    writePlugin(home, "bad-path", {
      schema_version: "prospero-plugin/v1",
      name: "bad-path",
      runtime_root: "../outside",
      services: [],
    });
    writePlugin(home, "wrong-dir", {
      schema_version: "prospero-plugin/v1",
      name: "other-name",
      services: [],
    });

    const result = discoverProsperoPlugins(home);
    expect(result.plugins).toEqual([]);
    expect(result.errors.map((error) => error.message)).toEqual(expect.arrayContaining([
      "service.command must be an argv array",
      "services.0.env.API_SECRET must not contain secret material",
      "../outside escapes plugin root",
      "manifest name must match plugin directory",
    ]));
  });

  it("ignores installer backup plugin directories", () => {
    const home = tempHome();
    writePlugin(home, "sample-plugin.backup-123", {
      schema_version: "prospero-plugin/v1",
      name: "sample-plugin",
      services: [],
    });

    const result = discoverProsperoPlugins(home);
    expect(result).toEqual({ plugins: [], errors: [] });
  });
});
