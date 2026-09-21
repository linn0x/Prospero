use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

struct HostCleanup {
    pid: i32,
    directory: std::path::PathBuf,
}
impl Drop for HostCleanup {
    fn drop(&mut self) {
        use fs2::FileExt;
        if let Ok(lock) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(self.directory.join("owner.lock"))
            && lock.try_lock_exclusive().is_err()
        {
            #[cfg(unix)]
            unsafe {
                libc::kill(self.pid, libc::SIGTERM);
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill.exe")
                    .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
    }
}
struct Daemon {
    child: Child,
    url: String,
    token: String,
    client: reqwest::Client,
}
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Daemon {
    async fn start(root: &Path) -> Self {
        let ready = root.join("connection.json");
        let child = Command::new(env!("CARGO_BIN_EXE_prosperod-rs"))
            .args(["serve", "--data-dir"])
            .arg(root)
            .env("CODEX_HOME", root.join("isolated-codex"))
            .env("PROSPERO_LEGACY_HOME", root.join("no-legacy"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut daemon = Self {
            child,
            url: String::new(),
            token: String::new(),
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
        };
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Ok(bytes) = std::fs::read(&ready)
                    && let Ok(value) = serde_json::from_slice::<Value>(&bytes)
                    && value["pid"].as_u64() == Some(daemon.child.id() as u64)
                {
                    daemon.url = value["baseUrl"].as_str().unwrap().into();
                    daemon.token = value["token"].as_str().unwrap().into();
                    if let Ok(r) = daemon
                        .client
                        .get(format!("{}/v1/health", daemon.url))
                        .bearer_auth(&daemon.token)
                        .send()
                        .await
                        && r.status().is_success()
                    {
                        break;
                    }
                }
                assert!(
                    daemon.child.try_wait().unwrap().is_none(),
                    "daemon exited during startup"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(daemon.get("/v1/health").await["persistence"]["pty"], true);
        daemon
    }
    async fn get(&self, path: &str) -> Value {
        self.client
            .get(format!("{}{path}", self.url))
            .bearer_auth(&self.token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn post(&self, path: &str, body: Value) -> Value {
        self.client
            .post(format!("{}{path}", self.url))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn input(&self, id: &str, s: &str) {
        self.post(
            &format!("/v1/terminals/{id}/input"),
            json!({"dataB64":STANDARD.encode(s)}),
        )
        .await;
    }
    async fn output(&self, id: &str, marker: &str) -> String {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let page = self
                    .get(&format!("/v1/terminals/{id}/output?afterSeq=0"))
                    .await;
                let text = page["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|e| e["dataB64"].as_str())
                    .map(|b| String::from_utf8_lossy(&STANDARD.decode(b).unwrap()).into_owned())
                    .collect::<String>();
                if text.contains(marker) {
                    return text;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap()
    }
    async fn close(&self, id: &str) {
        self.client
            .post(format!("{}/v1/terminals/{id}/close", self.url))
            .bearer_auth(&self.token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn shell_memory_and_output_survive_daemon_sigkill_and_graceful_restart() {
    let root = tempfile::tempdir().unwrap();
    let mut daemon = Daemon::start(root.path()).await;
    let script = "stty -echo; export REMEMBER=alive; printf 'READY:%s\\n' $$; while IFS= read -r line; do case \"$line\" in state) printf 'STATE:%s:%s\\n' $$ \"$REMEMBER\";; size) stty size;; control) prospero schedule list >/dev/null && printf CONTROL_OK;; done) exit 7;; esac; done";
    let head=daemon.post("/v1/terminals",json!({"title":"lifecycle","workspace":root.path(),"size":{"cols":80,"rows":24},"agent":"custom","command":script})).await;
    let id = head["id"].as_str().unwrap().to_owned();
    let host_dir = root.path().join("terminal-hosts").join(&id);
    let connection: Value =
        serde_json::from_slice(&std::fs::read(host_dir.join("host.json")).unwrap()).unwrap();
    let _cleanup = HostCleanup {
        pid: connection["pid"].as_i64().unwrap() as i32,
        directory: host_dir,
    };
    let initial = daemon.output(&id, "READY:").await;
    let pid = initial
        .split("READY:")
        .nth(1)
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .trim()
        .to_owned();
    let previous_url = daemon.url.clone();
    daemon.child.kill().unwrap();
    daemon.child.wait().unwrap();
    daemon = Daemon::start(root.path()).await;
    assert_eq!(daemon.url, previous_url);
    assert_eq!(
        daemon.get(&format!("/v1/sessions/{id}")).await["status"],
        "running"
    );
    daemon.input(&id, "control\n").await;
    daemon.output(&id, "CONTROL_OK").await;
    daemon.input(&id, "state\n").await;
    daemon.output(&id, &format!("STATE:{pid}:alive")).await;
    daemon
        .post(
            &format!("/v1/terminals/{id}/resize"),
            json!({"cols":92,"rows":31}),
        )
        .await;
    daemon.input(&id, "size\n").await;
    daemon.output(&id, "31 92").await;
    daemon.post("/v1/shutdown", json!({})).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while daemon.child.try_wait().unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    daemon = Daemon::start(root.path()).await;
    daemon.input(&id, "state\n").await;
    daemon.output(&id, &format!("STATE:{pid}:alive")).await;
    daemon.close(&id).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let head = daemon.get(&format!("/v1/sessions/{id}")).await;
            if head["lifecycle"] == "archived" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    assert_ne!(
        unsafe { libc::kill(pid.parse::<i32>().unwrap(), 0) },
        0,
        "explicit close must stop original shell"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn exit_while_daemon_is_down_is_archived_on_reattach_and_host_is_private() {
    let root = tempfile::tempdir().unwrap();
    let mut daemon = Daemon::start(root.path()).await;
    let head=daemon.post("/v1/terminals",json!({"title":"offline-exit","workspace":root.path(),"size":{"cols":80,"rows":24},"agent":"custom","command":"printf READY; while [ ! -f finish ]; do sleep 0.05; done; printf OFFLINE_EXIT; exit 7"})).await;
    let id = head["id"].as_str().unwrap().to_owned();
    let directory = root.path().join("terminal-hosts").join(&id);
    let info: Value =
        serde_json::from_slice(&std::fs::read(directory.join("host.json")).unwrap()).unwrap();
    let _cleanup = HostCleanup {
        pid: info["pid"].as_i64().unwrap() as i32,
        directory: directory.clone(),
    };
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(directory.join("host.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o077,
        0
    );
    let host_url = info["base_url"].as_str().unwrap();
    assert_eq!(
        daemon
            .client
            .get(format!("{host_url}identity"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        daemon
            .client
            .get(format!("{host_url}identity"))
            .bearer_auth(info["token"].as_str().unwrap())
            .header("origin", "http://example.invalid")
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    daemon.output(&id, "READY").await;
    daemon.child.kill().unwrap();
    daemon.child.wait().unwrap();
    std::fs::write(root.path().join("finish"), "").unwrap();
    // The owning host, not the dead daemon, must observe and retain the exit.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let activity: Value = daemon
                .client
                .get(format!("{host_url}activity"))
                .bearer_auth(info["token"].as_str().unwrap())
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if activity["exited"] == true {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    daemon = Daemon::start(root.path()).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let head = daemon.get(&format!("/v1/sessions/{id}")).await;
            if head["lifecycle"] == "archived" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    daemon.output(&id, "OFFLINE_EXIT").await;
    assert_eq!(
        daemon
            .get(&format!("/v1/terminals/{id}/output?afterSeq=0"))
            .await["exitCode"],
        7
    );
}

#[cfg(unix)]
#[tokio::test]
async fn hosted_input_backpressure_keeps_non_retryable_failure_contract() {
    let root = tempfile::tempdir().unwrap();
    let daemon = Daemon::start(root.path()).await;
    let head = daemon.post("/v1/terminals", json!({"title":"backpressure","workspace":root.path(),"size":{"cols":80,"rows":24},"agent":"custom","command":"stty raw -echo; printf READY; sleep 30"})).await;
    let id = head["id"].as_str().unwrap();
    let directory = root.path().join("terminal-hosts").join(id);
    let info: Value =
        serde_json::from_slice(&std::fs::read(directory.join("host.json")).unwrap()).unwrap();
    let _cleanup = HostCleanup {
        pid: info["pid"].as_i64().unwrap() as i32,
        directory,
    };
    daemon.output(id, "READY").await;
    let body = json!({"dataB64":STANDARD.encode(vec![b'x';8192])});
    let mut failed = false;
    for _ in 0..64 {
        let response = daemon
            .client
            .post(format!("{}/v1/terminals/{id}/input", daemon.url))
            .bearer_auth(&daemon.token)
            .json(&body)
            .send()
            .await
            .unwrap();
        if !response.status().is_success() {
            let error: Value = response.json().await.unwrap();
            assert_eq!(error["code"], "terminal_input_failed");
            assert_eq!(error["retryable"], false);
            failed = true;
            break;
        }
    }
    assert!(failed, "input must not buffer without a bound");
}

#[cfg(windows)]
#[tokio::test]
async fn conpty_shell_survives_daemon_restarts_and_explicit_close_archives_it() {
    let root = tempfile::tempdir().unwrap();
    let mut daemon = Daemon::start(root.path()).await;
    let command = r#"powershell.exe -NoLogo -NoProfile -Command "$remember='alive'; Write-Output ('READY:'+$PID); while ($null -ne ($line=[Console]::ReadLine())) { if($line -eq 'state') { Write-Output ('STATE:'+$PID+':'+$remember) } }""#;
    let head=daemon.post("/v1/terminals",json!({"title":"windows-lifecycle","workspace":root.path(),"size":{"cols":80,"rows":24},"agent":"custom","command":command})).await;
    let id = head["id"].as_str().unwrap().to_owned();
    let directory = root.path().join("terminal-hosts").join(&id);
    let info: Value =
        serde_json::from_slice(&std::fs::read(directory.join("host.json")).unwrap()).unwrap();
    let _cleanup = HostCleanup {
        pid: info["pid"].as_i64().unwrap() as i32,
        directory,
    };
    let initial = daemon.output(&id, "READY:").await;
    let pid = initial
        .split("READY:")
        .nth(1)
        .unwrap()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    assert!(!pid.is_empty());
    daemon.child.kill().unwrap();
    daemon.child.wait().unwrap();
    daemon = Daemon::start(root.path()).await;
    daemon.input(&id, "state\r\n").await;
    daemon.output(&id, &format!("STATE:{pid}:alive")).await;
    daemon
        .post(
            &format!("/v1/terminals/{id}/resize"),
            json!({"cols":92,"rows":31}),
        )
        .await;
    let page = daemon
        .get(&format!("/v1/terminals/{id}/output?afterSeq=0"))
        .await;
    assert!(
        page["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["type"] == "resize" && e["size"]["rows"] == 31)
    );
    daemon.post("/v1/shutdown", json!({})).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while daemon.child.try_wait().unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    daemon = Daemon::start(root.path()).await;
    daemon.input(&id, "state\r\n").await;
    daemon.output(&id, &format!("STATE:{pid}:alive")).await;
    daemon.close(&id).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if daemon.get(&format!("/v1/sessions/{id}")).await["lifecycle"] == "archived" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
}
