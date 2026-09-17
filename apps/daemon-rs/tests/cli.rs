use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, ChildStdout, Command, Stdio};

use base64::Engine;
use base64::prelude::BASE64_URL_SAFE_NO_PAD;
use serde_json::Value;

fn run(home: &tempfile::TempDir, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_prosperod-rs"))
        .args(args)
        .env("PROSPERO_HOME", home.path())
        .output()
        .unwrap()
}

fn run_at(binary: &str, home: &Path, args: &[&str]) -> std::process::Output {
    Command::new(binary)
        .args(args)
        .env("PROSPERO_HOME", home)
        .output()
        .unwrap()
}

fn text(output: &std::process::Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

struct DaemonGuard {
    child: Child,
    _stdout: BufReader<ChildStdout>,
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn serve(home: &Path, codex_home: &Path) -> DaemonGuard {
    let mut child = Command::new(env!("CARGO_BIN_EXE_prosperod-rs"))
        .args(["serve", "--data-dir", home.to_str().unwrap()])
        .env("CODEX_HOME", codex_home)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["event"], "ready");
    DaemonGuard {
        child,
        _stdout: reader,
    }
}

fn pair_payload(output: &str) -> Value {
    let uri = output
        .split_whitespace()
        .find(|word| word.starts_with("prospero://pair?d="))
        .unwrap();
    let encoded = uri.trim_start_matches("prospero://pair?d=");
    serde_json::from_slice(&BASE64_URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap()
}

#[test]
fn cli_pair_revoke_status_and_rotate_key_match_ts_surface() {
    let home = tempfile::TempDir::new().unwrap();
    let paired = run(
        &home,
        &[
            "pair",
            "--name",
            "phone",
            "--no-shell",
            "--no-orchestration",
        ],
    );
    assert!(paired.status.success(), "{}", text(&paired));
    let paired_text = text(&paired);
    let payload = pair_payload(&paired_text);
    assert_eq!(payload["v"], 7);
    assert_eq!(payload["token"].as_str().unwrap().len(), 32);
    assert_eq!(payload["pubKey"].as_str().unwrap().len(), 44);

    let devices: Value =
        serde_json::from_str(&std::fs::read_to_string(home.path().join("devices.json")).unwrap())
            .unwrap();
    let device = &devices["devices"][0];
    assert_eq!(device["name"], "phone");
    assert_eq!(device["allowShell"], false);
    assert_eq!(device["allowOrchestration"], false);

    let status = run(&home, &["status"]);
    assert!(status.status.success(), "{}", text(&status));
    assert!(text(&status).contains("设备(1):"));

    let id = {
        use sha2::{Digest, Sha256};
        BASE64_URL_SAFE_NO_PAD.encode(Sha256::digest(device["token"].as_str().unwrap()))
    };
    let revoked = run(&home, &["revoke", "--id", &id]);
    assert!(revoked.status.success(), "{}", text(&revoked));
    assert!(text(&revoked).contains("已撤销设备"));

    let dry_rotate = run(&home, &["rotate-key"]);
    assert!(dry_rotate.status.success(), "{}", text(&dry_rotate));
    assert!(text(&dry_rotate).contains("--yes"));
}

#[test]
fn cli_relay_commands_preserve_config_and_emit_json_status() {
    let home = tempfile::TempDir::new().unwrap();
    std::fs::write(
        home.path().join("config.json"),
        serde_json::json!({"port":7423,"notify":{"url":"https://ntfy.sh/topic"}}).to_string(),
    )
    .unwrap();

    let enabled = run(
        &home,
        &["relay", "enable", "--url", "wss://relay.example.com/root"],
    );
    assert!(enabled.status.success(), "{}", text(&enabled));
    let status = run(&home, &["relay", "status", "--json"]);
    assert!(status.status.success(), "{}", text(&status));
    let body: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(body["enabled"], true);
    assert_eq!(body["url"], "wss://relay.example.com/root");
    assert_eq!(body["state"], "offline");
    assert!(body["routeId"].as_str().unwrap().len() >= 40);

    let config: Value =
        serde_json::from_str(&std::fs::read_to_string(home.path().join("config.json")).unwrap())
            .unwrap();
    assert_eq!(config["notify"]["url"], "https://ntfy.sh/topic");
    assert!(config["relay"]["hostSecret"].as_str().is_some());

    let paired = run(&home, &["pair", "--name", "relay-phone"]);
    assert!(paired.status.success(), "{}", text(&paired));
    let payload = pair_payload(&text(&paired));
    assert_eq!(payload["relay"]["v"], 1);
    assert_eq!(payload["relay"]["url"], "wss://relay.example.com/root");

    let rotated = run(&home, &["relay", "rotate-key", "--yes"]);
    assert!(rotated.status.success(), "{}", text(&rotated));
    let devices: Value =
        serde_json::from_str(&std::fs::read_to_string(home.path().join("devices.json")).unwrap())
            .unwrap();
    assert!(devices["devices"][0].get("relayDeviceId").is_none());

    let disabled = run(&home, &["relay", "disable"]);
    assert!(disabled.status.success(), "{}", text(&disabled));
    let disabled_status = run(&home, &["relay", "status", "--json"]);
    let body: Value = serde_json::from_slice(&disabled_status.stdout).unwrap();
    assert_eq!(body["enabled"], false);
    assert_eq!(body["url"], "wss://relay.example.com/root");
}

#[test]
fn cli_notify_configures_and_clears_endpoint() {
    let home = tempfile::TempDir::new().unwrap();
    let saved = run(&home, &["notify", "--url", "https://ntfy.sh/topic"]);
    assert!(saved.status.success(), "{}", text(&saved));
    assert!(text(&saved).contains("推送端点已保存:https://ntfy.sh/topic"));
    let cleared = run(&home, &["notify", "--off"]);
    assert!(cleared.status.success(), "{}", text(&cleared));
    let config: Value =
        serde_json::from_str(&std::fs::read_to_string(home.path().join("config.json")).unwrap())
            .unwrap();
    assert!(config.get("notify").is_none());
}

#[test]
fn cli_plugin_and_schedule_commands_use_running_rust_daemon() {
    let home = tempfile::TempDir::new().unwrap();
    let codex_home = home.path().join("codex-home");
    let workspace = home.path().join("workspace");
    let plugin_root = home.path().join("plugins/prospero-demo/runtime");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&plugin_root).unwrap();
    std::fs::write(
        plugin_root.join("service.mjs"),
        "setInterval(() => {}, 1000);\n",
    )
    .unwrap();
    std::fs::write(
        home.path()
            .join("plugins/prospero-demo/prospero-plugin.json"),
        serde_json::json!({
            "schema_version": "prospero-plugin/v1",
            "name": "prospero-demo",
            "services": [{
                "id": "bridge",
                "mode": "manual",
                "command": ["node", "service.mjs"],
                "cwd": "runtime",
                "env": {"FEATURE_FLAG": "1"},
                "port_env": "PORT",
                "health_path": "/health"
            }]
        })
        .to_string(),
    )
    .unwrap();
    let _daemon = serve(home.path(), &codex_home);

    let plugins = run_at(
        env!("CARGO_BIN_EXE_prosperod-rs"),
        home.path(),
        &["plugin", "list", "--home", home.path().to_str().unwrap()],
    );
    assert!(plugins.status.success(), "{}", text(&plugins));
    let body: Value = serde_json::from_slice(&plugins.stdout).unwrap();
    assert_eq!(body["items"][0]["name"], "prospero-demo");

    let created = run_at(
        env!("CARGO_BIN_EXE_prospero"),
        home.path(),
        &[
            "--home",
            home.path().to_str().unwrap(),
            "schedule",
            "create",
            "--id",
            "daily-check",
            "--name",
            "Daily check",
            "--prompt",
            "Check the repo",
            "--rrule",
            "FREQ=DAILY",
            "--cwd",
            workspace.to_str().unwrap(),
            "--paused",
        ],
    );
    assert!(created.status.success(), "{}", text(&created));
    let body: Value = serde_json::from_slice(&created.stdout).unwrap();
    assert_eq!(body["id"], "daily-check");
    assert_eq!(body["status"], "PAUSED");

    let list = run_at(
        env!("CARGO_BIN_EXE_prospero"),
        home.path(),
        &["--home", home.path().to_str().unwrap(), "schedule", "list"],
    );
    assert!(list.status.success(), "{}", text(&list));
    let body: Value = serde_json::from_slice(&list.stdout).unwrap();
    assert_eq!(body.as_array().unwrap().len(), 1);

    let deleted = run_at(
        env!("CARGO_BIN_EXE_prospero"),
        home.path(),
        &[
            "--home",
            home.path().to_str().unwrap(),
            "schedule",
            "delete",
            "--id",
            "daily-check",
        ],
    );
    assert!(deleted.status.success(), "{}", text(&deleted));
    let body: Value = serde_json::from_slice(&deleted.stdout).unwrap();
    assert_eq!(body["deleted"], true);
}
