use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::error::{Error, Result};

use super::managed;
use super::models::FeatureError;
use super::profile::ModelCapabilities;

const MAX_BYTES: usize = 16_384;
const MAX_ENV_ENTRIES: usize = 64;
const ALLOWED_EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const CLAUDE_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const RESERVED_ENV_KEYS: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "NODE_OPTIONS",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "CODEX_SQLITE_HOME",
    "PI_CODING_AGENT_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CODEX_REFRESH_TOKEN",
];

#[derive(Debug, Clone)]
pub(crate) struct ConfigTarget {
    pub account_id: String,
    pub model: Option<String>,
    pub model_capabilities: Option<ModelCapabilities>,
    pub active_sessions: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct AccountOverrides {
    default_model: Option<String>,
    default_effort: Option<String>,
    proxy_url: Option<String>,
    no_proxy: Option<String>,
    env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AccountConfigDocument {
    pub id: String,
    pub label: String,
    pub format: String,
    pub content: String,
    pub revision: String,
    pub writable: bool,
    pub generated: bool,
    pub editable_keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentAccountConfig {
    pub account_id: String,
    pub documents: Vec<AccountConfigDocument>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_proxy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    pub supported_efforts: Vec<String>,
    pub applies_to: String,
    #[ts(type = "number")]
    pub active_sessions: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AccountConfigResult {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<AgentAccountConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<FeatureError>,
}

impl AccountConfigResult {
    pub(crate) fn success(request_id: &str, config: AgentAccountConfig) -> Self {
        Self {
            kind: "agent.account.config.result".into(),
            request_id: request_id.chars().take(100).collect(),
            ok: true,
            config: Some(config),
            error: None,
        }
    }

    pub(crate) fn failure(request_id: &str, error: FeatureError) -> Self {
        Self {
            kind: "agent.account.config.result".into(),
            request_id: request_id.chars().take(100).collect(),
            ok: false,
            config: None,
            error: Some(error),
        }
    }
}

fn document_id() -> &'static str {
    "claude-overrides"
}

fn file_path(root: &Path) -> PathBuf {
    root.join("prospero-overrides.yaml")
}

fn hash(content: &str) -> String {
    Sha256::digest(content.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn parse_scalar(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.is_empty() || text == "null" || text == "~" {
        return None;
    }
    if (text.starts_with('"') && text.ends_with('"'))
        || (text.starts_with('\'') && text.ends_with('\''))
    {
        let inner = &text[1..text.len().saturating_sub(1)];
        if text.starts_with('"') {
            Some(inner.replace("\\\"", "\"").replace("\\\\", "\\"))
        } else {
            Some(inner.to_owned())
        }
    } else {
        Some(text.to_owned())
    }
}

fn validate_proxy_url(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Error::Feature(
            "invalid_config".into(),
            "代理地址不能为空".into(),
        ));
    }
    if trimmed.len() > 2000 || trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(Error::Feature(
            "invalid_config".into(),
            "代理地址格式无效".into(),
        ));
    }
    let parsed = url::Url::parse(trimmed)
        .map_err(|_| Error::Feature("invalid_config".into(), "代理地址必须是有效的 URL（如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080）".into()))?;
    if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h")
        || parsed.host_str().is_none()
    {
        return Err(Error::Feature(
            "invalid_config".into(),
            "代理协议仅支持 http、https、socks5 或 socks5h".into(),
        ));
    }
    Ok(trimmed.to_owned())
}

fn validate_no_proxy(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.len() > 1000 || trimmed.chars().any(char::is_control) {
        return Err(Error::Feature(
            "invalid_config".into(),
            "NO_PROXY 格式无效".into(),
        ));
    }
    Ok(trimmed.to_owned())
}

fn validate_env_entry(key: &str, value: &str) -> Result<(String, String)> {
    let key = key.trim();
    let valid_key = !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_')
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
    if !valid_key {
        return Err(Error::Feature(
            "invalid_config".into(),
            "环境变量名称格式无效".into(),
        ));
    }
    if RESERVED_ENV_KEYS
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(key))
    {
        return Err(Error::Feature(
            "invalid_config".into(),
            format!("环境变量 {key} 为受保护的系统或凭据变量，不允许覆盖"),
        ));
    }
    if value.chars().count() > 4096 || value.contains(['\r', '\n', '\0']) {
        return Err(Error::Feature(
            "invalid_config".into(),
            format!("环境变量 {key} 的值无效"),
        ));
    }
    Ok((key.to_owned(), value.to_owned()))
}

fn parse(content: &str, target: &ConfigTarget, strict: bool) -> Result<AccountOverrides> {
    if content.len() > MAX_BYTES {
        return Err(Error::Feature(
            "limit_exceeded".into(),
            "配置文档超过大小限制".into(),
        ));
    }
    if content.trim().is_empty() || content.trim() == "{}" {
        return Ok(AccountOverrides::default());
    }
    let mut result = AccountOverrides::default();
    let mut in_env_block = false;
    for (index, raw) in content.lines().enumerate() {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let is_indented = raw.starts_with(' ') || raw.starts_with('\t');
        if is_indented {
            if !in_env_block {
                if strict {
                    return Err(Error::Feature(
                        "syntax".into(),
                        format!("YAML 缩进错误:{}", index + 1),
                    ));
                }
                continue;
            }
            let Some((env_key, env_val)) = trimmed.split_once(':') else {
                return Err(Error::Feature(
                    "syntax".into(),
                    format!("YAML 语法错误:{}", index + 1),
                ));
            };
            let val = parse_scalar(env_val).unwrap_or_default();
            match validate_env_entry(env_key, &val) {
                Ok((k, v)) => {
                    if result.env.len() >= MAX_ENV_ENTRIES && !result.env.contains_key(&k) {
                        if strict {
                            return Err(Error::Feature(
                                "limit_exceeded".into(),
                                "自定义环境变量数量超过上限（最多 64 项）".into(),
                            ));
                        }
                        continue;
                    }
                    result.env.insert(k, v);
                }
                Err(err) => {
                    if strict {
                        return Err(err);
                    }
                }
            }
            continue;
        }
        in_env_block = false;
        let Some((key, value)) = trimmed.split_once(':') else {
            return Err(Error::Feature(
                "syntax".into(),
                format!("YAML 语法错误:{}", index + 1),
            ));
        };
        let key = key.trim();
        let allowed_top = matches!(
            key,
            "default_model" | "default_effort" | "proxy_url" | "no_proxy" | "env"
        );
        if !allowed_top {
            if strict {
                return Err(Error::Feature(
                    "invalid_config".into(),
                    "配置包含不允许编辑的字段；凭据、环境变量与执行设置不能写入此文档".into(),
                ));
            }
            continue;
        }
        if target.model.is_some() && key != "default_effort" && strict {
            return Err(Error::Feature(
                "invalid_config".into(),
                "配置包含不允许编辑的字段；凭据、环境变量与执行设置不能写入此文档".into(),
            ));
        }
        match key {
            "default_model" => result.default_model = parse_scalar(value),
            "default_effort" => result.default_effort = parse_scalar(value),
            "proxy_url" => {
                if let Some(raw_proxy) = parse_scalar(value) {
                    match validate_proxy_url(&raw_proxy) {
                        Ok(valid) => result.proxy_url = Some(valid),
                        Err(err) if strict => return Err(err),
                        Err(_) => {}
                    }
                } else {
                    result.proxy_url = None;
                }
            }
            "no_proxy" => {
                if let Some(raw_no_proxy) = parse_scalar(value) {
                    match validate_no_proxy(&raw_no_proxy) {
                        Ok(valid) => result.no_proxy = (!valid.is_empty()).then_some(valid),
                        Err(err) if strict => return Err(err),
                        Err(_) => {}
                    }
                } else {
                    result.no_proxy = None;
                }
            }
            "env" => {
                let rest = value.trim();
                if rest.is_empty() {
                    in_env_block = true;
                } else if rest == "{}" || rest == "null" || rest == "~" {
                    result.env.clear();
                } else if strict {
                    return Err(Error::Feature(
                        "syntax".into(),
                        format!("env 字段请使用多行缩进键值对:{}", index + 1),
                    ));
                }
            }
            _ => {}
        }
    }
    if let Some(effort) = result.default_effort.as_deref()
        && !ALLOWED_EFFORTS.contains(&effort)
    {
        return Err(Error::Feature(
            "invalid_config".into(),
            "默认推理强度无效".into(),
        ));
    }
    if target.model.is_none()
        && let Some(model) = result.default_model.as_deref()
        && (model.trim().is_empty()
            || model.chars().count() > 300
            || model.contains(['\r', '\n', '\0']))
    {
        return Err(Error::Feature(
            "invalid_config".into(),
            "默认模型无效".into(),
        ));
    }
    Ok(result)
}

fn stringify(overrides: &AccountOverrides) -> String {
    let mut out = String::new();
    if let Some(model) = overrides.default_model.as_deref() {
        out.push_str("default_model: ");
        out.push_str(&quote(model));
        out.push('\n');
    }
    if let Some(effort) = overrides.default_effort.as_deref() {
        out.push_str("default_effort: ");
        out.push_str(&quote(effort));
        out.push('\n');
    }
    if let Some(proxy_url) = overrides.proxy_url.as_deref() {
        out.push_str("proxy_url: ");
        out.push_str(&quote(proxy_url));
        out.push('\n');
    }
    if let Some(no_proxy) = overrides.no_proxy.as_deref() {
        out.push_str("no_proxy: ");
        out.push_str(&quote(no_proxy));
        out.push('\n');
    }
    if !overrides.env.is_empty() {
        out.push_str("env:\n");
        for (key, value) in &overrides.env {
            out.push_str("  ");
            out.push_str(key);
            out.push_str(": ");
            out.push_str(&quote(value));
            out.push('\n');
        }
    }
    out
}

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn read_file(path: &Path) -> Result<Option<String>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(Error::Feature("storage".into(), "读取配置文档失败".into()));
        }
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() as usize > MAX_BYTES
    {
        return Err(Error::Feature(
            "forbidden".into(),
            "配置文档不允许链接或非普通文件".into(),
        ));
    }
    let content = fs::read_to_string(path)
        .map_err(|_| Error::Feature("storage".into(), "读取配置文档失败".into()))?;
    if content.len() > MAX_BYTES {
        return Err(Error::Feature(
            "limit_exceeded".into(),
            "配置文档超过大小限制".into(),
        ));
    }
    Ok(Some(content))
}

fn ensure_root(root: &Path) -> Result<()> {
    fs::create_dir_all(root)?;
    #[cfg(unix)]
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::Feature(
            "forbidden".into(),
            "账号配置目录不允许符号链接".into(),
        ));
    }
    Ok(())
}

fn write_atomic(root: &Path, file: &Path, content: &str) -> Result<()> {
    let temporary = root.join(format!(".prospero-config-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut opened = options.open(&temporary)?;
        opened.write_all(content.as_bytes())?;
        opened.sync_all()?;
        drop(opened);
        fs::rename(&temporary, file)?;
        #[cfg(unix)]
        fs::set_permissions(file, fs::Permissions::from_mode(0o600))?;
        #[cfg(unix)]
        {
            let directory = fs::File::open(root)?;
            directory.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn supported_efforts(
    target: &ConfigTarget,
    overrides: &AccountOverrides,
    catalog: Option<&crate::agent::LaunchModelCatalog>,
) -> Vec<String> {
    if target
        .model_capabilities
        .as_ref()
        .and_then(|caps| caps.reasoning)
        == Some(false)
    {
        return Vec::new();
    }
    let values = if target.model.is_some() {
        target
            .model_capabilities
            .as_ref()
            .and_then(|caps| caps.supported_efforts.clone())
            .unwrap_or_default()
    } else {
        let model = overrides
            .default_model
            .as_ref()
            .or(catalog.and_then(|catalog| catalog.current_model.as_ref()));
        catalog
            .and_then(|catalog| {
                model
                    .and_then(|model| catalog.models.iter().find(|entry| entry.id == *model))
                    .or_else(|| catalog.models.iter().find(|entry| entry.is_default))
            })
            .map(|entry| entry.supported_efforts.clone())
            .unwrap_or_default()
    };
    let mut result = Vec::new();
    for value in values {
        if CLAUDE_EFFORTS.contains(&value.as_str()) && !result.contains(&value) {
            result.push(value);
        }
    }
    result
}

pub(crate) fn read_defaults(
    data: &Path,
    target: &ConfigTarget,
) -> Result<(Option<String>, Option<String>)> {
    let root = managed::account_root(data, &target.account_id)?;
    let file = file_path(&root);
    let original = read_file(&file)?.unwrap_or_default();
    let overrides = parse(&original, target, false)?;
    Ok((overrides.default_model, overrides.default_effort))
}

/// Returns environment variable overrides (`HTTPS_PROXY`, `HTTP_PROXY`,
/// `ALL_PROXY`, `NO_PROXY`, plus custom `env` pairs) configured for an account.
pub(crate) fn read_runtime_environment(
    data: &Path,
    account_id: &str,
) -> Result<Vec<(String, String)>> {
    let root = managed::account_root(data, account_id)?;
    let file = file_path(&root);
    let Some(original) = read_file(&file)? else {
        return Ok(Vec::new());
    };
    let target = ConfigTarget {
        account_id: account_id.to_owned(),
        model: None,
        model_capabilities: None,
        active_sessions: 0,
    };
    let overrides = parse(&original, &target, false)?;
    let mut env = Vec::new();
    if let Some(proxy) = overrides.proxy_url {
        env.push(("HTTPS_PROXY".into(), proxy.clone()));
        env.push(("HTTP_PROXY".into(), proxy.clone()));
        env.push(("ALL_PROXY".into(), proxy.clone()));
        env.push(("https_proxy".into(), proxy.clone()));
        env.push(("http_proxy".into(), proxy.clone()));
        env.push(("all_proxy".into(), proxy));
    }
    if let Some(no_proxy) = overrides.no_proxy {
        env.push(("NO_PROXY".into(), no_proxy.clone()));
        env.push(("no_proxy".into(), no_proxy));
    }
    for (key, value) in overrides.env {
        env.push((key, value));
    }
    Ok(env)
}

/// Summarizes active proxy and custom environment overrides for UI display
/// without exposing credentials or values.
pub(crate) fn read_override_summary(data: &Path, account_id: &str) -> Option<String> {
    let root = managed::account_root(data, account_id).ok()?;
    let file = file_path(&root);
    let original = read_file(&file).ok()??;
    let target = ConfigTarget {
        account_id: account_id.to_owned(),
        model: None,
        model_capabilities: None,
        active_sessions: 0,
    };
    let overrides = parse(&original, &target, false).ok()?;
    let mut parts = Vec::new();
    if let Some(proxy) = overrides.proxy_url.as_deref() {
        let display = url::Url::parse(proxy)
            .ok()
            .and_then(|parsed| {
                let host = parsed.host_str()?;
                Some(match parsed.port() {
                    Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
                    None => format!("{}://{host}", parsed.scheme()),
                })
            })
            .unwrap_or_else(|| "已配置".into());
        parts.push(format!("代理: {display}"));
    }
    if !overrides.env.is_empty() {
        parts.push(format!("ENV: {} 项", overrides.env.len()));
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

pub(crate) fn get_config(
    data: &Path,
    target: ConfigTarget,
    catalog: Option<&crate::agent::LaunchModelCatalog>,
) -> Result<AgentAccountConfig> {
    let root = managed::account_root(data, &target.account_id)?;
    let file = file_path(&root);
    let original = read_file(&file)?.unwrap_or_default();
    let overrides = parse(&original, &target, false)?;
    let content = stringify(&overrides);
    let efforts = supported_efforts(&target, &overrides, catalog);
    Ok(AgentAccountConfig {
        account_id: target.account_id,
        documents: vec![AccountConfigDocument {
            id: document_id().into(),
            label: "Prospero overrides".into(),
            format: "yaml".into(),
            content,
            revision: hash(&original),
            writable: true,
            generated: false,
            editable_keys: if target.model.is_some() {
                vec!["default_effort".into()]
            } else {
                vec![
                    "default_model".into(),
                    "default_effort".into(),
                    "proxy_url".into(),
                    "no_proxy".into(),
                    "env".into(),
                ]
            },
        }],
        default_effort: overrides.default_effort,
        default_model: overrides.default_model,
        proxy_url: overrides.proxy_url,
        no_proxy: overrides.no_proxy,
        env: (!overrides.env.is_empty()).then_some(overrides.env),
        supported_efforts: efforts,
        applies_to: "new_sessions".into(),
        active_sessions: target.active_sessions,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn save_config(
    data: &Path,
    target: ConfigTarget,
    document_id: &str,
    revision: &str,
    content: Option<&str>,
    default_effort: Option<Option<String>>,
    proxy_url: Option<Option<String>>,
    no_proxy: Option<Option<String>>,
    env: Option<Option<BTreeMap<String, String>>>,
    catalog: Option<&crate::agent::LaunchModelCatalog>,
) -> Result<AgentAccountConfig> {
    if document_id != self::document_id() {
        return Err(Error::Feature(
            "forbidden".into(),
            "此账号不支持该配置文档".into(),
        ));
    }
    if content.is_none()
        && default_effort.is_none()
        && proxy_url.is_none()
        && no_proxy.is_none()
        && env.is_none()
    {
        return Err(Error::Feature(
            "invalid_request".into(),
            "没有需要保存的配置".into(),
        ));
    }
    if target.model.is_some() && (proxy_url.is_some() || no_proxy.is_some() || env.is_some()) {
        return Err(Error::Feature(
            "invalid_config".into(),
            "API 模型源账号请通过模型源端点与请求头配置连接".into(),
        ));
    }
    let root = managed::account_root(data, &target.account_id)?;
    ensure_root(&root)?;
    let file = file_path(&root);
    let previous = read_file(&file)?.unwrap_or_default();
    if hash(&previous) != revision {
        return Err(Error::Feature(
            "conflict".into(),
            "配置已被其它操作修改，请重新加载后保存".into(),
        ));
    }
    let mut next = parse(content.unwrap_or(&previous), &target, true)?;
    match default_effort {
        Some(Some(effort)) => {
            if !ALLOWED_EFFORTS.contains(&effort.as_str()) {
                return Err(Error::Feature(
                    "invalid_config".into(),
                    "默认推理强度无效".into(),
                ));
            }
            next.default_effort = Some(effort);
        }
        Some(None) => next.default_effort = None,
        None => {}
    }
    match proxy_url {
        Some(Some(raw)) if !raw.trim().is_empty() => {
            next.proxy_url = Some(validate_proxy_url(&raw)?);
        }
        Some(_) => next.proxy_url = None,
        None => {}
    }
    match no_proxy {
        Some(Some(raw)) if !raw.trim().is_empty() => {
            next.no_proxy = Some(validate_no_proxy(&raw)?);
        }
        Some(_) => next.no_proxy = None,
        None => {}
    }
    match env {
        Some(Some(entries)) => {
            if entries.len() > MAX_ENV_ENTRIES {
                return Err(Error::Feature(
                    "limit_exceeded".into(),
                    "自定义环境变量数量超过上限（最多 64 项）".into(),
                ));
            }
            let mut validated = BTreeMap::new();
            for (k, v) in entries {
                let (clean_k, clean_v) = validate_env_entry(&k, &v)?;
                validated.insert(clean_k, clean_v);
            }
            next.env = validated;
        }
        Some(None) => next.env.clear(),
        None => {}
    }
    if next.default_effort.is_some() && target.model.is_none() && next.default_model.is_none() {
        if let Some(model) = catalog.and_then(|catalog| catalog.current_model.clone()) {
            next.default_model = Some(model);
        } else if let Some(model) = catalog.and_then(|catalog| {
            catalog
                .models
                .iter()
                .find(|entry| entry.is_default)
                .map(|entry| entry.id.clone())
        }) {
            next.default_model = Some(model);
        }
    }
    if let Some(default_model) = next.default_model.as_deref()
        && !catalog
            .is_some_and(|catalog| catalog.models.iter().any(|model| model.id == default_model))
    {
        return Err(Error::Feature(
            "invalid_config".into(),
            "默认模型不在当前账号的可用模型目录中".into(),
        ));
    }
    if let Some(default_effort) = next.default_effort.as_deref()
        && !supported_efforts(&target, &next, catalog)
            .iter()
            .any(|effort| effort == default_effort)
    {
        return Err(Error::Feature(
            "invalid_config".into(),
            "所选模型尚未声明支持此推理强度，请使用模型默认值或更新模型能力".into(),
        ));
    }
    let contents = stringify(&next);
    write_atomic(&root, &file, &contents)?;
    get_config(data, target, catalog)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_writes_overrides() {
        let target = ConfigTarget {
            account_id: "a".into(),
            model: None,
            model_capabilities: None,
            active_sessions: 0,
        };
        let parsed = parse(
            "default_model: sonnet\ndefault_effort: high\nproxy_url: \"http://127.0.0.1:7890\"\nno_proxy: \"localhost,127.0.0.1\"\nenv:\n  CUSTOM_REGION: \"us-east-1\"\n",
            &target,
            true,
        )
        .unwrap();
        assert_eq!(parsed.default_model.as_deref(), Some("sonnet"));
        assert_eq!(parsed.default_effort.as_deref(), Some("high"));
        assert_eq!(parsed.proxy_url.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(parsed.no_proxy.as_deref(), Some("localhost,127.0.0.1"));
        assert_eq!(
            parsed.env.get("CUSTOM_REGION").map(String::as_str),
            Some("us-east-1")
        );
        let roundtrip = parse(&stringify(&parsed), &target, true).unwrap();
        assert_eq!(roundtrip, parsed);
        assert!(parse("danger: true\n", &target, true).is_err());
        assert!(parse("proxy_url: ftp://127.0.0.1:21\n", &target, true).is_err());
        assert!(parse("env:\n  PATH: /tmp\n", &target, true).is_err());
    }
}
