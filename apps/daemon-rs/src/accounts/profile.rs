//! Third-party API profile validation and session environment.
//!
//! Third-party API profiles are non-secret metadata stored in SQLite; the API
//! Key lives in the account's mode-0600 credential file. This module mirrors
//! the legacy `cleanApiProfile`, `ApiHeadersSchema` and per-agent environment
//! rules for Claude/Anthropic and Codex/OpenAI-compatible profiles.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{Error, Result};

const MAX_BASE_URL: usize = 2000;
const MAX_MODEL: usize = 300;
const MAX_HEADERS: usize = 32;
const MAX_HEADER_NAME: usize = 100;
const MAX_HEADER_VALUE: usize = 8192;

/// Header names the user can never override: authentication goes through the
/// API Key field, and transport headers are owned by the HTTP stack.
const BANNED_HEADERS: &[&str] = &[
    "authorization",
    "x-api-key",
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "upgrade",
    "expect",
    "trailer",
    "te",
    "proxy-authorization",
    "proxy-connection",
];

/// Declared model capabilities. The gateway is trusted to report these; the
/// daemon only enforces local shape and session limits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct ModelCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub context_window: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number")]
    pub max_output_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported_efforts: Option<Vec<String>>,
}

impl ModelCapabilities {
    pub(crate) fn clean(value: serde_json::Value) -> Result<Option<Self>> {
        if value.is_null() {
            return Ok(None);
        }
        let parsed: ModelCapabilities =
            serde_json::from_value(value).map_err(|_| Error::Invalid("模型能力配置无效".into()))?;
        let positive = |field: Option<i64>| -> Result<()> {
            if let Some(value) = field
                && !(1..=100_000_000).contains(&value)
            {
                return Err(Error::Invalid(
                    "模型能力配置无效：上下文和输出上限须为正整数".into(),
                ));
            }
            Ok(())
        };
        positive(parsed.context_window)?;
        positive(parsed.max_output_tokens)?;
        if let (Some(context), Some(output)) = (parsed.context_window, parsed.max_output_tokens)
            && output > context
        {
            return Err(Error::Invalid(
                "模型能力配置无效：输出不能超过上下文".into(),
            ));
        }
        if let Some(efforts) = &parsed.supported_efforts
            && (efforts.len() > 10
                || efforts
                    .iter()
                    .any(|level| !ALLOWED_EFFORTS.contains(&level.as_str())))
        {
            return Err(Error::Invalid("模型能力配置无效：推理强度不支持".into()));
        }
        // A model that explicitly cannot reason cannot declare effort levels.
        if parsed.reasoning == Some(false) && parsed.supported_efforts.is_some() {
            return Err(Error::Invalid(
                "模型能力配置无效：不支持推理时不能声明推理强度".into(),
            ));
        }
        Ok(Some(parsed))
    }
}

const ALLOWED_EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum ModelCapabilitySupportValue {
    Enforced,
    Unsupported,
}

/// Reports only explicitly declared capabilities; enforcement is engine-specific.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct ModelCapabilitySupport {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<ModelCapabilitySupportValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<ModelCapabilitySupportValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<ModelCapabilitySupportValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vision: Option<ModelCapabilitySupportValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ModelCapabilitySupportValue>,
}

pub(crate) fn capability_support(profile: &ApiProfile) -> Option<ModelCapabilitySupport> {
    let caps = profile.model_capabilities.as_ref()?;
    let lower_model = profile.model.to_lowercase();
    let protocol = profile.protocol();
    let claude_native_window = protocol == "anthropic"
        && ["claude-", "opus", "sonnet", "haiku", "fable", "[1m]"]
            .iter()
            .any(|needle| lower_model.contains(needle));
    Some(ModelCapabilitySupport {
        context_window: caps.context_window.map(|_| {
            if claude_native_window {
                ModelCapabilitySupportValue::Unsupported
            } else {
                ModelCapabilitySupportValue::Enforced
            }
        }),
        max_output_tokens: caps.max_output_tokens.map(|_| {
            if protocol == "anthropic" {
                ModelCapabilitySupportValue::Enforced
            } else {
                ModelCapabilitySupportValue::Unsupported
            }
        }),
        tools: caps.tools.map(|_| ModelCapabilitySupportValue::Enforced),
        vision: caps.vision.map(|vision| {
            if !vision || protocol == "anthropic" {
                ModelCapabilitySupportValue::Enforced
            } else {
                ModelCapabilitySupportValue::Unsupported
            }
        }),
        reasoning: caps.reasoning.map(|reasoning| {
            if (protocol == "anthropic" && reasoning)
                || (protocol == "openai_responses" && !reasoning)
            {
                ModelCapabilitySupportValue::Unsupported
            } else {
                ModelCapabilitySupportValue::Enforced
            }
        }),
    })
}

/// Public, non-secret API profile carried in account snapshots.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct ApiProfile {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    pub base_url: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_capabilities: Option<ModelCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
}

impl ApiProfile {
    pub fn protocol(&self) -> &str {
        self.protocol.as_deref().unwrap_or("anthropic")
    }
}

pub(crate) fn agent_kind(profile: &ApiProfile) -> crate::protocol::AgentKind {
    match profile.protocol() {
        "anthropic" => crate::protocol::AgentKind::Claude,
        "openai_chat_completions" => crate::protocol::AgentKind::Opencode,
        _ => crate::protocol::AgentKind::Codex,
    }
}

/// Wire input uses a JSON object for headers; SQLite stores the same shape.
pub(crate) fn parse_profile_json(raw: &str) -> Option<ApiProfile> {
    serde_json::from_str::<ApiProfile>(raw).ok()
}

fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_HEADER_NAME
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&c))
}

pub(crate) fn clean_headers(
    value: Option<serde_json::Value>,
) -> Result<Option<BTreeMap<String, String>>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let object = value
        .as_object()
        .ok_or_else(|| Error::Invalid("自定义 Header 无效".into()))?;
    if object.len() > MAX_HEADERS {
        return Err(Error::Invalid("最多配置 32 个 Header".into()));
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut headers = BTreeMap::new();
    for (name, raw_value) in object {
        if !valid_header_name(name) {
            return Err(Error::Invalid("Header 名称无效".into()));
        }
        let lower = name.to_ascii_lowercase();
        if BANNED_HEADERS.contains(&lower.as_str()) {
            return Err(Error::Invalid(
                "认证头请使用 API Key，不能覆盖传输头".into(),
            ));
        }
        if !seen.insert(lower) {
            return Err(Error::Invalid("Header 名称不能重复".into()));
        }
        let value = raw_value
            .as_str()
            .ok_or_else(|| Error::Invalid("Header 值无效".into()))?;
        if value.len() > MAX_HEADER_VALUE || value.bytes().any(|c| !(0x20..=0x7e).contains(&c)) {
            return Err(Error::Invalid("Header 值无效".into()));
        }
        headers.insert(name.clone(), value.to_owned());
    }
    Ok(Some(headers))
}

/// Normalizes and validates a profile the way legacy `cleanApiProfile` does.
#[allow(clippy::too_many_arguments)]
pub(crate) fn clean_profile(
    agent: &str,
    raw_base_url: &str,
    raw_model: &str,
    provider: Option<&str>,
    protocol: Option<&str>,
    capabilities: Option<serde_json::Value>,
    headers: Option<serde_json::Value>,
) -> Result<ApiProfile> {
    let (default_provider, default_protocol) = match agent {
        "claude" => ("anthropic_compatible", "anthropic"),
        "codex" => ("openai_compatible", "openai_responses"),
        "opencode" => ("openai_compatible", "openai_chat_completions"),
        _ => return Err(Error::Invalid("Agent 不支持 API Profile".into())),
    };
    let base_url = raw_base_url.trim();
    let model = raw_model.trim();
    if base_url.is_empty() || base_url.len() > MAX_BASE_URL || base_url.contains(['\r', '\n', '\0'])
    {
        return Err(Error::Invalid("API 地址格式无效".into()));
    }
    if model.is_empty() || model.len() > MAX_MODEL || model.contains(['\r', '\n', '\0']) {
        return Err(Error::Invalid("模型名称格式无效".into()));
    }
    let parsed_provider = provider.unwrap_or(default_provider);
    let parsed_protocol = protocol.unwrap_or(default_protocol);
    let valid = match agent {
        "codex" => {
            parsed_provider == "openai_compatible"
                && matches!(
                    parsed_protocol,
                    "openai_responses" | "openai_chat_completions"
                )
        }
        "opencode" => {
            parsed_provider == "openai_compatible" && parsed_protocol == "openai_chat_completions"
        }
        "claude" => parsed_provider == "anthropic_compatible" && parsed_protocol == "anthropic",
        _ => false,
    };
    if !valid {
        return Err(Error::Invalid(
            "所选 Agent、Provider 与 API 协议不兼容".into(),
        ));
    }
    // url::crate is already in the tree via reqwest.
    let mut url =
        url::Url::parse(base_url).map_err(|_| Error::Invalid("API 地址必须是完整 URL".into()))?;
    // Strip recognized API suffixes so callers may paste the endpoint URL.
    let mut normalized_path = None;
    if !url.cannot_be_a_base() {
        let path = url.path().trim_end_matches('/').to_string();
        let suffixes: &[&str] = match parsed_protocol {
            "openai_responses" => &["/responses"],
            "openai_chat_completions" => &["/chat/completions"],
            _ => &["/v1/messages", "/v1"],
        };
        let stripped = suffixes
            .iter()
            .find_map(|suffix| path.strip_suffix(suffix))
            .unwrap_or(&path)
            .trim_end_matches('/');
        let path = if stripped.is_empty() { "/" } else { stripped };
        url.set_path(path);
        normalized_path = Some(path.to_owned());
    }
    let mut normalized = url.to_string();
    if normalized_path.as_deref() == Some("/") && url.query().is_none() && url.fragment().is_none()
    {
        normalized.truncate(normalized.len() - 1);
    }
    let caps = ModelCapabilities::clean(capabilities.unwrap_or(serde_json::Value::Null))?;
    if parsed_protocol == "openai_chat_completions"
        && let Some(caps) = &caps
        && (caps.context_window.is_some() != caps.max_output_tokens.is_some())
    {
        return Err(Error::Invalid(
            "Chat Completions Profile 的上下文窗口与最大输出必须同时填写或同时留空".into(),
        ));
    }
    let headers = clean_headers(headers)?;
    Ok(ApiProfile {
        provider: parsed_provider.into(),
        protocol: (parsed_protocol != "anthropic").then(|| parsed_protocol.into()),
        base_url: normalized,
        model: model.into(),
        model_capabilities: caps,
        headers,
    })
}

/// Builds a cleaned profile from wire fields, tolerating omitted optionals.
pub(crate) fn clean_profile_inputs(
    agent: &str,
    base_url: &str,
    model: &str,
    provider: Option<&str>,
    protocol: Option<&str>,
    capabilities: Option<serde_json::Value>,
) -> Result<ApiProfile> {
    clean_profile(
        agent,
        base_url,
        model,
        provider,
        protocol,
        capabilities,
        None,
    )
}

/// Custom headers in the CLI's `Name: value` newline-joined form.
pub(crate) fn custom_headers(profile: &ApiProfile) -> String {
    profile
        .headers
        .iter()
        .flatten()
        .map(|(name, value)| format!("{name}: {value}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Full endpoint URL for the given API action (`v1/messages` or `v1/models`).
pub(crate) fn endpoint(profile: &ApiProfile, suffix: &str) -> Result<String> {
    let mut url = url::Url::parse(&profile.base_url)
        .map_err(|_| Error::Invalid("API Profile 地址无效".into()))?;
    if url.cannot_be_a_base() {
        return Ok(url.to_string());
    }
    let base = url.path().trim_end_matches('/');
    url.set_path(&format!("{base}{suffix}"));
    Ok(url.to_string())
}

/// Environment overrides for a structured/PTY session bound to an
/// API profile. The profile key is the only credential, inherited native
/// credentials are cleared, and model-capability overrides are pinned per
/// runtime.
pub(crate) fn session_environment(
    root: &std::path::Path,
    profile: &ApiProfile,
    secret: &str,
) -> Vec<(String, String)> {
    if profile.protocol() == "anthropic" {
        return claude_session_environment(root, profile, secret);
    }
    codex_session_environment(root, profile, secret)
}

fn claude_session_environment(
    root: &std::path::Path,
    profile: &ApiProfile,
    secret: &str,
) -> Vec<(String, String)> {
    let caps = profile.model_capabilities.as_ref();
    let mut environment = vec![
        ("ANTHROPIC_API_KEY".into(), secret.to_owned()),
        ("ANTHROPIC_AUTH_TOKEN".into(), String::new()),
        ("ANTHROPIC_BASE_URL".into(), profile.base_url.clone()),
        ("ANTHROPIC_CUSTOM_HEADERS".into(), custom_headers(profile)),
        ("ANTHROPIC_MODEL".into(), profile.model.clone()),
        ("PROSPERO_API_PROFILE_MODEL".into(), profile.model.clone()),
        ("CLAUDE_CODE_API_BASE_URL".into(), String::new()),
        ("CLAUDE_CODE_OAUTH_TOKEN".into(), String::new()),
        ("CLAUDE_CODE_OAUTH_REFRESH_TOKEN".into(), String::new()),
        ("CLAUDE_CODE_OAUTH_SCOPES".into(), String::new()),
        ("CLAUDE_CODE_USE_BEDROCK".into(), String::new()),
        ("CLAUDE_CODE_USE_VERTEX".into(), String::new()),
        ("CLAUDE_CODE_USE_FOUNDRY".into(), String::new()),
        ("CLAUDE_CODE_USE_GATEWAY".into(), String::new()),
        (
            "CLAUDE_CONFIG_DIR".into(),
            root.to_string_lossy().into_owned(),
        ),
        (
            "CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(),
            caps.and_then(|c| c.context_window)
                .map(|v| v.to_string())
                .unwrap_or_default(),
        ),
        (
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS".into(),
            caps.and_then(|c| c.max_output_tokens)
                .map(|v| v.to_string())
                .unwrap_or_default(),
        ),
        (
            "MAX_THINKING_TOKENS".into(),
            if caps.and_then(|c| c.reasoning) == Some(false) {
                "0".into()
            } else {
                String::new()
            },
        ),
        (
            "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT".into(),
            String::new(),
        ),
        ("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), String::new()),
        ("DISABLE_COMPACT".into(), String::new()),
        (
            "PROSPERO_API_PROFILE_VISION".into(),
            if caps.and_then(|c| c.vision) == Some(false) {
                "0"
            } else {
                "1"
            }
            .into(),
        ),
    ];
    // Non-Anthropic-host gateways need nonessential telemetry traffic off and
    // an onboarding marker inside the isolated config root.
    if url::Url::parse(&profile.base_url)
        .ok()
        .and_then(|url| url.host_str().map(|host| host != "api.anthropic.com"))
        .unwrap_or(false)
    {
        prepare_claude_config(root);
        environment.push((
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
            "1".into(),
        ));
    }
    environment
}

fn codex_session_environment(
    root: &std::path::Path,
    profile: &ApiProfile,
    secret: &str,
) -> Vec<(String, String)> {
    let mut environment = vec![
        ("OPENAI_API_KEY".into(), secret.to_owned()),
        ("CODEX_API_KEY".into(), String::new()),
        ("CODEX_ACCESS_TOKEN".into(), String::new()),
        ("CODEX_REFRESH_TOKEN".into(), String::new()),
        ("CODEX_HOME".into(), root.to_string_lossy().into_owned()),
        (
            "CODEX_SQLITE_HOME".into(),
            root.to_string_lossy().into_owned(),
        ),
        ("PROSPERO_API_PROFILE_MODEL".into(), profile.model.clone()),
        (
            "PROSPERO_API_PROFILE_MODEL_PROVIDER".into(),
            "prospero".into(),
        ),
        (
            "PROSPERO_API_PROFILE_VISION".into(),
            if profile.model_capabilities.as_ref().and_then(|c| c.vision) == Some(false) {
                "0"
            } else {
                "1"
            }
            .into(),
        ),
    ];
    for (index, (_, value)) in profile
        .headers
        .clone()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
    {
        environment.push((format!("PROSPERO_API_HEADER_{index}"), value));
    }
    environment
}

pub(crate) fn codex_app_server_args(profile: &ApiProfile) -> Vec<String> {
    let mut args = vec![
        "-c".into(),
        format!("model_provider={}", toml_string("prospero")),
        "-c".into(),
        format!("model={}", toml_string(&profile.model)),
        "-c".into(),
        format!("default_subagent_model={}", toml_string(&profile.model)),
        "-c".into(),
        format!(
            "model_providers.prospero.name={}",
            toml_string("Prospero external API")
        ),
        "-c".into(),
        format!(
            "model_providers.prospero.base_url={}",
            toml_string(&profile.base_url)
        ),
        "-c".into(),
        format!(
            "model_providers.prospero.env_key={}",
            toml_string("OPENAI_API_KEY")
        ),
        "-c".into(),
        format!(
            "model_providers.prospero.wire_api={}",
            toml_string("responses")
        ),
        "-c".into(),
        "model_providers.prospero.requires_openai_auth=false".into(),
    ];
    for (index, (name, _)) in profile
        .headers
        .clone()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
    {
        args.push("-c".into());
        args.push(format!(
            "model_providers.prospero.env_http_headers.{}={}",
            toml_string(&name),
            toml_string(&format!("PROSPERO_API_HEADER_{index}"))
        ));
    }
    if let Some(caps) = profile.model_capabilities.as_ref() {
        if let Some(context) = caps.context_window {
            args.push("-c".into());
            args.push(format!("model_context_window={context}"));
        }
        if let Some(reasoning) = caps.reasoning {
            args.push("-c".into());
            args.push(format!("model_supports_reasoning_summaries={reasoning}"));
            if !reasoning {
                args.push("-c".into());
                args.push("model_reasoning_summary=\"none\"".into());
            }
        }
    }
    args
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

/// Ensures `<root>/.claude.json` records completed onboarding so a profile
/// session never opens first-run flows against a third-party endpoint.
fn prepare_claude_config(root: &std::path::Path) {
    use std::io::Write;
    let path = root.join(".claude.json");
    let mut config = match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(value) if value.is_object() => value,
            _ => return,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            serde_json::json!({})
        }
        Err(_) => return,
    };
    if config.get("hasCompletedOnboarding") == Some(&serde_json::Value::Bool(true)) {
        return;
    }
    config["hasCompletedOnboarding"] = serde_json::Value::Bool(true);
    let Ok(body) = serde_json::to_vec_pretty(&config) else {
        return;
    };
    if let Ok(file) = std::fs::File::create(&path) {
        let mut file = file;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        let _ = file.write_all(&body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(protocol: Option<&str>) -> ApiProfile {
        ApiProfile {
            provider: if protocol == Some("anthropic") || protocol.is_none() {
                "anthropic_compatible"
            } else {
                "openai_compatible"
            }
            .into(),
            protocol: protocol.map(str::to_owned),
            base_url: "https://gateway.example/v1".into(),
            model: "test".into(),
            model_capabilities: None,
            headers: None,
        }
    }

    #[test]
    fn profile_protocol_selects_execution_engine() {
        assert_eq!(
            agent_kind(&profile(None)),
            crate::protocol::AgentKind::Claude
        );
        assert_eq!(
            agent_kind(&profile(Some("anthropic"))),
            crate::protocol::AgentKind::Claude
        );
        assert_eq!(
            agent_kind(&profile(Some("openai_responses"))),
            crate::protocol::AgentKind::Codex
        );
        assert_eq!(
            agent_kind(&profile(Some("openai_chat_completions"))),
            crate::protocol::AgentKind::Opencode
        );
    }

    #[test]
    fn profile_validation_accepts_permissive_external_urls() {
        let profile = clean_profile_inputs(
            "claude",
            "https://user:pass@gateway.example.com/v1/messages?token=1#frag",
            "claude-test",
            None,
            None,
            Some(serde_json::Value::Null),
        )
        .unwrap();
        assert_eq!(
            profile.base_url,
            "https://user:pass@gateway.example.com/?token=1#frag"
        );
        assert_eq!(
            endpoint(&profile, "/v1/messages").unwrap(),
            "https://user:pass@gateway.example.com/v1/messages?token=1#frag"
        );

        let ftp = clean_profile_inputs(
            "claude",
            "ftp://gateway.example.com/v1/messages",
            "claude-test",
            None,
            None,
            Some(serde_json::Value::Null),
        )
        .unwrap();
        assert_eq!(ftp.base_url, "ftp://gateway.example.com");
        assert_eq!(
            endpoint(&ftp, "/v1/messages").unwrap(),
            "ftp://gateway.example.com/v1/messages"
        );
    }
}
