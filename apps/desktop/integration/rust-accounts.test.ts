import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RustRuntime } from "../src/main/rust-runtime";
import { StateStore } from "../src/main/state-store";

const binary = resolve("../../target/debug", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const SECRET = "sk-prospero-desktop-managed-0123456789";
const fixtures: { directory: string; runtime: RustRuntime; dataDir: string }[] = [];

// Auth-status answers are driven by PROSPERO_FAKE_STATUS; the same script also
// speaks the catalog handshake, runs a headless turn, and emulates
// `setup-token` (records argv/env to LOGIN_CAPTURE, then idles on the PTY).
const MANAGED_CLAUDE = `#!/usr/bin/env python3
import json, os, sys, threading, time

argv = sys.argv[1:]

if argv == ["auth", "status", "--json"]:
    body = os.environ.get("PROSPERO_FAKE_STATUS", "")
    if body:
        sys.stdout.write(body)
    sys.exit(0)

catalog_args = ["-p", "--output-format", "stream-json",
                "--input-format", "stream-json", "--verbose"]

if argv == catalog_args:
    frame = json.loads(sys.stdin.readline())
    rid = frame["request_id"]
    sys.stdout.write(json.dumps({"type": "control_response", "response": {
        "subtype": "success", "request_id": rid,
        "response": {"models": [
            {"value": "default", "displayName": "Default",
             "supportedEffortLevels": ["low", "high"]}]}}}) + "\\n")
    sys.stdout.flush()
    sys.exit(0)

if argv == ["setup-token"]:
    login = os.environ.get("LOGIN_CAPTURE")
    if login:
        with open(login, "w", encoding="utf-8") as handle:
            json.dump({"argv": argv, "env": dict(os.environ)}, handle)
    time.sleep(3600)
    sys.exit(0)

# Headless turn: announce init then idle until the daemon closes us.
sys.stdout.write(json.dumps({"type": "system", "subtype": "init",
                             "session_id": "managed-fake"}) + "\\n")
sys.stdout.flush()
def answer_controls():
    while True:
        raw = sys.stdin.readline()
        if not raw:
            break
        try:
            frame = json.loads(raw)
        except Exception:
            continue
        sys.stdout.write(json.dumps({"type": "control_response", "response": {
            "subtype": "success", "request_id": frame.get("request_id"),
            "response": {}}}) + "\\n")
        sys.stdout.flush()
threading.Thread(target=answer_controls, daemon=True).start()
time.sleep(3600)
`;

// The auth-status-only script used by the discovery tests; argv-exact so a
// regression that mutates user CLI state fails the test.
const ACCOUNT_CLAUDE = `#!/usr/bin/env python3
import os, sys
if sys.argv[1:] != ["auth", "status", "--json"]:
    sys.exit(3)
body = os.environ.get("PROSPERO_FAKE_STATUS", "")
if body:
    sys.stdout.write(body)
`;

// Profile probes run `<claude> --version` with a scrubbed environment; the same
// script also answers the catalog handshake used by session model discovery.
const PROFILE_CLAUDE = `#!/usr/bin/env python3
import json, sys
argv = sys.argv[1:]
if argv == ["--version"]:
    sys.stdout.write("1.2.3-fake\\n")
    sys.exit(0)
if argv == ["auth", "status", "--json"]:
    sys.exit(0)
if argv == ["-p", "--output-format", "stream-json",
            "--input-format", "stream-json", "--verbose"]:
    frame = json.loads(sys.stdin.readline())
    rid = frame["request_id"]
    sys.stdout.write(json.dumps({"type": "control_response", "response": {
        "subtype": "success", "request_id": rid,
        "response": {"models": [
            {"value": "fakemodel-1", "displayName": "Fake Model"}]}}}) + "\\n")
    sys.stdout.flush()
    sys.exit(0)
sys.exit(0)
`;

interface FakeGateway {
  url: string;
  close: () => Promise<void>;
  messagesHits: () => number;
  modelsHits: () => number;
}

// Minimal Anthropic-compatible gateway: the two-turn forced-tool SSE handshake
// for connectivity probes plus a paginated /v1/models catalog.
function startGateway(options: { authFail?: boolean; pages?: unknown[] } = {}): FakeGateway {
  let messagesHits = 0;
  let modelsHits = 0;
  const pages = options.pages ?? [{ data: [{ id: "fakemodel-1" }] }];
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/messages") {
      messagesHits += 1;
      if (options.authFail) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "authentication_error" } }));
        return;
      }
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        const messages = Array.isArray(body["messages"]) ? body["messages"] as unknown[] : [];
        if (messages.length === 1) {
          const schema = ((body["tools"] as Record<string, unknown>[])[0]!["input_schema"]) as { properties: { nonce: { enum: string[] } } };
          const value = schema.properties.nonce.enum[0]!;
          for (const event of [
            { type: "message_start", message: { type: "message", role: "assistant", id: "msg-1" } },
            { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "prospero_connection_probe", input: {} } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ nonce: value }) } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "tool_use" } },
            { type: "message_stop" },
          ]) send(event);
        } else {
          const toolResult = messages.flatMap((message) => {
            const content = (message as Record<string, unknown>)["content"];
            return Array.isArray(content) ? content : [];
          }).find((block) => (block as Record<string, unknown>)["type"] === "tool_result") as Record<string, unknown> | undefined;
          const receipt = typeof toolResult?.["content"] === "string" ? toolResult["content"] : "missing";
          for (const event of [
            { type: "message_start", message: { type: "message", role: "assistant", id: "msg-2" } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: receipt } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" } },
            { type: "message_stop" },
          ]) send(event);
        }
        res.end();
      });
      return;
    }
    if (req.method === "GET" && (req.url === "/v1/models" || req.url?.startsWith("/v1/models?"))) {
      modelsHits += 1;
      const afterId = new URL(req.url!, "http://gateway").searchParams.get("after_id");
      const index = afterId ? Math.min(1, pages.length - 1) : 0;
      const page = pages[index]!;
      res.writeHead(options.authFail ? 401 : 200, { "content-type": "application/json" });
      res.end(options.authFail ? JSON.stringify({ error: { type: "authentication_error" } }) : JSON.stringify(page));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = (server.listen(0).address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
    messagesHits: () => messagesHits,
    modelsHits: () => modelsHits,
  };
}

const gateways: FakeGateway[] = [];


function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "rust-accounts-"));
  const dataDir = resolve(directory, "daemon");
  const store = new StateStore(resolve(directory, "desktop"), "api");
  const runtime = new RustRuntime(store, binary, dataDir);
  fixtures.push({ directory, runtime, dataDir });
  return { directory, runtime, store, dataDir };
}

function installCli(directory: string, script: string) {
  const cli = resolve(directory, "fake-claude.py");
  writeFileSync(cli, script);
  chmodSync(cli, 0o755);
  return cli;
}

describe.skipIf(process.platform === "win32")("Native account discovery through the Rust bridge", () => {
  let previousBin: string | undefined;
  let previousStatus: string | undefined;
  let previousLoginCapture: string | undefined;

  afterEach(async () => {
    for (const { directory, runtime } of fixtures.splice(0)) {
      expect((await runtime.stop()).ok).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
    await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
    if (previousBin === undefined) delete process.env["PROSPERO_CLAUDE_BIN"];
    else process.env["PROSPERO_CLAUDE_BIN"] = previousBin;
    if (previousStatus === undefined) delete process.env["PROSPERO_FAKE_STATUS"];
    else process.env["PROSPERO_FAKE_STATUS"] = previousStatus;
    if (previousLoginCapture === undefined) delete process.env["LOGIN_CAPTURE"];
    else process.env["LOGIN_CAPTURE"] = previousLoginCapture;
    previousBin = undefined;
    previousStatus = undefined;
    previousLoginCapture = undefined;
  });

  function start(directory: string, runtime: RustRuntime, scenario: string, script = ACCOUNT_CLAUDE) {
    const cli = installCli(directory, script);
    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    previousStatus = process.env["PROSPERO_FAKE_STATUS"];
    process.env["PROSPERO_CLAUDE_BIN"] = cli;
    process.env["PROSPERO_FAKE_STATUS"] = scenario;
    return runtime.start();
  }

  function control(runtime: RustRuntime, body: Record<string, unknown>, timeoutMs?: number) {
    return runtime.request("/_prospero/control/accounts", { method: "POST", body: body as never, timeoutMs });
  }

  function list(runtime: RustRuntime) {
    return control(runtime, { type: "agent.accounts.list", requestId: "bridge-1" });
  }

  it("returns the native-claude account with a fresh signed_in probe", async () => {
    const { directory, runtime } = fixture();
    await start(directory, runtime, '{"loggedIn":true,"authMethod":"api-token","apiProvider":"anthropic"}');
    const result = await list(runtime);
    expect(result).toMatchObject({
      type: "agent.accounts.result",
      requestId: "bridge-1",
      action: "list",
      ok: true,
    });
    const accounts = result!["accounts"] as unknown[];
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: "native-claude",
      agent: "claude",
      name: "本机默认",
      managed: false,
      isDefault: true,
      status: "signed_in",
      authMethod: "api-token",
      detail: "anthropic",
      capabilities: {
        sessionKinds: ["pty", "structured"],
        plan: true,
        resume: true,
        modelSelection: true,
        reasoningEffort: true,
      },
    });
  }, 30_000);

  it("maps a logged-out probe to signed_out", async () => {
    const { directory, runtime } = fixture();
    await start(directory, runtime, '{"loggedIn":false}');
    const result = await list(runtime);
    const accounts = result!["accounts"] as Record<string, unknown>[];
    expect(accounts[0]!["status"]).toBe("signed_out");
    expect(accounts[0]!["authMethod"]).toBeUndefined();
  }, 30_000);

  it("rejects unknown account actions", async () => {
    const { directory, runtime } = fixture();
    await start(directory, runtime, '{"loggedIn":true}');
    await expect(control(runtime, { type: "agent.account.something-else", requestId: "bridge-x" }))
      .rejects.toThrow(/不支持的账号操作/);
  }, 30_000);

  it("validates API profile envelopes in the bridge before forwarding", async () => {
    const { directory, runtime } = fixture();
    await start(directory, runtime, '{"loggedIn":true}', PROFILE_CLAUDE);
    const gateway = startGateway();
    gateways.push(gateway);
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ type: "agent.account.api.create", requestId: "r", agent: "codex", name: "x", baseUrl: gateway.url, model: "m", apiKey: SECRET }, /仅支持 Claude/],
      [{ type: "agent.account.api.create", requestId: "r", agent: "claude", name: "x", baseUrl: "https://x\n/path", model: "m", apiKey: SECRET }, /API 地址格式无效/],
      [{ type: "agent.account.api.create", requestId: "r", agent: "claude", name: "x", baseUrl: `https://${"a".repeat(2001)}`, model: "m", apiKey: SECRET }, /API 地址格式无效/],
      [{ type: "agent.account.api.create", requestId: "r", agent: "claude", name: "x", baseUrl: gateway.url, model: "m", apiKey: "  " }, /API Key 格式无效/],
      [{ type: "agent.account.api.create", requestId: "r", agent: "claude", name: "x", baseUrl: gateway.url, model: "m", apiKey: SECRET, protocol: "openai_responses" }, /Agent、Provider 与 API 协议/],
      [{ type: "agent.account.api.create", requestId: "r", agent: "claude", name: "x", baseUrl: gateway.url, model: "m", apiKey: SECRET, modelCapabilities: { maxOutputTokens: 0 } }, /模型能力配置无效/],
      [{ type: "agent.account.api.create", requestId: "r", agent: "claude", name: "x", baseUrl: gateway.url, model: "m", apiKey: SECRET, modelCapabilities: { tools: "yes" } }, /模型能力配置无效/],
      [{ type: "agent.account.api.configure", requestId: "r", accountId: "native-claude", name: "x" }, /账号 ID 无效/],
      [{ type: "agent.account.api.configure", requestId: "r", accountId: "../escape", name: "x" }, /账号 ID 无效/],
      [{ type: "agent.account.api.test", requestId: "r", accountId: "native-claude" }, /账号 ID 无效/],
      [{ type: "agent.account.api.test", requestId: "r", accountId: "abc", scope: "engine" }, /引擎验证尚未接入/],
      [{ type: "agent.account.api.test", requestId: "r", accountId: "abc", scope: "bogus" }, /连接测试范围无效/],
    ];
    for (const [body, matcher] of bad) {
      await expect(control(runtime, body)).rejects.toThrow(matcher);
    }
    // Model-catalog draft validation, including the account/draft XOR and the
    // anthropic-only protocol gate.
    await expect(control(runtime, {
      type: "agent.account.api.models.get", requestId: "r",
      accountId: "abc", baseUrl: gateway.url, apiKey: SECRET,
    })).rejects.toThrow(/不能同时指定账号与草稿配置/);
    await expect(control(runtime, {
      type: "agent.account.api.models.get", requestId: "r",
      protocol: "openai_responses", baseUrl: gateway.url, apiKey: SECRET,
    })).rejects.toThrow(/仅支持 Anthropic 协议/);
  }, 30_000);

  it("runs the API profile create/test/models/configure lifecycle against a fake gateway", async () => {
    const { directory, runtime, dataDir } = fixture();
    const gateway = startGateway({
      pages: [
        { data: [{ id: "m-002", display_name: "Model Two", max_tokens: 8192 }], has_more: true, last_id: "m-002" },
        { data: [{ id: "m-001", name: "Model One" }, { id: "m-003" }] },
      ],
    });
    gateways.push(gateway);
    await start(directory, runtime, '{"loggedIn":true}', PROFILE_CLAUDE);

    // Create: key lands in a 0600 credential file inside the isolated 0700
    // root, and the snapshot carries profile metadata but never the secret.
    const created = await control(runtime, {
      type: "agent.account.api.create", requestId: "p1",
      agent: "claude", name: "  第三方 Profile  ",
      baseUrl: gateway.url, model: "fakemodel-1", apiKey: SECRET,
      modelCapabilities: { contextWindow: 128_000, tools: true, vision: false },
    });
    const id = created!["accountId"] as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const createdRow = (created!["accounts"] as Record<string, unknown>[]).find((row) => row["id"] === id);
    expect(createdRow).toMatchObject({
      name: "第三方 Profile", status: "signed_in", authMethod: "API Key", managed: true,
      apiProfile: { baseUrl: gateway.url, model: "fakemodel-1" },
      capabilities: { sessionKinds: ["pty", "structured"], plan: true, resume: true, modelSelection: false, reasoningEffort: false },
    });
    expect(createdRow!["apiValidation"] ?? null).toBeNull();
    const root = resolve(dataDir, "agent-accounts", "claude", id);
    const credentialPath = resolve(root, ".prospero-credential.json");
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(credentialPath, "utf8"))["kind"]).toBe("api_key");
    expect(JSON.stringify(created)).not.toContain(SECRET);

    // Connectivity probe: real two-turn SSE handshake through the fake gateway.
    const tested = await control(runtime, {
      type: "agent.account.api.test", requestId: "p2", accountId: id,
    }, 45_000);
    expect(tested).toMatchObject({
      accountId: id,
      validation: { status: "passed", engine: "claude", checks: { runtime: "passed", streaming: "passed", tools: "passed" } },
    });
    expect(gateway.messagesHits()).toBe(2);
    const listed = await list(runtime);
    const listedRow = (listed!["accounts"] as Record<string, unknown>[]).find((row) => row["id"] === id)!;
    expect((listedRow!["apiValidation"] as Record<string, unknown>)["status"]).toBe("passed");
    expect(String(listedRow!["detail"])).toContain("协议测试通过");
    expect(JSON.stringify(listed)).not.toContain(SECRET);

    // Model catalog for the stored account follows pagination and sorts.
    const models = await control(runtime, {
      type: "agent.account.api.models.get", requestId: "p3", accountId: id,
    }, 35_000);
    expect(models!["ok"]).toBe(true);
    expect((models!["models"] as Record<string, unknown>[]).map((row) => row["id"])).toEqual(["m-001", "m-002", "m-003"]);
    expect(gateway.modelsHits()).toBe(2);

    // Draft catalog uses a pasted endpoint and never touches stored rows.
    const draft = await control(runtime, {
      type: "agent.account.api.models.get", requestId: "p4",
      baseUrl: `${gateway.url}/v1/models`, apiKey: SECRET,
    }, 35_000);
    expect(draft!["ok"]).toBe(true);
    expect((draft!["models"] as Record<string, unknown>[]).length).toBeGreaterThan(0);

    // Rename keeps the recorded validation; a model change clears it.
    const renamed = await control(runtime, {
      type: "agent.account.api.configure", requestId: "p5", accountId: id, name: "renamed",
    });
    expect(((renamed!["accounts"] as Record<string, unknown>[]).find((row) => row["id"] === id)!)["apiValidation"]).toBeTruthy();
    const reconfigured = await control(runtime, {
      type: "agent.account.api.configure", requestId: "p6", accountId: id, model: "fakemodel-2",
    });
    const changedRow = (reconfigured!["accounts"] as Record<string, unknown>[]).find((row) => row["id"] === id)!;
    expect((changedRow!["apiProfile"] as Record<string, unknown>)["model"]).toBe("fakemodel-2");
    expect(changedRow!["apiValidation"] ?? null).toBeNull();

    // A failing probe keeps a stable in-envelope code and never throws.
    const authGateway = startGateway({ authFail: true });
    gateways.push(authGateway);
    const failed = await control(runtime, {
      type: "agent.account.api.create", requestId: "p7",
      agent: "claude", name: "failing",
      baseUrl: authGateway.url, model: "fakemodel-1", apiKey: SECRET,
    });
    const failingId = failed!["accountId"] as string;
    const failedTest = await control(runtime, {
      type: "agent.account.api.test", requestId: "p8", accountId: failingId,
    }, 45_000);
    expect((failedTest!["validation"] as Record<string, unknown>)["status"]).toBe("failed");
    expect((failedTest!["validation"] as Record<string, unknown>)["code"]).toBe("authentication_failed");

    // The native row is not a profile: test is a bridge-side id rejection and
    // its catalog returns an in-body feature error rather than throwing.
    await expect(control(runtime, { type: "agent.account.api.configure", requestId: "p9", accountId: id, apiKey: "" })).resolves.toBeTruthy();
    const nativeModels = await control(runtime, {
      type: "agent.account.api.models.get", requestId: "p10", accountId: "native-claude",
    });
    expect(nativeModels!["ok"]).toBe(false);
    expect((nativeModels!["error"] as Record<string, unknown>)["code"]).toBe("unsupported");
  }, 90_000);

  it("validates managed-action envelopes before forwarding them", async () => {
    const { directory, runtime } = fixture();
    await start(directory, runtime, '{"loggedIn":true}');
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ type: "agent.account.create", requestId: "r", agent: "codex", name: "x" }, /仅支持 Claude/],
      [{ type: "agent.account.create", requestId: "r", agent: "claude", name: "   " }, /账号名称/],
      [{ type: "agent.account.create", requestId: "r", agent: "claude", name: "名".repeat(81) }, /账号名称/],
      [{ type: "agent.account.rename", requestId: "r", accountId: "native-claude", name: "x" }, /账号 ID 无效/],
      [{ type: "agent.account.rename", requestId: "r", accountId: "../escape", name: "x" }, /账号 ID 无效/],
      [{ type: "agent.account.login", requestId: "r", accountId: "abc", cols: 4, rows: 40 }, /终端尺寸/],
      [{ type: "agent.account.credential.set", requestId: "r", accountId: "abc", credentialKind: "bad", credential: SECRET }, /凭据类型/],
      [{ type: "agent.account.credential.set", requestId: "r", accountId: "abc", credentialKind: "api_key", credential: "short" }, /凭据格式/],
      [{ type: "agent.account.credential.set", requestId: "r", accountId: "abc", credentialKind: "api_key", credential: `${SECRET}\n` }, /凭据格式/],
    ];
    for (const [body, matcher] of bad) {
      await expect(control(runtime, body)).rejects.toThrow(matcher);
    }
  }, 30_000);

  it("runs the managed create/rename/default/credential/login/logout/delete lifecycle", async () => {
    const { directory, runtime, dataDir } = fixture();
    // The daemon (and therefore every spawned CLI) inherits this, so it must
    // be present before the runtime starts.
    const loginCapture = resolve(directory, "login.json");
    previousLoginCapture = process.env["LOGIN_CAPTURE"];
    process.env["LOGIN_CAPTURE"] = loginCapture;
    await start(directory, runtime, '{"loggedIn":true}', MANAGED_CLAUDE);

    // Create: first managed account becomes the default; the native row yields.
    const created = await control(runtime, {
      type: "agent.account.create", requestId: "c1", agent: "claude", name: "  工作账号  ",
    });
    const accounts = created!["accounts"] as Record<string, unknown>[];
    const id = created!["accountId"] as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const first = accounts.find((row) => row["id"] === id);
    expect(first).toMatchObject({
      agent: "claude", managed: true, name: "工作账号", isDefault: true, status: "signed_in",
    });
    expect(accounts.find((row) => row["id"] === "native-claude")!["isDefault"]).toBe(false);

    // Rename.
    const renamed = await control(runtime, {
      type: "agent.account.rename", requestId: "c2", accountId: id, name: "renamed",
    });
    expect((renamed!["accounts"] as Record<string, unknown>[]).find((row) => row["id"] === id)!["name"]).toBe("renamed");

    // Credential: persisted as a 0600 file inside the isolated root, never in
    // a snapshot, even via error paths.
    await control(runtime, {
      type: "agent.account.credential.set", requestId: "c3",
      accountId: id, credentialKind: "oauth_token", credential: `  ${SECRET}  `,
    });
    const root = resolve(dataDir, "agent-accounts", "claude", id);
    const credentialPath = resolve(root, ".prospero-credential.json");
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(await list(runtime))).not.toContain(SECRET);

    // Catalog probe and structured session creation bind the managed account.
    const catalog = await runtime.request(
      `/_prospero/control/launch/models?agent=claude&accountId=${encodeURIComponent(id)}`,
    );
    expect((catalog!["models"] as Record<string, unknown>[]).map((model) => model["id"])).toEqual(["default"]);

    const workspace = resolve(directory, "workspace");
    mkdirSync(workspace, { recursive: true });
    const session = await runtime.request("/_prospero/control/session/create", {
      method: "POST",
      body: { kind: "structured", agent: "claude", cwd: workspace, approvalPolicy: "standard", accountId: id },
    });
    const sessionId = session!["id"] as string;

    // A second account does not steal the default; switching moves the flag.
    const second = await control(runtime, {
      type: "agent.account.create", requestId: "c4", agent: "claude", name: "second",
    });
    const id2 = second!["accountId"] as string;
    expect((second!["accounts"] as Record<string, unknown>[]).find((row) => row["id"] === id2)!["isDefault"]).toBe(false);
    await control(runtime, { type: "agent.account.default", requestId: "c5", accountId: id2 });
    const afterDefault = (await list(runtime))!["accounts"] as Record<string, unknown>[];
    expect(afterDefault.find((row) => row["id"] === id)!["isDefault"]).toBe(false);
    expect(afterDefault.find((row) => row["id"] === id2)!["isDefault"]).toBe(true);
    await control(runtime, { type: "agent.account.default", requestId: "c6", accountId: id });

    // In-use delete is a daemon 409 with its own in_use code, surfaced as a
    // dedicated message rather than the generic "stale record" conflict.
    await expect(control(runtime, { type: "agent.account.delete", requestId: "c7", accountId: id }))
      .rejects.toThrow(/该账号仍有活跃会话/);
    await runtime.request(`/_prospero/control/session/${sessionId}/kill`, { method: "POST" });

    // Login opens a real PTY running `setup-token` with cleared secrets.
    const login = await control(runtime, {
      type: "agent.account.login", requestId: "c8", accountId: id, cols: 120, rows: 40,
    });
    expect(login!["accountId"]).toBe(id);
    const terminalId = login!["sessionId"] as string;
    expect(terminalId).toMatch(/^[0-9a-f-]{36}$/);
    let dumped: { argv: string[]; env: Record<string, string> } | undefined;
    for (let attempt = 0; attempt < 100 && !dumped; attempt += 1) {
      try {
        dumped = await Promise.resolve().then(() => JSON.parse(require("node:fs").readFileSync(loginCapture, "utf8")));
      } catch {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
      }
    }
    expect(dumped!["argv"]).toEqual(["setup-token"]);
    expect(dumped!["env"]["CLAUDE_CONFIG_DIR"]).toBe(root);
    expect(dumped!["env"]["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("");
    expect(dumped!["env"]["ANTHROPIC_API_KEY"]).toBe("");

    // Unknown managed ids reach the daemon and come back as 404.
    await expect(control(runtime, {
      type: "agent.account.rename", requestId: "c9", accountId: "00000000-0000-0000-0000-000000000000", name: "x",
    })).rejects.toThrow(/Rust 服务请求失败（404）/);

    // Close the login PTY, logout (credential file removed), then delete.
    await runtime.request(`/_prospero/control/session/${terminalId}/kill`, { method: "POST" });
    await control(runtime, { type: "agent.account.logout", requestId: "c10", accountId: id });
    const finalList = await control(runtime, {
      type: "agent.account.delete", requestId: "c11", accountId: id,
    });
    const remaining = finalList!["accounts"] as Record<string, unknown>[];
    expect(remaining.find((row) => row["id"] === id)).toBeUndefined();
    expect(require("node:fs").existsSync(root)).toBe(false);
  }, 60_000);

  it("accepts the native account id when creating a structured session", async () => {
    const { directory, runtime } = fixture();
    await start(directory, runtime, '{"loggedIn":true}', MANAGED_CLAUDE);
    const created = await runtime.request("/_prospero/control/session/create", {
      method: "POST",
      body: { kind: "structured", agent: "claude", cwd: directory, approvalPolicy: "standard", accountId: "native-claude" },
    });
    expect(created!["agent"]).toBe("claude");
  }, 30_000);
});
