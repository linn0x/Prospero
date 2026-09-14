//! `GET <baseUrl>/v1/models` catalog fetch for API profiles.
//!
//! Port of the legacy `fetchApiModels`:
//! bounded redirects, a 2 MiB / 1000-model / 10-page budget, and stable
//! feature-error codes the desktop renders without a daemon restart.

use std::time::Duration;

use serde::Serialize;
use ts_rs::TS;

use super::profile::ModelCapabilities;

const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_MODELS: usize = 1000;
const MAX_PAGES: usize = 10;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub(crate) struct CatalogModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_capabilities: Option<ModelCapabilities>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub(crate) struct FeatureError {
    pub code: String,
    pub message: String,
}

impl FeatureError {
    pub(crate) fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub(crate) struct ModelsResult {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub ok: bool,
    pub models: Vec<CatalogModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<FeatureError>,
}

impl ModelsResult {
    pub(crate) fn success(request_id: &str, models: Vec<CatalogModel>) -> Self {
        Self {
            kind: "agent.account.api.models.result".into(),
            request_id: request_id.chars().take(100).collect(),
            ok: true,
            models,
            error: None,
        }
    }

    pub(crate) fn failure(request_id: &str, error: FeatureError) -> Self {
        Self {
            kind: "agent.account.api.models.result".into(),
            request_id: request_id.chars().take(100).collect(),
            ok: false,
            models: vec![],
            error: Some(error),
        }
    }
}

/// Normalizes a pasted gateway URL into the `/v1/models` endpoint, stripping
/// any recognized API suffix first.
fn models_url(base_url: &str) -> std::result::Result<url::Url, FeatureError> {
    let mut url = url::Url::parse(base_url)
        .map_err(|_| FeatureError::new("invalid_request", "API 地址必须是完整 URL"))?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && local);
    if base_url.len() > 2000
        || base_url.contains(['\r', '\n', '\0'])
        || !scheme_ok
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(FeatureError::new(
            "invalid_request",
            "API 地址必须使用 HTTPS（localhost 可使用 HTTP），且不能包含凭据或查询参数",
        ));
    }
    let path = url.path().trim_end_matches('/').to_string();
    // Strip the recognized API suffixes so a pasted endpoint URL works too.
    let stripped = path
        .strip_suffix("/chat/completions")
        .or_else(|| path.strip_suffix("/responses"))
        .or_else(|| path.strip_suffix("/messages"))
        .or_else(|| path.strip_suffix("/models"))
        .unwrap_or(&path)
        .trim_end_matches('/');
    let normalized = if stripped.is_empty() {
        "/v1".into()
    } else if !stripped.rsplit('/').next().is_some_and(|last| {
        last.len() >= 2 && &last[..1] == "v" && last[1..].chars().all(char::is_numeric)
    }) {
        format!("{stripped}/v1")
    } else {
        stripped.to_string()
    };
    url.set_path(&format!("{normalized}/models"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn safe_text(value: &serde_json::Value, maximum: usize, secret: &str) -> Option<String> {
    let text = value.as_str()?.trim();
    if text.is_empty()
        || text.len() > maximum
        || text
            .chars()
            .any(|c| ('\u{0000}'..='\u{001f}').contains(&c) || c == '\u{007f}')
        || text.contains(secret)
    {
        return None;
    }
    Some(text.to_owned())
}

fn capability_bool(
    explicit: Option<&serde_json::Value>,
    native: Option<&serde_json::Value>,
) -> Option<bool> {
    explicit.and_then(|v| v.as_bool()).or_else(|| {
        native.and_then(|v| {
            v.as_bool().or_else(|| {
                v.as_object()
                    .and_then(|object| object.get("supported"))
                    .and_then(|value| value.as_bool())
            })
        })
    })
}

fn positive_limit(value: &serde_json::Value) -> Option<i64> {
    value
        .as_i64()
        .filter(|value| (1..=100_000_000).contains(value))
}

const ALLOWED_EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// Derives model capabilities from one catalog row, Anthropic field names.
fn row_capabilities(row: &serde_json::Value) -> Option<ModelCapabilities> {
    let explicit = row.get("model_capabilities");
    let capabilities = row.get("capabilities");
    let mut result = ModelCapabilities {
        context_window: explicit
            .and_then(|v| v.get("contextWindow"))
            .and_then(positive_limit)
            .or_else(|| row.get("max_input_tokens").and_then(positive_limit)),
        max_output_tokens: explicit
            .and_then(|v| v.get("maxOutputTokens"))
            .and_then(positive_limit)
            .or_else(|| row.get("max_tokens").and_then(positive_limit)),
        tools: capability_bool(
            explicit.and_then(|v| v.get("tools")),
            capabilities.and_then(|v| v.get("tools")),
        ),
        vision: capability_bool(
            explicit.and_then(|v| v.get("vision")),
            capabilities.and_then(|v| v.get("image_input")),
        ),
        reasoning: capability_bool(
            explicit.and_then(|v| v.get("reasoning")),
            capabilities.and_then(|v| v.get("thinking")),
        ),
        supported_efforts: None,
    };
    if let (Some(context), Some(output)) = (result.context_window, result.max_output_tokens)
        && output > context
    {
        result.context_window = None;
        result.max_output_tokens = None;
    }
    let reported = explicit
        .and_then(|v| v.get("supportedEfforts"))
        .or_else(|| row.get("supported_reasoning_efforts"));
    if let Some(array) = reported.and_then(|v| v.as_array()) {
        let efforts: Vec<String> = array
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .filter(|level| ALLOWED_EFFORTS.contains(&level.as_str()))
            .collect();
        if efforts.len() == array.len() && efforts.len() <= 10 {
            result.supported_efforts = Some(efforts);
        }
    } else if let Some(effort) = capabilities.and_then(|v| v.get("effort"))
        && let Some(supported) = effort.get("supported").and_then(|v| v.as_bool())
    {
        if !supported {
            result.supported_efforts = Some(vec![]);
        } else if let Some(object) = effort.as_object() {
            let levels = ALLOWED_EFFORTS
                .iter()
                .filter(|level| {
                    object
                        .get(**level)
                        .and_then(|v| v.get("supported"))
                        .and_then(|v| v.as_bool())
                        == Some(true)
                })
                .map(|level| (*level).to_owned())
                .collect::<Vec<_>>();
            if !levels.is_empty() {
                result.supported_efforts = Some(levels);
            }
        }
    }
    if result.reasoning == Some(false) {
        result.supported_efforts = None;
    }
    let used = result.context_window.is_some()
        || result.max_output_tokens.is_some()
        || result.tools.is_some()
        || result.vision.is_some()
        || result.reasoning.is_some()
        || result.supported_efforts.is_some();
    used.then_some(result)
}

fn client() -> std::result::Result<reqwest::Client, FeatureError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| FeatureError::new("network", "无法连接模型目录"))
}

/// Fetches the catalog. All failure modes are stable `FeatureError`s.
pub(crate) async fn fetch_models(
    base_url: &str,
    api_key: &str,
    headers: &std::collections::BTreeMap<String, String>,
) -> std::result::Result<Vec<CatalogModel>, FeatureError> {
    let key = api_key.trim();
    if key.is_empty() || key.len() > 8192 || key.contains(['\r', '\n', '\0']) {
        return Err(FeatureError::new("invalid_request", "请填写有效的 API Key"));
    }
    let endpoint = models_url(base_url)?;
    let http = client()?;
    let run = async {
        let mut models: Vec<CatalogModel> = Vec::new();
        let mut seen_ids = std::collections::BTreeSet::new();
        let mut seen_cursors = std::collections::BTreeSet::new();
        let mut total_bytes = 0usize;
        let mut cursor: Option<String> = None;
        for _page in 0..MAX_PAGES {
            let mut url = endpoint.clone();
            url.query_pairs_mut().append_pair("limit", "100");
            if let Some(after) = &cursor {
                url.query_pairs_mut().append_pair("after_id", after);
            }
            let mut next_url = url.clone();
            let mut response = None;
            for redirect in 0..=3u8 {
                let mut request = http
                    .get(next_url.clone())
                    .header("accept", "application/json")
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01");
                for (name, value) in headers {
                    request = request.header(name, value);
                }
                let reply = request.send().await.map_err(|_| {
                    FeatureError::new("network", "无法连接模型目录，请检查地址和网络")
                })?;
                let status = reply.status().as_u16();
                if [301, 302, 303, 307, 308].contains(&status) {
                    let location = reply
                        .headers()
                        .get("location")
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned);
                    let Some(location) = location else {
                        return Err(FeatureError::new("unsupported", "模型目录重定向无效"));
                    };
                    let resolved = next_url
                        .join(&location)
                        .map_err(|_| FeatureError::new("unsupported", "模型目录重定向无效"))?;
                    if redirect == 3
                        || resolved.origin() != endpoint.origin()
                        || !resolved.username().is_empty()
                        || resolved.password().is_some()
                    {
                        return Err(FeatureError::new(
                            "unsupported",
                            "模型目录不支持跨站或过多重定向",
                        ));
                    }
                    next_url = resolved;
                    continue;
                }
                if !reply.status().is_success() {
                    return Err(match status {
                        401 | 403 => FeatureError::new(
                            "authentication",
                            "模型目录认证失败，请检查 API Key 与访问权限",
                        ),
                        404 | 405 | 501 => FeatureError::new(
                            "unsupported",
                            "服务商不支持模型目录，仍可手动填写模型 ID",
                        ),
                        _ => FeatureError::new(
                            "network",
                            "模型目录请求失败，请稍后重试或手动填写模型 ID",
                        ),
                    });
                }
                response = Some(reply);
                break;
            }
            let response =
                response.expect("redirect loop either returns a final response or an error");
            if response
                .content_length()
                .is_some_and(|length| length as usize > MAX_BYTES - total_bytes)
            {
                return Err(FeatureError::new(
                    "limit_exceeded",
                    "模型目录响应超过大小限制",
                ));
            }
            use futures_util::StreamExt;
            let mut stream = response.bytes_stream();
            let mut body = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| FeatureError::new("network", "无法连接模型目录"))?;
                total_bytes += chunk.len();
                if total_bytes > MAX_BYTES {
                    return Err(FeatureError::new(
                        "limit_exceeded",
                        "模型目录响应超过大小限制",
                    ));
                }
                body.extend_from_slice(&chunk);
            }
            let payload: serde_json::Value = serde_json::from_slice(&body)
                .map_err(|_| FeatureError::new("invalid_format", "模型目录响应不是有效 JSON"))?;
            let data = payload
                .get("data")
                .and_then(|v| v.as_array())
                .ok_or_else(|| FeatureError::new("invalid_format", "模型目录响应缺少模型列表"))?;
            for row in data {
                let Some(id) =
                    safe_text(row.get("id").unwrap_or(&serde_json::Value::Null), 300, key)
                else {
                    return Err(FeatureError::new(
                        "invalid_format",
                        "模型目录包含无效模型记录",
                    ));
                };
                if !seen_ids.insert(id.clone()) {
                    continue;
                }
                let entry = CatalogModel {
                    id,
                    label: safe_text(
                        row.get("display_name")
                            .or_else(|| row.get("name"))
                            .unwrap_or(&serde_json::Value::Null),
                        300,
                        key,
                    ),
                    owner: safe_text(
                        row.get("owned_by").unwrap_or(&serde_json::Value::Null),
                        300,
                        key,
                    ),
                    description: safe_text(
                        row.get("description").unwrap_or(&serde_json::Value::Null),
                        1000,
                        key,
                    ),
                    model_capabilities: row_capabilities(row),
                };
                models.push(entry);
                if models.len() > MAX_MODELS {
                    return Err(FeatureError::new(
                        "limit_exceeded",
                        "模型数量超过目录限制，请手动填写模型 ID",
                    ));
                }
            }
            if payload.get("has_more") != Some(&serde_json::Value::Bool(true)) {
                if models.is_empty() {
                    return Err(FeatureError::new(
                        "empty_catalog",
                        "服务商返回空模型目录，仍可手动填写模型 ID",
                    ));
                }
                models.sort_by(|a, b| a.id.cmp(&b.id));
                return Ok(models);
            }
            let Some(next) = safe_text(
                payload.get("last_id").unwrap_or(&serde_json::Value::Null),
                300,
                key,
            ) else {
                return Err(FeatureError::new("invalid_format", "模型目录分页信息无效"));
            };
            if !seen_cursors.insert(next.clone()) {
                return Err(FeatureError::new("invalid_format", "模型目录分页信息无效"));
            }
            cursor = Some(next);
        }
        Err(FeatureError::new(
            "limit_exceeded",
            "模型目录分页超过限制，请手动填写模型 ID",
        ))
    };
    match tokio::time::timeout(TIMEOUT, run).await {
        Ok(result) => result,
        Err(_) => Err(FeatureError::new(
            "timeout",
            "模型目录请求已超时或取消，请重试",
        )),
    }
}
