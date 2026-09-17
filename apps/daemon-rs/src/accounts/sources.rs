use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use super::profile::{ApiProfile, clean_headers};
use crate::error::{Error, Result};
use crate::protocol::AgentKind;

const MAX_REGISTRY_BYTES: usize = 8 * 1024 * 1024;
const MAX_SOURCES: usize = 100;
const MAX_CREDENTIALS: usize = 10_000;
const MAX_BINDINGS: usize = 10_000;
const MAX_SOURCE_CREDENTIALS: usize = 32;
const MAX_ROUTES: usize = 500;
const MAX_ENDPOINTS: usize = 3;
const MAX_NAME: usize = 80;
const MAX_CREATIONS: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
enum FileSignature {
    Absent,
    Present {
        dev: u64,
        ino: u64,
        len: u64,
        mtime_nsec: i128,
        ctime_nsec: i128,
        sha256: String,
    },
}

fn file_signature(path: &Path) -> Result<FileSignature> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileSignature::Absent);
        }
        Err(_) => return Err(Error::Invalid("模型源存储无法读取，原文件已保留".into())),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(Error::Invalid("模型源存储文件不安全".into()));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(Error::Invalid("模型源存储文件不安全".into()));
    }
    if metadata.len() as usize > MAX_REGISTRY_BYTES {
        return Err(Error::Invalid("模型源文件过大".into()));
    }
    let body =
        fs::read(path).map_err(|_| Error::Invalid("模型源存储无法读取，原文件已保留".into()))?;
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(&body);
    Ok(FileSignature::Present {
        dev: metadata.dev(),
        ino: metadata.ino(),
        len: metadata.len(),
        mtime_nsec: metadata.mtime() as i128 * 1_000_000_000 + metadata.mtime_nsec() as i128,
        ctime_nsec: metadata.ctime() as i128 * 1_000_000_000 + metadata.ctime_nsec() as i128,
        sha256: hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    })
}

fn ensure_private_root(root: &Path) -> Result<()> {
    fs::create_dir_all(root)?;
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::Invalid("模型源目录不安全".into()));
    }
    Ok(())
}

fn sync_directory(root: &Path) -> Result<()> {
    fs::File::open(root)?.sync_all()?;
    Ok(())
}

pub(crate) fn validate_source_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.chars().count() > 100
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(Error::Invalid("模型源 ID 无效".into()));
    }
    Ok(())
}

fn clean_name(value: &str) -> Result<String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME || name.chars().any(char::is_control) {
        return Err(Error::Invalid("模型源名称应为 1–80 个字符".into()));
    }
    Ok(name.to_owned())
}

fn clean_secret(value: &str) -> Result<String> {
    let secret = value.trim();
    if secret.is_empty() || secret.len() > 8192 || secret.contains(char::is_control) {
        return Err(Error::Invalid("API Key 格式无效".into()));
    }
    Ok(secret.to_owned())
}

fn clean_model(value: &str) -> Result<String> {
    let model = value.trim();
    if model.is_empty() || model.chars().count() > 300 || model.chars().any(char::is_control) {
        return Err(Error::Invalid("模型名称格式无效".into()));
    }
    Ok(model.to_owned())
}
fn supported_protocol(protocol: &str) -> bool {
    matches!(
        protocol,
        "anthropic" | "openai_responses" | "openai_chat_completions"
    )
}

fn agent_for_protocol(protocol: &str) -> &'static str {
    match protocol {
        "anthropic" => "claude",
        _ => "codex",
    }
}

fn provider_for_protocol(protocol: &str) -> &'static str {
    if protocol == "anthropic" {
        "anthropic_compatible"
    } else {
        "openai_compatible"
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct ModelSource {
    pub id: String,
    pub name: String,
    #[ts(type = "number")]
    pub revision: i64,
    pub enabled: bool,
    pub endpoints: Vec<SourceEndpoint>,
    pub credentials: Vec<SourceCredentialInfo>,
    pub routes: Vec<SourceRoute>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_route_id: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct SourceEndpoint {
    pub protocol: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct SourceCredentialInfo {
    pub id: String,
    pub name: String,
    #[ts(type = "number")]
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct SourceRoute {
    pub id: String,
    pub name: String,
    pub model: String,
    pub protocol: String,
    #[serde(rename = "credentialId")]
    pub credential_id: String,
    pub enabled: bool,
    #[serde(
        rename = "modelCapabilities",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub model_capabilities: Option<super::ModelCapabilities>,
    #[serde(
        rename = "defaultEffort",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub default_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SourceBindingView {
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "routeId")]
    pub route_id: String,
    #[ts(type = "number")]
    pub revision: i64,
    pub source_name: String,
    pub route_name: String,
    pub legacy: bool,
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialRecord {
    source_id: String,
    id: String,
    revision: i64,
    secret: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BindingRecord {
    account_id: String,
    source_id: String,
    route_id: String,
    revision: i64,
    source_name: String,
    route_name: String,
    legacy: bool,
    credential_id: String,
    credential_revision: i64,
    profile: ApiProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreationReceipt {
    operation_id: String,
    source_id: String,
    fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    version: u32,
    sources: Vec<ModelSource>,
    credentials: Vec<CredentialRecord>,
    bindings: Vec<BindingRecord>,
    #[serde(default)]
    creations: Vec<CreationReceipt>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SourceMigrationAccount {
    pub id: String,
    pub name: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SourceMigration {
    pub id: String,
    pub name: String,
    pub protocol: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[ts(type = "number")]
    pub credential_count: i64,
    pub accounts: Vec<SourceMigrationAccount>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SourceResult {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<ModelSource>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<crate::accounts::models::CatalogModel>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrations: Option<Vec<SourceMigration>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub skipped_accounts: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accounts: Option<Vec<super::NativeAccount>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<crate::accounts::models::FeatureError>,
}

impl SourceResult {
    pub(crate) fn success(request_id: &str) -> Self {
        Self {
            kind: "model.source.result".into(),
            request_id: request_id.chars().take(100).collect(),
            ok: true,
            sources: None,
            models: None,
            migrations: None,
            skipped_accounts: None,
            account_id: None,
            accounts: None,
            error: None,
        }
    }

    pub(crate) fn failure(request_id: &str, error: crate::accounts::models::FeatureError) -> Self {
        Self {
            ok: false,
            error: Some(error),
            ..Self::success(request_id)
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceControl {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub action: SourceAction,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind")]
pub(crate) enum SourceAction {
    #[serde(rename = "list")]
    List,
    #[serde(rename = "create")]
    Create {
        #[serde(rename = "operationId")]
        operation_id: Option<String>,
        name: String,
        endpoints: Vec<SourceEndpointInput>,
        credential: CredentialInput,
        routes: Option<Vec<RouteInput>>,
    },
    #[serde(rename = "update")]
    Update {
        #[serde(rename = "sourceId")]
        source_id: String,
        revision: i64,
        name: Option<String>,
        enabled: Option<bool>,
        endpoints: Option<Vec<SourceEndpointInput>>,
        #[serde(rename = "defaultRouteId")]
        default_route_id: Option<String>,
    },
    #[serde(rename = "credential.set")]
    CredentialSet {
        #[serde(rename = "sourceId")]
        source_id: String,
        revision: i64,
        #[serde(rename = "credentialId")]
        credential_id: Option<String>,
        name: String,
        #[serde(rename = "apiKey")]
        api_key: Option<String>,
    },
    #[serde(rename = "credential.remove")]
    CredentialRemove {
        #[serde(rename = "sourceId")]
        source_id: String,
        revision: i64,
        #[serde(rename = "credentialId")]
        credential_id: String,
    },
    #[serde(rename = "routes.set")]
    RoutesSet {
        #[serde(rename = "sourceId")]
        source_id: String,
        revision: i64,
        routes: Vec<RouteInputWithId>,
    },
    #[serde(rename = "route.remove")]
    RouteRemove {
        #[serde(rename = "sourceId")]
        source_id: String,
        revision: i64,
        #[serde(rename = "routeId")]
        route_id: String,
    },
    #[serde(rename = "delete")]
    Delete {
        #[serde(rename = "sourceId")]
        source_id: String,
        revision: i64,
    },
    #[serde(rename = "models")]
    Models {
        #[serde(rename = "sourceId")]
        source_id: String,
        revision: i64,
        protocol: String,
        #[serde(rename = "credentialId")]
        credential_id: String,
        #[serde(rename = "refresh")]
        _refresh: Option<bool>,
    },
    #[serde(rename = "bind")]
    Bind {
        #[serde(rename = "sourceId")]
        source_id: String,
        #[serde(rename = "routeId")]
        route_id: String,
        revision: i64,
        agent: Option<AgentKind>,
    },
    #[serde(rename = "migration.preview")]
    MigrationPreview,
    #[serde(rename = "migration.apply")]
    MigrationApply {
        #[serde(rename = "migrationId")]
        migration_id: String,
        name: String,
        target: Option<TargetInput>,
    },
    #[serde(rename = "migration.rollback")]
    MigrationRollback {
        #[serde(rename = "accountIds")]
        account_ids: Vec<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEndpointInput {
    protocol: String,
    #[serde(rename = "baseUrl")]
    base_url: String,
    headers: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialInput {
    name: String,
    #[serde(rename = "apiKey")]
    api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouteInput {
    name: String,
    model: String,
    protocol: String,
    enabled: bool,
    #[serde(rename = "modelCapabilities")]
    model_capabilities: Option<serde_json::Value>,
    #[serde(rename = "defaultEffort")]
    default_effort: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouteInputWithId {
    id: Option<String>,
    name: String,
    model: String,
    protocol: String,
    #[serde(rename = "credentialId")]
    credential_id: String,
    enabled: bool,
    #[serde(rename = "modelCapabilities")]
    model_capabilities: Option<serde_json::Value>,
    #[serde(rename = "defaultEffort")]
    default_effort: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TargetInput {
    #[serde(rename = "sourceId")]
    _source_id: String,
    #[serde(rename = "revision")]
    _revision: i64,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct MigrationEntry {
    pub account_id: String,
    pub name: String,
    pub profile: ApiProfile,
    pub secret: String,
    pub default_effort: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct BoundRoute {
    pub profile: ApiProfile,
    pub account_name: String,
    pub credential_id: String,
    pub credential_revision: i64,
    pub secret: String,
}

pub struct ModelSources {
    root: PathBuf,
    file: PathBuf,
    registry: Registry,
    disk_signature: FileSignature,
}

impl ModelSources {
    pub(crate) fn open(data: &Path) -> Result<Self> {
        let root = data.join("model-sources");
        let file = root.join(".registry.json");
        let disk_signature = file_signature(&file)?;
        let registry = match &disk_signature {
            FileSignature::Present { .. } => {
                let raw = fs::read_to_string(&file)
                    .map_err(|_| Error::Invalid("模型源存储无法读取，原文件已保留".into()))?;
                serde_json::from_str::<Registry>(&raw)
                    .map_err(|_| Error::Invalid("模型源存储无法读取，原文件已保留".into()))?
            }
            FileSignature::Absent => Registry::empty(),
        };
        let sources = Self {
            root,
            file,
            registry,
            disk_signature,
        };
        sources.validate()?;
        Ok(sources)
    }

    pub(crate) fn list(&self) -> Vec<ModelSource> {
        self.registry.sources.clone()
    }

    #[allow(dead_code)]
    pub(crate) fn bound_account_ids(&self) -> Vec<String> {
        self.registry
            .bindings
            .iter()
            .map(|binding| binding.account_id.clone())
            .collect()
    }

    pub(crate) fn binding_view(&self, account_id: &str) -> Option<SourceBindingView> {
        let binding = self
            .registry
            .bindings
            .iter()
            .find(|binding| binding.account_id == account_id)?;
        let current = self
            .registry
            .sources
            .iter()
            .find(|source| source.id == binding.source_id)
            .is_some_and(|source| source.revision == binding.revision);
        Some(SourceBindingView {
            source_id: binding.source_id.clone(),
            route_id: binding.route_id.clone(),
            revision: binding.revision,
            source_name: binding.source_name.clone(),
            route_name: binding.route_name.clone(),
            legacy: binding.legacy,
            current,
        })
    }

    #[allow(dead_code)]
    pub(crate) fn allows_new_sessions(&self, account_id: &str) -> bool {
        let Some(binding) = self
            .registry
            .bindings
            .iter()
            .find(|binding| binding.account_id == account_id)
        else {
            return true;
        };
        let Some(source) = self
            .registry
            .sources
            .iter()
            .find(|source| source.id == binding.source_id)
        else {
            return false;
        };
        let Some(route) = source
            .routes
            .iter()
            .find(|route| route.id == binding.route_id)
        else {
            return false;
        };
        source.enabled
            && route.enabled
            && route
                .model_capabilities
                .as_ref()
                .map(|caps| caps.tools != Some(false))
                .unwrap_or(true)
    }

    fn save(&mut self) -> Result<()> {
        self.validate()?;
        let body = serde_json::to_vec(&self.registry)?;
        if body.len() > MAX_REGISTRY_BYTES {
            return Err(Error::Invalid("模型源存储空间已达上限".into()));
        }
        ensure_private_root(&self.root)?;
        if file_signature(&self.file)? != self.disk_signature {
            return Err(Error::Conflict);
        }
        let temporary = self.root.join(format!(".registry.{}.tmp", Uuid::new_v4()));
        let write_result = (|| -> Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&body)?;
            file.sync_all()?;
            drop(file);
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
            if file_signature(&self.file)? != self.disk_signature {
                return Err(Error::Conflict);
            }
            fs::rename(&temporary, &self.file)?;
            sync_directory(&self.root)?;
            Ok(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        write_result?;
        self.disk_signature = file_signature(&self.file)?;
        Ok(())
    }

    fn source_index(&self, id: &str) -> Result<usize> {
        self.registry
            .sources
            .iter()
            .position(|source| source.id == id)
            .ok_or_else(|| Error::NotFound)
    }

    fn require_source(&self, id: &str, revision: i64) -> Result<&ModelSource> {
        let source = &self.registry.sources[self.source_index(id)?];
        if source.revision != revision {
            return Err(Error::Conflict);
        }
        Ok(source)
    }

    fn credential_secret(
        &self,
        source_id: &str,
        credential_id: &str,
        revision: i64,
    ) -> Result<&str> {
        self.registry
            .credentials
            .iter()
            .find(|credential| {
                credential.source_id == source_id
                    && credential.id == credential_id
                    && credential.revision == revision
            })
            .map(|credential| credential.secret.as_str())
            .ok_or_else(|| Error::Invalid("模型源凭据缺失，已停止连接".into()))
    }

    fn resolve_route(&self, source_id: &str, route_id: &str, revision: i64) -> Result<BoundRoute> {
        let source = self.require_source(source_id, revision)?;
        let route = source
            .routes
            .iter()
            .find(|route| route.id == route_id)
            .ok_or(Error::NotFound)?;
        if !source.enabled || !route.enabled {
            return Err(Error::Invalid("模型源或模型已停用".into()));
        }
        let endpoint = source
            .endpoints
            .iter()
            .find(|endpoint| endpoint.protocol == route.protocol)
            .ok_or_else(|| Error::Invalid("模型协议缺少连接地址".into()))?;
        let info = source
            .credentials
            .iter()
            .find(|credential| credential.id == route.credential_id)
            .ok_or_else(|| Error::Invalid("模型凭据不存在".into()))?;
        let secret = self.credential_secret(source_id, &info.id, info.revision)?;
        let profile = route_profile(endpoint, route)?;
        Ok(BoundRoute {
            profile,
            account_name: format!("{} / {}", source.name, route.name),
            credential_id: info.id.clone(),
            credential_revision: info.revision,
            secret: secret.to_owned(),
        })
    }

    #[allow(dead_code)]
    pub(crate) fn binding_secret(
        &self,
        account_id: &str,
        account_profile: &ApiProfile,
    ) -> Result<String> {
        let binding = self
            .registry
            .bindings
            .iter()
            .find(|binding| binding.account_id == account_id)
            .ok_or(Error::NotFound)?;
        if binding.profile != *account_profile {
            return Err(Error::Invalid("模型源绑定与账号不一致".into()));
        }
        let secret = self.credential_secret(
            &binding.source_id,
            &binding.credential_id,
            binding.credential_revision,
        )?;
        Ok(secret.to_owned())
    }

    #[allow(dead_code)]
    pub(crate) fn is_bound(&self, account_id: &str) -> bool {
        self.registry
            .bindings
            .iter()
            .any(|binding| binding.account_id == account_id)
    }

    pub(crate) fn create(&mut self, action: SourceAction) -> Result<ModelSource> {
        let SourceAction::Create {
            operation_id,
            name,
            endpoints,
            credential,
            routes,
        } = action
        else {
            return Err(Error::Invalid("unsupported model source action".into()));
        };
        let routes = routes.unwrap_or_default();
        let endpoints = clean_endpoints(endpoints)?;
        let name = clean_name(&name)?;
        let credential_name = clean_name(&credential.name)?;
        let secret = clean_secret(&credential.api_key)?;
        let fingerprint =
            create_fingerprint(&name, &endpoints, &credential_name, &secret, &routes)?;
        if let Some(operation_id) = &operation_id {
            validate_source_id(operation_id)?;
            if let Some(receipt) = self
                .registry
                .creations
                .iter()
                .find(|receipt| receipt.operation_id == *operation_id)
            {
                if receipt.fingerprint != fingerprint
                    || !self
                        .registry
                        .sources
                        .iter()
                        .any(|source| source.id == receipt.source_id)
                {
                    return Err(Error::Conflict);
                }
                let id = receipt.source_id.clone();
                return self
                    .registry
                    .sources
                    .iter()
                    .find(|source| source.id == id)
                    .cloned()
                    .ok_or(Error::NotFound);
            }
        }
        if self.registry.sources.len() >= MAX_SOURCES {
            return Err(Error::Invalid("模型源数量已达上限".into()));
        }
        let id = Uuid::new_v4().to_string();
        let credential_id = Uuid::new_v4().to_string();
        let timestamp = crate::database::now();
        let built_routes = build_initial_routes(routes, &credential_id)?;
        let default_route_id = built_routes.first().map(|route| route.id.clone());
        let source = ModelSource {
            id: id.clone(),
            name,
            revision: 1,
            enabled: true,
            endpoints,
            credentials: vec![SourceCredentialInfo {
                id: credential_id.clone(),
                name: credential_name.clone(),
                revision: 1,
            }],
            routes: built_routes,
            default_route_id,
            created_at: timestamp,
            updated_at: timestamp,
        };
        self.registry.credentials.push(CredentialRecord {
            source_id: id.clone(),
            id: credential_id,
            revision: 1,
            secret,
        });
        if let Some(operation_id) = operation_id
            && self.registry.creations.len() < MAX_CREATIONS
        {
            self.registry.creations.push(CreationReceipt {
                operation_id,
                source_id: id.clone(),
                fingerprint,
            });
        }
        self.registry.sources.push(source.clone());
        self.save()?;
        Ok(source)
    }

    pub(crate) fn change(
        &mut self,
        action: SourceAction,
        known_accounts: &std::collections::HashSet<String>,
    ) -> Result<ModelSource> {
        let (source_id, revision) = action_ref(&action)?;
        let index = self.source_index(&source_id)?;
        if self.registry.sources[index].revision != revision {
            return Err(Error::Conflict);
        }
        match action {
            SourceAction::Update {
                name,
                enabled,
                endpoints,
                default_route_id,
                ..
            } => {
                if let Some(name) = name {
                    self.registry.sources[index].name = clean_name(&name)?;
                }
                if let Some(enabled) = enabled {
                    self.registry.sources[index].enabled = enabled;
                }
                if let Some(endpoints) = endpoints {
                    self.registry.sources[index].endpoints = clean_endpoints(endpoints)?;
                }
                if let Some(route_id) = default_route_id {
                    validate_source_id(&route_id)?;
                    if !self.registry.sources[index]
                        .routes
                        .iter()
                        .any(|route| route.id == route_id)
                    {
                        return Err(Error::NotFound);
                    }
                    self.registry.sources[index].default_route_id = Some(route_id);
                }
            }
            SourceAction::CredentialSet {
                credential_id,
                name,
                api_key,
                ..
            } => {
                let target = credential_id
                    .as_deref()
                    .map(|id| {
                        self.registry.sources[index]
                            .credentials
                            .iter()
                            .position(|credential| credential.id == id)
                            .ok_or(Error::NotFound)
                    })
                    .transpose()?;
                if target.is_none() && api_key.is_none() {
                    return Err(Error::Invalid("新增凭据需要 API Key".into()));
                }
                let name = clean_name(&name)?;
                match target {
                    Some(position) => {
                        let id = self.registry.sources[index].credentials[position]
                            .id
                            .clone();
                        self.registry.sources[index].credentials[position].name = name;
                        if let Some(raw) = api_key {
                            let secret = clean_secret(&raw)?;
                            let next_revision =
                                self.registry.sources[index].credentials[position].revision + 1;
                            self.registry.sources[index].credentials[position].revision =
                                next_revision;
                            self.registry.credentials.push(CredentialRecord {
                                source_id: source_id.clone(),
                                id,
                                revision: next_revision,
                                secret,
                            });
                        }
                    }
                    None => {
                        if self.registry.sources[index].credentials.len() >= MAX_SOURCE_CREDENTIALS
                        {
                            return Err(Error::Invalid("模型源最多支持 32 组凭据".into()));
                        }
                        let id = Uuid::new_v4().to_string();
                        let secret = clean_secret(api_key.as_deref().unwrap_or(""))?;
                        self.registry.sources[index]
                            .credentials
                            .push(SourceCredentialInfo {
                                id: id.clone(),
                                name,
                                revision: 1,
                            });
                        self.registry.credentials.push(CredentialRecord {
                            source_id: source_id.clone(),
                            id,
                            revision: 1,
                            secret,
                        });
                    }
                }
            }
            SourceAction::CredentialRemove { credential_id, .. } => {
                if self.registry.sources[index]
                    .routes
                    .iter()
                    .any(|route| route.credential_id == credential_id)
                {
                    return Err(Error::InUse);
                }
                if !self.registry.sources[index]
                    .credentials
                    .iter()
                    .any(|credential| credential.id == credential_id)
                {
                    return Err(Error::NotFound);
                }
                self.registry.sources[index]
                    .credentials
                    .retain(|credential| credential.id != credential_id);
                self.registry.credentials.retain(|record| {
                    !(record.source_id == source_id && record.id == credential_id)
                });
            }
            SourceAction::RoutesSet { routes, .. } => {
                for input in routes {
                    if let Some(id) = &input.id
                        && !self.registry.sources[index]
                            .routes
                            .iter()
                            .any(|route| route.id == *id)
                    {
                        return Err(Error::NotFound);
                    }
                    let route = build_route(&input)?;
                    self.registry.sources[index]
                        .routes
                        .retain(|existing| existing.id != route.id);
                    self.registry.sources[index].routes.push(route.clone());
                    if self.registry.sources[index].default_route_id.is_none() {
                        self.registry.sources[index].default_route_id = Some(route.id);
                    }
                    if self.registry.sources[index].routes.len() > MAX_ROUTES {
                        return Err(Error::Invalid("模型源最多支持 500 个模型".into()));
                    }
                }
            }
            SourceAction::RouteRemove { route_id, .. } => {
                if !self.registry.sources[index]
                    .routes
                    .iter()
                    .any(|route| route.id == route_id)
                {
                    return Err(Error::NotFound);
                }
                self.registry.sources[index]
                    .routes
                    .retain(|route| route.id != route_id);
                if self.registry.sources[index].default_route_id.as_deref()
                    == Some(route_id.as_str())
                {
                    self.registry.sources[index].default_route_id = self.registry.sources[index]
                        .routes
                        .first()
                        .map(|route| route.id.clone());
                }
            }
            SourceAction::Delete { .. } => {
                if self.registry.bindings.iter().any(|binding| {
                    binding.source_id == source_id && known_accounts.contains(&binding.account_id)
                }) {
                    return Err(Error::InUse);
                }
                let removed = self.registry.sources[index].clone();
                self.registry
                    .sources
                    .retain(|source| source.id != source_id);
                self.registry
                    .credentials
                    .retain(|record| record.source_id != source_id);
                self.registry
                    .bindings
                    .retain(|binding| binding.source_id != source_id);
                for receipt in &mut self.registry.creations {
                    if receipt.source_id == source_id {
                        receipt.fingerprint = "deleted".into();
                    }
                }
                self.save()?;
                return Ok(removed);
            }
            _ => return Err(Error::Invalid("不支持的模型源修改".into())),
        }
        self.registry.sources[index].revision += 1;
        self.registry.sources[index].updated_at = crate::database::now();
        let source = self.registry.sources[index].clone();
        self.save()?;
        Ok(source)
    }

    pub(crate) fn bind(
        &mut self,
        source_id: &str,
        route_id: &str,
        revision: i64,
        agent: Option<AgentKind>,
        known_accounts: &std::collections::HashSet<String>,
        account_agents: &std::collections::HashMap<String, AgentKind>,
    ) -> Result<BindOutcome> {
        let bound = self.require_source(source_id, revision)?;
        let route = bound
            .routes
            .iter()
            .find(|route| route.id == route_id)
            .ok_or(Error::NotFound)?;
        let agent = agent.unwrap_or_else(|| agent_for_route(route));
        let resolved = self.resolve_route(source_id, route_id, revision)?;
        super::managed::validate_profile_agent(agent, &resolved.profile)?;
        if let Some(binding) = self.registry.bindings.iter().find(|binding| {
            binding.source_id == source_id
                && binding.route_id == route_id
                && binding.revision == revision
                && known_accounts.contains(&binding.account_id)
                && account_agents.get(&binding.account_id) == Some(&agent)
        }) {
            return Ok(BindOutcome::Existing(binding.account_id.clone()));
        }
        if resolved
            .profile
            .model_capabilities
            .as_ref()
            .is_some_and(|caps| caps.tools == Some(false))
        {
            return Err(Error::Invalid("此模型未启用 Agent 所需的工具调用".into()));
        }
        let account_id = Uuid::new_v4().to_string();
        let source_name = bound.name.clone();
        let source = self.require_source(source_id, revision)?;
        let route = source
            .routes
            .iter()
            .find(|route| route.id == route_id)
            .ok_or(Error::NotFound)?;
        let binding = BindingRecord {
            account_id: account_id.clone(),
            source_id: source_id.to_owned(),
            route_id: route_id.to_owned(),
            revision,
            source_name,
            route_name: route.name.clone(),
            legacy: false,
            credential_id: resolved.credential_id,
            credential_revision: resolved.credential_revision,
            profile: resolved.profile.clone(),
            default_effort: route.default_effort.clone(),
        };
        self.registry.bindings.push(binding);
        self.save()?;
        Ok(BindOutcome::Created {
            account_id,
            agent,
            profile: resolved.profile,
            name: resolved.account_name.chars().take(80).collect(),
            secret: resolved.secret,
        })
    }

    #[allow(dead_code)]
    pub(crate) fn migrate(
        &mut self,
        name: &str,
        entries: Vec<MigrationEntry>,
        target: Option<TargetInput>,
    ) -> Result<ModelSource> {
        if entries.is_empty() || entries.len() > 500 {
            return Err(Error::Invalid("没有可迁移的 Profile".into()));
        }
        for entry in &entries {
            if self.is_bound(&entry.account_id) {
                return Err(Error::Conflict);
            }
        }
        let name = clean_name(name)?;
        let timestamp = crate::database::now();
        let (index, source_id) = match &target {
            Some(target) => {
                validate_source_id(&target._source_id)?;
                let index = self.source_index(&target._source_id)?;
                if self.registry.sources[index].revision != target._revision {
                    return Err(Error::Conflict);
                }
                (index, target._source_id.clone())
            }
            None => {
                let id = Uuid::new_v4().to_string();
                self.registry.sources.push(ModelSource {
                    id: id.clone(),
                    name: name.clone(),
                    revision: 1,
                    enabled: true,
                    endpoints: Vec::new(),
                    credentials: Vec::new(),
                    routes: Vec::new(),
                    default_route_id: None,
                    created_at: timestamp,
                    updated_at: timestamp,
                });
                let index = self.registry.sources.len() - 1;
                (index, id)
            }
        };
        for entry in entries {
            let protocol = entry.profile.protocol();
            if let Some(existing) = self.registry.sources[index]
                .endpoints
                .iter()
                .find(|endpoint| endpoint.protocol == protocol)
            {
                if existing.base_url != entry.profile.base_url
                    || existing.headers != entry.profile.headers
                {
                    return Err(Error::Invalid("同一协议的连接配置不一致".into()));
                }
            } else {
                if self.registry.sources[index].endpoints.len() >= MAX_ENDPOINTS {
                    return Err(Error::Invalid("每种协议只能配置一个端点".into()));
                }
                self.registry.sources[index].endpoints.push(SourceEndpoint {
                    protocol: protocol.to_owned(),
                    base_url: entry.profile.base_url.clone(),
                    headers: entry.profile.headers.clone(),
                });
            }
            let secret = clean_secret(&entry.secret)?;
            let credential_position = match self
                .registry
                .credentials
                .iter()
                .position(|record| record.source_id == source_id && record.secret == secret)
            {
                Some(position)
                    if self.registry.sources[index].credentials.iter().any(|info| {
                        info.id == self.registry.credentials[position].id
                            && info.revision == self.registry.credentials[position].revision
                    }) =>
                {
                    position
                }
                _ => {
                    let id = Uuid::new_v4().to_string();
                    let label =
                        format!("Key {}", self.registry.sources[index].credentials.len() + 1);
                    self.registry.sources[index]
                        .credentials
                        .push(SourceCredentialInfo {
                            id: id.clone(),
                            name: label,
                            revision: 1,
                        });
                    self.registry.credentials.push(CredentialRecord {
                        source_id: source_id.clone(),
                        id,
                        revision: 1,
                        secret,
                    });
                    self.registry.credentials.len() - 1
                }
            };
            let credential = &self.registry.credentials[credential_position];
            let credential_id = credential.id.clone();
            let credential_revision = credential.revision;
            let route_id = Uuid::new_v4().to_string();
            let route = SourceRoute {
                id: route_id.clone(),
                name: entry.name.clone(),
                model: entry.profile.model.clone(),
                protocol: protocol.to_owned(),
                credential_id: credential_id.clone(),
                enabled: true,
                model_capabilities: entry.profile.model_capabilities.clone(),
                default_effort: entry.default_effort.clone(),
            };
            self.registry.sources[index].routes.push(route);
            if self.registry.sources[index].default_route_id.is_none() {
                self.registry.sources[index].default_route_id = Some(route_id.clone());
            }
            let source_name = self.registry.sources[index].name.clone();
            self.registry.bindings.push(BindingRecord {
                account_id: entry.account_id,
                source_id: source_id.clone(),
                route_id,
                revision: self.registry.sources[index].revision,
                source_name,
                route_name: entry.name,
                legacy: true,
                credential_id,
                credential_revision,
                profile: entry.profile.clone(),
                default_effort: entry.default_effort,
            });
        }
        if self.registry.sources[index].credentials.len() > MAX_SOURCE_CREDENTIALS
            || self.registry.sources[index].routes.len() > MAX_ROUTES
        {
            return Err(Error::Invalid(
                "模型源最多支持 32 组凭据与 500 个模型，请拆分迁移".into(),
            ));
        }
        if target.is_some() {
            self.registry.sources[index].revision += 1;
            self.registry.sources[index].updated_at = timestamp;
        }
        let source = self.registry.sources[index].clone();
        self.save()?;
        Ok(source)
    }

    #[allow(dead_code)]
    pub(crate) fn unbind(&mut self, account_ids: &[String]) -> Result<()> {
        for id in account_ids {
            let binding = self
                .registry
                .bindings
                .iter()
                .find(|binding| binding.account_id == *id)
                .ok_or(Error::NotFound)?;
            if !binding.legacy {
                return Err(Error::Invalid("只能还原迁移前的独立 Profile".into()));
            }
        }
        for id in account_ids {
            self.registry
                .bindings
                .retain(|binding| binding.account_id != *id);
        }
        self.save()
    }

    pub(crate) fn models_target(
        &self,
        source_id: &str,
        revision: i64,
        protocol: &str,
        credential_id: &str,
    ) -> Result<(SourceEndpoint, String)> {
        let source = self.require_source(source_id, revision)?;
        let endpoint = source
            .endpoints
            .iter()
            .find(|endpoint| endpoint.protocol == protocol)
            .ok_or(Error::NotFound)?;
        let info = source
            .credentials
            .iter()
            .find(|credential| credential.id == credential_id)
            .ok_or(Error::NotFound)?;
        let secret = self.credential_secret(source_id, credential_id, info.revision)?;
        Ok((endpoint.clone(), secret.to_owned()))
    }

    fn validate(&self) -> Result<()> {
        if self.registry.version != Registry::VERSION
            || self.registry.sources.len() > MAX_SOURCES
            || self.registry.credentials.len() > MAX_CREDENTIALS
            || self.registry.bindings.len() > MAX_BINDINGS
            || self.registry.creations.len() > MAX_CREATIONS
        {
            return Err(Error::Invalid("模型源存储格式或数量超限".into()));
        }
        let mut source_ids = std::collections::BTreeSet::new();
        for source in &self.registry.sources {
            validate_source_id(&source.id)?;
            if !source_ids.insert(source.id.clone()) {
                return Err(Error::Invalid("模型源标识冲突".into()));
            }
            if source.revision < 1 {
                return Err(Error::Invalid("模型源版本无效".into()));
            }
            if source.endpoints.is_empty() || source.endpoints.len() > MAX_ENDPOINTS {
                return Err(Error::Invalid("模型源连接配置无效".into()));
            }
            let mut protocols = std::collections::BTreeSet::new();
            for endpoint in &source.endpoints {
                if !supported_protocol(&endpoint.protocol)
                    || !protocols.insert(endpoint.protocol.clone())
                {
                    return Err(Error::Invalid("模型源协议重复或不支持".into()));
                }
                normalize_base_url(&endpoint.base_url, &endpoint.protocol)?;
            }
            let credential_ids: std::collections::BTreeSet<&str> = source
                .credentials
                .iter()
                .map(|credential| credential.id.as_str())
                .collect();
            if credential_ids.len() != source.credentials.len()
                || source.credentials.len() > MAX_SOURCE_CREDENTIALS
            {
                return Err(Error::Invalid("模型凭据标识冲突或超限".into()));
            }
            let route_ids: std::collections::BTreeSet<&str> = source
                .routes
                .iter()
                .map(|route| route.id.as_str())
                .collect();
            if route_ids.len() != source.routes.len() || source.routes.len() > MAX_ROUTES {
                return Err(Error::Invalid("模型标识冲突或超限".into()));
            }
            if let Some(default_route_id) = &source.default_route_id
                && !route_ids.contains(default_route_id.as_str())
            {
                return Err(Error::Invalid("默认模型不存在".into()));
            }
            for route in &source.routes {
                validate_source_id(&route.id)?;
                if !supported_protocol(&route.protocol) {
                    return Err(Error::Invalid("模型协议不支持".into()));
                }
                if !source
                    .endpoints
                    .iter()
                    .any(|endpoint| endpoint.protocol == route.protocol)
                    || !credential_ids.contains(route.credential_id.as_str())
                {
                    return Err(Error::Invalid("模型引用了不存在的连接或凭据".into()));
                }
                clean_name(&route.name)?;
                clean_model(&route.model)?;
                if let Some(effort) = &route.default_effort
                    && (!ALLOWED_EFFORTS.contains(&effort.as_str())
                        || !route
                            .model_capabilities
                            .as_ref()
                            .and_then(|caps| caps.supported_efforts.as_ref())
                            .is_some_and(|efforts| efforts.iter().any(|level| level == effort)))
                {
                    return Err(Error::Invalid("推理档位不受此模型路由支持".into()));
                }
            }
        }
        let mut bound_accounts = std::collections::BTreeSet::new();
        for binding in &self.registry.bindings {
            if !bound_accounts.insert(binding.account_id.clone()) {
                return Err(Error::Invalid("会话模型绑定冲突".into()));
            }
            let source = self
                .registry
                .sources
                .iter()
                .find(|source| source.id == binding.source_id)
                .ok_or_else(|| Error::Invalid("会话模型绑定了不存在的模型源".into()))?;
            if binding.revision < 1
                || !source
                    .routes
                    .iter()
                    .any(|route| route.id == binding.route_id)
            {
                return Err(Error::Invalid("会话模型绑定格式错误".into()));
            }
            let has_credential = self.registry.credentials.iter().any(|credential| {
                credential.source_id == binding.source_id
                    && credential.id == binding.credential_id
                    && credential.revision == binding.credential_revision
            });
            if !has_credential {
                return Err(Error::Invalid("模型源凭据缺失".into()));
            }
        }
        for credential in &self.registry.credentials {
            if self
                .registry
                .sources
                .iter()
                .all(|source| source.id != credential.source_id)
            {
                return Err(Error::Invalid("模型源凭据缺少来源".into()));
            }
            if credential.revision < 1 {
                return Err(Error::Invalid("模型源凭据版本无效".into()));
            }
            clean_secret(&credential.secret)?;
        }
        Ok(())
    }
}

fn agent_for_route(route: &SourceRoute) -> AgentKind {
    match route.protocol.as_str() {
        "anthropic" => AgentKind::Claude,
        _ => AgentKind::Codex,
    }
}

#[allow(clippy::large_enum_variant)]
pub(crate) enum BindOutcome {
    Existing(String),
    Created {
        account_id: String,
        agent: AgentKind,
        profile: ApiProfile,
        name: String,
        secret: String,
    },
}

impl Registry {
    const VERSION: u32 = 1;

    fn empty() -> Self {
        Self {
            version: Self::VERSION,
            sources: Vec::new(),
            credentials: Vec::new(),
            bindings: Vec::new(),
            creations: Vec::new(),
        }
    }
}

const ALLOWED_EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

fn action_ref(action: &SourceAction) -> Result<(String, i64)> {
    match action {
        SourceAction::Update {
            source_id,
            revision,
            ..
        }
        | SourceAction::CredentialSet {
            source_id,
            revision,
            ..
        }
        | SourceAction::CredentialRemove {
            source_id,
            revision,
            ..
        }
        | SourceAction::RoutesSet {
            source_id,
            revision,
            ..
        }
        | SourceAction::RouteRemove {
            source_id,
            revision,
            ..
        }
        | SourceAction::Delete {
            source_id,
            revision,
        } => {
            validate_source_id(source_id)?;
            Ok((source_id.clone(), *revision))
        }
        _ => Err(Error::Invalid("unsupported model source action".into())),
    }
}

fn clean_endpoints(input: Vec<SourceEndpointInput>) -> Result<Vec<SourceEndpoint>> {
    if input.is_empty() || input.len() > MAX_ENDPOINTS {
        return Err(Error::Invalid("每种协议只能配置一个端点".into()));
    }
    let mut endpoints = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for endpoint in input {
        if !supported_protocol(&endpoint.protocol) || !seen.insert(endpoint.protocol.clone()) {
            return Err(Error::Invalid("模型源协议重复或不支持".into()));
        }
        let headers = clean_headers(endpoint.headers)?;
        let base_url = normalize_base_url(&endpoint.base_url, &endpoint.protocol)?;
        endpoints.push(SourceEndpoint {
            protocol: endpoint.protocol,
            base_url,
            headers,
        });
    }
    Ok(endpoints)
}

fn normalize_base_url(raw: &str, protocol: &str) -> Result<String> {
    let profile = super::profile::clean_profile_inputs(
        agent_for_protocol(protocol),
        raw,
        "catalog",
        Some(provider_for_protocol(protocol)),
        Some(protocol),
        Some(serde_json::Value::Null),
    )?;
    Ok(profile.base_url)
}

fn clean_effort(value: &Option<String>) -> Result<Option<String>> {
    match value {
        None => Ok(None),
        Some(level) => {
            if !ALLOWED_EFFORTS.contains(&level.as_str()) {
                return Err(Error::Invalid("模型能力配置无效：推理强度不支持".into()));
            }
            Ok(Some(level.clone()))
        }
    }
}

fn clean_capabilities(
    value: Option<serde_json::Value>,
) -> Result<Option<super::ModelCapabilities>> {
    match value {
        None => Ok(None),
        Some(value) => super::ModelCapabilities::clean(value),
    }
}

fn build_initial_routes(input: Vec<RouteInput>, credential_id: &str) -> Result<Vec<SourceRoute>> {
    if input.len() > 100 {
        return Err(Error::Invalid("创建模型源时最多带 100 个模型".into()));
    }
    input
        .into_iter()
        .map(|route| {
            Ok(SourceRoute {
                id: Uuid::new_v4().to_string(),
                name: clean_name(&route.name)?,
                model: clean_model(&route.model)?,
                protocol: require_supported_route_protocol(&route.protocol)?,
                credential_id: credential_id.to_owned(),
                enabled: route.enabled,
                model_capabilities: clean_capabilities(route.model_capabilities)?,
                default_effort: clean_effort(&route.default_effort)?,
            })
        })
        .collect()
}

fn build_route(input: &RouteInputWithId) -> Result<SourceRoute> {
    Ok(SourceRoute {
        id: match &input.id {
            Some(id) => {
                validate_source_id(id)?;
                id.clone()
            }
            None => Uuid::new_v4().to_string(),
        },
        name: clean_name(&input.name)?,
        model: clean_model(&input.model)?,
        protocol: require_supported_route_protocol(&input.protocol)?,
        credential_id: {
            validate_source_id(&input.credential_id)?;
            input.credential_id.clone()
        },
        enabled: input.enabled,
        model_capabilities: clean_capabilities(input.model_capabilities.clone())?,
        default_effort: clean_effort(&input.default_effort)?,
    })
}

fn require_supported_route_protocol(protocol: &str) -> Result<String> {
    if !supported_protocol(protocol) {
        return Err(Error::Invalid("模型协议不支持".into()));
    }
    Ok(protocol.into())
}

fn route_profile(endpoint: &SourceEndpoint, route: &SourceRoute) -> Result<ApiProfile> {
    super::profile::clean_profile(
        agent_for_protocol(&route.protocol),
        &endpoint.base_url,
        &route.model,
        Some(provider_for_protocol(&route.protocol)),
        Some(&route.protocol),
        route
            .model_capabilities
            .clone()
            .map(serde_json::to_value)
            .transpose()?
            .map(|value| {
                // clean_capabilities accepted null; strip it back.
                if value.is_null() {
                    serde_json::Value::Null
                } else {
                    value
                }
            }),
        endpoint
            .headers
            .clone()
            .map(serde_json::to_value)
            .transpose()?,
    )
}

fn create_fingerprint(
    name: &str,
    endpoints: &[SourceEndpoint],
    credential_name: &str,
    secret: &str,
    routes: &[RouteInput],
) -> Result<String> {
    use sha2::{Digest, Sha256};
    let payload = serde_json::json!([name, endpoints, credential_name, secret, routes]);
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&payload)?);
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_save_rejects_stale_writer() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path();
        let endpoint = SourceEndpointInput {
            protocol: "anthropic".into(),
            base_url: "https://example.invalid".into(),
            headers: None,
        };
        let create = || SourceAction::Create {
            operation_id: None,
            name: "Atomic".into(),
            endpoints: vec![endpoint.clone()],
            credential: CredentialInput {
                name: "Key".into(),
                api_key: "sk-prospero-source-secret-0123456789".into(),
            },
            routes: Some(vec![RouteInput {
                name: "A".into(),
                model: "a".into(),
                protocol: "anthropic".into(),
                enabled: true,
                model_capabilities: None,
                default_effort: None,
            }]),
        };
        let mut initial = ModelSources::open(data).unwrap();
        initial.create(create()).unwrap();

        let mut stale = ModelSources::open(data).unwrap();
        let mut fresh = ModelSources::open(data).unwrap();
        let source = fresh.list()[0].clone();
        fresh
            .change(
                SourceAction::Update {
                    source_id: source.id.clone(),
                    revision: source.revision,
                    name: Some("Fresh".into()),
                    enabled: None,
                    endpoints: None,
                    default_route_id: None,
                },
                &std::collections::HashSet::new(),
            )
            .unwrap();
        let stale_result = stale.change(
            SourceAction::Update {
                source_id: source.id,
                revision: source.revision,
                name: Some("Stale".into()),
                enabled: None,
                endpoints: None,
                default_route_id: None,
            },
            &std::collections::HashSet::new(),
        );
        assert!(matches!(stale_result, Err(Error::Conflict)));
        let after = ModelSources::open(data).unwrap().list()[0].name.clone();
        assert_eq!(after, "Fresh");
    }
}
