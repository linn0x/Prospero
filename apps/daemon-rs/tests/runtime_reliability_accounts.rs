#![cfg(unix)]

use prosperod_rs::{
    execution_budget::BudgetClient, execution_host::launcher::HostHandle,
    orchestration::reliability::ExecutionRecord,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, Read, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{sleep, timeout},
};

const SECRETS: [&str; 5] = [
    "fixture-anthropic-key-28473619",
    "fixture-gpt-key-74619283",
    "fixture-deepseek-key-19283746",
    "fixture-flash-key-83746192",
    "fixture-oauth-token-61928374",
];

const FAKE_EXECUTOR: &str = r##"#!/usr/bin/env python3
import http.server
import json
import os
import sys
import threading
import time
import urllib.parse

os.umask(0o077)
argv = sys.argv[1:]
if argv == ['--version']:
    print('1.2.3-fixture')
    sys.exit(0)
if argv in [['auth', 'status', '--json'], ['login', 'status']]:
    print(json.dumps({'loggedIn': True, 'authMethod': 'fixture'}))
    sys.exit(0)
if argv == ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose']:
    frame = json.loads(sys.stdin.readline())
    print(json.dumps({'type':'control_response','response':{'subtype':'success','request_id':frame['request_id'],'response':{'models':[{'value':'default','displayName':'Fixture','supportedEffortLevels':['low','high']}]}}}), flush=True)
    sys.exit(0)

keys = ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_CUSTOM_HEADERS','ANTHROPIC_MODEL','CLAUDE_CONFIG_DIR','OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','CODEX_REFRESH_TOKEN','CODEX_HOME','CODEX_SQLITE_HOME','PROSPERO_API_PROFILE_MODEL','PROSPERO_API_HEADER_0','PROSPERO_API_HEADER_1','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','PROSPERO_API_PROFILE_CONFIG','PROSPERO_EXECUTION_IDENTITY_JSON']
capture = {'argv':argv, 'env':{key:os.environ.get(key) for key in keys}, 'pid':os.getpid()}
lock = threading.Lock()

def write_capture(**values):
    with lock:
        capture.update(values)
        with open('capture.tmp','w') as output:
            json.dump(capture, output)
        os.replace('capture.tmp','capture.json')

def heartbeat():
    while True:
        with open('heartbeat','w') as output:
            output.write(str(time.monotonic_ns()))
        time.sleep(0.03)

threading.Thread(target=heartbeat, daemon=True).start()

def emit(value):
    print(json.dumps(value), flush=True)

if argv and argv[0] == 'app-server':
    for line in sys.stdin:
        frame=json.loads(line)
        method=frame.get('method')
        rid=frame.get('id')
        params=frame.get('params') or {}
        if method == 'initialize':
            emit({'jsonrpc':'2.0','id':rid,'result':{'protocolVersion':1}})
        elif method in ['thread/start','thread/resume']:
            emit({'jsonrpc':'2.0','id':rid,'result':{'thread':{'id':'fixture-thread'}}})
        elif method == 'turn/start':
            write_capture(engine='codex', turn=params)
            emit({'jsonrpc':'2.0','id':rid,'result':{'turn':{'id':'fixture-turn'}}})
            emit({'jsonrpc':'2.0','method':'turn/started','params':{'threadId':'fixture-thread','turn':{'id':'fixture-turn'}}})
        elif rid is not None:
            emit({'jsonrpc':'2.0','id':rid,'result':{}})
elif argv and argv[0] == 'serve':
    with open(os.environ['PROSPERO_API_PROFILE_CONFIG']) as source:
        profile=json.load(source)
    model=profile['model']
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def respond(self, value):
            body=json.dumps(value).encode()
            self.send_response(200)
            self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def do_GET(self):
            path=urllib.parse.urlparse(self.path).path
            if path == '/api/event':
                self.send_response(200)
                self.send_header('Content-Type','text/event-stream')
                self.end_headers()
                try:
                    while True:
                        self.wfile.write(b': fixture heartbeat\n\n')
                        self.wfile.flush()
                        time.sleep(0.05)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            elif path == '/api/model':
                self.respond({model:{'id':model}})
            elif path == '/config':
                self.respond({'model':model})
            elif path.startswith('/api/provider/'):
                self.respond({'id':'prospero'})
            else:
                self.respond({})
        def do_POST(self):
            length=int(self.headers.get('Content-Length','0'))
            body=json.loads(self.rfile.read(length) or b'{}')
            path=urllib.parse.urlparse(self.path).path
            if path == '/api/session':
                self.respond({'id':'fixture-session'})
            elif path == '/api/session/fixture-session/prompt':
                write_capture(engine='opencode', profile=profile, prompt=body)
                self.respond({'sessionID':'fixture-session','id':'fixture-prompt'})
            else:
                self.respond({})
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
    print('listening on http://127.0.0.1:'+str(server.server_address[1]),flush=True)
    server.serve_forever()
else:
    emit({'type':'system','subtype':'init','session_id':'fixture-claude'})
    for line in sys.stdin:
        frame=json.loads(line)
        if frame.get('type') == 'user':
            write_capture(engine='claude')
        elif frame.get('type') == 'control_request':
            emit({'type':'control_response','response':{'subtype':'success','request_id':frame.get('request_id'),'response':{}}})
"##;

struct Cleanup {
    directory: PathBuf,
    budget: PathBuf,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Ok(hosts) = fs::read_dir(self.directory.join("execution-hosts")) {
            for host in hosts.flatten() {
                if let Ok(epochs) = fs::read_dir(host.path()) {
                    for epoch in epochs.flatten() {
                        shutdown_directory(&epoch.path(), "socketPath");
                    }
                }
            }
        }
        shutdown_directory(&self.budget, "socket");
    }
}

fn shutdown_directory(directory: &Path, socket_key: &str) {
    let Some((socket, token)) = fs::read(directory.join("manifest.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|manifest| {
            Some((
                PathBuf::from(manifest[socket_key].as_str()?),
                fs::read_to_string(directory.join("token")).ok()?,
            ))
        })
    else {
        return;
    };
    if let Ok(mut stream) = std::os::unix::net::UnixStream::connect(&socket) {
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
        let mut request = json!({"requestType":"shutdown","token":token})
            .to_string()
            .into_bytes();
        request.push(b'\n');
        if stream.write_all(&request).is_ok() {
            let mut reply = String::new();
            let _ = std::io::BufReader::new(stream)
                .take(16_384)
                .read_line(&mut reply);
        }
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while socket.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn assert_public(value: &str) {
    for secret in SECRETS {
        assert!(
            !value.contains(secret),
            "private synthetic credential leaked into a public/control record"
        );
    }
}

async fn spawn_daemon(directory: &Path, environment: &[(String, String)]) -> (Child, Value) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_prosperod-rs"));
    command
        .args(["serve", "--data-dir"])
        .arg(directory)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap())
        .envs(environment.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    let mut child = command.spawn().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    timeout(Duration::from_secs(30), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            assert_public(&line);
            if serde_json::from_str::<Value>(&line).is_ok_and(|value| value["event"] == "ready") {
                return;
            }
        }
        panic!("isolated account test daemon exited before ready");
    })
    .await
    .unwrap();
    let connection: Value =
        serde_json::from_slice(&fs::read(directory.join("connection.json")).unwrap()).unwrap();
    assert_eq!(connection["pid"].as_u64(), child.id().map(u64::from));
    (child, connection)
}

async fn request(
    connection: &Value,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Value {
    let mut request = reqwest::Client::new()
        .request(
            method,
            format!("{}{path}", connection["baseUrl"].as_str().unwrap()),
        )
        .bearer_auth(connection["token"].as_str().unwrap())
        .timeout(Duration::from_secs(15))
        .header("prefer", "respond-async");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.unwrap();
    let status = response.status();
    let raw = response.text().await.unwrap();
    assert_public(&raw);
    assert!(
        status.is_success(),
        "unexpected account fixture HTTP status {status} at {path}"
    );
    serde_json::from_str(&raw).unwrap()
}

async fn account(connection: &Value, kind: &str, values: Value) -> Value {
    let mut payload = values.as_object().unwrap().clone();
    payload.insert("type".into(), kind.into());
    payload.insert("requestId".into(), "account-fixture".into());
    let result = request(
        connection,
        reqwest::Method::POST,
        "/v1/accounts",
        Some(Value::Object(payload)),
    )
    .await;
    assert_eq!(result["ok"], true, "synthetic account control failed");
    result
}

async fn set_effort(connection: &Value, account_id: &str) {
    let config = account(
        connection,
        "agent.account.config.get",
        json!({"accountId":account_id}),
    )
    .await;
    let document = &config["config"]["documents"][0];
    account(connection, "agent.account.config.set", json!({"accountId":account_id,"documentId":document["id"],"revision":document["revision"],"content":"default_effort: high\n","defaultEffort":"high"})).await;
}

async fn wait_operation(connection: &Value, operation_id: &str) -> Value {
    timeout(Duration::from_secs(40), async {
        loop {
            let value = request(
                connection,
                reqwest::Method::GET,
                &format!("/v1/operations/{operation_id}"),
                None,
            )
            .await;
            match value["state"].as_str().unwrap() {
                "SUCCEEDED" => return value,
                "FAILED" | "CANCELLED" => {
                    panic!("account fixture operation did not succeed: {operation_id}")
                }
                _ => sleep(Duration::from_millis(50)).await,
            }
        }
    })
    .await
    .unwrap()
}

async fn wait_capture(workspace: &Path) -> Value {
    timeout(Duration::from_secs(15), async {
        loop {
            if let Ok(bytes) = fs::read(workspace.join("capture.json"))
                && let Ok(capture) = serde_json::from_slice(&bytes)
            {
                return capture;
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap()
}

fn assert_control_storage_private(directory: &Path) {
    let connection = rusqlite::Connection::open_with_flags(
        directory.join("prospero.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    for table in [
        "orch_operations_v2",
        "orch_host_commands",
        "change_events",
        "orch_host_events",
    ] {
        let mut columns = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let names = columns
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for (name, kind) in names {
            if kind != "TEXT" {
                continue;
            }
            let mut statement = connection
                .prepare(&format!("SELECT \"{name}\" FROM {table}"))
                .unwrap();
            for value in statement
                .query_map([], |row| row.get::<_, Option<String>>(0))
                .unwrap()
            {
                if let Some(value) = value.unwrap() {
                    assert_public(&value);
                }
            }
        }
    }
    fn journals(directory: &Path) {
        for entry in fs::read_dir(directory).unwrap().flatten() {
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                journals(&path);
            } else if entry
                .file_name()
                .to_string_lossy()
                .starts_with("host-journal-")
                && path
                    .extension()
                    .is_some_and(|extension| extension == "jsonl")
            {
                assert_public(&fs::read_to_string(path).unwrap());
            }
        }
    }
    journals(&directory.join("execution-hosts"));
}

struct Case {
    name: &'static str,
    protocol: Option<&'static str>,
    requested: &'static str,
    engine: &'static str,
    model: &'static str,
    secret: &'static str,
    effort: bool,
}

#[tokio::test]
async fn hosted_accounts_preserve_credentials_protocols_isolation_and_offline_ownership() {
    let temporary = tempfile::tempdir().unwrap();
    let home = temporary.path().join("home");
    let directory = home.join("daemon");
    let budget = home.join("budget");
    for path in [&home, &directory] {
        fs::create_dir(path).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let _cleanup = Cleanup {
        directory: directory.clone(),
        budget: budget.clone(),
    };
    let cli = temporary.path().join("fake-account-executor.py");
    fs::write(&cli, FAKE_EXECUTOR).unwrap();
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
    let environment = vec![
        ("HOME".into(), home.to_string_lossy().into_owned()),
        ("PROSPERO_HOME".into(), home.to_string_lossy().into_owned()),
        ("PROSPERO_EXECUTION_MODE".into(), "hosted".into()),
        (
            "PROSPERO_EXECUTION_HOST_BINARY".into(),
            env!("CARGO_BIN_EXE_prospero-execution-host").into(),
        ),
        (
            "PROSPERO_EXECUTION_BUDGET_BINARY".into(),
            env!("CARGO_BIN_EXE_prospero-budget-host").into(),
        ),
        (
            "PROSPERO_EXECUTION_BUDGET_DIR".into(),
            budget.to_string_lossy().into_owned(),
        ),
        ("PROSPERO_EXECUTION_BUDGET_CAPACITY".into(), "5".into()),
        (
            "PROSPERO_CLAUDE_BIN".into(),
            cli.to_string_lossy().into_owned(),
        ),
        (
            "PROSPERO_CODEX_BIN".into(),
            cli.to_string_lossy().into_owned(),
        ),
        (
            "PROSPERO_OPENCODE_BIN".into(),
            cli.to_string_lossy().into_owned(),
        ),
        (
            "ANTHROPIC_API_KEY".into(),
            "native-anthropic-must-not-be-used".into(),
        ),
        (
            "CLAUDE_CODE_OAUTH_TOKEN".into(),
            "native-oauth-must-not-be-used".into(),
        ),
        (
            "OPENAI_API_KEY".into(),
            "native-openai-must-not-be-used".into(),
        ),
        (
            "CODEX_API_KEY".into(),
            "native-codex-must-not-be-used".into(),
        ),
    ];
    let (mut daemon, connection) = spawn_daemon(&directory, &environment).await;
    let cases = [
        Case {
            name: "anthropic",
            protocol: Some("anthropic"),
            requested: "claude",
            engine: "claude",
            model: "claude-fixture",
            secret: SECRETS[0],
            effort: false,
        },
        Case {
            name: "gpt",
            protocol: Some("openai_responses"),
            requested: "codex",
            engine: "codex",
            model: "gpt-fixture",
            secret: SECRETS[1],
            effort: true,
        },
        Case {
            name: "deepseek",
            protocol: Some("openai_chat_completions"),
            requested: "codex",
            engine: "opencode",
            model: "deepseek-fixture",
            secret: SECRETS[2],
            effort: false,
        },
        Case {
            name: "flash",
            protocol: Some("openai_chat_completions"),
            requested: "opencode",
            engine: "opencode",
            model: "gemini-flash-fixture",
            secret: SECRETS[3],
            effort: false,
        },
        Case {
            name: "oauth",
            protocol: None,
            requested: "claude",
            engine: "claude",
            model: "",
            secret: SECRETS[4],
            effort: true,
        },
    ];
    let mut running = Vec::new();
    let mut captures = Vec::new();
    for case in &cases {
        let workspace = temporary.path().join(case.name);
        fs::create_dir(&workspace).unwrap();
        let base_url = format!("http://127.0.0.1:9/{}/v1", case.name);
        let account_id = if case.name == "anthropic" {
            let created = request(&connection, reqwest::Method::POST, "/v1/model-sources", Some(json!({"type":"model.source.action","requestId":"source-create","action":{"kind":"create","operationId":"source-anthropic","name":"fixture-anthropic","endpoints":[{"protocol":"anthropic","baseUrl":base_url,"headers":{"X-Prospero-Fixture":"anthropic-isolated"}}],"credential":{"name":"fixture","apiKey":case.secret},"routes":[{"name":"fixture","model":case.model,"protocol":"anthropic","enabled":true,"modelCapabilities":{"tools":true,"reasoning":true,"supportedEfforts":["low","high"]}}]}}))).await;
            assert_eq!(created["ok"], true);
            let source = created["sources"]
                .as_array()
                .unwrap()
                .iter()
                .find(|source| source["name"] == "fixture-anthropic")
                .unwrap();
            let bound = request(&connection, reqwest::Method::POST, "/v1/model-sources", Some(json!({"type":"model.source.action","requestId":"source-bind","action":{"kind":"bind","sourceId":source["id"],"routeId":source["routes"][0]["id"],"revision":source["revision"],"agent":"claude"}}))).await;
            assert_eq!(bound["ok"], true);
            bound["accountId"].as_str().unwrap().to_owned()
        } else if let Some(protocol) = case.protocol {
            let result = account(&connection, "agent.account.api.create", json!({"agent":case.requested,"name":format!("fixture-{}",case.name),"protocol":protocol,"baseUrl":base_url,"model":case.model,"apiKey":case.secret,"modelCapabilities":{"tools":true,"reasoning":true,"supportedEfforts":["low","high"]}})).await;
            result["accountId"].as_str().unwrap().to_owned()
        } else {
            let result = account(
                &connection,
                "agent.account.create",
                json!({"agent":"claude","name":"fixture-oauth"}),
            )
            .await;
            let id = result["accountId"].as_str().unwrap().to_owned();
            account(
                &connection,
                "agent.account.credential.set",
                json!({"accountId":id,"credentialKind":"oauth_token","credential":case.secret}),
            )
            .await;
            id
        };
        if case.effort {
            set_effort(&connection, &account_id).await;
        }
        let graph = request(&connection, reqwest::Method::POST, "/v1/runs/graph", Some(json!({"operationId":format!("graph-{}",case.name),"objective":format!("synthetic hosted {} account",case.name),"nodes":[{"clientId":"fixture","title":"isolated account","spec":"wait for explicit controlled shutdown"}]}))).await;
        let task_id = graph["idMap"]["fixture"].as_str().unwrap().to_owned();
        let operation_id = format!("start-{}", case.name);
        request(&connection, reqwest::Method::POST, "/v1/workers/start", Some(json!({"operationId":operation_id,"taskId":task_id,"agent":case.requested,"accountId":account_id,"cwd":workspace,"worktree":"none","approvalPolicy":"standard"}))).await;
        let started = wait_operation(&connection, &operation_id).await;
        let execution: ExecutionRecord = serde_json::from_value(
            request(
                &connection,
                reqwest::Method::GET,
                &format!("/v1/executions/{}", started["attemptId"].as_str().unwrap()),
                None,
            )
            .await,
        )
        .unwrap();
        let capture = wait_capture(&workspace).await;
        assert_eq!(capture["engine"], case.engine);
        let env = &capture["env"];
        if case.engine == "claude" {
            assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "");
            if case.protocol.is_some() {
                assert_eq!(env["ANTHROPIC_API_KEY"], case.secret);
                assert_eq!(
                    env["ANTHROPIC_BASE_URL"],
                    base_url.strip_suffix("/v1").unwrap()
                );
                assert_eq!(env["ANTHROPIC_MODEL"], case.model);
                assert_eq!(env["CLAUDE_CODE_OAUTH_TOKEN"], "");
                assert!(
                    env["ANTHROPIC_CUSTOM_HEADERS"]
                        .as_str()
                        .unwrap()
                        .contains("anthropic-isolated")
                );
            } else {
                assert_eq!(env["CLAUDE_CODE_OAUTH_TOKEN"], case.secret);
                assert_eq!(env["ANTHROPIC_API_KEY"], "");
            }
            assert!(
                Path::new(env["CLAUDE_CONFIG_DIR"].as_str().unwrap())
                    .starts_with(directory.join("execution-hosts"))
            );
            if case.effort {
                let argv = capture["argv"].as_array().unwrap();
                assert!(
                    argv.windows(2)
                        .any(|pair| pair[0] == "--effort" && pair[1] == "high")
                );
            }
        } else {
            assert_eq!(env["OPENAI_API_KEY"], case.secret);
            if case.engine == "codex" {
                assert_eq!(env["CODEX_API_KEY"], "");
                assert_eq!(env["CODEX_ACCESS_TOKEN"], "");
                assert_eq!(env["CODEX_REFRESH_TOKEN"], "");
                assert_eq!(capture["turn"]["model"], case.model);
                assert_eq!(capture["turn"]["effort"], "high");
                assert!(
                    capture["argv"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|arg| arg.as_str().is_some_and(|arg| arg.contains(&base_url)))
                );
                assert!(
                    Path::new(env["CODEX_HOME"].as_str().unwrap())
                        .starts_with(directory.join("execution-hosts"))
                );
            } else {
                assert_eq!(
                    capture["profile"]["model"],
                    format!("prospero/{}", case.model)
                );
                assert_eq!(
                    capture["profile"]["provider"]["prospero"]["options"]["baseURL"],
                    base_url
                );
                assert!(
                    Path::new(env["XDG_CONFIG_HOME"].as_str().unwrap())
                        .starts_with(directory.join("execution-hosts"))
                );
            }
        }
        let raw = capture.to_string();
        for other in SECRETS {
            if other != case.secret {
                assert!(!raw.contains(other), "cross-account credential inheritance");
            }
        }
        let host = HostHandle::open(&directory, execution.identity.host.as_ref().unwrap()).unwrap();
        let events = host.client().unwrap().events(0, 1000).await.unwrap();
        assert_public(&serde_json::to_string(&events).unwrap());
        captures.push(capture);
        running.push((case.name, workspace, execution, host.manifest.pid));
    }
    assert_ne!(
        captures[2]["env"]["XDG_CONFIG_HOME"],
        captures[3]["env"]["XDG_CONFIG_HOME"]
    );
    let budget_client = BudgetClient::from_directory(&budget).unwrap();
    assert_eq!(budget_client.health().await.unwrap().held, 5);
    assert_control_storage_private(&directory);
    daemon.kill().await.unwrap();
    daemon.wait().await.unwrap();
    let heartbeat = running[1].1.join("heartbeat");
    let before = fs::read_to_string(&heartbeat).unwrap();
    sleep(Duration::from_millis(180)).await;
    assert_ne!(fs::read_to_string(&heartbeat).unwrap(), before);
    assert_eq!(budget_client.health().await.unwrap().held, 5);
    let (mut daemon, connection) = spawn_daemon(&directory, &environment).await;
    for (name, _, execution, original_pid) in &running {
        assert_eq!(
            HostHandle::open(&directory, execution.identity.host.as_ref().unwrap())
                .unwrap()
                .manifest
                .pid,
            *original_pid
        );
        let stop_id = format!("stop-{name}");
        request(
            &connection,
            reqwest::Method::POST,
            &format!("/v1/executions/{}/stop", execution.identity.attempt_id),
            Some(json!({"operationId":stop_id,"payload":{"reason":"synthetic account test stop"}})),
        )
        .await;
        wait_operation(&connection, &stop_id).await;
        timeout(Duration::from_secs(20), async {
            loop {
                let final_execution = request(
                    &connection,
                    reqwest::Method::GET,
                    &format!("/v1/executions/{}", execution.identity.attempt_id),
                    None,
                )
                .await;
                if final_execution["state"] == "FINALIZED" {
                    assert!(final_execution["exitProofId"].is_string());
                    break;
                }
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
    }
    timeout(Duration::from_secs(15), async {
        loop {
            let status = budget_client.health().await.unwrap();
            if status.held == 0 && status.quarantined == 0 {
                assert_eq!(status.released, 5);
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    assert_control_storage_private(&directory);
    request(&connection, reqwest::Method::POST, "/v1/shutdown", None).await;
    assert!(
        timeout(Duration::from_secs(10), daemon.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    for (_, _, execution, _) in &running {
        let _ = HostHandle::open(&directory, execution.identity.host.as_ref().unwrap())
            .unwrap()
            .client()
            .unwrap()
            .shutdown()
            .await;
    }
    budget_client.shutdown().await.unwrap();
}
