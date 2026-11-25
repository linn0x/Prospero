#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use prosperod_rs::{
    agent::PermissionMode,
    auth::Token,
    protocol::{MessageRole, NativeSession, SessionStatus, TimelineBody, TimelineQuery},
    server::Api,
    worker::Database,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const SECRET: &str = "sk-prospero-source-switch-0123456789";
const BEARER: &str = "Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const FAKE_CLAUDE: &str = r#"#!/usr/bin/env python3
import json, os, sys, time, uuid

if sys.argv[1:] == ["--version"]:
    print("2.1.0-fake")
    sys.exit(0)

if sys.argv[1:] == ["auth", "status", "--json"]:
    sys.exit(0)

is_structured = len(sys.argv) > 1 and sys.argv[1] == "-p"
if not is_structured:
    import signal
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGHUP, lambda *_: sys.exit(0))
    cwd = os.getcwd()
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", "")
    resume = None
    for i, arg in enumerate(sys.argv[1:]):
        if arg == "--resume" and i + 2 < len(sys.argv):
            resume = sys.argv[i + 2]
        elif arg.startswith("--resume="):
            resume = arg.split("=", 1)[1]
    with open(os.path.join(cwd, "claude-pty-calls.log"), "a", encoding="utf-8") as log:
        json.dump({
            "argv": sys.argv[1:],
            "resume": resume,
            "config_dir": config_dir,
            "model": os.environ.get("ANTHROPIC_MODEL"),
            "base_url": os.environ.get("ANTHROPIC_BASE_URL"),
        }, log)
        log.write("\n")
    sys.stdout.write("claude pty ready\n")
    sys.stdout.flush()
    while True:
        time.sleep(0.05)

if sys.argv[1:] == ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"]:
    line = sys.stdin.readline()
    frame = json.loads(line)
    sys.stdout.write(json.dumps({
        "type": "control_response",
        "response": {"subtype": "success", "request_id": frame["request_id"], "response": {"models": []}}
    }) + "\n")
    sys.stdout.flush()
    sys.exit(0)

cwd = os.getcwd()
config_dir = os.environ.get("CLAUDE_CONFIG_DIR", "")
resume = None
for arg in sys.argv[1:]:
    if arg.startswith("--resume="):
        resume = arg.split("=", 1)[1]

session_id = resume or str(uuid.uuid4())

def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

emit({"type": "system", "subtype": "init", "session_id": session_id})
line = sys.stdin.readline()

with open(os.path.join(cwd, "claude-calls.log"), "a", encoding="utf-8") as log:
    json.dump({
        "argv": sys.argv[1:],
        "resume": resume,
        "session_id": session_id,
        "config_dir": config_dir,
        "model": os.environ.get("ANTHROPIC_MODEL"),
        "base_url": os.environ.get("ANTHROPIC_BASE_URL"),
        "prompt": line,
    }, log)
    log.write("\n")

# Persist a native Claude transcript file including a thinking block so same-engine
# migration proves thinking blocks are stripped across config directories.
if config_dir:
    project_key = "".join(c if c.isalnum() else "-" for c in os.path.realpath(cwd))
    project_dir = os.path.join(config_dir, "projects", project_key)
    os.makedirs(project_dir, exist_ok=True)
    transcript_path = os.path.join(project_dir, f"{session_id}.jsonl")
    u_id = str(uuid.uuid4())
    a_id = str(uuid.uuid4())
    if not os.path.exists(transcript_path):
        with open(transcript_path, "w", encoding="utf-8") as tf:
            tf.write(json.dumps({
                "sessionId": session_id,
                "cwd": cwd,
                "isSidechain": False,
                "timestamp": "2026-01-01T00:00:00.000Z",
                "version": "2.1.0",
                "type": "user",
                "uuid": u_id,
                "parentUuid": None,
                "message": {"role": "user", "content": "Initial question"},
            }) + "\n")
            tf.write(json.dumps({
                "sessionId": session_id,
                "cwd": cwd,
                "isSidechain": False,
                "timestamp": "2026-01-01T00:00:01.000Z",
                "version": "2.1.0",
                "type": "assistant",
                "uuid": a_id,
                "parentUuid": u_id,
                "message": {
                    "role": "assistant",
                    "type": "message",
                    "id": "msg_1",
                    "model": os.environ.get("ANTHROPIC_MODEL", "claude-route-1"),
                    "content": [
                        {"type": "thinking", "thinking": "private chain", "signature": "sig_foreign_secret"},
                        {"type": "text", "text": "Answer from claude"},
                    ],
                    "stop_reason": "end_turn",
                },
            }) + "\n")

if os.path.exists(os.path.join(cwd, "hang_claude")):
    time.sleep(10)

emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}})
emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Answer from claude"}}})
emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})
emit({"type": "result", "subtype": "success", "is_error": False})
time.sleep(0.1)
"#;

const FAKE_CODEX: &str = r#"#!/usr/bin/env python3
import json, os, signal, sys, time

if sys.argv[1:] == ["--version"]:
    print("0.153.0-fake")
    sys.exit(0)
if len(sys.argv) > 1 and sys.argv[1] == "login":
    sys.exit(0)

cwd = os.getcwd()
if "app-server" not in sys.argv[1:]:
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGHUP, lambda *_: sys.exit(0))
    with open(os.path.join(cwd, "codex-pty-calls.log"), "a", encoding="utf-8") as log:
        json.dump({
            "argv": sys.argv[1:],
            "env_model": os.environ.get("PROSPERO_API_PROFILE_MODEL"),
            "codex_home": os.environ.get("CODEX_HOME"),
        }, log)
        log.write("\n")
    sys.stdout.write("codex pty ready\n")
    sys.stdout.flush()
    while True:
        time.sleep(0.05)

thread_id = "thread-codex-handoff-1"
turn_id = "turn-codex-1"

def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

def respond(rpc_id, result):
    emit({"jsonrpc": "2.0", "id": rpc_id, "result": result})

for line in sys.stdin:
    if not line.strip():
        continue
    msg = json.loads(line)
    method = msg.get("method")
    rpc_id = msg.get("id")
    params = msg.get("params") or {}
    if method == "initialize":
        respond(rpc_id, {"protocolVersion": 1})
    elif method == "initialized":
        pass
    elif method == "thread/start":
        with open(os.path.join(cwd, "codex-thread-start.json"), "w", encoding="utf-8") as log:
            json.dump({"argv": sys.argv[1:], "params": params, "env_model": os.environ.get("PROSPERO_API_PROFILE_MODEL")}, log)
        respond(rpc_id, {"thread": {"id": thread_id}})
    elif method == "turn/start":
        with open(os.path.join(cwd, "codex-turn-start.json"), "w", encoding="utf-8") as log:
            json.dump(params, log)
        emit({"jsonrpc": "2.0", "method": "turn/started", "params": {"threadId": params.get("threadId"), "turn": {"id": turn_id}}})
        emit({"jsonrpc": "2.0", "method": "item/agentMessage/delta", "params": {"threadId": params.get("threadId"), "turnId": turn_id, "itemId": "item-1", "delta": "Answer from codex"}})
        emit({"jsonrpc": "2.0", "method": "turn/completed", "params": {"threadId": params.get("threadId"), "turn": {"id": turn_id, "status": "completed"}}})
        respond(rpc_id, {"turn": {"id": turn_id}})
        time.sleep(0.1)
        break
    else:
        respond(rpc_id, {})
"#;

struct Harness {
    _dir: TempDir,
    workspace: TempDir,
    database: Database,
    api: Api,
    app: axum::Router,
}

impl Harness {
    async fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let claude_bin = dir.path().join("fake-claude.py");
        let codex_bin = dir.path().join("fake-codex.py");
        std::fs::write(&claude_bin, FAKE_CLAUDE).unwrap();
        std::fs::write(&codex_bin, FAKE_CODEX).unwrap();
        std::fs::set_permissions(&claude_bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&codex_bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        unsafe {
            std::env::set_var("PROSPERO_CLAUDE_BIN", &claude_bin);
            std::env::set_var("PROSPERO_CODEX_BIN", &codex_bin);
        }
        let database = Database::open(dir.path().join("daemon")).await.unwrap();
        let api = Api::new(
            database.clone(),
            Token::parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into())
                .unwrap(),
        );
        let app = api.router();
        Self {
            _dir: dir,
            workspace,
            database,
            api,
            app,
        }
    }

    async fn post(&self, path: &str, payload: Value) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("authorization", BEARER)
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, body)
    }

    async fn wait_for_turns(&self, session_id: &str, expected_turns: usize) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let sid = session_id.to_owned();
            let page = self
                .database
                .call(move |store| {
                    store.timeline(
                        &sid,
                        TimelineQuery {
                            before: None,
                            after: None,
                            limit: Some(100),
                        },
                    )
                })
                .await
                .unwrap();
            let count = page
                .items
                .iter()
                .filter(|item| matches!(item.body, TimelineBody::TurnEnd { .. }))
                .count();
            if count >= expected_turns {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {expected_turns} turns on {session_id}; got {count}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

#[tokio::test]
async fn switches_same_engine_and_cross_engine_model_sources_in_session() {
    let _guard = SERIAL.lock().await;
    let h = Harness::new().await;

    // 1. Create a model source with two Anthropic routes, one OpenAI Responses route, and one Chat Completions route.
    let (status, created_source) = h
        .post(
            "/v1/model-sources",
            json!({
                "type": "model.source.action",
                "requestId": "req-create-src",
                "action": {
                    "kind": "create",
                    "operationId": "op-create-switch-1",
                    "name": "Gateway A",
                    "credential": { "name": "Main Key", "apiKey": SECRET },
                    "endpoints": [
                        { "protocol": "anthropic", "baseUrl": "https://anthropic-1.example.com" },
                        { "protocol": "openai_responses", "baseUrl": "https://responses.example.com/v1" },
                        { "protocol": "openai_chat_completions", "baseUrl": "https://chat.example.com/v1" }
                    ],
                    "routes": [
                        { "name": "Claude Route 1", "model": "claude-route-1", "protocol": "anthropic", "enabled": true, "modelCapabilities": { "tools": true, "supportedEfforts": ["low", "high"] }, "defaultEffort": "high" },
                        { "name": "Claude Route 2", "model": "claude-route-2", "protocol": "anthropic", "enabled": true, "modelCapabilities": { "tools": true, "supportedEfforts": ["medium", "max"] }, "defaultEffort": "medium" },
                        { "name": "Codex Route", "model": "gpt-codex-1", "protocol": "openai_responses", "enabled": true, "modelCapabilities": { "tools": true, "supportedEfforts": ["low", "medium", "high"] }, "defaultEffort": "medium" },
                        { "name": "Pi Chat Route", "model": "deepseek-chat-1", "protocol": "openai_chat_completions", "enabled": true, "modelCapabilities": { "tools": true } }
                    ]
                }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created_source}");
    let source = &created_source["sources"][0];
    let source_id = source["id"].as_str().unwrap().to_owned();
    let revision = source["revision"].as_i64().unwrap();
    let routes = source["routes"].as_array().unwrap();
    let route_claude_1 = routes[0]["id"].as_str().unwrap().to_owned();
    let route_claude_2 = routes[1]["id"].as_str().unwrap().to_owned();
    let route_codex = routes[2]["id"].as_str().unwrap().to_owned();
    let route_pi_chat = routes[3]["id"].as_str().unwrap().to_owned();

    // 2. Bind route_claude_1 and create a structured Claude session in plan mode.
    let (status, bound) = h
        .post(
            "/v1/model-sources",
            json!({
                "type": "model.source.action",
                "requestId": "req-bind-1",
                "action": {
                    "kind": "bind",
                    "sourceId": source_id,
                    "routeId": route_claude_1,
                    "revision": revision,
                    "agent": "claude"
                }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let account_1 = bound["accountId"].as_str().unwrap().to_owned();

    let (status, session) = h
        .post(
            "/v1/agent-sessions",
            json!({
                "agent": "claude",
                "title": "Source Switch Test",
                "workspace": h.workspace.path().to_str().unwrap(),
                "mode": "plan",
                "model": "claude-route-1",
                "accountId": account_1
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let session_id = session["id"].as_str().unwrap().to_owned();

    // 3. Run Turn 1 on Claude Route 1.
    let (status, _) = h
        .post(
            &format!("/v1/agent-sessions/{session_id}/send"),
            json!({ "text": "Initial question" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    h.wait_for_turns(&session_id, 1).await;

    let first_call: Value = serde_json::from_str(
        std::fs::read_to_string(h.workspace.path().join("claude-calls.log"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    let first_native_id = first_call["session_id"].as_str().unwrap().to_owned();
    assert_eq!(first_call["model"].as_str(), Some("claude-route-1"));

    // 4. Same-engine switch: Claude Route 1 -> Claude Route 2.
    let (status, switched_same) = h
        .post(
            &format!("/v1/agent-sessions/{session_id}/model-source"),
            json!({
                "sourceId": source_id,
                "routeId": route_claude_2,
                "revision": revision,
                "agent": "claude"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "switch failed: {switched_same}");
    assert_eq!(switched_same["handoffMode"].as_str(), Some("native"));
    assert_eq!(switched_same["previousEngine"].as_str(), Some("claude"));
    assert_eq!(switched_same["engine"].as_str(), Some("claude"));
    assert_eq!(switched_same["currentModel"].as_str(), Some("claude-route-2"));
    assert_eq!(switched_same["currentEffort"].as_str(), Some("medium"));
    let account_2 = switched_same["accountId"].as_str().unwrap().to_owned();
    assert_ne!(account_2, account_1);

    // Run Turn 2 on Claude Route 2 and verify --resume uses the migrated transcript with thinking stripped.
    let (status, _) = h
        .post(
            &format!("/v1/agent-sessions/{session_id}/send"),
            json!({ "text": "Follow up on route 2" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    h.wait_for_turns(&session_id, 2).await;

    let calls_log = std::fs::read_to_string(h.workspace.path().join("claude-calls.log")).unwrap();
    let second_call: Value = serde_json::from_str(calls_log.lines().nth(1).unwrap()).unwrap();
    let resumed_id = second_call["resume"].as_str().unwrap().to_owned();
    assert_ne!(resumed_id, first_native_id);
    assert_eq!(second_call["model"].as_str(), Some("claude-route-2"));
    let second_config_dir = second_call["config_dir"].as_str().unwrap();
    assert!(second_config_dir.contains(&account_2));
    let migrated_files: Vec<_> = std::fs::read_dir(std::path::Path::new(second_config_dir).join("projects"))
        .unwrap()
        .flatten()
        .collect();
    let migrated_jsonl = std::fs::read_to_string(
        migrated_files[0].path().join(format!("{resumed_id}.jsonl")),
    )
    .unwrap();
    assert!(migrated_jsonl.contains("Initial question"));
    assert!(!migrated_jsonl.contains("sig_foreign_secret"));

    // 5. Cross-engine switch: Claude Route 2 -> Codex Route.
    let (status, switched_cross) = h
        .post(
            &format!("/v1/agent-sessions/{session_id}/model-source"),
            json!({
                "sourceId": source_id,
                "routeId": route_codex,
                "revision": revision,
                "agent": "codex",
                "effort": "high"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "cross switch failed: {switched_cross}");
    assert_eq!(switched_cross["handoffMode"].as_str(), Some("timeline_handoff"));
    assert_eq!(switched_cross["previousEngine"].as_str(), Some("claude"));
    assert_eq!(switched_cross["engine"].as_str(), Some("codex"));
    assert_eq!(switched_cross["currentModel"].as_str(), Some("gpt-codex-1"));
    assert_eq!(switched_cross["currentEffort"].as_str(), Some("high"));

    // Run Turn 3 on Codex and verify handoff prompt was injected, user timeline stayed clean, and handoff_context cleared.
    let (status, _) = h
        .post(
            &format!("/v1/agent-sessions/{session_id}/send"),
            json!({ "text": "Continue in Codex" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    h.wait_for_turns(&session_id, 3).await;

    let codex_turn: Value = serde_json::from_str(
        &std::fs::read_to_string(h.workspace.path().join("codex-turn-start.json")).unwrap(),
    )
    .unwrap();
    let codex_input_text = codex_turn["input"][0]["text"].as_str().unwrap();
    assert!(codex_input_text.contains("[Prospero Session Handoff]"));
    assert!(codex_input_text.contains("Initial question"));
    assert!(codex_input_text.contains("Answer from claude"));
    assert!(codex_input_text.contains("Continue in Codex"));

    // User's timeline record remains raw without the injected handoff wrapper.
    let sid_timeline = session_id.clone();
    let page = h
        .database
        .call(move |store| {
            store.timeline(
                &sid_timeline,
                TimelineQuery {
                    before: None,
                    after: None,
                    limit: Some(100),
                },
            )
        })
        .await
        .unwrap();
    let user_turn3 = page
        .items
        .iter()
        .find(|item| {
            item.turn_id == "turn3"
                && matches!(item.body, TimelineBody::Message { role: MessageRole::User, .. })
        })
        .unwrap();
    assert_eq!(user_turn3.preview, "Continue in Codex");

    // 6. Cross-engine switch from Codex (plan mode) -> Pi (does not support plan mode -> downgraded to default).
    let (status, switched_pi) = h
        .post(
            &format!("/v1/agent-sessions/{session_id}/model-source"),
            json!({
                "sourceId": source_id,
                "routeId": route_pi_chat,
                "revision": revision,
                "agent": "pi"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "pi switch failed: {switched_pi}");
    assert_eq!(switched_pi["handoffMode"].as_str(), Some("timeline_handoff"));
    assert_eq!(switched_pi["engine"].as_str(), Some("pi"));
    let mode = h.api.agents.mode(&session_id).await.unwrap();
    assert_eq!(mode, PermissionMode::Default);

    // 7. Reject switching on non-API native session.
    let (status, native_session) = h
        .post(
            "/v1/agent-sessions",
            json!({
                "agent": "claude",
                "title": "Native session",
                "workspace": h.workspace.path().to_str().unwrap()
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let native_session_id = native_session["id"].as_str().unwrap();
    let (status, rejected) = h
        .post(
            &format!("/v1/agent-sessions/{native_session_id}/model-source"),
            json!({
                "sourceId": source_id,
                "routeId": route_claude_2,
                "revision": revision,
                "agent": "claude"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        rejected["message"]
            .as_str()
            .is_some_and(|msg| msg.contains("API 模型源")),
        "{rejected}"
    );
}

#[tokio::test]
async fn rejects_model_source_switch_while_turn_is_running() {
    let _guard = SERIAL.lock().await;
    let h = Harness::new().await;
    std::fs::write(h.workspace.path().join("hang_claude"), "1").unwrap();

    let (status, created_source) = h
        .post(
            "/v1/model-sources",
            json!({
                "type": "model.source.action",
                "requestId": "req-create-busy",
                "action": {
                    "kind": "create",
                    "operationId": "op-create-busy-1",
                    "name": "Busy Gateway",
                    "credential": { "name": "Key", "apiKey": SECRET },
                    "endpoints": [{ "protocol": "anthropic", "baseUrl": "https://anthropic-busy.example.com" }],
                    "routes": [
                        { "name": "R1", "model": "claude-r1", "protocol": "anthropic", "enabled": true, "modelCapabilities": { "tools": true } },
                        { "name": "R2", "model": "claude-r2", "protocol": "anthropic", "enabled": true, "modelCapabilities": { "tools": true } }
                    ]
                }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created_source}");
    let source = &created_source["sources"][0];
    let source_id = source["id"].as_str().unwrap();
    let revision = source["revision"].as_i64().unwrap();
    let r1 = source["routes"][0]["id"].as_str().unwrap();
    let r2 = source["routes"][1]["id"].as_str().unwrap();

    let (_, bound) = h
        .post(
            "/v1/model-sources",
            json!({
                "type": "model.source.action",
                "requestId": "req-bind-busy",
                "action": { "kind": "bind", "sourceId": source_id, "routeId": r1, "revision": revision, "agent": "claude" }
            }),
        )
        .await;
    let account_id = bound["accountId"].as_str().unwrap();
    let (_, session) = h
        .post(
            "/v1/agent-sessions",
            json!({
                "agent": "claude",
                "title": "Busy Switch Test",
                "workspace": h.workspace.path().to_str().unwrap(),
                "model": "claude-r1",
                "accountId": account_id
            }),
        )
        .await;
    let session_id = session["id"].as_str().unwrap();

    let (status, _) = h
        .post(
            &format!("/v1/agent-sessions/{session_id}/send"),
            json!({ "text": "Long running task" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let sid_check = session_id.to_owned();
        if h.database
            .call(move |store| store.session(&sid_check))
            .await
            .unwrap()
            .status
            == SessionStatus::Running
        {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let (status, busy_error) = h
        .post(
            &format!("/v1/agent-sessions/{session_id}/model-source"),
            json!({
                "sourceId": source_id,
                "routeId": r2,
                "revision": revision,
                "agent": "claude"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        busy_error["message"]
            .as_str()
            .is_some_and(|msg| msg.contains("仍在运行")),
        "{busy_error}"
    );

    let _ = h.api.agents.interrupt(session_id).await;
}

#[tokio::test]
async fn switches_pty_model_source_same_engine_and_cross_engine() {
    let _guard = SERIAL.lock().await;
    let h = Harness::new().await;

    let (status, created_source) = h
        .post(
            "/v1/model-sources",
            json!({
                "type": "model.source.action",
                "requestId": "req-create-pty-src",
                "action": {
                    "kind": "create",
                    "operationId": "op-create-pty-switch",
                    "name": "PTY Gateway",
                    "credential": { "name": "Key", "apiKey": SECRET },
                    "endpoints": [
                        { "protocol": "anthropic", "baseUrl": "https://anthropic-pty.example.com" },
                        { "protocol": "openai_responses", "baseUrl": "https://responses-pty.example.com/v1" }
                    ],
                    "routes": [
                        { "name": "Claude PTY 1", "model": "claude-pty-1", "protocol": "anthropic", "enabled": true, "modelCapabilities": { "tools": true } },
                        { "name": "Claude PTY 2", "model": "claude-pty-2", "protocol": "anthropic", "enabled": true, "modelCapabilities": { "tools": true, "supportedEfforts": ["low", "high"] }, "defaultEffort": "high" },
                        { "name": "Codex PTY", "model": "gpt-codex-pty", "protocol": "openai_responses", "enabled": true, "modelCapabilities": { "tools": true, "supportedEfforts": ["medium", "high"] }, "defaultEffort": "medium" }
                    ]
                }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created_source}");
    let source = &created_source["sources"][0];
    let source_id = source["id"].as_str().unwrap().to_owned();
    let revision = source["revision"].as_i64().unwrap();
    let r_claude_1 = source["routes"][0]["id"].as_str().unwrap().to_owned();
    let r_claude_2 = source["routes"][1]["id"].as_str().unwrap().to_owned();
    let r_codex = source["routes"][2]["id"].as_str().unwrap().to_owned();

    let (status, bound) = h
        .post(
            "/v1/model-sources",
            json!({
                "type": "model.source.action",
                "requestId": "req-bind-pty-1",
                "action": { "kind": "bind", "sourceId": source_id, "routeId": r_claude_1, "revision": revision, "agent": "claude" }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{bound}");
    let account_1 = bound["accountId"].as_str().unwrap().to_owned();

    let (status, terminal) = h
        .post(
            "/v1/terminals",
            json!({
                "title": "PTY Source Switch",
                "workspace": h.workspace.path().to_str().unwrap(),
                "size": { "cols": 100, "rows": 30 },
                "agent": "claude",
                "accountId": account_1,
                "model": "claude-pty-1"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{terminal}");
    let session_id = terminal["id"].as_str().unwrap().to_owned();

    // Wait for first fake Claude PTY launch to record its config dir.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let claude_log = h.workspace.path().join("claude-pty-calls.log");
    loop {
        if std::fs::read_to_string(&claude_log)
            .is_ok_and(|content| !content.lines().next().unwrap_or("").is_empty())
        {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "claude pty did not start");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let first_call: Value = serde_json::from_str(
        std::fs::read_to_string(&claude_log).unwrap().lines().next().unwrap(),
    )
    .unwrap();
    assert_eq!(first_call["model"].as_str(), Some("claude-pty-1"));
    let first_config_dir = first_call["config_dir"].as_str().unwrap().to_owned();

    // Seed a native Claude transcript with a thinking block and bind it to the PTY session.
    let native_id = uuid::Uuid::new_v4().to_string();
    let canonical_ws = std::fs::canonicalize(h.workspace.path()).unwrap();
    let project_key: String = canonical_ws
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let project_dir = std::path::Path::new(&first_config_dir)
        .join("projects")
        .join(&project_key);
    std::fs::create_dir_all(&project_dir).unwrap();
    std::fs::write(
        project_dir.join(format!("{native_id}.jsonl")),
        format!(
            "{}\n{}\n",
            json!({
                "sessionId": native_id,
                "cwd": canonical_ws,
                "isSidechain": false,
                "timestamp": "2026-01-01T00:00:00.000Z",
                "type": "user",
                "uuid": uuid::Uuid::new_v4().to_string(),
                "parentUuid": null,
                "message": { "role": "user", "content": "PTY prompt 1" }
            }),
            json!({
                "sessionId": native_id,
                "cwd": canonical_ws,
                "isSidechain": false,
                "timestamp": "2026-01-01T00:00:01.000Z",
                "type": "assistant",
                "uuid": uuid::Uuid::new_v4().to_string(),
                "parentUuid": null,
                "message": {
                    "role": "assistant",
                    "type": "message",
                    "content": [
                        { "type": "thinking", "thinking": "secret", "signature": "sig_pty_secret" },
                        { "type": "text", "text": "PTY answer 1" }
                    ]
                }
            })
        ),
    )
    .unwrap();
    let sid_bind = session_id.clone();
    let nid_bind = native_id.clone();
    h.database
        .call(move |store| {
            let head = store.session(&sid_bind)?;
            let mut native = head.native_session.unwrap_or(NativeSession {
                output_start_seq: Some(0),
                runtime_id: sid_bind.clone(),
                native_id: None,
                managed: false,
                state: "running".into(),
                error: None,
            });
            native.native_id = Some(nid_bind);
            store.set_native_session(&sid_bind, native)
        })
        .await
        .unwrap();

    // Reject OpenCode on PTY.
    let (status, opencode_err) = h
        .post(
            &format!("/v1/agent-sessions/{session_id}/model-source"),
            json!({
                "sourceId": source_id,
                "routeId": r_claude_2,
                "revision": revision,
                "agent": "opencode"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{opencode_err}");

    // Same-engine PTY switch: Claude PTY 1 -> Claude PTY 2.
    let (status, switched_same) = h
        .post(
            &format!("/v1/agent-sessions/{session_id}/model-source"),
            json!({
                "sourceId": source_id,
                "routeId": r_claude_2,
                "revision": revision,
                "agent": "claude"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{switched_same}");
    assert_eq!(switched_same["handoffMode"].as_str(), Some("native"));
    assert_eq!(switched_same["engine"].as_str(), Some("claude"));
    assert_eq!(switched_same["currentModel"].as_str(), Some("claude-pty-2"));
    assert_eq!(switched_same["currentEffort"].as_str(), Some("high"));

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if std::fs::read_to_string(&claude_log)
            .is_ok_and(|content| content.lines().count() >= 2)
        {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "restarted claude pty did not start");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let second_call: Value = serde_json::from_str(
        std::fs::read_to_string(&claude_log).unwrap().lines().nth(1).unwrap(),
    )
    .unwrap();
    assert_eq!(second_call["model"].as_str(), Some("claude-pty-2"));
    let migrated_id = second_call["resume"].as_str().unwrap();
    assert_ne!(migrated_id, native_id);
    let second_config_dir = second_call["config_dir"].as_str().unwrap();
    let migrated_jsonl = std::fs::read_to_string(
        std::path::Path::new(second_config_dir)
            .join("projects")
            .join(&project_key)
            .join(format!("{migrated_id}.jsonl")),
    )
    .unwrap();
    assert!(migrated_jsonl.contains("PTY prompt 1"));
    assert!(!migrated_jsonl.contains("sig_pty_secret"));

    // Cross-engine PTY switch: Claude PTY 2 -> Codex PTY.
    let (status, switched_cross) = h
        .post(
            &format!("/v1/agent-sessions/{session_id}/model-source"),
            json!({
                "sourceId": source_id,
                "routeId": r_codex,
                "revision": revision,
                "agent": "codex",
                "effort": "high"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{switched_cross}");
    assert_eq!(switched_cross["handoffMode"].as_str(), Some("fresh"));
    assert_eq!(switched_cross["previousEngine"].as_str(), Some("claude"));
    assert_eq!(switched_cross["engine"].as_str(), Some("codex"));
    assert_eq!(switched_cross["currentModel"].as_str(), Some("gpt-codex-pty"));
    assert_eq!(switched_cross["currentEffort"].as_str(), Some("high"));

    let codex_log = h.workspace.path().join("codex-pty-calls.log");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if std::fs::read_to_string(&codex_log)
            .is_ok_and(|content| !content.lines().next().unwrap_or("").is_empty())
        {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "codex pty did not start");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let codex_call: Value = serde_json::from_str(
        std::fs::read_to_string(&codex_log).unwrap().lines().next().unwrap(),
    )
    .unwrap();
    assert_eq!(codex_call["env_model"].as_str(), Some("gpt-codex-pty"));

    let _ = h.post(&format!("/v1/terminals/{session_id}/close"), json!({})).await;
}

#[tokio::test]
async fn switches_credential_only_on_same_route_for_structured_and_pty() {
    let _guard = SERIAL.lock().await;
    let h = Harness::new().await;

    let (status, created) = h
        .post(
            "/v1/model-sources",
            json!({
                "type": "model.source.action",
                "requestId": "req-cred-switch-create",
                "action": {
                    "kind": "create",
                    "operationId": "op-cred-switch-create",
                    "name": "GLM Source",
                    "credential": { "name": "Account A", "apiKey": "sk-glm-a-0123456789" },
                    "endpoints": [
                        { "protocol": "anthropic", "baseUrl": "https://glm.example.com/anthropic" }
                    ],
                    "routes": [
                        { "name": "GLM 5.4", "model": "glm-5.4", "protocol": "anthropic", "enabled": true, "modelCapabilities": { "tools": true } }
                    ]
                }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let source = &created["sources"][0];
    let source_id = source["id"].as_str().unwrap().to_owned();
    let route_id = source["routes"][0]["id"].as_str().unwrap().to_owned();
    let cred_a_id = source["credentials"][0]["id"].as_str().unwrap().to_owned();
    let rev_1 = source["revision"].as_i64().unwrap();

    let (status, cred_added) = h
        .post(
            "/v1/model-sources",
            json!({
                "type": "model.source.action",
                "requestId": "req-cred-switch-add",
                "action": {
                    "kind": "credential.set",
                    "sourceId": source_id,
                    "revision": rev_1,
                    "name": "Account B",
                    "apiKey": "sk-glm-b-0123456789"
                }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cred_added}");
    let updated_source = cred_added["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == source_id)
        .unwrap();
    let revision = updated_source["revision"].as_i64().unwrap();
    let cred_b_id = updated_source["credentials"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "Account B")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // 1. Structured session starts with default Account A credential.
    let (status, bind_res) = h
        .post(
            "/v1/model-sources",
            json!({
                "type": "model.source.action",
                "requestId": "req-cred-bind-a",
                "action": { "kind": "bind", "sourceId": source_id, "routeId": route_id, "revision": revision, "agent": "claude" }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{bind_res}");
    let account_a = bind_res["accountId"].as_str().unwrap().to_owned();

    let (status, sess) = h
        .post(
            "/v1/agent-sessions",
            json!({
                "agent": "claude",
                "title": "Cred Switch Chat",
                "workspace": h.workspace.path().to_str().unwrap(),
                "accountId": account_a,
                "model": "glm-5.4"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{sess}");
    let chat_id = sess["id"].as_str().unwrap().to_owned();

    let (status, _) = h
        .post(
            &format!("/v1/agent-sessions/{chat_id}/send"),
            json!({ "text": "Hello Account A" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    h.wait_for_turns(&chat_id, 1).await;

    // Switch ONLY credentialId on the same sourceId + routeId + agent.
    let (status, switched_chat) = h
        .post(
            &format!("/v1/agent-sessions/{chat_id}/model-source"),
            json!({
                "sourceId": source_id,
                "routeId": route_id,
                "revision": revision,
                "credentialId": cred_b_id,
                "agent": "claude"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{switched_chat}");
    let account_b = switched_chat["accountId"].as_str().unwrap().to_owned();
    assert_ne!(account_a, account_b);
    assert_eq!(switched_chat["credentialId"].as_str(), Some(cred_b_id.as_str()));
    assert_eq!(switched_chat["credentialName"].as_str(), Some("Account B"));
    assert_eq!(switched_chat["handoffMode"].as_str(), Some("native"));

    let (status, _) = h
        .post(
            &format!("/v1/agent-sessions/{chat_id}/send"),
            json!({ "text": "Continue on Account B" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    h.wait_for_turns(&chat_id, 2).await;

    let calls_log = std::fs::read_to_string(h.workspace.path().join("claude-calls.log")).unwrap();
    let second_call: Value = serde_json::from_str(calls_log.lines().nth(1).unwrap()).unwrap();
    assert!(second_call["config_dir"].as_str().unwrap().contains(&account_b));
    assert_eq!(second_call["model"].as_str(), Some("glm-5.4"));

    // Switch back to Account A explicitly.
    let (status, switched_back) = h
        .post(
            &format!("/v1/agent-sessions/{chat_id}/model-source"),
            json!({
                "sourceId": source_id,
                "routeId": route_id,
                "revision": revision,
                "credentialId": cred_a_id,
                "agent": "claude"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{switched_back}");
    assert_eq!(switched_back["accountId"].as_str(), Some(account_a.as_str()));
    assert_eq!(switched_back["credentialId"].as_str(), Some(cred_a_id.as_str()));
    assert_eq!(switched_back["credentialName"].as_str(), Some("Account A"));

    // 2. PTY session starts on Account A and switches credential only to Account B.
    let (status, pty) = h
        .post(
            "/v1/terminals",
            json!({
                "title": "Cred Switch PTY",
                "workspace": h.workspace.path().to_str().unwrap(),
                "size": { "cols": 100, "rows": 30 },
                "agent": "claude",
                "accountId": account_a,
                "model": "glm-5.4"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{pty}");
    let pty_id = pty["id"].as_str().unwrap().to_owned();

    let pty_log = h.workspace.path().join("claude-pty-calls.log");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if std::fs::read_to_string(&pty_log)
            .is_ok_and(|content| !content.lines().next().unwrap_or("").is_empty())
        {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "pty did not start");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    let (status, switched_pty) = h
        .post(
            &format!("/v1/agent-sessions/{pty_id}/model-source"),
            json!({
                "sourceId": source_id,
                "routeId": route_id,
                "revision": revision,
                "credentialId": cred_b_id,
                "agent": "claude"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{switched_pty}");
    assert_eq!(switched_pty["accountId"].as_str(), Some(account_b.as_str()));
    assert_eq!(switched_pty["credentialId"].as_str(), Some(cred_b_id.as_str()));
    assert_eq!(switched_pty["credentialName"].as_str(), Some("Account B"));

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if std::fs::read_to_string(&pty_log)
            .is_ok_and(|content| content.lines().count() >= 2)
        {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "pty did not restart with cred B");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let pty_second: Value = serde_json::from_str(
        std::fs::read_to_string(&pty_log).unwrap().lines().nth(1).unwrap(),
    )
    .unwrap();
    assert!(pty_second["config_dir"].as_str().unwrap().contains(&account_b));

    let _ = h.post(&format!("/v1/terminals/{pty_id}/close"), json!({})).await;
}
