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
const ALLOWED_EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const CLAUDE_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

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
        Some(text[1..text.len().saturating_sub(1)].to_owned())
    } else {
        Some(text.to_owned())
    }
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
    for (index, raw) in content.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            return Err(Error::Feature(
                "syntax".into(),
                format!("YAML 语法错误:{}", index + 1),
            ));
        };
        let key = key.trim();
        if key != "default_model" && key != "default_effort" {
            if strict {
                return Err(Error::Feature(
                    "invalid_config".into(),
                    "配置包含不允许编辑的字段；凭据、环境变量与执行设置不能写入此文档".into(),
                ));
            }
            continue;
        }
        if target.model.is_some() && key == "default_model" && strict {
            return Err(Error::Feature(
                "invalid_config".into(),
                "配置包含不允许编辑的字段；凭据、环境变量与执行设置不能写入此文档".into(),
            ));
        }
        match key {
            "default_model" => result.default_model = parse_scalar(value),
            "default_effort" => result.default_effort = parse_scalar(value),
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
                vec!["default_model".into(), "default_effort".into()]
            },
        }],
        default_effort: overrides.default_effort,
        default_model: overrides.default_model,
        supported_efforts: efforts,
        applies_to: "new_sessions".into(),
        active_sessions: target.active_sessions,
    })
}

pub(crate) fn save_config(
    data: &Path,
    target: ConfigTarget,
    document_id: &str,
    revision: &str,
    content: Option<&str>,
    default_effort: Option<Option<String>>,
    catalog: Option<&crate::agent::LaunchModelCatalog>,
) -> Result<AgentAccountConfig> {
    if document_id != self::document_id() {
        return Err(Error::Feature(
            "forbidden".into(),
            "此账号不支持该配置文档".into(),
        ));
    }
    if content.is_none() && default_effort.is_none() {
        return Err(Error::Feature(
            "invalid_request".into(),
            "没有需要保存的配置".into(),
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
        Some(Some(effort)) => next.default_effort = Some(effort),
        Some(None) => next.default_effort = None,
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
            "default_model: sonnet\ndefault_effort: high\n",
            &target,
            true,
        )
        .unwrap();
        assert_eq!(parsed.default_model.as_deref(), Some("sonnet"));
        assert_eq!(parsed.default_effort.as_deref(), Some("high"));
        assert!(parse("danger: true\n", &target, true).is_err());
    }
}
