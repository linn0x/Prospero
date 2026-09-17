use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::{Client, Method};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::error::{Error, Result};

#[derive(Debug, Clone)]
pub struct ControlClient {
    base_url: String,
    token: String,
    timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct ControlEnvironment {
    pub home: PathBuf,
    pub base_url: String,
    pub token_path: PathBuf,
    pub socket_path: String,
    pub cli_dir: Option<PathBuf>,
}

impl ControlEnvironment {
    pub fn vars(&self, session_id: Option<&str>) -> Vec<(String, String)> {
        let mut out = vec![
            (
                "PROSPERO_HOME".into(),
                self.home.to_string_lossy().into_owned(),
            ),
            ("PROSPERO_CONTROL_HTTP".into(), self.base_url.clone()),
            (
                "PROSPERO_CONTROL_TOKEN_PATH".into(),
                self.token_path.to_string_lossy().into_owned(),
            ),
            (
                "PROSPERO_CONTROL_SOCKET_PATH".into(),
                self.socket_path.clone(),
            ),
            ("PROSPERO_CONTROL_SOCK".into(), self.socket_path.clone()),
        ];
        if let Some(session_id) = session_id {
            out.push(("PROSPERO_SESSION_ID".into(), session_id.to_owned()));
        }
        if let Some(path) = self.path() {
            out.push(("PATH".into(), path));
        }
        out
    }

    fn path(&self) -> Option<String> {
        let cli_dir = self.cli_dir.as_ref()?;
        let mut entries = vec![cli_dir.clone()];
        if let Some(path) = std::env::var_os("PATH") {
            entries.extend(std::env::split_paths(&path));
        }
        std::env::join_paths(entries)
            .ok()
            .map(|value| value.to_string_lossy().into_owned())
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionFile {
    api_version: u32,
    base_url: String,
    token: String,
}

impl ControlClient {
    pub fn from_home(home: &Path) -> Result<Self> {
        Self::from_home_with_overrides(home, None, None)
    }

    pub fn from_home_with_overrides(
        home: &Path,
        base_url: Option<String>,
        token_path: Option<&Path>,
    ) -> Result<Self> {
        let mut connection = match base_url {
            Some(base_url) => ConnectionFile {
                api_version: crate::protocol::API_VERSION,
                base_url,
                token: String::new(),
            },
            None => read_connection(home)?,
        };
        if let Some(token_path) = token_path {
            connection.token = read_token(token_path)?;
        }
        if !valid_base_url(&connection.base_url) || !valid_token(&connection.token) {
            return Err(Error::Invalid("invalid daemon connection file".into()));
        }
        Ok(Self {
            base_url: connection.base_url.trim_end_matches('/').to_owned(),
            token: connection.token,
            timeout: Duration::from_secs(30),
        })
    }

    pub fn from_env_or_home(home: &Path) -> Result<Self> {
        if let Some(base_url) = std::env::var("PROSPERO_CONTROL_HTTP")
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            let token_path = std::env::var_os("PROSPERO_CONTROL_TOKEN_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("control.token"));
            return Self::from_home_with_overrides(home, Some(base_url), Some(&token_path));
        }
        Self::from_home(home)
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.request(Method::GET, path, None).await
    }

    pub async fn post<T: DeserializeOwned>(&self, path: &str, body: Value) -> Result<T> {
        self.request(Method::POST, path, Some(body)).await
    }

    pub async fn patch<T: DeserializeOwned>(&self, path: &str, body: Value) -> Result<T> {
        self.request(Method::PATCH, path, Some(body)).await
    }

    pub async fn delete<T: DeserializeOwned>(&self, path: &str, body: Option<Value>) -> Result<T> {
        self.request(Method::DELETE, path, body).await
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T> {
        let url = format!("{}{}", self.base_url, path);
        let mut request = Client::builder()
            .timeout(self.timeout)
            .build()
            .map_err(|error| Error::Invalid(error.to_string()))?
            .request(method, url)
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| Error::Invalid(format!("无法连接本机 Rust 服务: {error}")))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| Error::Invalid(format!("无法读取 Rust 服务响应: {error}")))?;
        if !status.is_success() {
            let value = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| value.get("error").and_then(Value::as_str))
                .map(str::to_owned)
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).trim().to_owned());
            let code = value
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("request_failed");
            return Err(Error::Feature(
                code.into(),
                format!(
                    "Rust 服务请求失败（{}）{}",
                    status.as_u16(),
                    if message.is_empty() {
                        String::new()
                    } else {
                        format!("：{message}")
                    }
                ),
            ));
        }
        serde_json::from_slice(&bytes).map_err(Into::into)
    }
}

fn read_connection(home: &Path) -> Result<ConnectionFile> {
    let path = home.join("connection.json");
    let raw = fs::read_to_string(&path).map_err(|error| {
        Error::Invalid(format!(
            "无法读取 Rust daemon 连接文件 {}：{error}",
            path.display()
        ))
    })?;
    let connection: ConnectionFile = serde_json::from_str(&raw)?;
    if connection.api_version != crate::protocol::API_VERSION {
        return Err(Error::Invalid("invalid daemon connection file".into()));
    }
    Ok(connection)
}

fn read_token(path: &Path) -> Result<String> {
    let token = fs::read_to_string(path)
        .map_err(|error| {
            Error::Invalid(format!(
                "无法读取控制 token 文件 {}：{error}",
                path.display()
            ))
        })?
        .trim()
        .to_owned();
    if !valid_token(&token) {
        return Err(Error::Invalid("invalid daemon credential".into()));
    }
    Ok(token)
}

pub fn prospero_home(data_dir: Option<PathBuf>) -> PathBuf {
    data_dir
        .or_else(|| std::env::var_os("PROSPERO_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".prospero")))
        .or_else(|| {
            std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".prospero"))
        })
        .unwrap_or_else(|| PathBuf::from(".prospero"))
}

fn valid_base_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.scheme() == "http"
        && matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("[::1]") | Some("::1")
        )
        && url.username().is_empty()
        && url.password().is_none()
}

fn valid_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub async fn control_method(home: &Path, method: &str, params: Value) -> Result<Value> {
    let client = ControlClient::from_env_or_home(home)?.with_timeout(timeout_for(method, &params));
    match method {
        "plugin.list" => client.get("/v1/plugins").await,
        "plugin.service.status" => client.get("/v1/plugin-services").await,
        "plugin.service.start" => {
            let plugin_id = required_plugin_id(&params, "pluginId")?;
            let service_id = required_plugin_id(&params, "serviceId")?;
            client
                .post(
                    &format!(
                        "/v1/plugin/{}/service/{}/start",
                        path_component(&plugin_id),
                        path_component(&service_id)
                    ),
                    json!({}),
                )
                .await
        }
        "plugin.service.stop" => {
            let plugin_id = required_plugin_id(&params, "pluginId")?;
            let service_id = required_plugin_id(&params, "serviceId")?;
            client
                .post(
                    &format!(
                        "/v1/plugin/{}/service/{}/stop",
                        path_component(&plugin_id),
                        path_component(&service_id)
                    ),
                    json!({}),
                )
                .await
        }
        "plugin.service.restart" => {
            let plugin_id = required_plugin_id(&params, "pluginId")?;
            let service_id = required_plugin_id(&params, "serviceId")?;
            client
                .post(
                    &format!(
                        "/v1/plugin/{}/service/{}/restart",
                        path_component(&plugin_id),
                        path_component(&service_id)
                    ),
                    json!({}),
                )
                .await
        }
        "plugin.service.health" => {
            let plugin_id = required_plugin_id(&params, "pluginId")?;
            let service_id = required_plugin_id(&params, "serviceId")?;
            client
                .get(&format!(
                    "/v1/plugin/{}/service/{}/health",
                    path_component(&plugin_id),
                    path_component(&service_id)
                ))
                .await
        }
        "schedule.list" => client.get("/v1/schedules").await,
        "schedule.get" => {
            let id = required_schedule_id(&params)?;
            client
                .get(&format!("/v1/schedules/{}", path_component(&id)))
                .await
        }
        "schedule.create" => {
            client
                .post("/v1/schedules", strip_empty(params, &["type", "requestId"]))
                .await
        }
        "schedule.update" => {
            let id = required_schedule_id(&params)?;
            client
                .patch(
                    &format!("/v1/schedules/{}", path_component(&id)),
                    strip_empty(params, &["type", "requestId", "actorSessionId"]),
                )
                .await
        }
        "schedule.pause" => {
            let id = required_schedule_id(&params)?;
            client
                .post(
                    &format!("/v1/schedules/{}/pause", path_component(&id)),
                    json!({}),
                )
                .await
        }
        "schedule.resume" => {
            let id = required_schedule_id(&params)?;
            client
                .post(
                    &format!("/v1/schedules/{}/resume", path_component(&id)),
                    json!({}),
                )
                .await
        }
        "schedule.delete" => {
            let id = required_schedule_id(&params)?;
            client
                .delete(&format!("/v1/schedules/{}", path_component(&id)), None)
                .await
        }
        "schedule.run" => {
            let id = required_schedule_id(&params)?;
            client
                .post(
                    &format!("/v1/schedules/{}/run", path_component(&id)),
                    json!({}),
                )
                .await
        }
        "orchestration.snapshot" => {
            let (runs, tasks, dispatches, gates, worktree_assets) = tokio::try_join!(
                client.get::<Value>("/v1/runs"),
                client.get::<Value>("/v1/tasks"),
                client.get::<Value>("/v1/dispatches"),
                client.get::<Value>("/v1/gates"),
                client.get::<Value>("/v1/worktrees"),
            )?;
            let schedules = client
                .get::<Value>("/v1/schedules")
                .await
                .unwrap_or(json!([]));
            Ok(json!({
                "runs": map_by_id(runs),
                "tasks": map_by_id(tasks),
                "dispatches": map_by_id(dispatches),
                "gates": map_by_id(gates),
                "worktreeAssets": map_by_id(worktree_assets),
                "schedules": map_by_id(schedules),
            }))
        }
        "run.create" => {
            client
                .post(
                    "/v1/runs",
                    strip_empty(
                        json!({
                            "objective": required_text(&params, "objective")?,
                            "coordinatorSessionId": optional_text(&params, "coordinatorSessionId"),
                        }),
                        &[],
                    ),
                )
                .await
        }
        "run.list" => client.get("/v1/runs").await,
        "run.complete" => {
            let run_id = required_id(&params, "runId")?;
            client
                .post(
                    &format!("/v1/runs/{}/complete", path_component(&run_id)),
                    json!({"allowFailedTasks": params.get("allowFailedTasks").and_then(Value::as_bool).unwrap_or(false)}),
                )
                .await
        }
        "run.abandon" => {
            let run_id = required_id(&params, "runId")?;
            client
                .post(
                    &format!("/v1/runs/{}/abandon", path_component(&run_id)),
                    json!({}),
                )
                .await
        }
        "run.delete" => {
            let run_id = required_id(&params, "runId")?;
            client
                .delete(
                    &format!("/v1/runs/{}", path_component(&run_id)),
                    Some(json!({"force": params.get("force").and_then(Value::as_bool).unwrap_or(false)})),
                )
                .await
        }
        "task.create" => {
            client
                .post(
                    "/v1/tasks",
                    json!({
                        "runId": required_id(&params, "runId")?,
                        "title": required_text(&params, "title")?,
                        "spec": required_text(&params, "spec")?,
                        "skills": string_list(&params, "skills")?,
                        "deps": string_list(&params, "deps")?,
                        "parentId": optional_text(&params, "parentId"),
                    }),
                )
                .await
        }
        "task.list" => {
            if let Some(run_id) = optional_text(&params, "runId") {
                client
                    .get(&format!("/v1/tasks?runId={}", query_component(&run_id)))
                    .await
            } else {
                client.get("/v1/tasks").await
            }
        }
        "task.get" => {
            let task_id = required_id(&params, "taskId")?;
            client
                .get(&format!("/v1/tasks/{}", path_component(&task_id)))
                .await
        }
        "task.cancel" => {
            let task_id = required_id(&params, "taskId")?;
            client
                .post(
                    &format!("/v1/tasks/{}/cancel", path_component(&task_id)),
                    strip_empty(json!({"reason": optional_text(&params, "reason")}), &[]),
                )
                .await
        }
        "task.retry" => {
            let task_id = required_id(&params, "taskId")?;
            client
                .post(
                    &format!("/v1/tasks/{}/retry", path_component(&task_id)),
                    json!({}),
                )
                .await
        }
        "task.done" => {
            let task_id = required_id(&params, "taskId")?;
            client
                .post(
                    &format!("/v1/tasks/{}/complete", path_component(&task_id)),
                    strip_empty(
                        json!({"body": required_text(&params, "body")?, "actorSessionId": optional_text(&params, "actorSessionId")}),
                        &[],
                    ),
                )
                .await
        }
        "task.fail" => {
            let task_id = required_id(&params, "taskId")?;
            client
                .post(
                    &format!("/v1/tasks/{}/fail", path_component(&task_id)),
                    strip_empty(
                        json!({"body": required_text(&params, "body")?, "actorSessionId": optional_text(&params, "actorSessionId")}),
                        &[],
                    ),
                )
                .await
        }
        "worker.start" => client
            .post(
                "/v1/workers/start",
                strip_empty(
                    json!({
                    "taskId": required_id(&params, "taskId")?,
                    "agent": optional_text(&params, "agent").unwrap_or_else(|| "claude".into()),
                    "worktree": optional_text(&params, "worktree").unwrap_or_else(|| "none".into()),
                    "cwd": required_text(&params, "cwd")?,
                    "kind": optional_text(&params, "kind"),
                    "approvalPolicy": optional_text(&params, "approvalPolicy"),
                    "skills": string_list(&params, "skills")?,
                    "accountId": optional_text(&params, "accountId"),
                    "operationId": optional_text(&params, "operationId"),
                    }),
                    &[],
                ),
            )
            .await,
        "worker.stop" => {
            client
                .post(
                    "/v1/workers/stop",
                    strip_empty(
                        json!({
                        "taskId": required_id(&params, "taskId")?,
                        "reason": optional_text(&params, "reason"),
                        "finalStatus": optional_text(&params, "finalStatus"),
                        }),
                        &[],
                    ),
                )
                .await
        }
        "worktree.list" => {
            if let Some(run_id) = optional_text(&params, "runId") {
                client
                    .get(&format!("/v1/worktrees?runId={}", query_component(&run_id)))
                    .await
            } else {
                client.get("/v1/worktrees").await
            }
        }
        "worktree.inspect" => {
            let asset_id = required_id(&params, "assetId")?;
            client
                .post(
                    &format!("/v1/worktrees/{}/inspect", path_component(&asset_id)),
                    json!({"targetRef": optional_text(&params, "targetRef").unwrap_or_else(|| "HEAD".into())}),
                )
                .await
        }
        "worktree.cleanup" => {
            let asset_id = required_id(&params, "assetId")?;
            client
                .post(
                    &format!("/v1/worktrees/{}/cleanup", path_component(&asset_id)),
                    json!({
                        "targetRef": optional_text(&params, "targetRef").unwrap_or_else(|| "HEAD".into()),
                        "confirm": params.get("confirm").and_then(Value::as_bool).unwrap_or(false),
                        "deleteBranch": params.get("deleteBranch").and_then(Value::as_bool).unwrap_or(false),
                    }),
                )
                .await
        }
        "automation.start" => {
            let run_id = required_id(&params, "runId")?;
            client
                .post(
                    &format!("/v1/runs/{}/automation/start", path_component(&run_id)),
                    strip_empty(
                        json!({
                        "runId": run_id,
                        "agent": optional_text(&params, "agent").unwrap_or_else(|| "claude".into()),
                        "accountId": optional_text(&params, "accountId"),
                        "approvalPolicy": required_text(&params, "approvalPolicy")?,
                        "workspace": required_text(&params, "workspace")?,
                        "cwd": required_text(&params, "cwd")?,
                        }),
                        &[],
                    ),
                )
                .await
        }
        "automation.pause" => {
            let run_id = required_id(&params, "runId")?;
            client
                .post(
                    &format!("/v1/runs/{}/automation/pause", path_component(&run_id)),
                    json!({}),
                )
                .await
        }
        "gate.create" => {
            let run_id = required_id(&params, "runId")?;
            client
                .post(
                    &format!("/v1/runs/{}/gates", path_component(&run_id)),
                    strip_empty(
                        json!({
                        "taskId": optional_text(&params, "taskId"),
                        "question": required_text(&params, "question")?,
                        "options": string_list(&params, "options")?,
                        }),
                        &[],
                    ),
                )
                .await
        }
        "gate.resolve" => {
            let gate_id = required_id(&params, "gateId")?;
            client
                .post(
                    &format!("/v1/gates/{}/resolve", path_component(&gate_id)),
                    json!({"decision": required_text(&params, "decision")?}),
                )
                .await
        }
        "gate.list" => {
            let mut query = Vec::new();
            if let Some(run_id) = optional_text(&params, "runId") {
                query.push(format!("runId={}", query_component(&run_id)));
            }
            if let Some(status) = optional_text(&params, "status") {
                query.push(format!("status={}", query_component(&status)));
            }
            let suffix = if query.is_empty() {
                String::new()
            } else {
                format!("?{}", query.join("&"))
            };
            client.get(&format!("/v1/gates{suffix}")).await
        }
        "mail.send" => {
            client
                .post(
                    "/v1/messages",
                    strip_empty(
                        json!({
                        "runId": required_id(&params, "runId")?,
                        "from": required_text(&params, "from")?,
                        "to": required_text(&params, "to")?,
                        "type": required_text(&params, "type")?,
                        "subject": required_text(&params, "subject")?,
                        "body": required_text(&params, "body")?,
                        "threadId": optional_text(&params, "threadId"),
                        "taskId": optional_text(&params, "taskId"),
                        }),
                        &[],
                    ),
                )
                .await
        }
        "mail.check" => check_messages(&client, params).await,
        "mail.ask" => ask_message(&client, params).await,
        "mail.reply" => reply_message(&client, params).await,
        _ => Err(Error::Feature(
            "method_not_found".into(),
            format!("未知控制方法: {method}"),
        )),
    }
}

fn timeout_for(method: &str, params: &Value) -> Duration {
    if method == "worker.start" || method == "schedule.run" {
        return Duration::from_secs(5 * 60);
    }
    if (method == "mail.check" || method == "mail.ask")
        && params
            .get("wait")
            .and_then(Value::as_bool)
            .unwrap_or(method == "mail.ask")
    {
        return Duration::from_secs(15 * 60 + 5);
    }
    Duration::from_secs(30)
}

fn map_by_id(value: Value) -> Value {
    let Some(items) = value.as_array() else {
        return json!({});
    };
    let mut out = serde_json::Map::new();
    for item in items {
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            out.insert(id.to_owned(), item.clone());
        }
    }
    Value::Object(out)
}

async fn check_messages(client: &ControlClient, params: Value) -> Result<Value> {
    let recipient = required_text(&params, "recipient")?;
    let run_id = optional_text(&params, "runId");
    let wait = params.get("wait").and_then(Value::as_bool).unwrap_or(false);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15 * 60);
    loop {
        let messages = unread_messages_for(client, &recipient, run_id.as_deref()).await?;
        if messages.as_array().is_some_and(|items| !items.is_empty()) || !wait {
            return Ok(messages);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(messages);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn unread_messages_for(
    client: &ControlClient,
    recipient: &str,
    run_id: Option<&str>,
) -> Result<Value> {
    let mut query = vec![format!("recipient={}", query_component(recipient))];
    if let Some(run_id) = run_id {
        query.push(format!("runId={}", query_component(run_id)));
    }
    let messages = client
        .get::<Value>(&format!("/v1/messages/unread?{}", query.join("&")))
        .await?;
    if let Some(ids) = messages.as_array().map(|items| {
        items
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect::<Vec<_>>()
    }) && !ids.is_empty()
    {
        let _: Value = client
            .post("/v1/messages/read", json!({"ids": ids}))
            .await?;
    }
    Ok(messages)
}

async fn ask_message(client: &ControlClient, params: Value) -> Result<Value> {
    let run_id = required_id(&params, "runId")?;
    let from = required_text(&params, "from")?;
    let to = required_text(&params, "to")?;
    let thread_id = format!("thread_{}", uuid::Uuid::new_v4().simple());
    let ask = client
        .post::<Value>(
            "/v1/messages",
            strip_empty(
                json!({
                        "runId": run_id.clone(),
                        "from": from.clone(),
                "to": to,
                "type": "ask",
                "subject": required_text(&params, "subject")?,
                "body": required_text(&params, "body")?,
                        "threadId": thread_id.clone(),
                "taskId": optional_text(&params, "taskId"),
                        }),
                &[],
            ),
        )
        .await?;
    if !params.get("wait").and_then(Value::as_bool).unwrap_or(true) {
        return Ok(json!({"ask": ask, "reply": null}));
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15 * 60);
    loop {
        let messages = client
            .get::<Value>(&format!("/v1/messages?runId={}", query_component(&run_id)))
            .await?;
        let reply = messages.as_array().and_then(|items| {
            items.iter().find(|item| {
                item.get("type").and_then(Value::as_str) == Some("reply")
                    && item.get("threadId").and_then(Value::as_str) == Some(thread_id.as_str())
                    && item.get("to").and_then(Value::as_str) == Some(from.as_str())
            })
        });
        if let Some(reply) = reply {
            if let Some(id) = reply.get("id").and_then(Value::as_str) {
                let _ = client
                    .post::<Value>("/v1/messages/read", json!({"ids": [id]}))
                    .await;
            }
            if let Some(id) = ask.get("id").and_then(Value::as_str) {
                let _ = client
                    .post::<Value>(
                        &format!("/v1/messages/{}/answered", path_component(id)),
                        json!({}),
                    )
                    .await;
            }
            return Ok(json!({"ask": ask, "reply": reply}));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(json!({"ask": ask, "reply": null}));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn reply_message(client: &ControlClient, params: Value) -> Result<Value> {
    let run_id = required_id(&params, "runId")?;
    let from = required_text(&params, "from")?;
    let to = required_text(&params, "to")?;
    let thread_id = required_id(&params, "threadId")?;
    let messages = client
        .get::<Value>(&format!("/v1/messages?runId={}", query_component(&run_id)))
        .await?;
    let ask_id = messages.as_array().and_then(|items| {
        items.iter().find_map(|item| {
            (item.get("type").and_then(Value::as_str) == Some("ask")
                && item.get("threadId").and_then(Value::as_str) == Some(thread_id.as_str())
                && item.get("to").and_then(Value::as_str) == Some(from.as_str())
                && item.get("from").and_then(Value::as_str) == Some(to.as_str()))
            .then(|| item.get("id").and_then(Value::as_str).map(str::to_owned))
            .flatten()
        })
    });
    let Some(ask_id) = ask_id else {
        return Err(Error::Feature(
            "thread_not_found".into(),
            format!("找不到提问线程 {thread_id}"),
        ));
    };
    let reply = client
        .post::<Value>(
            "/v1/messages",
            strip_empty(
                json!({
                "runId": run_id,
                "from": from,
                "to": to,
                "type": "reply",
                "subject": required_text(&params, "subject")?,
                "body": required_text(&params, "body")?,
                "threadId": thread_id,
                "taskId": optional_text(&params, "taskId"),
                        }),
                &[],
            ),
        )
        .await?;
    let _ = client
        .post::<Value>(
            &format!("/v1/messages/{}/answered", path_component(&ask_id)),
            json!({}),
        )
        .await;
    Ok(reply)
}

fn required_text(value: &Value, key: &str) -> Result<String> {
    let Some(text) = value.get(key).and_then(Value::as_str) else {
        return Err(Error::Invalid(format!("缺少 {key}")));
    };
    let text = text.trim();
    if text.is_empty() || text.chars().any(|c| c == '\0' || c.is_control()) {
        return Err(Error::Invalid(format!("缺少 {key}")));
    }
    Ok(text.to_owned())
}

fn optional_text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn required_id(value: &Value, key: &str) -> Result<String> {
    let text = required_text(value, key)?;
    crate::database::validate_id(&text)?;
    Ok(text)
}

fn required_plugin_id(value: &Value, key: &str) -> Result<String> {
    let text = required_text(value, key)?;
    let mut bytes = text.bytes();
    let Some(first) = bytes.next() else {
        return Err(Error::Invalid(format!("{key} is invalid")));
    };
    if !first.is_ascii_lowercase()
        || text.len() > 64
        || !bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
    {
        return Err(Error::Invalid(format!("{key} is invalid")));
    }
    Ok(text)
}

fn required_schedule_id(value: &Value) -> Result<String> {
    let text = required_text(value, "id")?;
    if text.len() > 100
        || !text.as_bytes()[0].is_ascii_alphanumeric()
        || !text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(Error::Invalid("定时任务 ID 无效".into()));
    }
    Ok(text)
}

fn string_list(value: &Value, key: &str) -> Result<Vec<String>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| Error::Invalid(format!("{key} must be a string array")))
            })
            .collect(),
        _ => Err(Error::Invalid(format!("{key} must be a string array"))),
    }
}

fn strip_empty(mut value: Value, keys: &[&str]) -> Value {
    if let Some(object) = value.as_object_mut() {
        for key in keys {
            object.remove(*key);
        }
        object.retain(|_, value| !value.is_null());
    }
    value
}

fn path_component(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn query_component(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}
