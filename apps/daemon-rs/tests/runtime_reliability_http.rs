#![cfg(unix)]

use prosperod_rs::{
    execution_budget::BudgetClient, execution_host::launcher::HostHandle,
    orchestration::reliability::ExecutionRecord,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
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

const FAKE_CLI: &str = r##"#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import time

def emit(value):
    print(json.dumps(value), flush=True)

emit({"type":"system","subtype":"init","session_id":"fake-full-stack"})
for line in sys.stdin:
    frame=json.loads(line)
    if frame.get("type")!="user":
        continue
    identity=json.loads(os.environ["PROSPERO_EXECUTION_IDENTITY_JSON"])
    with open("worker-identity.json","w") as output:
        json.dump(identity,output)
    while not os.path.exists("submit-offline"):
        time.sleep(0.02)
    result=subprocess.run([os.environ["PROSPERO_W09_CONTROL_BIN"],"task","done","--id",identity["taskId"],"--body","verified offline fixture deliverable"],text=True,capture_output=True,timeout=15)
    with open("submission.tmp","w") as output:
        json.dump({"code":result.returncode,"stdout":result.stdout,"stderr":result.stderr},output)
    os.replace("submission.tmp","submission.json")
    while True:
        time.sleep(1)
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
        let mut bytes = json!({"requestType":"shutdown","token":token})
            .to_string()
            .into_bytes();
        bytes.push(b'\n');
        let _ = stream.write_all(&bytes);
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while socket.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
}

async fn spawn_daemon(directory: &Path, environment: &[(String, String)]) -> (Child, Value) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_prosperod-rs"));
    command
        .args(["serve", "--data-dir"])
        .arg(directory)
        .envs(environment.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    let mut child = command.spawn().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    timeout(Duration::from_secs(25), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if let Ok(value) = serde_json::from_str::<Value>(&line)
                && value["event"] == "ready"
            {
                return;
            }
        }
        panic!("test daemon exited before ready");
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
        .timeout(Duration::from_secs(10))
        .header("prefer", "respond-async");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.unwrap();
    let status = response.status();
    let value: Value = response.json().await.unwrap();
    assert!(status.is_success(), "{path}: {status} {value}");
    value
}

async fn operation(connection: &Value, id: &str) -> Value {
    timeout(Duration::from_secs(35), async {
        loop {
            let response = reqwest::Client::new()
                .get(format!(
                    "{}/v1/operations/{id}",
                    connection["baseUrl"].as_str().unwrap()
                ))
                .bearer_auth(connection["token"].as_str().unwrap())
                .timeout(Duration::from_secs(5))
                .send()
                .await
                .unwrap();
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                sleep(Duration::from_millis(50)).await;
                continue;
            }
            assert!(response.status().is_success());
            let value: Value = response.json().await.unwrap();
            match value["state"].as_str().unwrap() {
                "SUCCEEDED" => return value,
                "FAILED" | "CANCELLED" => panic!("operation failed: {value}"),
                _ => sleep(Duration::from_millis(50)).await,
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn hosted_http_worker_submits_offline_and_recovery_releases_budget_after_exit() {
    let temporary = tempfile::tempdir().unwrap();
    let home = temporary.path().join("home");
    let directory = home.join("daemon");
    let budget = home.join("budget");
    let workspace = temporary.path().join("workspace");
    for path in [&home, &directory, &workspace] {
        fs::create_dir(path).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let _cleanup = Cleanup {
        directory: directory.clone(),
        budget: budget.clone(),
    };
    let cli = temporary.path().join("fake-claude.py");
    fs::write(&cli, FAKE_CLI).unwrap();
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
        ("PROSPERO_EXECUTION_BUDGET_CAPACITY".into(), "1".into()),
        (
            "PROSPERO_CLAUDE_BIN".into(),
            cli.to_string_lossy().into_owned(),
        ),
        (
            "PROSPERO_W09_CONTROL_BIN".into(),
            env!("CARGO_BIN_EXE_prospero").into(),
        ),
    ];
    let (mut daemon, connection) = spawn_daemon(&directory, &environment).await;
    let graph=request(&connection,reqwest::Method::POST,"/v1/runs/graph",Some(json!({"objective":"offline hosted worker test","operationId":"graph-offline","nodes":[{"clientId":"a","title":"fixture","spec":"wait for fixture gate before explicitly delivering"}]}))).await;
    let task = graph["idMap"]["a"].as_str().unwrap();
    request(&connection,reqwest::Method::POST,"/v1/workers/start",Some(json!({"operationId":"start-offline","taskId":task,"agent":"claude","cwd":workspace,"worktree":"none","approvalPolicy":"standard"}))).await;
    let started = operation(&connection, "start-offline").await;
    let attempt = started["attemptId"].as_str().unwrap();
    let execution: ExecutionRecord = serde_json::from_value(
        request(
            &connection,
            reqwest::Method::GET,
            &format!("/v1/executions/{attempt}"),
            None,
        )
        .await,
    )
    .unwrap();
    timeout(Duration::from_secs(10), async {
        while !workspace.join("worker-identity.json").exists() {
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    let injected: Value =
        serde_json::from_slice(&fs::read(workspace.join("worker-identity.json")).unwrap()).unwrap();
    assert_eq!(injected, serde_json::to_value(&execution.identity).unwrap());
    let host = HostHandle::open(&directory, execution.identity.host.as_ref().unwrap()).unwrap();
    let original_host_pid = host.manifest.pid;
    let client = host.client().unwrap();
    daemon.kill().await.unwrap();
    daemon.wait().await.unwrap();
    fs::write(workspace.join("submit-offline"), b"submit").unwrap();
    timeout(Duration::from_secs(20), async {
        while !workspace.join("submission.json").exists() {
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    let submission: Value =
        serde_json::from_slice(&fs::read(workspace.join("submission.json")).unwrap()).unwrap();
    assert_eq!(submission["code"], 0, "{submission}");
    assert!(
        submission["stdout"].as_str().unwrap().contains("RECEIVED"),
        "{submission}"
    );
    let events = client.events(0, 1000).await.unwrap();
    let delivery = events
        .events
        .iter()
        .find(|event| event.kind == "delivery_received_offline")
        .unwrap();
    let payload: Value = serde_json::from_str(&delivery.payload).unwrap();
    let detail = client
        .command_detail(payload["commandId"].as_str().unwrap())
        .await
        .unwrap();
    assert!(
        detail
            .command
            .payload
            .contains("verified offline fixture deliverable")
    );
    assert_eq!(
        BudgetClient::from_directory(&budget)
            .unwrap()
            .health()
            .await
            .unwrap()
            .held,
        1
    );
    let (mut daemon, connection) = spawn_daemon(&directory, &environment).await;
    operation(&connection, &detail.command.operation_id).await;
    timeout(Duration::from_secs(25), async {
        loop {
            let current = request(
                &connection,
                reqwest::Method::GET,
                &format!("/v1/executions/{attempt}"),
                None,
            )
            .await;
            if current["state"] == "FINALIZED" {
                assert_eq!(current["resultState"], "ACCEPTED");
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    timeout(Duration::from_secs(15), async {
        loop {
            let status = BudgetClient::from_directory(&budget)
                .unwrap()
                .health()
                .await
                .unwrap();
            if status.held == 0 && status.quarantined == 0 {
                assert_eq!(status.released, 1);
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        HostHandle::open(&directory, execution.identity.host.as_ref().unwrap())
            .unwrap()
            .manifest
            .pid,
        original_host_pid
    );
    let task = request(
        &connection,
        reqwest::Method::GET,
        &format!("/v1/tasks/{task}"),
        None,
    )
    .await;
    assert_eq!(task["status"], "done");
    request(&connection, reqwest::Method::POST, "/v1/shutdown", None).await;
    assert!(
        timeout(Duration::from_secs(10), daemon.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    let _ = client.shutdown().await;
    BudgetClient::from_directory(&budget)
        .unwrap()
        .shutdown()
        .await
        .unwrap();
}
