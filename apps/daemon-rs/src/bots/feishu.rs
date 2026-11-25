use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc, watch};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use url::Url;

use super::pbbp2::{
    ChunkAssembler, FRAME_TYPE_CONTROL, FRAME_TYPE_DATA, HEADER_MESSAGE_ID, HEADER_SEQ, HEADER_SUM,
    HEADER_TYPE, MESSAGE_TYPE_EVENT, MESSAGE_TYPE_PONG, PbbpFrame,
};
use super::{
    BotFeishuProbeResult, BotFeishuRuntimeStatus, BotThreadChannel, BotsSupervisor,
    FeishuAccessPolicy, FeishuConnectionState, FeishuDomain, FeishuGroupTrigger,
    FeishuMemoryTurnInput, FeishuThreadMetadata,
};
use crate::database::now;
use crate::error::{Error, Result};
use crate::protocol::{MessageRole, SessionStatus, TimelineBody, TimelineQuery, TimelineTextQuery};

const MAX_SEEN_IDS: usize = 1024;
const STREAM_THROTTLE: Duration = Duration::from_millis(1000);
const MAX_WATCH_DURATION: Duration = Duration::from_secs(15 * 60);
const MAX_CARD_CHARS: usize = 8_000;

#[derive(Debug, Clone)]
pub struct FeishuWorkerConfig {
    pub bot_id: String,
    pub bot_name: String,
    pub domain: FeishuDomain,
    pub app_id: String,
    pub app_secret: String,
    #[allow(dead_code)]
    pub group_trigger: FeishuGroupTrigger,
    #[allow(dead_code)]
    pub streaming_card: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct EndpointClientConfig {
    #[allow(dead_code)]
    #[serde(default)]
    reconnect_count: Option<i64>,
    #[serde(default)]
    reconnect_interval: Option<u64>,
    #[serde(default)]
    reconnect_nonce: Option<u64>,
    #[serde(default)]
    ping_interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct EndpointData {
    #[serde(rename = "URL")]
    url: String,
    #[serde(rename = "ClientConfig", default)]
    client_config: Option<EndpointClientConfig>,
}

#[derive(Debug, Deserialize)]
struct EndpointResponse {
    code: i64,
    #[serde(default)]
    msg: String,
    #[serde(default)]
    data: Option<EndpointData>,
}

#[derive(Debug, Clone)]
struct CachedTenantToken {
    token: String,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
struct CachedName {
    value: Option<String>,
    expires_at: Instant,
}

const NAME_CACHE_HIT_TTL: Duration = Duration::from_secs(30 * 60);
const NAME_CACHE_MISS_TTL: Duration = Duration::from_secs(5 * 60);

async fn cached_name_lookup<F, Fut>(
    cache: &Mutex<HashMap<String, CachedName>>,
    key: &str,
    fetcher: F,
) -> Option<String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Option<String>>,
{
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return None;
    }
    {
        let guard = cache.lock().await;
        if let Some(entry) = guard.get(trimmed)
            && entry.expires_at > Instant::now()
        {
            return entry.value.clone();
        }
    }
    let fetched = fetcher().await;
    let ttl = if fetched.is_some() {
        NAME_CACHE_HIT_TTL
    } else {
        NAME_CACHE_MISS_TTL
    };
    let mut guard = cache.lock().await;
    if guard.len() > MAX_SEEN_IDS {
        guard.clear();
    }
    guard.insert(
        trimmed.to_owned(),
        CachedName {
            value: fetched.clone(),
            expires_at: Instant::now() + ttl,
        },
    );
    fetched
}

#[derive(Clone)]
pub struct FeishuApiClient {
    http: Client,
    base_url: String,
    app_id: String,
    app_secret: String,
    token_cache: Arc<Mutex<Option<CachedTenantToken>>>,
    chat_name_cache: Arc<Mutex<HashMap<String, CachedName>>>,
    user_name_cache: Arc<Mutex<HashMap<String, CachedName>>>,
}

impl FeishuApiClient {
    pub fn new(domain: FeishuDomain, app_id: String, app_secret: String) -> Result<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| Error::Invalid(format!("无法初始化飞书 HTTP 客户端：{error}")))?;
        Ok(Self {
            http,
            base_url: domain.base_url().to_owned(),
            app_id,
            app_secret,
            token_cache: Arc::new(Mutex::new(None)),
            chat_name_cache: Arc::new(Mutex::new(HashMap::new())),
            user_name_cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn tenant_access_token(&self) -> Result<String> {
        {
            let guard = self.token_cache.lock().await;
            if let Some(cached) = guard.as_ref()
                && Instant::now() < cached.expires_at
            {
                return Ok(cached.token.clone());
            }
        }
        let url = format!(
            "{}/open-apis/auth/v3/tenant_access_token/internal",
            self.base_url
        );
        let resp = self
            .http
            .post(&url)
            .json(&json!({
                "app_id": self.app_id,
                "app_secret": self.app_secret,
            }))
            .send()
            .await
            .map_err(|error| Error::Invalid(format!("获取飞书 token 网络失败：{error}")))?;
        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|error| Error::Invalid(format!("解析飞书 token 响应失败：{error}")))?;
        let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);
        if !status.is_success() || code != 0 {
            let msg = body
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("未知错误");
            return Err(Error::Invalid(format!("飞书鉴权失败 (code={code}): {msg}")));
        }
        let token = body
            .get("tenant_access_token")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| Error::Invalid("飞书响应缺少 tenant_access_token".into()))?
            .to_owned();
        let expire_secs = body
            .get("expire")
            .and_then(Value::as_u64)
            .unwrap_or(7200)
            .saturating_sub(180)
            .max(60);
        let mut guard = self.token_cache.lock().await;
        *guard = Some(CachedTenantToken {
            token: token.clone(),
            expires_at: Instant::now() + Duration::from_secs(expire_secs),
        });
        Ok(token)
    }

    pub async fn bot_info(&self) -> Result<(Option<String>, Option<String>)> {
        let token = self.tenant_access_token().await?;
        let url = format!("{}/open-apis/bot/v3/info", self.base_url);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| Error::Invalid(format!("获取飞书机器人信息失败：{error}")))?;
        let body: Value = resp
            .json()
            .await
            .map_err(|error| Error::Invalid(format!("解析飞书机器人信息失败：{error}")))?;
        if body.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
            let msg = body
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("获取机器人信息失败");
            return Err(Error::Invalid(msg.to_owned()));
        }
        let bot = body.get("bot").unwrap_or(&Value::Null);
        let app_name = bot
            .get("app_name")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let open_id = bot
            .get("open_id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        Ok((app_name, open_id))
    }

    pub async fn chat_name(&self, chat_id: &str) -> Option<String> {
        cached_name_lookup(&self.chat_name_cache, chat_id, || {
            self.fetch_chat_name(chat_id.trim())
        })
        .await
    }

    async fn fetch_chat_name(&self, chat_id: &str) -> Option<String> {
        let token = self.tenant_access_token().await.ok()?;
        let url = format!("{}/open-apis/im/v1/chats/{chat_id}", self.base_url);
        let resp = self.http.get(&url).bearer_auth(token).send().await.ok()?;
        let body: Value = resp.json().await.ok()?;
        if body.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
            return None;
        }
        body.pointer("/data/name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
    }

    pub async fn user_name(&self, user_id: &str) -> Option<String> {
        cached_name_lookup(&self.user_name_cache, user_id, || {
            self.fetch_user_name(user_id.trim())
        })
        .await
    }

    async fn fetch_user_name(&self, user_id: &str) -> Option<String> {
        let token = self.tenant_access_token().await.ok()?;
        let id_type = if user_id.starts_with("on_") {
            "union_id"
        } else if user_id.starts_with("ou_") {
            "open_id"
        } else {
            "user_id"
        };
        let url = format!(
            "{}/open-apis/contact/v3/users/{user_id}?user_id_type={id_type}",
            self.base_url
        );
        let resp = self.http.get(&url).bearer_auth(token).send().await.ok()?;
        let body: Value = resp.json().await.ok()?;
        if body.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
            return None;
        }
        for pointer in [
            "/data/user/name",
            "/data/user/nickname",
            "/data/user/en_name",
        ] {
            if let Some(name) = body
                .pointer(pointer)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Some(name.to_owned());
            }
        }
        None
    }

    async fn fetch_ws_endpoint(&self) -> Result<(String, EndpointClientConfig)> {
        let url = format!("{}/callback/ws/endpoint", self.base_url);
        let resp = self
            .http
            .post(&url)
            .header("locale", "zh")
            .json(&json!({
                "AppID": self.app_id,
                "AppSecret": self.app_secret,
            }))
            .send()
            .await
            .map_err(|error| Error::Invalid(format!("请求飞书长连接地址失败：{error}")))?;
        let status = resp.status();
        let parsed: EndpointResponse = resp
            .json()
            .await
            .map_err(|error| Error::Invalid(format!("解析飞书长连接地址失败：{error}")))?;
        if !status.is_success() || parsed.code != 0 {
            return Err(Error::Invalid(format!(
                "飞书长连接握手失败 (code={}): {}",
                parsed.code, parsed.msg
            )));
        }
        let data = parsed
            .data
            .ok_or_else(|| Error::Invalid("飞书长连接响应缺少 data".into()))?;
        if data.url.trim().is_empty() {
            return Err(Error::Invalid("飞书长连接响应缺少 URL".into()));
        }
        Ok((data.url, data.client_config.unwrap_or_default()))
    }

    pub async fn reply_card(
        &self,
        message_id: &str,
        card: &Value,
        reply_in_thread: bool,
    ) -> Result<String> {
        let token = self.tenant_access_token().await?;
        let url = format!(
            "{}/open-apis/im/v1/messages/{message_id}/reply",
            self.base_url
        );
        let mut payload = json!({
            "msg_type": "interactive",
            "content": card.to_string(),
        });
        if reply_in_thread && let Some(obj) = payload.as_object_mut() {
            obj.insert("reply_in_thread".into(), json!(true));
        }
        let resp = self
            .http
            .post(&url)
            .bearer_auth(token)
            .json(&payload)
            .send()
            .await
            .map_err(|error| Error::Invalid(format!("发送飞书卡片回复失败：{error}")))?;
        let body: Value = resp
            .json()
            .await
            .map_err(|error| Error::Invalid(format!("解析飞书卡片回复失败：{error}")))?;
        if body.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
            let msg = body
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("发送卡片失败");
            return Err(Error::Invalid(format!("发送飞书卡片失败：{msg}")));
        }
        Ok(body
            .pointer("/data/message_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned())
    }

    pub async fn patch_card(&self, message_id: &str, card: &Value) -> Result<()> {
        if message_id.is_empty() {
            return Ok(());
        }
        let token = self.tenant_access_token().await?;
        let url = format!("{}/open-apis/im/v1/messages/{message_id}", self.base_url);
        let resp = self
            .http
            .patch(&url)
            .bearer_auth(token)
            .json(&json!({ "content": card.to_string() }))
            .send()
            .await
            .map_err(|error| Error::Invalid(format!("更新飞书卡片失败：{error}")))?;
        let body: Value = resp
            .json()
            .await
            .map_err(|error| Error::Invalid(format!("解析飞书更新响应失败：{error}")))?;
        let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);
        if code != 0 {
            let msg = body
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("更新卡片失败");
            return Err(Error::Invalid(format!(
                "更新飞书卡片失败 (code={code}): {msg}"
            )));
        }
        Ok(())
    }

    pub async fn send_card_to_chat(&self, chat_id: &str, card: &Value) -> Result<String> {
        let clean_chat = chat_id.trim();
        if clean_chat.is_empty() {
            return Err(Error::Invalid("飞书群聊/会话 ID 不能为空".into()));
        }
        let token = self.tenant_access_token().await?;
        let url = format!(
            "{}/open-apis/im/v1/messages?receive_id_type=chat_id",
            self.base_url
        );
        let payload = build_chat_card_message_payload(clean_chat, card);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(token)
            .json(&payload)
            .send()
            .await
            .map_err(|error| Error::Invalid(format!("主动发送飞书卡片失败：{error}")))?;
        let body: Value = resp
            .json()
            .await
            .map_err(|error| Error::Invalid(format!("解析飞书发送响应失败：{error}")))?;
        let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);
        if code != 0 {
            let msg = body
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("主动发送卡片失败");
            return Err(Error::Invalid(format!(
                "主动发送飞书卡片失败 (code={code}): {msg}"
            )));
        }
        Ok(body
            .pointer("/data/message_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned())
    }

    pub async fn reply_text(
        &self,
        message_id: &str,
        text: &str,
        reply_in_thread: bool,
    ) -> Result<String> {
        let token = self.tenant_access_token().await?;
        let url = format!(
            "{}/open-apis/im/v1/messages/{message_id}/reply",
            self.base_url
        );
        let mut payload = json!({
            "msg_type": "text",
            "content": json!({ "text": text }).to_string(),
        });
        if reply_in_thread && let Some(obj) = payload.as_object_mut() {
            obj.insert("reply_in_thread".into(), json!(true));
        }
        let resp = self
            .http
            .post(&url)
            .bearer_auth(token)
            .json(&payload)
            .send()
            .await
            .map_err(|error| Error::Invalid(format!("发送飞书文本回复失败：{error}")))?;
        let body: Value = resp
            .json()
            .await
            .map_err(|error| Error::Invalid(format!("解析飞书文本回复失败：{error}")))?;
        if body.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
            let msg = body
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("发送文本失败");
            return Err(Error::Invalid(format!("发送飞书文本失败：{msg}")));
        }
        Ok(body
            .pointer("/data/message_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned())
    }
}

pub async fn probe_feishu(
    domain: FeishuDomain,
    app_id: String,
    app_secret: String,
) -> BotFeishuProbeResult {
    let client = match FeishuApiClient::new(domain, app_id, app_secret) {
        Ok(client) => client,
        Err(error) => {
            return BotFeishuProbeResult {
                ok: false,
                bot_name: None,
                bot_open_id: None,
                ws_ready: false,
                message: error.to_string(),
            };
        }
    };
    if let Err(error) = client.tenant_access_token().await {
        return BotFeishuProbeResult {
            ok: false,
            bot_name: None,
            bot_open_id: None,
            ws_ready: false,
            message: error.to_string(),
        };
    }
    let (bot_name, bot_open_id) = client.bot_info().await.unwrap_or((None, None));
    match client.fetch_ws_endpoint().await {
        Ok(_) => BotFeishuProbeResult {
            ok: true,
            bot_name: bot_name.clone(),
            bot_open_id,
            ws_ready: true,
            message: match bot_name {
                Some(name) => format!("连接验证通过：已识别机器人「{name}」，长连接可用"),
                None => "连接验证通过：飞书凭据与长连接网关均可用".into(),
            },
        },
        Err(error) => BotFeishuProbeResult {
            ok: false,
            bot_name,
            bot_open_id,
            ws_ready: false,
            message: format!(
                "凭据有效，但长连接端点校验失败（请确认已在飞书开放平台开启「使用长连接接收事件」并订阅 im.message.receive_v1）：{error}"
            ),
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFeishuMessage {
    pub event_id: String,
    pub message_id: String,
    pub chat_id: String,
    pub chat_type: String,
    pub root_id: Option<String>,
    pub parent_id: Option<String>,
    pub sender_open_id: Option<String>,
    pub text: String,
    pub mentioned_bot: bool,
}

#[derive(Debug, Deserialize)]
struct FeishuEnvelope<'a> {
    #[serde(default)]
    schema: &'a str,
    #[serde(default)]
    header: Option<FeishuEnvelopeHeader>,
    #[serde(default)]
    event: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct FeishuEnvelopeHeader {
    #[serde(default)]
    event_id: String,
    #[serde(default)]
    event_type: String,
}

#[derive(Debug, Deserialize)]
struct FeishuMention {
    #[serde(default)]
    key: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    id: FeishuMentionId,
}

#[derive(Debug, Default, Deserialize)]
struct FeishuMentionId {
    #[serde(default)]
    open_id: String,
}

pub(crate) fn parse_receive_event(
    payload: &[u8],
    bot_open_id: Option<&str>,
) -> Option<ParsedFeishuMessage> {
    let envelope: FeishuEnvelope<'_> = serde_json::from_slice(payload).ok()?;
    if !envelope.schema.is_empty() && envelope.schema != "2.0" {
        return None;
    }
    let header = envelope.header?;
    if header.event_type != "im.message.receive_v1" {
        return None;
    }
    let event = envelope.event?;
    let sender_type = event
        .pointer("/sender/sender_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    if sender_type != "user" {
        return None;
    }
    let sender_open_id = [
        "/sender/sender_id/open_id",
        "/sender/sender_id/user_id",
        "/sender/sender_id/union_id",
    ]
    .into_iter()
    .find_map(|pointer| {
        event
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    });
    let message = event.get("message")?;
    let message_id = message
        .get("message_id")
        .and_then(Value::as_str)?
        .trim()
        .to_owned();
    let chat_id = message
        .get("chat_id")
        .and_then(Value::as_str)?
        .trim()
        .to_owned();
    if message_id.is_empty() || chat_id.is_empty() {
        return None;
    }
    let chat_type = message
        .get("chat_type")
        .and_then(Value::as_str)
        .unwrap_or("p2p")
        .to_owned();
    let root_id = message
        .get("root_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let parent_id = message
        .get("parent_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let message_type = message
        .get("message_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    let raw_content = message.get("content").and_then(Value::as_str).unwrap_or("");
    let mentions: Vec<FeishuMention> = message
        .get("mentions")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();

    let mentioned_bot = match bot_open_id.filter(|id| !id.is_empty()) {
        Some(open_id) => mentions.iter().any(|mention| mention.id.open_id == open_id),
        None => !mentions.is_empty(),
    };

    let raw_text = extract_message_text(message_type, raw_content);
    let text = strip_bot_mentions(&raw_text, &mentions, bot_open_id);

    Some(ParsedFeishuMessage {
        event_id: header.event_id,
        message_id,
        chat_id,
        chat_type,
        root_id,
        parent_id,
        sender_open_id,
        text,
        mentioned_bot,
    })
}

fn extract_message_text(message_type: &str, raw_content: &str) -> String {
    let parsed: Value = match serde_json::from_str(raw_content) {
        Ok(value) => value,
        Err(_) => return raw_content.trim().to_owned(),
    };
    match message_type {
        "text" => parsed
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned(),
        "post" => extract_post_text(&parsed),
        other => {
            if let Some(text) = parsed.get("text").and_then(Value::as_str) {
                text.trim().to_owned()
            } else {
                format!("[飞书 {other} 消息]")
            }
        }
    }
}

fn extract_post_text(value: &Value) -> String {
    let post = if value.get("content").is_some() {
        value
    } else if let Some(obj) = value.as_object() {
        obj.values()
            .find(|candidate| candidate.get("content").is_some())
            .unwrap_or(value)
    } else {
        value
    };
    let mut lines = Vec::new();
    if let Some(title) = post
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
    {
        lines.push(title.to_owned());
    }
    if let Some(paragraphs) = post.get("content").and_then(Value::as_array) {
        for paragraph in paragraphs {
            let Some(elements) = paragraph.as_array() else {
                continue;
            };
            let mut line = String::new();
            for item in elements {
                let tag = item.get("tag").and_then(Value::as_str).unwrap_or("");
                match tag {
                    "text" | "a" => {
                        if let Some(t) = item.get("text").and_then(Value::as_str) {
                            line.push_str(t);
                        }
                    }
                    "at" => {
                        let name = item.get("user_name").and_then(Value::as_str).unwrap_or("");
                        if !name.is_empty() {
                            line.push('@');
                            line.push_str(name);
                            line.push(' ');
                        }
                    }
                    "md" => {
                        if let Some(t) = item.get("text").and_then(Value::as_str) {
                            line.push_str(t);
                        }
                    }
                    _ => {}
                }
            }
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                lines.push(trimmed.to_owned());
            }
        }
    }
    lines.join("\n")
}

fn strip_bot_mentions(text: &str, mentions: &[FeishuMention], bot_open_id: Option<&str>) -> String {
    let mut out = text.to_owned();
    for mention in mentions {
        if mention.key.is_empty() {
            continue;
        }
        let is_bot = match bot_open_id.filter(|id| !id.is_empty()) {
            Some(open_id) => mention.id.open_id == open_id,
            None => mentions.len() == 1,
        };
        if is_bot {
            out = out.replace(&mention.key, "");
        } else if !mention.name.is_empty() {
            out = out.replace(&mention.key, &format!("@{}", mention.name));
        }
    }
    out.split('\n')
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

const MAX_TABLES_PER_CARD: usize = 5;

pub(crate) fn build_chat_card_message_payload(chat_id: &str, card: &Value) -> Value {
    json!({
        "receive_id": chat_id,
        "msg_type": "interactive",
        "content": card.to_string(),
    })
}

pub(crate) fn build_card_json(title: &str, body_markdown: &str, footer: Option<&str>) -> Value {
    let truncated = truncate_chars(body_markdown, MAX_CARD_CHARS);
    let content = if truncated.trim().is_empty() {
        "…"
    } else {
        truncated.as_str()
    };
    let elements = markdown_to_card_elements(content);
    assemble_card_v2(title, elements, footer)
}

pub(crate) fn build_simple_markdown_card_json(
    title: &str,
    body_markdown: &str,
    footer: Option<&str>,
) -> Value {
    let truncated = truncate_chars(body_markdown, MAX_CARD_CHARS);
    let content = if truncated.trim().is_empty() {
        "…"
    } else {
        truncated.as_str()
    };
    assemble_card_v2(
        title,
        vec![json!({
            "tag": "markdown",
            "content": content,
        })],
        footer,
    )
}

fn assemble_card_v2(title: &str, mut elements: Vec<Value>, footer: Option<&str>) -> Value {
    if elements.is_empty() {
        elements.push(json!({
            "tag": "markdown",
            "content": "…",
        }));
    }
    if let Some(footer) = footer.map(str::trim).filter(|text| !text.is_empty()) {
        elements.push(json!({ "tag": "hr" }));
        elements.push(json!({
            "tag": "markdown",
            "text_size": "notation",
            "content": format!("<font color='grey'>{}</font>", escape_markdown_html(footer)),
        }));
    }
    json!({
        "schema": "2.0",
        "config": {
            "width_mode": "fill",
            "update_multi": true,
        },
        "header": {
            "title": {
                "tag": "plain_text",
                "content": title,
            }
        },
        "body": {
            "elements": elements,
        },
    })
}

fn escape_markdown_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn markdown_to_card_elements(markdown: &str) -> Vec<Value> {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut elements: Vec<Value> = Vec::new();
    let mut text_buf: Vec<&str> = Vec::new();
    let mut table_count = 0usize;
    let mut fence: Option<char> = None;
    let mut idx = 0usize;

    while idx < lines.len() {
        let line = lines[idx];
        let trimmed = line.trim_start();
        if let Some(marker) = fence {
            text_buf.push(line);
            if trimmed.starts_with(&marker.to_string().repeat(3)) {
                fence = None;
            }
            idx += 1;
            continue;
        }
        if trimmed.starts_with("```") {
            fence = Some('`');
            text_buf.push(line);
            idx += 1;
            continue;
        }
        if trimmed.starts_with("~~~") {
            fence = Some('~');
            text_buf.push(line);
            idx += 1;
            continue;
        }

        if let Some((table, next_idx)) = parse_gfm_table(&lines, idx) {
            flush_markdown_buffer(&mut elements, &mut text_buf);
            if table_count < MAX_TABLES_PER_CARD {
                elements.push(table.into_card_element());
                table_count += 1;
            } else {
                elements.push(json!({
                    "tag": "markdown",
                    "content": table.to_fallback_markdown(),
                }));
            }
            idx = next_idx;
            continue;
        }

        text_buf.push(line);
        idx += 1;
    }

    flush_markdown_buffer(&mut elements, &mut text_buf);
    elements
}

fn flush_markdown_buffer(elements: &mut Vec<Value>, buf: &mut Vec<&str>) {
    if buf.is_empty() {
        return;
    }
    let chunk = buf.join("\n");
    buf.clear();
    let trimmed = chunk.trim();
    if !trimmed.is_empty() {
        elements.push(json!({
            "tag": "markdown",
            "content": trimmed,
        }));
    }
}

struct ParsedTable {
    headers: Vec<String>,
    alignments: Vec<&'static str>,
    rows: Vec<Vec<String>>,
}

impl ParsedTable {
    fn into_card_element(self) -> Value {
        let col_count = self.headers.len();
        let columns: Vec<Value> = self
            .headers
            .iter()
            .enumerate()
            .map(|(i, header)| {
                let display_name = if header.trim().is_empty() {
                    " ".to_owned()
                } else {
                    header.trim().to_owned()
                };
                let align = self.alignments.get(i).copied().unwrap_or("left");
                json!({
                    "name": format!("c{i}"),
                    "display_name": display_name,
                    "width": "auto",
                    "data_type": "lark_md",
                    "horizontal_align": align,
                })
            })
            .collect();

        let page_size = self.rows.len().clamp(1, 10);
        let rows: Vec<Value> = self
            .rows
            .into_iter()
            .map(|row| {
                let mut obj = serde_json::Map::with_capacity(col_count);
                for i in 0..col_count {
                    let cell = row.get(i).cloned().unwrap_or_default();
                    obj.insert(format!("c{i}"), Value::String(cell));
                }
                Value::Object(obj)
            })
            .collect();

        json!({
            "tag": "table",
            "page_size": page_size,
            "row_height": "auto",
            "header_style": {
                "text_align": "left",
                "text_size": "normal",
                "background_style": "grey",
                "bold": true,
            },
            "columns": columns,
            "rows": rows,
        })
    }

    fn to_fallback_markdown(&self) -> String {
        self.rows
            .iter()
            .map(|row| {
                let pairs: Vec<String> = self
                    .headers
                    .iter()
                    .enumerate()
                    .filter_map(|(i, header)| {
                        let val = row.get(i).map(String::as_str).unwrap_or("").trim();
                        if val.is_empty() {
                            return None;
                        }
                        let key = header.trim();
                        if key.is_empty() {
                            Some(val.to_owned())
                        } else {
                            Some(format!("**{key}**: {val}"))
                        }
                    })
                    .collect();
                format!("- {}", pairs.join(" · "))
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn parse_gfm_table(lines: &[&str], start: usize) -> Option<(ParsedTable, usize)> {
    if start + 2 >= lines.len() {
        return None;
    }
    let header_line = lines[start].trim();
    let sep_line = lines[start + 1].trim();
    if !header_line.contains('|') || !sep_line.contains('|') {
        return None;
    }
    let headers = split_pipe_cells(header_line)?;
    let alignments = parse_table_alignments(sep_line, headers.len())?;

    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut cursor = start + 2;
    while cursor < lines.len() {
        let candidate = lines[cursor].trim();
        if candidate.is_empty() || !candidate.contains('|') {
            break;
        }
        // Stop before a new separator line if another table immediately follows without blank line.
        if cursor + 1 < lines.len()
            && parse_table_alignments(
                lines[cursor + 1].trim(),
                split_pipe_cells(candidate).map(|c| c.len()).unwrap_or(0),
            )
            .is_some()
        {
            break;
        }
        let Some(mut cells) = split_pipe_cells(candidate) else {
            break;
        };
        cells.resize(headers.len(), String::new());
        rows.push(cells);
        cursor += 1;
    }

    if rows.is_empty() {
        return None;
    }

    Some((
        ParsedTable {
            headers,
            alignments,
            rows,
        },
        cursor,
    ))
}

fn split_pipe_cells(line: &str) -> Option<Vec<String>> {
    let trimmed = line.trim();
    if !trimmed.contains('|') {
        return None;
    }
    let stripped = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let stripped = stripped.strip_suffix('|').unwrap_or(stripped);

    let mut cells = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for ch in stripped.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '|' {
            cells.push(current.trim().to_owned());
            current.clear();
        } else {
            current.push(ch);
        }
    }
    if escaped {
        current.push('\\');
    }
    cells.push(current.trim().to_owned());
    if cells.is_empty() { None } else { Some(cells) }
}

fn parse_table_alignments(line: &str, expected_cols: usize) -> Option<Vec<&'static str>> {
    if expected_cols == 0 {
        return None;
    }
    let cells = split_pipe_cells(line)?;
    if cells.len() != expected_cols {
        return None;
    }
    let mut aligns = Vec::with_capacity(expected_cols);
    for cell in cells {
        let c = cell.trim();
        let left = c.starts_with(':');
        let right = c.ends_with(':');
        let inner = c.trim_start_matches(':').trim_end_matches(':');
        if inner.is_empty() || !inner.chars().all(|ch| ch == '-') {
            return None;
        }
        let align = match (left, right) {
            (true, true) => "center",
            (false, true) => "right",
            _ => "left",
        };
        aligns.push(align);
    }
    Some(aligns)
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max_chars.saturating_sub(24)).collect();
    out.push_str("\n\n...(内容已截断，完整记录可在 Prospero 桌面端查看)");
    out
}

#[derive(Default)]
struct DedupeCache {
    set: HashSet<String>,
    order: VecDeque<String>,
}

impl DedupeCache {
    fn insert_if_new(&mut self, key: String) -> bool {
        if key.is_empty() {
            return true;
        }
        if !self.set.insert(key.clone()) {
            return false;
        }
        self.order.push_back(key);
        while self.order.len() > MAX_SEEN_IDS {
            if let Some(oldest) = self.order.pop_front() {
                self.set.remove(&oldest);
            }
        }
        true
    }
}

pub fn spawn_worker(
    config: FeishuWorkerConfig,
    supervisor: BotsSupervisor,
    mut stop: watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        run_worker(config, supervisor, &mut stop).await;
    });
}

async fn run_worker(
    config: FeishuWorkerConfig,
    supervisor: BotsSupervisor,
    stop: &mut watch::Receiver<bool>,
) {
    let api = match FeishuApiClient::new(
        config.domain,
        config.app_id.clone(),
        config.app_secret.clone(),
    ) {
        Ok(client) => client,
        Err(error) => {
            supervisor
                .update_feishu_status(
                    &config.bot_id,
                    BotFeishuRuntimeStatus {
                        state: FeishuConnectionState::Error,
                        bot_name: None,
                        bot_open_id: None,
                        last_connected_at: None,
                        last_event_at: None,
                        last_error: Some(error.to_string()),
                        ..Default::default()
                    },
                )
                .await;
            return;
        }
    };

    let dedupe = Arc::new(Mutex::new(DedupeCache::default()));
    let mut resolved_name: Option<String> = None;
    let mut resolved_open_id: Option<String> = None;
    let mut attempt = 0u32;

    loop {
        if *stop.borrow() {
            break;
        }
        let state = if attempt == 0 {
            FeishuConnectionState::Connecting
        } else {
            FeishuConnectionState::Reconnecting
        };
        supervisor
            .update_feishu_status(
                &config.bot_id,
                BotFeishuRuntimeStatus {
                    state,
                    bot_name: resolved_name.clone(),
                    bot_open_id: resolved_open_id.clone(),
                    last_connected_at: None,
                    last_event_at: None,
                    last_error: None,
                    ..Default::default()
                },
            )
            .await;

        if resolved_open_id.is_none()
            && let Ok((name, open_id)) = api.bot_info().await
        {
            resolved_name = name;
            resolved_open_id = open_id;
        }

        let endpoint_result = api.fetch_ws_endpoint().await;
        let (endpoint_url, client_config) = match endpoint_result {
            Ok(result) => result,
            Err(error) => {
                attempt = attempt.saturating_add(1);
                supervisor
                    .update_feishu_status(
                        &config.bot_id,
                        BotFeishuRuntimeStatus {
                            state: FeishuConnectionState::Error,
                            bot_name: resolved_name.clone(),
                            bot_open_id: resolved_open_id.clone(),
                            last_connected_at: None,
                            last_event_at: None,
                            last_error: Some(error.to_string()),
                            ..Default::default()
                        },
                    )
                    .await;
                let backoff = reconnect_delay(attempt, None);
                tokio::select! {
                    _ = stop.changed() => break,
                    _ = tokio::time::sleep(backoff) => continue,
                }
            }
        };

        let service_id = parse_service_id(&endpoint_url);
        let ws_connect = tokio_tungstenite::connect_async(&endpoint_url).await;
        let (ws_stream, _) = match ws_connect {
            Ok(connected) => connected,
            Err(error) => {
                attempt = attempt.saturating_add(1);
                supervisor
                    .update_feishu_status(
                        &config.bot_id,
                        BotFeishuRuntimeStatus {
                            state: FeishuConnectionState::Error,
                            bot_name: resolved_name.clone(),
                            bot_open_id: resolved_open_id.clone(),
                            last_connected_at: None,
                            last_event_at: None,
                            last_error: Some(format!("WebSocket 连接失败：{error}")),
                            ..Default::default()
                        },
                    )
                    .await;
                let backoff = reconnect_delay(attempt, client_config.reconnect_interval);
                tokio::select! {
                    _ = stop.changed() => break,
                    _ = tokio::time::sleep(backoff) => continue,
                }
            }
        };

        attempt = 0;
        let connected_at = now();
        let mut last_event_at: Option<i64> = None;
        supervisor
            .update_feishu_status(
                &config.bot_id,
                BotFeishuRuntimeStatus {
                    state: FeishuConnectionState::Connected,
                    bot_name: resolved_name.clone(),
                    bot_open_id: resolved_open_id.clone(),
                    last_connected_at: Some(connected_at),
                    last_event_at,
                    last_error: None,
                    ..Default::default()
                },
            )
            .await;

        let (mut ws_sink, mut ws_source) = ws_stream.split();
        let (tx, mut rx) = mpsc::channel::<WsMessage>(64);

        // Writer task ensures ACKs and Pings never race on the WebSocket sink.
        let writer = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if ws_sink.send(msg).await.is_err() {
                    break;
                }
            }
        });

        let mut ping_secs = client_config.ping_interval.unwrap_or(120).clamp(15, 300);
        let mut ping_timer = tokio::time::interval(Duration::from_secs(ping_secs));
        ping_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let _ = tx
            .send(WsMessage::Binary(
                PbbpFrame::new_ping(service_id).encode().into(),
            ))
            .await;

        let mut assembler = ChunkAssembler::default();
        let disconnect_reason: Option<String>;

        loop {
            tokio::select! {
                _ = stop.changed() => {
                    let _ = tx.send(WsMessage::Close(None)).await;
                    writer.abort();
                    return;
                }
                _ = ping_timer.tick() => {
                    let ping = PbbpFrame::new_ping(service_id).encode();
                    if tx.send(WsMessage::Binary(ping.into())).await.is_err() {
                        disconnect_reason = Some("心跳发送失败".into());
                        break;
                    }
                }
                incoming = ws_source.next() => {
                    match incoming {
                        Some(Ok(WsMessage::Binary(bytes))) => {
                            let Ok(frame) = PbbpFrame::decode(&bytes) else {
                                continue;
                            };
                            if frame.method == FRAME_TYPE_CONTROL {
                                if frame.header(HEADER_TYPE) == Some(MESSAGE_TYPE_PONG)
                                    && let Some(payload) = frame.payload.as_deref()
                                    && let Ok(conf) = serde_json::from_slice::<EndpointClientConfig>(payload)
                                    && let Some(next_ping) = conf.ping_interval
                                {
                                    let clamped = next_ping.clamp(15, 300);
                                    if clamped != ping_secs {
                                        ping_secs = clamped;
                                        ping_timer = tokio::time::interval(Duration::from_secs(ping_secs));
                                        ping_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                                    }
                                }
                                continue;
                            }
                            if frame.method == FRAME_TYPE_DATA {
                                let sum = frame.header_usize(HEADER_SUM).unwrap_or(1);
                                let seq = frame.header_usize(HEADER_SEQ).unwrap_or(0);
                                let msg_id = frame.header(HEADER_MESSAGE_ID).unwrap_or("").to_owned();
                                let msg_type = frame.header(HEADER_TYPE).unwrap_or("").to_owned();
                                let Some(raw_payload) = frame.payload.clone() else {
                                    continue;
                                };
                                let Some(payload) = assembler.push(&msg_id, sum, seq, raw_payload) else {
                                    continue;
                                };

                                // Acknowledge within 3 seconds immediately before launching agent work.
                                let ack = frame.into_event_ack(200, 1).encode();
                                let _ = tx.send(WsMessage::Binary(ack.into())).await;

                                if msg_type != MESSAGE_TYPE_EVENT {
                                    continue;
                                }

                                let event_ts = now();
                                last_event_at = Some(event_ts);
                                supervisor
                                    .update_feishu_status(
                                        &config.bot_id,
                                        BotFeishuRuntimeStatus {
                                            state: FeishuConnectionState::Connected,
                                            bot_name: resolved_name.clone(),
                                            bot_open_id: resolved_open_id.clone(),
                                            last_connected_at: Some(connected_at),
                                            last_event_at,
                                            last_error: None,
                                            ..Default::default()
                                        },
                                    )
                                    .await;

                                if let Some(parsed) = parse_receive_event(&payload, resolved_open_id.as_deref()) {
                                    let is_new = {
                                        let mut guard = dedupe.lock().await;
                                        guard.insert_if_new(format!("event:{}", parsed.event_id))
                                            && guard.insert_if_new(format!("msg:{}", parsed.message_id))
                                    };
                                    if is_new {
                                        let cfg = config.clone();
                                        let api_clone = api.clone();
                                        let sup_clone = supervisor.clone();
                                        tokio::spawn(async move {
                                            dispatch_feishu_message(cfg, api_clone, sup_clone, parsed).await;
                                        });
                                    }
                                }
                            }
                        }
                        Some(Ok(WsMessage::Ping(payload))) => {
                            let _ = tx.send(WsMessage::Pong(payload)).await;
                        }
                        Some(Ok(WsMessage::Close(frame))) => {
                            disconnect_reason = Some(match frame {
                                Some(f) => format!("连接关闭 ({}: {})", f.code, f.reason),
                                None => "飞书服务端断开连接".into(),
                            });
                            break;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(error)) => {
                            disconnect_reason = Some(format!("WebSocket 读取失败：{error}"));
                            break;
                        }
                        None => {
                            disconnect_reason = Some("WebSocket 连接已结束".into());
                            break;
                        }
                    }
                }
            }
        }

        writer.abort();
        attempt = attempt.saturating_add(1);
        supervisor
            .update_feishu_status(
                &config.bot_id,
                BotFeishuRuntimeStatus {
                    state: FeishuConnectionState::Reconnecting,
                    bot_name: resolved_name.clone(),
                    bot_open_id: resolved_open_id.clone(),
                    last_connected_at: Some(connected_at),
                    last_event_at,
                    last_error: disconnect_reason,
                    ..Default::default()
                },
            )
            .await;

        let nonce = client_config.reconnect_nonce.unwrap_or(5).min(15);
        let backoff = Duration::from_secs(nonce.clamp(2, 30));
        tokio::select! {
            _ = stop.changed() => break,
            _ = tokio::time::sleep(backoff) => {}
        }
    }
}

fn parse_service_id(endpoint_url: &str) -> i32 {
    Url::parse(endpoint_url)
        .ok()
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "service_id")
                .and_then(|(_, val)| val.parse::<i32>().ok())
        })
        .unwrap_or(0)
}

fn reconnect_delay(attempt: u32, server_interval_secs: Option<u64>) -> Duration {
    if let Some(secs) = server_interval_secs.filter(|s| *s > 0 && *s <= 30) {
        return Duration::from_secs(secs);
    }
    let exp = 2u64.saturating_pow(attempt.min(5));
    Duration::from_secs(exp.clamp(2, 30))
}

async fn reply_card_with_fallback(
    api: &FeishuApiClient,
    message_id: &str,
    title: &str,
    body: &str,
    note: Option<&str>,
    reply_in_thread: bool,
) -> Option<String> {
    let card = build_card_json(title, body, note);
    if let Ok(reply_id) = api.reply_card(message_id, &card, reply_in_thread).await {
        return Some(reply_id);
    }
    let simple = build_simple_markdown_card_json(title, body, note);
    if simple != card
        && let Ok(reply_id) = api.reply_card(message_id, &simple, reply_in_thread).await
    {
        return Some(reply_id);
    }
    let _ = api.reply_text(message_id, body, reply_in_thread).await;
    None
}

async fn patch_card_with_fallback(
    api: &FeishuApiClient,
    reply_message_id: &str,
    title: &str,
    body: &str,
    footer: Option<&str>,
) -> bool {
    let card = build_card_json(title, body, footer);
    if api.patch_card(reply_message_id, &card).await.is_ok() {
        return true;
    }
    let simple = build_simple_markdown_card_json(title, body, footer);
    simple != card && api.patch_card(reply_message_id, &simple).await.is_ok()
}

async fn dispatch_feishu_message(
    config: FeishuWorkerConfig,
    api: FeishuApiClient,
    supervisor: BotsSupervisor,
    msg: ParsedFeishuMessage,
) {
    let is_group = msg.chat_type == "group";
    let (group_trigger, streaming_card) =
        supervisor.live_feishu_runtime_options(&config.bot_id).await;
    if is_group && group_trigger == FeishuGroupTrigger::Mention && !msg.mentioned_bot {
        return;
    }

    let trimmed = msg.text.trim();
    if trimmed.is_empty() {
        return;
    }
    let reply_in_thread = msg.root_id.is_some();

    let (chat_name, sender_name) = tokio::join!(
        async {
            if is_group {
                api.chat_name(&msg.chat_id).await
            } else {
                None
            }
        },
        async {
            match msg.sender_open_id.as_deref() {
                Some(open_id) => api.user_name(open_id).await,
                None => None,
            }
        }
    );

    if matches!(trimmed, "/whoami" | "/id") {
        if let Ok(identity) = supervisor
            .inspect_feishu_identity(
                &config.bot_id,
                msg.sender_open_id.as_deref(),
                sender_name.as_deref(),
                &msg.chat_id,
                chat_name.as_deref(),
            )
            .await
        {
            let policy_text = match identity.access_policy {
                FeishuAccessPolicy::Everyone => "全员可用",
                FeishuAccessPolicy::AdminsDmAllGroups => "私聊仅管理员 · 群聊全员可用",
                FeishuAccessPolicy::AdminsOnly => "仅管理员可用",
            };
            let uid_text = msg
                .sender_open_id
                .as_deref()
                .map(|id| format!("`{id}`"))
                .unwrap_or_else(|| "未知".into());
            let name_line = sender_name
                .as_deref()
                .map(|name| format!("- **姓名**: {name}\n"))
                .unwrap_or_default();
            let group_line = if is_group {
                let gname = chat_name
                    .as_deref()
                    .map(|n| format!(" ({n})"))
                    .unwrap_or_default();
                format!("- **当前群聊 ID**: `{}`{}\n", msg.chat_id, gname)
            } else {
                String::new()
            };
            let role_label = if identity.is_admin {
                "管理员"
            } else {
                "普通成员"
            };
            let body = format!(
                "{name_line}- **飞书 Open ID**: {uid_text}\n{group_line}- **当前权限角色**: {role_label}\n- **Bot 访问策略**: {policy_text}（已配置 {} 位管理员）\n\n提示：在 Prospero 桌面端「记忆与权限」可直接将最近发言成员一键设为管理员。",
                identity.admin_count
            );
            reply_card_with_fallback(
                &api,
                &msg.message_id,
                &format!("{} · 身份信息", config.bot_name),
                &body,
                Some("飞书 IM · 权限身份"),
                reply_in_thread,
            )
            .await;
        }
        return;
    }

    let parsed_new = parse_new_command(trimmed);
    let is_status_cmd = trimmed == "/status";
    let is_admin_command = is_status_cmd || parsed_new.is_some();

    let access = match supervisor
        .evaluate_feishu_access(
            &config.bot_id,
            is_group,
            msg.sender_open_id.as_deref(),
            sender_name.as_deref(),
            &msg.chat_id,
            chat_name.as_deref(),
            is_admin_command,
        )
        .await
    {
        Ok(decision) => decision,
        Err(_) => return,
    };

    if !access.allowed {
        if (!is_group || is_admin_command)
            && let Some(reason) = access.denial_reason
        {
            reply_card_with_fallback(
                &api,
                &msg.message_id,
                &format!("{} · 访问受限", config.bot_name),
                &reason,
                Some("权限控制"),
                reply_in_thread,
            )
            .await;
        }
        return;
    }

    if is_status_cmd {
        if let Ok(status_text) = supervisor
            .describe_feishu_status(&config.bot_id, &msg.chat_id)
            .await
        {
            reply_card_with_fallback(
                &api,
                &msg.message_id,
                &format!("{} · 状态", config.bot_name),
                &status_text,
                None,
                reply_in_thread,
            )
            .await;
        }
        return;
    }

    let (force_new, prompt) = if let Some(rest) = parsed_new {
        (true, rest)
    } else {
        (false, trimmed.to_owned())
    };

    if !access.is_admin
        && let Some(category) = super::detect_non_admin_governance_attempt(&prompt)
    {
        supervisor
            .record_feishu_denied_attempt(
                &config.bot_id,
                msg.sender_open_id.as_deref(),
                sender_name.as_deref(),
                &msg.chat_id,
                chat_name.as_deref(),
            )
            .await;
        let text = format!(
            "🔒 **权限受限**：普通成员无权执行「{category}」等管理或规则变更操作。\n\n该操作仅限授权管理员执行，本次指令已拦截且未生效。"
        );
        reply_card_with_fallback(
            &api,
            &msg.message_id,
            &format!("{} · 权限管控", config.bot_name),
            &text,
            Some("权限保护 · 已拦截"),
            reply_in_thread,
        )
        .await;
        return;
    }

    let channel = if is_group {
        BotThreadChannel::FeishuGroup
    } else {
        BotThreadChannel::FeishuP2p
    };

    let base_meta = FeishuThreadMetadata {
        chat_name: chat_name.clone(),
        sender_id: msg.sender_open_id.clone(),
        sender_name: sender_name.clone(),
        message_preview: if prompt.is_empty() {
            None
        } else {
            Some(prompt.clone())
        },
    };

    if force_new && prompt.is_empty() {
        let new_title = if is_group {
            chat_name
                .as_deref()
                .map(|name| format!("{name} · 新话题"))
                .unwrap_or_else(|| "新话题".into())
        } else {
            sender_name
                .as_deref()
                .map(|name| format!("{name} · 新话题"))
                .unwrap_or_else(|| "新话题".into())
        };
        match supervisor
            .create_feishu_thread(&config.bot_id, &msg.chat_id, channel, &new_title, base_meta)
            .await
        {
            Ok(thread) => {
                let text = format!("已开启新话题：**{}**\n请直接发送下一条消息。", thread.title);
                if let Some(reply_id) = reply_card_with_fallback(
                    &api,
                    &msg.message_id,
                    &config.bot_name,
                    &text,
                    Some("飞书 IM · 新话题"),
                    reply_in_thread,
                )
                .await
                {
                    supervisor
                        .record_feishu_reply(&config.bot_id, &reply_id, &thread.id)
                        .await;
                }
            }
            Err(error) => {
                let _ = api
                    .reply_text(
                        &msg.message_id,
                        &format!("创建话题失败：{error}"),
                        reply_in_thread,
                    )
                    .await;
            }
        }
        return;
    }

    let prepared = supervisor
        .prepare_feishu_memory_turn(FeishuMemoryTurnInput {
            bot_id: config.bot_id.clone(),
            chat_id: msg.chat_id.clone(),
            is_group,
            chat_name,
            sender_open_id: msg.sender_open_id.clone(),
            sender_name,
            sender_is_admin: access.is_admin,
            user_prompt: prompt.clone(),
        })
        .await
        .ok();
    let (dispatch_prompt, thread_title_hint) = match prepared {
        Some(prepared) => (prepared.augmented_prompt, prepared.thread_title_hint),
        None => (prompt.clone(), prompt.clone()),
    };

    let thread = match supervisor
        .resolve_or_create_feishu_thread(
            &config.bot_id,
            &msg.chat_id,
            channel,
            msg.root_id.as_deref().or(msg.parent_id.as_deref()),
            &thread_title_hint,
            force_new,
            base_meta,
        )
        .await
    {
        Ok(thread) => thread,
        Err(error) => {
            let _ = api
                .reply_text(
                    &msg.message_id,
                    &format!("无法启动 Bot 会话：{error}"),
                    reply_in_thread,
                )
                .await;
            return;
        }
    };

    let session_id = thread.session_id.clone();
    let baseline = supervisor
        .database()
        .read("feishu.timeline_baseline", {
            let session_id = session_id.clone();
            move |store| {
                let head = store.session(&session_id)?;
                let page = store.timeline(
                    &session_id,
                    TimelineQuery {
                        before: None,
                        after: None,
                        limit: Some(1),
                    },
                )?;
                let was_idle = matches!(
                    head.status,
                    SessionStatus::Idle | SessionStatus::Completed | SessionStatus::Failed
                );
                Ok((page.latest_position, was_idle))
            }
        })
        .await;
    let (baseline_pos, was_idle) = match baseline {
        Ok(values) => values,
        Err(error) => {
            let _ = api
                .reply_text(
                    &msg.message_id,
                    &format!("读取会话状态失败：{error}"),
                    reply_in_thread,
                )
                .await;
            return;
        }
    };

    let card_message_id = if streaming_card {
        let initial = build_card_json(
            &config.bot_name,
            "⏳ 正在思考…",
            Some(&format!("话题：{}", thread.title)),
        );
        match api
            .reply_card(&msg.message_id, &initial, reply_in_thread)
            .await
        {
            Ok(reply_id) => {
                supervisor
                    .record_feishu_reply(&config.bot_id, &reply_id, &thread.id)
                    .await;
                Some(reply_id)
            }
            Err(_) => None,
        }
    } else {
        None
    };

    let non_admin_guard = if !access.is_admin {
        supervisor.begin_non_admin_guard(&config.bot_id).await.ok()
    } else {
        None
    };

    if let Err(error) = supervisor
        .agents()
        .send(&session_id, dispatch_prompt.clone(), None, Vec::new())
        .await
    {
        let err_text = format!("发送指令失败：{error}");
        if let Some(reply_id) = card_message_id.as_deref() {
            let card = build_card_json(&config.bot_name, &err_text, Some("执行失败"));
            let _ = api.patch_card(reply_id, &card).await;
        } else {
            let _ = api
                .reply_text(&msg.message_id, &err_text, reply_in_thread)
                .await;
        }
        return;
    }

    let bot_id = config.bot_id.clone();
    stream_turn_to_feishu(
        config,
        api,
        supervisor.clone(),
        msg.message_id,
        reply_in_thread,
        card_message_id,
        streaming_card,
        thread.title,
        session_id,
        baseline_pos,
        was_idle,
        dispatch_prompt,
    )
    .await;

    if let Some(guard) = non_admin_guard {
        let _ = supervisor.finish_non_admin_guard(guard).await;
    } else {
        supervisor.record_admin_feishu_turn_completed(&bot_id).await;
    }

    supervisor.notify_memory_updated().await;
}

fn parse_new_command(trimmed: &str) -> Option<String> {
    for prefix in ["/new", "/reset"] {
        if trimmed == prefix {
            return Some(String::new());
        }
        if let Some(rest) = trimmed.strip_prefix(prefix)
            && rest.starts_with(char::is_whitespace)
        {
            return Some(rest.trim().to_owned());
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
async fn stream_turn_to_feishu(
    config: FeishuWorkerConfig,
    api: FeishuApiClient,
    supervisor: BotsSupervisor,
    incoming_message_id: String,
    reply_in_thread: bool,
    card_message_id: Option<String>,
    streaming_card: bool,
    thread_title: String,
    session_id: String,
    baseline_pos: i64,
    was_idle: bool,
    prompt: String,
) {
    let mut changes = supervisor.agents().changes().subscribe();
    let deadline = tokio::time::Instant::now() + MAX_WATCH_DURATION;
    let mut target_turn_id: Option<String> = None;
    let mut last_pushed_content = String::new();
    let mut last_patch_at = Instant::now() - STREAM_THROTTLE;
    let mut saw_running = false;
    let prompt_head: String = prompt.chars().take(48).collect();

    loop {
        let snapshot = read_turn_snapshot(
            &supervisor,
            &session_id,
            baseline_pos,
            was_idle,
            &prompt_head,
            target_turn_id.as_deref(),
        )
        .await;

        if let Ok(snapshot) = snapshot {
            if target_turn_id.is_none() && snapshot.turn_id.is_some() {
                target_turn_id = snapshot.turn_id.clone();
            }
            if matches!(
                snapshot.session_status,
                SessionStatus::Starting | SessionStatus::Running
            ) {
                saw_running = true;
            }

            let finished = snapshot.turn_ended
                || (saw_running
                    && target_turn_id.is_some()
                    && matches!(
                        snapshot.session_status,
                        SessionStatus::Idle | SessionStatus::Completed | SessionStatus::Failed
                    ));

            let body = if !snapshot.assistant_text.is_empty() {
                if let Some(tool) = snapshot.active_tool.as_deref().filter(|_| !finished) {
                    format!("{}\n\n> 🔧 正在执行 `{tool}`…", snapshot.assistant_text)
                } else {
                    snapshot.assistant_text.clone()
                }
            } else if let Some(err) = snapshot.error_text.as_deref() {
                format!("❌ 执行出错：{err}")
            } else if let Some(tool) = snapshot.active_tool.as_deref() {
                format!("🔧 正在调用工具 `{tool}`…")
            } else if finished {
                "（本轮已完成，无文本输出）".into()
            } else {
                "⏳ 正在思考…".into()
            };

            if finished {
                let footer = format!("{} · 已完成", thread_title);
                if let Some(reply_id) = card_message_id.as_deref() {
                    if !patch_card_with_fallback(
                        &api,
                        reply_id,
                        &config.bot_name,
                        &body,
                        Some(&footer),
                    )
                    .await
                    {
                        let _ = api
                            .reply_text(&incoming_message_id, &body, reply_in_thread)
                            .await;
                    }
                } else {
                    let _ = reply_card_with_fallback(
                        &api,
                        &incoming_message_id,
                        &config.bot_name,
                        &body,
                        Some(&footer),
                        reply_in_thread,
                    )
                    .await;
                }
                break;
            }

            if streaming_card
                && let Some(reply_id) = card_message_id.as_deref()
                && body != last_pushed_content
                && last_patch_at.elapsed() >= STREAM_THROTTLE
            {
                let footer = format!("{} · 生成中", thread_title);
                if patch_card_with_fallback(&api, reply_id, &config.bot_name, &body, Some(&footer))
                    .await
                {
                    last_pushed_content = body;
                    last_patch_at = Instant::now();
                }
            }
        }

        let sleep_until = (last_patch_at + STREAM_THROTTLE).min(deadline.into_std());
        let wait_ms = sleep_until
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(250));

        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {
                if let Some(reply_id) = card_message_id.as_deref() {
                    let card = build_card_json(
                        &config.bot_name,
                        if last_pushed_content.is_empty() { "⏱️ 任务仍在后台执行，可在 Prospero 桌面端查看实时进展。" } else { &last_pushed_content },
                        Some(&format!("{} · 转入后台", thread_title)),
                    );
                    let _ = api.patch_card(reply_id, &card).await;
                }
                break;
            }
            _ = tokio::time::sleep(wait_ms) => {}
            changed = changes.changed() => {
                if changed.is_err() {
                    break;
                }
            }
        }
    }
}

struct TurnSnapshot {
    session_status: SessionStatus,
    turn_id: Option<String>,
    assistant_text: String,
    active_tool: Option<String>,
    error_text: Option<String>,
    turn_ended: bool,
}

async fn read_turn_snapshot(
    supervisor: &BotsSupervisor,
    session_id: &str,
    baseline_pos: i64,
    was_idle: bool,
    prompt_head: &str,
    known_turn_id: Option<&str>,
) -> Result<TurnSnapshot> {
    let sid = session_id.to_owned();
    let prompt_head = prompt_head.to_owned();
    let known_turn = known_turn_id.map(str::to_owned);
    supervisor
        .database()
        .read("feishu.turn_snapshot", move |store| {
            let head = store.session(&sid)?;
            let page = store.timeline(
                &sid,
                TimelineQuery {
                    before: None,
                    after: Some(baseline_pos),
                    limit: Some(100),
                },
            )?;
            let turn_id = known_turn.or_else(|| {
                if was_idle {
                    page.items
                        .iter()
                        .find(|record| {
                            matches!(
                                record.body,
                                TimelineBody::Message {
                                    role: MessageRole::User,
                                    ..
                                }
                            )
                        })
                        .or_else(|| page.items.first())
                        .map(|record| record.turn_id.clone())
                } else {
                    page.items
                        .iter()
                        .find(|record| {
                            matches!(
                                record.body,
                                TimelineBody::Message {
                                    role: MessageRole::User,
                                    ..
                                }
                            ) && (prompt_head.is_empty()
                                || record.preview.starts_with(&prompt_head))
                        })
                        .map(|record| record.turn_id.clone())
                }
            });

            let Some(ref active_turn) = turn_id else {
                return Ok(TurnSnapshot {
                    session_status: head.status,
                    turn_id: None,
                    assistant_text: String::new(),
                    active_tool: None,
                    error_text: None,
                    turn_ended: false,
                });
            };

            let mut assistant_parts = Vec::new();
            let mut active_tool = None;
            let mut error_text = None;
            let mut turn_ended = false;

            for record in page.items.iter().filter(|r| &r.turn_id == active_turn) {
                match &record.body {
                    TimelineBody::Message {
                        role: MessageRole::Assistant,
                        ..
                    } => {
                        let text = if record.truncated {
                            store
                                .timeline_text(&sid, &record.id, TimelineTextQuery::default())
                                .map(|page| page.text)
                                .unwrap_or_else(|_| record.preview.clone())
                        } else {
                            record.preview.clone()
                        };
                        if !text.trim().is_empty() {
                            assistant_parts.push(text);
                        }
                    }
                    TimelineBody::Tool { name, state, .. } => {
                        if *state == crate::protocol::ToolState::Running {
                            active_tool = Some(name.clone());
                        } else if active_tool.as_deref() == Some(name.as_str()) {
                            active_tool = None;
                        }
                    }
                    TimelineBody::Error { .. } => {
                        let text = if record.truncated {
                            store
                                .timeline_text(&sid, &record.id, TimelineTextQuery::default())
                                .map(|page| page.text)
                                .unwrap_or_else(|_| record.preview.clone())
                        } else {
                            record.preview.clone()
                        };
                        if !text.trim().is_empty() {
                            error_text = Some(text);
                        }
                    }
                    TimelineBody::TurnEnd { .. } => {
                        turn_ended = true;
                    }
                    _ => {}
                }
            }

            Ok(TurnSnapshot {
                session_status: head.status,
                turn_id,
                assistant_text: assistant_parts.join("\n\n"),
                active_tool,
                error_text,
                turn_ended,
            })
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_group_mention_text_and_strips_bot_tag() {
        let payload = serde_json::to_vec(&json!({
            "schema": "2.0",
            "header": {
                "event_id": "evt_1",
                "event_type": "im.message.receive_v1"
            },
            "event": {
                "sender": { "sender_type": "user" },
                "message": {
                    "message_id": "om_123",
                    "chat_id": "oc_group1",
                    "chat_type": "group",
                    "message_type": "text",
                    "content": r#"{"text":"@_user_1 请帮我总结项目进度 @_user_2"}"#,
                    "mentions": [
                        {
                            "key": "@_user_1",
                            "name": "ResearchBot",
                            "id": { "open_id": "ou_bot" }
                        },
                        {
                            "key": "@_user_2",
                            "name": "Alice",
                            "id": { "open_id": "ou_alice" }
                        }
                    ]
                }
            }
        }))
        .unwrap();

        let parsed = parse_receive_event(&payload, Some("ou_bot")).expect("should parse");
        assert!(parsed.mentioned_bot);
        assert_eq!(parsed.chat_type, "group");
        assert_eq!(parsed.text, "请帮我总结项目进度 @Alice");
    }

    #[test]
    fn ignores_non_user_sender_and_detects_other_mention_only() {
        let bot_sender = serde_json::to_vec(&json!({
            "schema": "2.0",
            "header": { "event_id": "evt_2", "event_type": "im.message.receive_v1" },
            "event": {
                "sender": { "sender_type": "app" },
                "message": {
                    "message_id": "om_2",
                    "chat_id": "oc_1",
                    "chat_type": "p2p",
                    "message_type": "text",
                    "content": r#"{"text":"hello"}"#
                }
            }
        }))
        .unwrap();
        assert!(parse_receive_event(&bot_sender, Some("ou_bot")).is_none());

        let other_mention = serde_json::to_vec(&json!({
            "schema": "2.0",
            "header": { "event_id": "evt_3", "event_type": "im.message.receive_v1" },
            "event": {
                "sender": { "sender_type": "user" },
                "message": {
                    "message_id": "om_3",
                    "chat_id": "oc_group",
                    "chat_type": "group",
                    "message_type": "text",
                    "content": r#"{"text":"@_user_1 hi"}"#,
                    "mentions": [
                        { "key": "@_user_1", "name": "Bob", "id": { "open_id": "ou_bob" } }
                    ]
                }
            }
        }))
        .unwrap();
        let parsed = parse_receive_event(&other_mention, Some("ou_bot")).unwrap();
        assert!(!parsed.mentioned_bot);
        assert_eq!(parsed.text, "@Bob hi");
    }

    #[test]
    fn extracts_post_rich_text_and_new_command() {
        let payload = serde_json::to_vec(&json!({
            "schema": "2.0",
            "header": { "event_id": "evt_4", "event_type": "im.message.receive_v1" },
            "event": {
                "sender": { "sender_type": "user" },
                "message": {
                    "message_id": "om_4",
                    "chat_id": "oc_p2p",
                    "chat_type": "p2p",
                    "message_type": "post",
                    "content": serde_json::to_string(&json!({
                        "zh_cn": {
                            "title": "周报",
                            "content": [[
                                { "tag": "text", "text": "/new " },
                                { "tag": "text", "text": "整理本周工作" }
                            ]]
                        }
                    })).unwrap()
                }
            }
        }))
        .unwrap();
        let parsed = parse_receive_event(&payload, Some("ou_bot")).unwrap();
        assert_eq!(parsed.text, "周报\n/new 整理本周工作");
        assert_eq!(parse_new_command("/new 帮我查下"), Some("帮我查下".into()));
        assert_eq!(parse_new_command("/reset"), Some(String::new()));
        assert_eq!(parse_new_command("/news"), None);
    }

    #[test]
    fn builds_update_multi_markdown_card() {
        let card = build_card_json("ResearchBot", "**Hello**\nWorld", Some("话题 · 完成"));
        assert_eq!(card["schema"], "2.0");
        assert_eq!(card["config"]["update_multi"], true);
        assert_eq!(card["config"]["width_mode"], "fill");
        assert_eq!(card["body"]["elements"][0]["tag"], "markdown");
        assert_eq!(card["body"]["elements"][1]["tag"], "hr");
        assert_eq!(card["body"]["elements"][2]["tag"], "markdown");
        assert_eq!(card["body"]["elements"][2]["text_size"], "notation");
    }

    #[test]
    fn converts_markdown_tables_to_card_v2_table_elements_and_ignores_code_fences() {
        let sample = "\
「示例项目群」群目前共 12 人：

| | 成员 |
|---|---|
| 👑 群主 | 林一 |
| 成员 | 陈二、周三 |

```markdown
| a | b |
|---|---|
| 1 | 2 |
```

需要我帮大家做点什么吗？";

        let card = build_card_json("示例助手", sample, Some("示例项目群 · 已完成"));
        let elements = card["body"]["elements"].as_array().unwrap();
        assert_eq!(elements[0]["tag"], "markdown");
        assert!(
            elements[0]["content"]
                .as_str()
                .unwrap()
                .contains("群目前共 12 人")
        );
        assert_eq!(elements[1]["tag"], "table");
        assert_eq!(elements[1]["row_height"], "auto");
        assert_eq!(elements[1]["columns"][0]["display_name"], " ");
        assert_eq!(elements[1]["columns"][0]["data_type"], "lark_md");
        assert_eq!(elements[1]["columns"][1]["display_name"], "成员");
        assert_eq!(elements[1]["rows"][0]["c0"], "👑 群主");
        assert_eq!(elements[1]["rows"][0]["c1"], "林一");
        assert_eq!(elements[1]["rows"][1]["c0"], "成员");
        assert_eq!(elements[1]["rows"][1]["c1"], "陈二、周三");
        // Code fence table stays verbatim inside markdown element, not converted into a table.
        assert_eq!(elements[2]["tag"], "markdown");
        assert!(
            elements[2]["content"]
                .as_str()
                .unwrap()
                .contains("```markdown")
        );
        assert!(
            elements[2]["content"]
                .as_str()
                .unwrap()
                .contains("需要我帮大家做点什么吗")
        );
        assert_eq!(elements[3]["tag"], "hr");
        assert_eq!(elements[4]["tag"], "markdown");
        assert_eq!(elements[4]["text_size"], "notation");
    }

    #[test]
    fn extracts_sender_open_id_and_fallbacks() {
        let open_id_payload = serde_json::to_vec(&json!({
            "schema": "2.0",
            "header": { "event_id": "evt_sender_1", "event_type": "im.message.receive_v1" },
            "event": {
                "sender": {
                    "sender_type": "user",
                    "sender_id": { "open_id": "ou_alice", "user_id": "u_alice" }
                },
                "message": {
                    "message_id": "om_s1",
                    "chat_id": "oc_group_1",
                    "chat_type": "group",
                    "message_type": "text",
                    "content": r#"{"text":"hello"}"#
                }
            }
        }))
        .unwrap();
        let parsed = parse_receive_event(&open_id_payload, Some("ou_bot")).unwrap();
        assert_eq!(parsed.sender_open_id.as_deref(), Some("ou_alice"));

        let fallback_payload = serde_json::to_vec(&json!({
            "schema": "2.0",
            "header": { "event_id": "evt_sender_2", "event_type": "im.message.receive_v1" },
            "event": {
                "sender": {
                    "sender_type": "user",
                    "sender_id": { "open_id": " ", "user_id": "u_fallback" }
                },
                "message": {
                    "message_id": "om_s2",
                    "chat_id": "oc_p2p_1",
                    "chat_type": "p2p",
                    "message_type": "text",
                    "content": r#"{"text":"hi"}"#
                }
            }
        }))
        .unwrap();
        let parsed_fallback = parse_receive_event(&fallback_payload, Some("ou_bot")).unwrap();
        assert_eq!(
            parsed_fallback.sender_open_id.as_deref(),
            Some("u_fallback")
        );
    }

    #[test]
    fn builds_proactive_chat_card_message_payload() {
        let card = build_card_json(
            "⏰ 每日早报",
            "今日任务一切正常",
            Some("Prospero Bot 后台任务"),
        );
        let payload = build_chat_card_message_payload("oc_chat_123", &card);
        assert_eq!(payload["receive_id"], "oc_chat_123");
        assert_eq!(payload["msg_type"], "interactive");
        let content_str = payload["content"]
            .as_str()
            .expect("content must be JSON string");
        let parsed: Value = serde_json::from_str(content_str).unwrap();
        assert_eq!(parsed["schema"], "2.0");
        assert_eq!(parsed["header"]["title"]["content"], "⏰ 每日早报");
    }
}
