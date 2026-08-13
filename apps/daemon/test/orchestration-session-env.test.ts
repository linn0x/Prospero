import type {
  AdapterContext,
  AgentAdapter,
  AgentModelCatalog,
} from "../src/adapters/types.js";
import { SessionManager } from "../src/session-manager.js";
import { afterEach, describe, expect, it } from "vitest";

class EnvAdapter implements AgentAdapter {
  context: AdapterContext | null = null;

  async start(context: AdapterContext): Promise<void> {
    this.context = context;
  }

  async send(): Promise<void> {}
  async listModels(): Promise<AgentModelCatalog> {
    return {
      models: [{ id: "native-model", label: "Native", supportedEfforts: ["low", "high"] }],
      currentModel: "native-model",
      currentEffort: "low",
    };
  }
  async respondPermission(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {}
}

describe("编排会话环境", () => {
  const managers: SessionManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  });

  it("给结构化 worker 注入稳定会话身份与控制 socket", async () => {
    let adapter: EnvAdapter | null = null;
    const manager = new SessionManager({
      sessionEnv: (sessionId) => ({
        PROSPERO_SESSION_ID: sessionId,
        PROSPERO_CONTROL_SOCK: "/tmp/prospero-control.sock",
        PROSPERO_CONTROL_TOKEN_PATH: "/tmp/prospero-control.token",
      }),
      adapterFactory: () => {
        adapter = new EnvAdapter();
        return adapter;
      },
    });
    managers.push(manager);

    const info = await manager.create({
      agent: "codex",
      kind: "structured",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      allowShell: false,
    });

    expect(adapter?.context?.env).toEqual({
      PROSPERO_SESSION_ID: info.id,
      PROSPERO_CONTROL_SOCK: "/tmp/prospero-control.sock",
      PROSPERO_CONTROL_TOKEN_PATH: "/tmp/prospero-control.token",
    });
  });

  it("创建前模型探针不登记会话，并以 catalogOnly 启动临时适配器", async () => {
    let adapter: EnvAdapter | null = null;
    const manager = new SessionManager({
      adapterFactory: () => {
        adapter = new EnvAdapter();
        return adapter;
      },
    });
    managers.push(manager);

    const catalog = await manager.launchModels("codex");

    expect(catalog).toMatchObject({
      currentModel: "native-model",
      models: [{ id: "native-model" }],
    });
    expect(adapter?.context?.catalogOnly).toBe(true);
    expect(manager.list()).toEqual([]);
  });
});
