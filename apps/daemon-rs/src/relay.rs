//! Relay v1 protocol primitives for the outbound host client.
//!
//! This ports the security-sensitive pieces of `packages/protocol/src/relay.ts`:
//! URL deployment policy, route/device credential derivation, and the JSON
//! control frames used by `/v1/host` and `/v1/stream`.  The runtime client is
//! layered on top of these primitives so tests can compare exact contract
//! vectors before sockets are introduced.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::prelude::{BASE64_STANDARD, BASE64_URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::error::{Error, Result};
use crate::pairing::DeviceRecord;

pub const RELAY_PROTOCOL_VERSION: u8 = 1;
pub const RELAY_HOST_PATH: &str = "/v1/host";
pub const RELAY_CLIENT_PATH: &str = "/v1/client";
pub const RELAY_STREAM_PATH: &str = "/v1/stream";
pub const MAX_RELAY_CONTROL_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_RELAY_DATA_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_RELAY_URL_CHARS: usize = 2048;
pub const MAX_RELAY_ROUTE_ID_CHARS: usize = 43;
pub const MAX_RELAY_HOST_SECRET_CHARS: usize = 43;
pub const MAX_RELAY_DEVICE_ID_CHARS: usize = 128;
pub const MAX_RELAY_TOKEN_CHARS: usize = 512;
pub const MAX_RELAY_STREAM_ID_CHARS: usize = 128;
pub const MAX_RELAY_TICKET_CHARS: usize = 128;
pub const MAX_RELAY_DEVICE_CREDENTIALS: usize = 1024;
pub const MAX_RELAY_GENERATION: u64 = 4_294_967_295;
pub const RELAY_ROUTE_ID_DOMAIN: &str = "prospero.relay.v1.route-id\\0";
pub const RELAY_DEVICE_CREDENTIAL_DOMAIN: &str = "prospero.relay.v1.device-credential\\0";
pub const RELAY_SYNC_STATE_FILE: &str = "relay-sync-state.json";
pub const MIN_RECONNECT_MS: u64 = 500;
pub const MAX_RECONNECT_MS: u64 = 30_000;
pub const HEARTBEAT_MS: u64 = 15_000;
pub const AUTH_TIMEOUT_MS: u64 = 10_000;
pub const DEVICE_SYNC_TIMEOUT_MS: u64 = 10_000;
pub const READY_TIMEOUT_MS: u64 = 10_000;
pub const HEARTBEAT_ACK_TIMEOUT_MS: u64 = 10_000;
pub const MAX_RELAY_EXPIRES_AT_MS: u64 = 8_640_000_000_000_000;
pub const RELAY_CONFIG_POLL_MS: u64 = 500;
pub const MAX_ACTIVE_RELAY_STREAMS: usize = 128;

pub type RelayDataStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayHostAuth {
    pub v: u8,
    pub route_id: String,
    pub host_secret: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayDeviceCredential {
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayHostDeviceSync {
    #[serde(rename = "type")]
    pub kind: String,
    pub v: u8,
    pub generation: u64,
    pub credentials: Vec<RelayDeviceCredential>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStreamAccept {
    #[serde(rename = "type")]
    pub kind: String,
    pub v: u8,
    pub stream_id: String,
    pub ticket: String,
}

pub fn validate_relay_url(value: &str, allow_insecure_loopback: bool) -> Result<String> {
    if value.is_empty() || value.len() > MAX_RELAY_URL_CHARS {
        return Err(Error::Invalid("relay URL length is invalid".into()));
    }
    let url = Url::parse(value).map_err(|_| Error::Invalid("relay URL is invalid".into()))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::Invalid(
            "relay URL must not contain credentials, query, or fragment".into(),
        ));
    }
    if url.scheme() == "wss" {
        return Ok(value.to_owned());
    }
    if allow_insecure_loopback
        && url.scheme() == "ws"
        && is_loopback_host(url.host_str().unwrap_or_default())
    {
        return Ok(value.to_owned());
    }
    Err(Error::Invalid(
        "relay URL must use wss (ws is allowed only with explicit loopback development opt-in)"
            .into(),
    ))
}

pub fn relay_endpoint(base: &str, endpoint_path: &str) -> Result<String> {
    validate_relay_url(base, true)?;
    let mut url = Url::parse(base).map_err(|_| Error::Invalid("relay URL is invalid".into()))?;
    url.set_path(endpoint_path);
    Ok(url.to_string())
}

pub fn derive_relay_route_id(host_secret: &str) -> Result<String> {
    validate_sha256_b64url(host_secret, "host secret")?;
    let secret = BASE64_URL_SAFE_NO_PAD
        .decode(host_secret)
        .map_err(|_| Error::Invalid("host secret is invalid".into()))?;
    let mut hasher = Sha256::new();
    hasher.update(RELAY_ROUTE_ID_DOMAIN.as_bytes());
    hasher.update(secret);
    Ok(BASE64_URL_SAFE_NO_PAD.encode(hasher.finalize()))
}

pub fn derive_relay_device_credential_digest(token: &str) -> Result<String> {
    validate_opaque_id(token, MAX_RELAY_TOKEN_CHARS, "relay token")?;
    let mut hasher = Sha256::new();
    hasher.update(RELAY_DEVICE_CREDENTIAL_DOMAIN.as_bytes());
    hasher.update(token.as_bytes());
    Ok(BASE64_URL_SAFE_NO_PAD.encode(hasher.finalize()))
}

pub fn relay_route_id_matches_host_secret(route_id: &str, host_secret: &str) -> bool {
    let Ok(expected) = derive_relay_route_id(host_secret) else {
        return false;
    };
    validate_sha256_b64url(route_id, "routeId").is_ok()
        && expected.len() == route_id.len()
        && expected
            .bytes()
            .zip(route_id.bytes())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

pub fn device_relay_credentials(device: &DeviceRecord) -> Option<(&str, &str)> {
    if device.relay_credential_issued == Some(true) {
        Some((
            device.relay_device_id.as_deref()?,
            device.relay_token.as_deref()?,
        ))
    } else {
        None
    }
}

pub fn device_sync_frame(devices: &[DeviceRecord], generation: u64) -> Result<RelayHostDeviceSync> {
    if generation > MAX_RELAY_GENERATION {
        return Err(Error::Invalid("relay generation is invalid".into()));
    }
    let mut credentials = Vec::new();
    let mut device_ids = HashSet::new();
    for device in devices.iter().take(MAX_RELAY_DEVICE_CREDENTIALS + 1) {
        let Some((device_id, token)) = device_relay_credentials(device) else {
            continue;
        };
        validate_opaque_id(device_id, MAX_RELAY_DEVICE_ID_CHARS, "deviceId")?;
        if !device_ids.insert(device_id.to_owned()) {
            return Err(Error::Invalid("duplicate relay deviceId".into()));
        }
        credentials.push(RelayDeviceCredential {
            device_id: device_id.to_owned(),
            credential_digest: Some(derive_relay_device_credential_digest(token)?),
            revoked: None,
        });
    }
    if credentials.len() > MAX_RELAY_DEVICE_CREDENTIALS {
        return Err(Error::Invalid("too many relay device credentials".into()));
    }
    Ok(RelayHostDeviceSync {
        kind: "host.device-sync".into(),
        v: RELAY_PROTOCOL_VERSION,
        generation,
        credentials,
    })
}

pub fn host_auth_frame(host_secret: &str) -> Result<RelayHostAuth> {
    Ok(RelayHostAuth {
        v: RELAY_PROTOCOL_VERSION,
        route_id: derive_relay_route_id(host_secret)?,
        host_secret: host_secret.to_owned(),
    })
}

pub fn stream_accept_frame(stream_id: &str, ticket: &str) -> Result<RelayStreamAccept> {
    validate_opaque_id(stream_id, MAX_RELAY_STREAM_ID_CHARS, "streamId")?;
    validate_opaque_id(ticket, MAX_RELAY_TICKET_CHARS, "stream ticket")?;
    Ok(RelayStreamAccept {
        kind: "stream.accept".into(),
        v: RELAY_PROTOCOL_VERSION,
        stream_id: stream_id.to_owned(),
        ticket: ticket.to_owned(),
    })
}

fn is_loopback_host(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1" | "[::1]"
    )
}

fn validate_sha256_b64url(value: &str, label: &str) -> Result<()> {
    if value.len() != 43 || !is_b64url(value) {
        return Err(Error::Invalid(format!("{label} is invalid")));
    }
    let decoded = BASE64_URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| BASE64_STANDARD.decode(value))
        .map_err(|_| Error::Invalid(format!("{label} is invalid")))?;
    if decoded.len() != 32 {
        return Err(Error::Invalid(format!("{label} is invalid")));
    }
    Ok(())
}

fn validate_opaque_id(value: &str, max: usize, label: &str) -> Result<()> {
    if value.len() < 16 || value.len() > max || !is_b64url(value) {
        return Err(Error::Invalid(format!("{label} is invalid")));
    }
    Ok(())
}

fn is_b64url(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_route_and_device_digest_like_ts_contract() {
        let secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        assert_eq!(
            derive_relay_route_id(secret).unwrap(),
            "CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk"
        );
        assert!(relay_route_id_matches_host_secret(
            "CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk",
            secret
        ));
        assert!(!relay_route_id_matches_host_secret(
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            secret
        ));
        assert_eq!(
            derive_relay_device_credential_digest("relay-token-abcdefghijkl").unwrap(),
            "h5SFUoy1S0XUU-8tMZq243pvWEz3dGQsn4vmzPd_-Pk"
        );
    }

    #[test]
    fn validates_relay_url_deployment_policy_and_endpoint_paths() {
        assert!(validate_relay_url("wss://relay.example.com/root", false).is_ok());
        assert!(validate_relay_url("ws://127.0.0.1:9000", true).is_ok());
        assert!(validate_relay_url("ws://relay.example.com", true).is_err());
        assert!(validate_relay_url("wss://user@relay.example.com", false).is_err());
        assert_eq!(
            relay_endpoint("wss://relay.example.com/root", RELAY_HOST_PATH).unwrap(),
            "wss://relay.example.com/v1/host"
        );
    }

    #[test]
    fn builds_device_sync_from_issued_relay_credentials_only() {
        let devices = vec![
            DeviceRecord {
                name: "ready".into(),
                token: "pairing-token".into(),
                client_pub_key: None,
                allow_shell: true,
                allow_orchestration: None,
                relay_device_id: Some("device-id-abcdefgh".into()),
                relay_token: Some("relay-token-abcdefghijkl".into()),
                relay_credential_issued: Some(true),
                created_at: 1,
                last_seen_at: None,
            },
            DeviceRecord {
                name: "legacy".into(),
                token: "pairing-token-2".into(),
                client_pub_key: None,
                allow_shell: true,
                allow_orchestration: None,
                relay_device_id: Some("device-id-legacyxx".into()),
                relay_token: Some("relay-token-legacyxx".into()),
                relay_credential_issued: None,
                created_at: 1,
                last_seen_at: None,
            },
        ];
        let frame = device_sync_frame(&devices, 7).unwrap();
        assert_eq!(frame.kind, "host.device-sync");
        assert_eq!(frame.generation, 7);
        assert_eq!(frame.credentials.len(), 1);
        assert_eq!(frame.credentials[0].device_id, "device-id-abcdefgh");
        assert_eq!(
            frame.credentials[0].credential_digest.as_deref(),
            Some("h5SFUoy1S0XUU-8tMZq243pvWEz3dGQsn4vmzPd_-Pk")
        );
    }
}

pub use prospero_protocol_rs::{
    RelayConnectionState, RelayRuntimeDeviceStatus, RelayRuntimeStatus,
};

pub type RelayHostSessionStatus = RelayRuntimeStatus;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_secret: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRelayConfig {
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<RelayConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RelayTarget {
    url: String,
    route_id: String,
    host_secret: String,
    devices: Vec<DeviceRecord>,
    credential_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct RelaySyncState {
    version: u8,
    #[serde(default)]
    routes: HashMap<String, u64>,
}

pub fn load_daemon_relay_config(home: &Path) -> Result<DaemonRelayConfig> {
    let path = home.join("config.json");
    if !path.exists() {
        return Ok(DaemonRelayConfig {
            port: Some(7423),
            bind: None,
            relay: None,
        });
    }
    let raw = fs::read_to_string(path)?;
    serde_json::from_str(&raw).map_err(|_| Error::Invalid("invalid daemon config".into()))
}

pub fn generate_relay_host_secret() -> String {
    crate::pairing::random_b64url(32)
}

pub fn save_relay_config_raw(
    home: &Path,
    enabled: bool,
    url: Option<String>,
    host_secret: Option<String>,
) -> Result<()> {
    fs::create_dir_all(home)?;
    let path = home.join("config.json");
    let mut config = if path.exists() {
        let raw = fs::read_to_string(&path)?;
        serde_json::from_str::<serde_json::Value>(&raw)
            .map_err(|_| Error::Invalid("invalid daemon config".into()))?
    } else {
        serde_json::json!({"port": 7423})
    };
    if !config.is_object() {
        return Err(Error::Invalid("invalid daemon config".into()));
    }
    let has_url = url.is_some();
    let has_host_secret = host_secret.is_some();
    config["relay"] = serde_json::json!({
        "enabled": enabled,
        "url": url,
        "hostSecret": host_secret,
    });
    if !has_url {
        config["relay"]
            .as_object_mut()
            .and_then(|relay| relay.remove("url"));
    }
    if !has_host_secret {
        config["relay"]
            .as_object_mut()
            .and_then(|relay| relay.remove("hostSecret"));
    }
    let tmp = home.join(format!(
        ".config.json.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let bytes = serde_json::to_vec_pretty(&config)?;
    fs::write(&tmp, [bytes, b"\n".to_vec()].concat())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(tmp, path)?;
    Ok(())
}

pub fn rotate_relay_key(
    home: &Path,
    config: DaemonRelayConfig,
) -> Result<(DaemonRelayConfig, usize)> {
    let count = crate::pairing::clear_relay_credentials(home)?;
    let previous = config.relay.as_ref();
    let next_secret = generate_relay_host_secret();
    save_relay_config_raw(
        home,
        previous.is_some_and(|relay| relay.enabled),
        previous.and_then(|relay| relay.url.clone()),
        Some(next_secret),
    )?;
    let next = load_daemon_relay_config(home)?;
    Ok((next, count))
}

pub fn effective_relay_url(config: &DaemonRelayConfig) -> Option<String> {
    config
        .relay
        .as_ref()
        .and_then(|relay| relay.url.clone())
        .filter(|url| !url.is_empty())
        .or_else(|| {
            std::env::var("PROSPERO_DEFAULT_RELAY_URL")
                .ok()
                .filter(|url| !url.is_empty())
        })
}

fn relay_target_from_config(
    config: &DaemonRelayConfig,
    devices: Vec<DeviceRecord>,
    dev_mode: bool,
) -> Result<Option<RelayTarget>> {
    let Some(relay) = config.relay.as_ref().filter(|relay| relay.enabled) else {
        return Ok(None);
    };
    let Some(url) = effective_relay_url(config) else {
        return Err(Error::Invalid("relay configuration incomplete".into()));
    };
    let Some(host_secret) = relay
        .host_secret
        .clone()
        .filter(|secret| !secret.is_empty())
    else {
        return Err(Error::Invalid("relay configuration incomplete".into()));
    };
    validate_relay_url(&url, dev_mode)?;
    let route_id = derive_relay_route_id(&host_secret)?;
    let credential_fingerprint = device_snapshot_fingerprint(&devices);
    Ok(Some(RelayTarget {
        url,
        route_id,
        host_secret,
        devices,
        credential_fingerprint,
    }))
}

pub fn relay_status_from_config(
    config: &DaemonRelayConfig,
    devices: &[DeviceRecord],
    dev_mode: bool,
) -> RelayRuntimeStatus {
    let now = crate::database::now();
    let Some(relay) = config.relay.as_ref().filter(|relay| relay.enabled) else {
        return publish_status(
            RelayConnectionState::Disabled,
            None,
            None,
            None,
            devices,
            0,
            now,
        );
    };
    let requested_url = effective_relay_url(config);
    let host_secret = relay.host_secret.clone();
    let target = match (requested_url.clone(), host_secret) {
        (Some(_), Some(_)) => relay_target_from_config(config, devices.to_vec(), dev_mode),
        _ => Err(Error::Invalid("relay configuration incomplete".into())),
    };
    match target {
        Ok(Some(target)) => publish_status(
            RelayConnectionState::Connecting,
            Some(target.url),
            Some(target.route_id),
            None,
            devices,
            0,
            now,
        ),
        Ok(None) => publish_status(
            RelayConnectionState::Disabled,
            None,
            None,
            None,
            devices,
            0,
            now,
        ),
        Err(error) => publish_status(
            RelayConnectionState::Error,
            requested_url,
            None,
            Some(error.to_string()),
            devices,
            0,
            now,
        ),
    }
}

pub fn relay_status_from_home(home: &Path, dev_mode: bool) -> Option<RelayRuntimeStatus> {
    let config = match load_daemon_relay_config(home) {
        Ok(config) => config,
        Err(error) => {
            return Some(publish_status(
                RelayConnectionState::Error,
                None,
                None,
                Some(error.to_string()),
                &[],
                0,
                crate::database::now(),
            ));
        }
    };
    let devices = match crate::pairing::load_devices(home) {
        Ok(devices) => devices,
        Err(error) => {
            return Some(publish_status(
                RelayConnectionState::Error,
                effective_relay_url(&config),
                None,
                Some(error.to_string()),
                &[],
                0,
                crate::database::now(),
            ));
        }
    };
    let status = relay_status_from_config(&config, &devices, dev_mode);
    if status.state == RelayConnectionState::Disabled {
        None
    } else {
        Some(status)
    }
}

fn publish_status(
    state: RelayConnectionState,
    url: Option<String>,
    route_id: Option<String>,
    last_error: Option<String>,
    devices: &[DeviceRecord],
    ready: usize,
    updated_at: i64,
) -> RelayRuntimeStatus {
    RelayRuntimeStatus {
        enabled: state != RelayConnectionState::Disabled,
        state,
        url,
        route_id,
        updated_at,
        last_connected_at: None,
        last_error,
        devices: RelayRuntimeDeviceStatus {
            total: devices.len(),
            ready,
            needs_re_pair: devices
                .iter()
                .filter(|device| device_relay_credentials(device).is_none())
                .count(),
        },
        active_streams: 0,
        stream_failures: 0,
        last_stream_error: None,
    }
}

fn device_snapshot_fingerprint(devices: &[DeviceRecord]) -> String {
    let mut entries = devices
        .iter()
        .filter_map(|device| {
            let (device_id, token) = device_relay_credentials(device)?;
            Some(format!("{device_id}:{token}"))
        })
        .collect::<Vec<_>>();
    entries.sort();
    entries.join("\n")
}

#[derive(Debug, Clone)]
pub struct RelayGenerationJournal {
    path: PathBuf,
    routes: HashMap<String, u64>,
}

impl RelayGenerationJournal {
    pub fn load(state_dir: impl AsRef<Path>) -> Self {
        let path = state_dir.as_ref().join(RELAY_SYNC_STATE_FILE);
        let routes = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<RelaySyncState>(&raw).ok())
            .filter(|state| state.version == 1)
            .map(|state| {
                state
                    .routes
                    .into_iter()
                    .filter(|(route_id, generation)| {
                        validate_sha256_b64url(route_id, "routeId").is_ok()
                            && *generation <= MAX_RELAY_GENERATION
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self { path, routes }
    }

    pub fn generation_for(&self, route_id: &str) -> Option<u64> {
        self.routes.get(route_id).copied()
    }

    pub fn next_generation(&mut self, route_id: &str) -> Result<u64> {
        validate_sha256_b64url(route_id, "routeId")?;
        let previous = self.routes.get(route_id).copied().unwrap_or(0);
        if previous >= MAX_RELAY_GENERATION {
            return Err(Error::Invalid("relay generation exhausted".into()));
        }
        let generation = previous + 1;
        let mut routes = self.routes.clone();
        routes.insert(route_id.to_owned(), generation);
        let state = RelaySyncState { version: 1, routes };
        let parent = self
            .path
            .parent()
            .ok_or_else(|| Error::Invalid("invalid relay generation path".into()))?;
        fs::create_dir_all(parent)?;
        let tmp = self.path.with_file_name(format!(
            ".{}.{}.tmp",
            RELAY_SYNC_STATE_FILE,
            uuid::Uuid::new_v4().simple()
        ));
        let bytes = serde_json::to_vec(&state)?;
        fs::write(&tmp, [bytes, b"\n".to_vec()].concat())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
        }
        if let Err(error) = fs::rename(&tmp, &self.path) {
            let _ = fs::remove_file(&tmp);
            return Err(error.into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600))?;
        }
        self.routes = state.routes;
        Ok(generation)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RelayTimeouts {
    pub auth: Duration,
    pub device_sync: Duration,
    pub ready: Duration,
    pub heartbeat: Duration,
    pub heartbeat_ack: Duration,
    pub min_reconnect: Duration,
    pub max_reconnect: Duration,
}

impl Default for RelayTimeouts {
    fn default() -> Self {
        Self {
            auth: Duration::from_millis(AUTH_TIMEOUT_MS),
            device_sync: Duration::from_millis(DEVICE_SYNC_TIMEOUT_MS),
            ready: Duration::from_millis(READY_TIMEOUT_MS),
            heartbeat: Duration::from_millis(HEARTBEAT_MS),
            heartbeat_ack: Duration::from_millis(HEARTBEAT_ACK_TIMEOUT_MS),
            min_reconnect: Duration::from_millis(MIN_RECONNECT_MS),
            max_reconnect: Duration::from_millis(MAX_RECONNECT_MS),
        }
    }
}

pub fn relay_client_from_config(
    home: &Path,
    config: &DaemonRelayConfig,
    dev_mode: bool,
) -> Result<Option<RelayHostClient>> {
    let devices = crate::pairing::load_devices(home)?;
    let Some(target) = relay_target_from_config(config, devices, dev_mode)? else {
        return Ok(None);
    };
    let mut journal = RelayGenerationJournal::load(home);
    let generation = journal.next_generation(&target.route_id)?;
    Ok(Some(RelayHostClient::new(
        target.url,
        target.host_secret,
        target.devices,
        generation,
    )))
}

pub struct RelayHostClient {
    url: String,
    host_secret: String,
    devices: Vec<DeviceRecord>,
    generation: u64,
}

pub struct RelayHostSession {
    control: RelayDataStream,
    url: String,
    route_id: String,
    generation: u64,
    total_devices: usize,
    ready_devices: usize,
    needs_re_pair: usize,
    ready_device_ids: HashSet<String>,
    active_stream_ids: HashSet<String>,
    timeouts: RelayTimeouts,
    stream_failures: u64,
    last_stream_error: Option<String>,
}

impl RelayHostClient {
    pub fn new(
        url: String,
        host_secret: String,
        devices: Vec<DeviceRecord>,
        generation: u64,
    ) -> Self {
        Self {
            url,
            host_secret,
            devices,
            generation,
        }
    }

    /// Connect one `/v1/host` control socket through auth, full device sync,
    /// sync ack, and host.ready. Reconnect/backoff/status-file wiring lives in
    /// the daemon supervisor; this bounded primitive keeps the relay T1 control
    /// sequence testable and reusable.
    pub async fn connect_once(&self) -> Result<RelayHostSession> {
        self.connect_once_with_timeouts(RelayTimeouts::default())
            .await
    }

    pub async fn connect_once_with_timeouts(
        &self,
        timeouts: RelayTimeouts,
    ) -> Result<RelayHostSession> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        validate_relay_url(&self.url, true)?;
        let route_id = derive_relay_route_id(&self.host_secret)?;
        let endpoint = relay_endpoint(&self.url, RELAY_HOST_PATH)?;
        let mut control =
            connect_relay_socket(endpoint, MAX_RELAY_CONTROL_FRAME_BYTES, timeouts.auth).await?;
        control
            .send(Message::Text(
                serde_json::to_string(&host_auth_frame(&self.host_secret)?)?.into(),
            ))
            .await
            .map_err(|error| Error::Invalid(format!("relay host auth send failed: {error}")))?;
        let sync = device_sync_frame(&self.devices, self.generation)?;
        let ready_device_ids = sync
            .credentials
            .iter()
            .map(|credential| credential.device_id.clone())
            .collect::<HashSet<_>>();
        let ready_devices = ready_device_ids.len();
        control
            .send(Message::Text(serde_json::to_string(&sync)?.into()))
            .await
            .map_err(|error| Error::Invalid(format!("relay device sync send failed: {error}")))?;

        let mut acked = false;
        let mut ready = false;
        for _ in 0..8 {
            let Some(frame) =
                tokio::time::timeout(timeouts.device_sync + timeouts.ready, control.next())
                    .await
                    .map_err(|_| Error::Timeout)?
            else {
                return Err(Error::Invalid(
                    "relay host control closed before ready".into(),
                ));
            };
            let frame = frame
                .map_err(|error| Error::Invalid(format!("relay host control failed: {error}")))?;
            let Message::Text(text) = frame else {
                return Err(Error::Invalid("relay host control must be text".into()));
            };
            let value: serde_json::Value = serde_json::from_str(&text)?;
            match value["type"].as_str() {
                Some("host.device-sync.ack")
                    if value["v"] == RELAY_PROTOCOL_VERSION
                        && value["generation"].as_u64() == Some(self.generation) =>
                {
                    acked = true;
                }
                Some("host.ready")
                    if value["v"] == RELAY_PROTOCOL_VERSION
                        && value["generation"].as_u64() == Some(self.generation)
                        && value["routeId"].as_str() == Some(route_id.as_str()) =>
                {
                    ready = true;
                }
                Some("error") => {
                    return Err(Error::Invalid("relay host returned error".into()));
                }
                _ => {}
            }
            if acked && ready {
                return Ok(RelayHostSession {
                    control,
                    url: self.url.clone(),
                    route_id,
                    generation: self.generation,
                    total_devices: self.devices.len(),
                    ready_devices,
                    needs_re_pair: self.devices.len().saturating_sub(ready_devices),
                    ready_device_ids,
                    active_stream_ids: HashSet::new(),
                    timeouts,
                    stream_failures: 0,
                    last_stream_error: None,
                });
            }
        }
        Err(Error::Invalid("relay host did not become ready".into()))
    }
}

impl RelayHostSession {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn status(&self) -> RelayHostSessionStatus {
        RelayRuntimeStatus {
            enabled: true,
            state: RelayConnectionState::Online,
            url: Some(self.url.clone()),
            route_id: Some(self.route_id.clone()),
            updated_at: crate::database::now(),
            last_connected_at: Some(crate::database::now()),
            last_error: None,
            devices: RelayRuntimeDeviceStatus {
                total: self.total_devices,
                ready: self.ready_devices,
                needs_re_pair: self.needs_re_pair,
            },
            active_streams: self.active_stream_ids.len(),
            stream_failures: self.stream_failures,
            last_stream_error: self.last_stream_error.clone(),
        }
    }

    /// Send one `host.heartbeat` and wait for the matching acknowledgement.
    /// The long-lived supervisor uses this as the bounded liveness primitive
    /// before reconnecting a silent relay control socket.
    pub async fn heartbeat_roundtrip(&mut self) -> Result<()> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        self.control
            .send(Message::Text(
                serde_json::json!({
                    "type":"host.heartbeat",
                    "v":RELAY_PROTOCOL_VERSION,
                    "generation":self.generation
                })
                .to_string()
                .into(),
            ))
            .await
            .map_err(|error| Error::Invalid(format!("relay heartbeat send failed: {error}")))?;

        let Some(frame) = tokio::time::timeout(self.timeouts.heartbeat_ack, self.control.next())
            .await
            .map_err(|_| Error::Timeout)?
        else {
            return Err(Error::Invalid(
                "relay host control closed before heartbeat ack".into(),
            ));
        };
        let frame =
            frame.map_err(|error| Error::Invalid(format!("relay heartbeat failed: {error}")))?;
        let Message::Text(text) = frame else {
            return Err(Error::Invalid("relay heartbeat ack must be text".into()));
        };
        let ack: serde_json::Value = serde_json::from_str(&text)?;
        if ack["type"].as_str() == Some("host.heartbeat.ack")
            && ack["v"] == RELAY_PROTOCOL_VERSION
            && ack["generation"].as_u64() == Some(self.generation)
        {
            Ok(())
        } else if ack["type"].as_str() == Some("error") {
            Err(Error::Invalid("relay heartbeat returned error".into()))
        } else {
            Err(Error::Invalid("relay heartbeat ack is invalid".into()))
        }
    }

    /// Wait for one `stream.offer`, open `/v1/stream`, send `stream.accept`,
    /// and return after the relay answers `stream.ready`. The returned stream
    /// is ready to be handed to the E2E SecureChannel forwarding layer.
    pub async fn accept_one_stream(&mut self) -> Result<RelayDataStream> {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::Message;

        loop {
            let Some(frame) = self.control.next().await else {
                return Err(Error::Invalid(
                    "relay host control closed before stream offer".into(),
                ));
            };
            let frame = frame
                .map_err(|error| Error::Invalid(format!("relay host control failed: {error}")))?;
            let Message::Text(text) = frame else {
                return Err(Error::Invalid("relay host control must be text".into()));
            };
            let value: serde_json::Value = serde_json::from_str(&text)?;
            if value["type"].as_str() != Some("stream.offer") {
                continue;
            }
            if value["v"] != RELAY_PROTOCOL_VERSION {
                return Err(Error::Invalid(
                    "relay stream.offer version is invalid".into(),
                ));
            }
            let stream_id = value["streamId"]
                .as_str()
                .ok_or_else(|| Error::Invalid("stream.offer missing streamId".into()))?
                .to_owned();
            let ticket = value["ticket"]
                .as_str()
                .ok_or_else(|| Error::Invalid("stream.offer missing ticket".into()))?
                .to_owned();
            let device_id = value["deviceId"]
                .as_str()
                .ok_or_else(|| Error::Invalid("stream.offer missing deviceId".into()))?
                .to_owned();
            let expires_at = value["expiresAt"]
                .as_u64()
                .ok_or_else(|| Error::Invalid("stream.offer missing expiresAt".into()))?;
            validate_opaque_id(&stream_id, MAX_RELAY_STREAM_ID_CHARS, "streamId")?;
            validate_opaque_id(&ticket, MAX_RELAY_TICKET_CHARS, "stream ticket")?;
            validate_opaque_id(&device_id, MAX_RELAY_DEVICE_ID_CHARS, "deviceId")?;
            if !self.ready_device_ids.contains(&device_id) {
                self.revoke_stream(&stream_id, "revoked").await?;
                continue;
            }
            if expires_at == 0
                || expires_at > MAX_RELAY_EXPIRES_AT_MS
                || expires_at <= crate::database::now() as u64
            {
                self.revoke_stream(&stream_id, "expired").await?;
                continue;
            }
            if self.active_stream_ids.len() >= MAX_ACTIVE_RELAY_STREAMS
                || !self.active_stream_ids.insert(stream_id.clone())
            {
                self.revoke_stream(&stream_id, "normal").await?;
                continue;
            }
            let offer = RelayStreamOffer {
                stream_id,
                ticket,
                device_id,
                expires_at,
            };
            let stream_id = offer.stream_id.clone();
            return match open_relay_stream(self.url.clone(), offer, self.timeouts).await {
                Ok(stream) => Ok(stream),
                Err(error) => {
                    self.active_stream_ids.remove(&stream_id);
                    Err(error)
                }
            };
        }
    }

    pub async fn run<F, Fut>(
        &mut self,
        mut stopping: tokio::sync::watch::Receiver<bool>,
        on_stream: F,
        on_status: impl Fn(RelayRuntimeStatus) + Clone + Send + Sync + 'static,
    ) -> Result<()>
    where
        F: Fn(RelayDataStream) -> Fut + Clone + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<()>> + Send + 'static,
    {
        use futures_util::{FutureExt, SinkExt, StreamExt};
        use tokio::task::JoinSet;
        use tokio::time::{Instant, MissedTickBehavior};
        use tokio_tungstenite::tungstenite::Message;

        let mut heartbeat = tokio::time::interval_at(
            Instant::now() + self.timeouts.heartbeat,
            self.timeouts.heartbeat,
        );
        heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut heartbeat_deadline = None;
        let mut streams: JoinSet<(String, Result<()>)> = JoinSet::new();

        loop {
            tokio::select! {
                changed = stopping.changed() => {
                    if changed.is_err() || *stopping.borrow() {
                        return Ok(());
                    }
                }
                _ = heartbeat.tick(), if heartbeat_deadline.is_none() => {
                    self.control.send(Message::Text(serde_json::json!({
                        "type":"host.heartbeat",
                        "v":RELAY_PROTOCOL_VERSION,
                        "generation":self.generation
                    }).to_string().into())).await
                        .map_err(|error| Error::Invalid(format!("relay heartbeat send failed: {error}")))?;
                    heartbeat_deadline = Some(Instant::now() + self.timeouts.heartbeat_ack);
                }
                _ = async {
                    if let Some(deadline) = heartbeat_deadline {
                        tokio::time::sleep_until(deadline).await;
                    }
                }, if heartbeat_deadline.is_some() => {
                    return Err(Error::Timeout);
                }
                finished = streams.join_next(), if !streams.is_empty() => {
                    if let Some(finished) = finished {
                        match finished {
                            Ok((stream_id, Ok(()))) => {
                                self.active_stream_ids.remove(&stream_id);
                            }
                            Ok((stream_id, Err(error))) => {
                                self.active_stream_ids.remove(&stream_id);
                                self.stream_failures = self.stream_failures.saturating_add(1);
                                self.last_stream_error = Some(error.to_string());
                            }
                            Err(error) => {
                                self.stream_failures = self.stream_failures.saturating_add(1);
                                self.last_stream_error = Some(format!("relay stream task failed: {error}"));
                            }
                        }
                        on_status(self.status());
                    }
                }
                frame = self.control.next() => {
                    let Some(frame) = frame else {
                        return Err(Error::Closed);
                    };
                    let frame = frame
                        .map_err(|error| Error::Invalid(format!("relay host control failed: {error}")))?;
                    let Message::Text(text) = frame else {
                        return Err(Error::Invalid("relay host control must be text".into()));
                    };
                    let value: serde_json::Value = serde_json::from_str(&text)?;
                    match value["type"].as_str() {
                        Some("host.heartbeat.ack")
                            if value["v"] == RELAY_PROTOCOL_VERSION
                                && value["generation"].as_u64() == Some(self.generation) =>
                        {
                            heartbeat_deadline = None;
                        }
                        Some("stream.offer") => {
                            let offer = parse_stream_offer(&value)?;
                            if !self.ready_device_ids.contains(&offer.device_id) {
                                self.revoke_stream(&offer.stream_id, "revoked").await?;
                                continue;
                            }
                            if offer.expires_at <= crate::database::now() as u64
                                || offer.expires_at > MAX_RELAY_EXPIRES_AT_MS
                            {
                                self.revoke_stream(&offer.stream_id, "expired").await?;
                                continue;
                            }
                            if self.active_stream_ids.len() >= MAX_ACTIVE_RELAY_STREAMS
                                || !self.active_stream_ids.insert(offer.stream_id.clone())
                            {
                                self.revoke_stream(&offer.stream_id, "normal").await?;
                                continue;
                            }
                            let url = self.url.clone();
                            let timeouts = self.timeouts;
                            let handler = on_stream.clone();
                            let status_callback = on_status.clone();
                            let stream_id = offer.stream_id.clone();
                            status_callback(self.status());
                            streams.spawn(async move {
                                let result = match open_relay_stream(url, offer, timeouts).await {
                                    Ok(stream) => {
                                        match std::panic::AssertUnwindSafe(handler(stream))
                                            .catch_unwind()
                                            .await
                                        {
                                            Ok(result) => result,
                                            Err(_) => Err(Error::Invalid(
                                                "relay stream task panicked".into(),
                                            )),
                                        }
                                    }
                                    Err(error) => Err(error),
                                };
                                (stream_id, result)
                            });
                        }
                        Some("stream.close" | "stream.revoke") => {}
                        Some("error") => {
                            return Err(Error::Invalid("relay host returned error".into()));
                        }
                        _ => {
                            return Err(Error::Invalid("relay host control is invalid".into()));
                        }
                    }
                }
            }
        }
    }

    async fn revoke_stream(&mut self, stream_id: &str, code: &str) -> Result<()> {
        use futures_util::SinkExt;
        use tokio_tungstenite::tungstenite::Message;

        self.control
            .send(Message::Text(
                serde_json::json!({
                    "type":"stream.revoke",
                    "v":RELAY_PROTOCOL_VERSION,
                    "streamId":stream_id,
                    "code":code
                })
                .to_string()
                .into(),
            ))
            .await
            .map_err(|error| Error::Invalid(format!("relay stream revoke failed: {error}")))
    }
}

#[derive(Clone)]
struct RelayStreamOffer {
    stream_id: String,
    ticket: String,
    device_id: String,
    expires_at: u64,
}

fn parse_stream_offer(value: &serde_json::Value) -> Result<RelayStreamOffer> {
    if value["v"] != RELAY_PROTOCOL_VERSION {
        return Err(Error::Invalid(
            "relay stream.offer version is invalid".into(),
        ));
    }
    let offer = RelayStreamOffer {
        stream_id: value["streamId"]
            .as_str()
            .ok_or_else(|| Error::Invalid("stream.offer missing streamId".into()))?
            .to_owned(),
        ticket: value["ticket"]
            .as_str()
            .ok_or_else(|| Error::Invalid("stream.offer missing ticket".into()))?
            .to_owned(),
        device_id: value["deviceId"]
            .as_str()
            .ok_or_else(|| Error::Invalid("stream.offer missing deviceId".into()))?
            .to_owned(),
        expires_at: value["expiresAt"]
            .as_u64()
            .ok_or_else(|| Error::Invalid("stream.offer missing expiresAt".into()))?,
    };
    validate_opaque_id(&offer.stream_id, MAX_RELAY_STREAM_ID_CHARS, "streamId")?;
    validate_opaque_id(&offer.ticket, MAX_RELAY_TICKET_CHARS, "stream ticket")?;
    validate_opaque_id(&offer.device_id, MAX_RELAY_DEVICE_ID_CHARS, "deviceId")?;
    Ok(offer)
}

fn websocket_config(
    max_payload: usize,
) -> tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
    tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .read_buffer_size(64 * 1024)
        .write_buffer_size(64 * 1024)
        .max_write_buffer_size(max_payload.saturating_mul(2).max(128 * 1024))
        .max_message_size(Some(max_payload))
        .max_frame_size(Some(max_payload))
}

async fn connect_relay_socket(
    endpoint: String,
    max_payload: usize,
    timeout: Duration,
) -> Result<RelayDataStream> {
    tokio::time::timeout(
        timeout,
        tokio_tungstenite::connect_async_with_config(
            endpoint,
            Some(websocket_config(max_payload)),
            true,
        ),
    )
    .await
    .map_err(|_| Error::Timeout)?
    .map(|(socket, _)| socket)
    .map_err(|error| Error::Invalid(format!("relay connection failed: {error}")))
}

async fn open_relay_stream(
    url: String,
    offer: RelayStreamOffer,
    timeouts: RelayTimeouts,
) -> Result<RelayDataStream> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let accept = stream_accept_frame(&offer.stream_id, &offer.ticket)?;
    let endpoint = relay_endpoint(&url, RELAY_STREAM_PATH)?;
    let mut stream =
        connect_relay_socket(endpoint, MAX_RELAY_DATA_FRAME_BYTES, timeouts.auth).await?;
    stream
        .send(Message::Text(serde_json::to_string(&accept)?.into()))
        .await
        .map_err(|error| Error::Invalid(format!("relay stream accept failed: {error}")))?;
    let Some(frame) = tokio::time::timeout(timeouts.ready, stream.next())
        .await
        .map_err(|_| Error::Timeout)?
    else {
        return Err(Error::Invalid("relay stream closed before ready".into()));
    };
    let frame = frame.map_err(|error| Error::Invalid(format!("relay stream failed: {error}")))?;
    let Message::Text(text) = frame else {
        return Err(Error::Invalid("relay stream control must be text".into()));
    };
    let ready: serde_json::Value = serde_json::from_str(&text)?;
    if ready["type"].as_str() != Some("stream.ready")
        || ready["v"] != RELAY_PROTOCOL_VERSION
        || ready["streamId"].as_str() != Some(offer.stream_id.as_str())
    {
        return Err(Error::Invalid("relay stream did not become ready".into()));
    }
    Ok(stream)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RustDaemonStatusSnapshot {
    pub pid: u32,
    pub full_access: bool,
    pub started_at: i64,
    pub built_at: i64,
    pub port: u16,
    pub bind: Option<String>,
    pub control_token: String,
    pub persistence: RustDaemonPersistence,
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<RelayRuntimeStatus>,
    pub session_summary: RustDaemonStatusSummary,
    pub sessions: Vec<RustDaemonStatusSession>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub schedules: Vec<crate::schedules::StatusScheduledAgentTask>,
}

#[derive(Debug)]
pub struct RustDaemonStatusInput {
    pub port: u16,
    pub bind: Option<String>,
    pub control_token: String,
    pub capabilities: Vec<String>,
    pub session_summary: crate::protocol::SessionSummary,
    pub sessions: Vec<crate::protocol::SessionHead>,
    pub schedules: Vec<crate::schedules::StatusScheduledAgentTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RustDaemonStatusSummary {
    pub total: i64,
    pub active: i64,
    pub attention: i64,
    pub terminal: i64,
    pub included: usize,
    pub omitted: i64,
    pub active_limit: usize,
    pub attention_limit: usize,
    pub recent_terminal_limit: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RustDaemonStatusSession {
    pub id: String,
    pub agent: String,
    pub kind: String,
    pub title: String,
    pub cwd: String,
    pub status: String,
    pub pending_permissions: usize,
    pub pending_questions: usize,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub busy_since: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RustDaemonPersistence {
    pub pty: bool,
    pub structured: bool,
}

#[derive(Clone, Debug)]
pub struct RelayStatusHandle {
    home: PathBuf,
    started_at: i64,
    status: Arc<Mutex<Option<RelayRuntimeStatus>>>,
}

#[derive(Debug, Clone, Copy)]
pub struct RelaySupervisorOptions {
    pub timeouts: RelayTimeouts,
    pub config_poll: Duration,
}

impl Default for RelaySupervisorOptions {
    fn default() -> Self {
        Self {
            timeouts: RelayTimeouts::default(),
            config_poll: Duration::from_millis(RELAY_CONFIG_POLL_MS),
        }
    }
}

impl RelayStatusHandle {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self {
            home: home.into(),
            started_at: crate::database::now(),
            status: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set(&self, status: RelayRuntimeStatus) {
        if let Ok(mut current) = self.status.lock() {
            *current = Some(status);
        }
    }

    pub fn get(&self) -> Option<RelayRuntimeStatus> {
        self.status.lock().ok().and_then(|status| status.clone())
    }

    pub fn write_minimal_status(&self, input: RustDaemonStatusInput) -> Result<()> {
        let RustDaemonStatusInput {
            port,
            bind,
            control_token,
            capabilities,
            session_summary,
            sessions,
            schedules,
        } = input;
        let included = sessions.len();
        let terminal = session_summary.archived;
        let omitted = session_summary.total.saturating_sub(included as i64);
        write_status_file(
            &self.home,
            &RustDaemonStatusSnapshot {
                pid: std::process::id(),
                full_access: false,
                started_at: self.started_at,
                built_at: crate::database::now(),
                port,
                bind,
                control_token,
                persistence: RustDaemonPersistence {
                    pty: true,
                    structured: true,
                },
                capabilities,
                relay: self.get(),
                session_summary: RustDaemonStatusSummary {
                    total: session_summary.total,
                    active: session_summary.active,
                    attention: session_summary.attention,
                    terminal,
                    included,
                    omitted,
                    active_limit: 100,
                    attention_limit: 100,
                    recent_terminal_limit: 20,
                    truncated: omitted > 0,
                },
                sessions: sessions
                    .into_iter()
                    .map(RustDaemonStatusSession::from)
                    .collect(),
                schedules,
            },
        )
    }
}

impl From<crate::protocol::SessionHead> for RustDaemonStatusSession {
    fn from(head: crate::protocol::SessionHead) -> Self {
        let status = match head.status {
            crate::protocol::SessionStatus::WaitingPermission => "waiting_approval",
            crate::protocol::SessionStatus::WaitingInput => "waiting_input",
            crate::protocol::SessionStatus::Starting => "starting",
            crate::protocol::SessionStatus::Running => "running",
            crate::protocol::SessionStatus::Idle => "idle",
            crate::protocol::SessionStatus::Completed => "completed",
            crate::protocol::SessionStatus::Failed => "failed",
        };
        Self {
            id: head.id,
            agent: serde_json::to_value(head.agent)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| "shell".into()),
            kind: serde_json::to_value(head.kind)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| "pty".into()),
            title: head.title,
            cwd: head.workspace,
            status: status.into(),
            pending_permissions: usize::from(
                head.status == crate::protocol::SessionStatus::WaitingPermission,
            ),
            pending_questions: usize::from(
                head.status == crate::protocol::SessionStatus::WaitingInput,
            ),
            created_at: head.created_at,
            busy_since: head.busy_since,
        }
    }
}

pub async fn serve_configured_relay_once<F, Fut>(
    home: PathBuf,
    dev_mode: bool,
    status: RelayStatusHandle,
    on_stream: F,
) -> Result<()>
where
    F: FnOnce(
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        ) -> Fut
        + Send,
    Fut: std::future::Future<Output = ()> + Send,
{
    let config = load_daemon_relay_config(&home)?;
    let devices = crate::pairing::load_devices(&home)?;
    status.set(relay_status_from_config(&config, &devices, dev_mode));
    let Some(client) = relay_client_from_config(&home, &config, dev_mode)? else {
        return Ok(());
    };
    let mut session = client.connect_once().await?;
    status.set(session.status());
    let stream = session.accept_one_stream().await?;
    on_stream(stream).await;
    Ok(())
}

pub async fn run_relay_supervisor(
    home: PathBuf,
    local_ws_url: String,
    dev_mode: bool,
    status: RelayStatusHandle,
    mut stopping: tokio::sync::watch::Receiver<bool>,
    options: RelaySupervisorOptions,
) {
    let mut attempts = 0u32;
    loop {
        if *stopping.borrow() {
            return;
        }
        let loaded = load_relay_target(&home, dev_mode);
        let target = match loaded {
            Ok(Some(target)) => target,
            Ok(None) => {
                let devices = crate::pairing::load_devices(&home).unwrap_or_default();
                status.set(publish_status(
                    RelayConnectionState::Disabled,
                    None,
                    None,
                    None,
                    &devices,
                    0,
                    crate::database::now(),
                ));
                if wait_or_stop(options.config_poll, &mut stopping).await {
                    return;
                }
                attempts = 0;
                continue;
            }
            Err(_) => {
                status.set(publish_status(
                    RelayConnectionState::Error,
                    None,
                    None,
                    Some("relay configuration".into()),
                    &[],
                    0,
                    crate::database::now(),
                ));
                if wait_or_stop(reconnect_delay(attempts, options.timeouts), &mut stopping).await {
                    return;
                }
                attempts = attempts.saturating_add(1);
                continue;
            }
        };
        status.set(publish_status(
            RelayConnectionState::Connecting,
            Some(target.url.clone()),
            Some(target.route_id.clone()),
            None,
            &target.devices,
            0,
            crate::database::now(),
        ));
        let mut journal = RelayGenerationJournal::load(&home);
        let generation = match journal.next_generation(&target.route_id) {
            Ok(generation) => generation,
            Err(_) => {
                set_relay_error(&status, &target, "relay state");
                if wait_or_stop(reconnect_delay(attempts, options.timeouts), &mut stopping).await {
                    return;
                }
                attempts = attempts.saturating_add(1);
                continue;
            }
        };
        let client = RelayHostClient::new(
            target.url.clone(),
            target.host_secret.clone(),
            target.devices.clone(),
            generation,
        );
        let mut session = match client.connect_once_with_timeouts(options.timeouts).await {
            Ok(session) => session,
            Err(_) => {
                set_relay_error(&status, &target, "relay network");
                if wait_or_stop(reconnect_delay(attempts, options.timeouts), &mut stopping).await {
                    return;
                }
                attempts = attempts.saturating_add(1);
                continue;
            }
        };
        attempts = 0;
        status.set(session.status());
        let proxy_url = local_ws_url.clone();
        let proxy_stop = stopping.clone();
        let status_update = status.clone();
        let run = session.run(
            stopping.clone(),
            move |stream| {
                let local_ws_url = proxy_url.clone();
                let stopping = proxy_stop.clone();
                async move { proxy_relay_stream(stream, local_ws_url, stopping).await }
            },
            move |next| status_update.set(next),
        );
        tokio::pin!(run);
        let mut poll = tokio::time::interval(options.config_poll);
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let disconnected = loop {
            tokio::select! {
                result = &mut run => break Some(result),
                changed = stopping.changed() => {
                    if changed.is_err() || *stopping.borrow() {
                        break None;
                    }
                }
                _ = poll.tick() => {
                    if !relay_target_unchanged(&home, dev_mode, &target) {
                        break None;
                    }
                }
            }
        };
        if *stopping.borrow() {
            return;
        }
        if disconnected.is_some() {
            set_relay_error(&status, &target, "relay network");
            if wait_or_stop(reconnect_delay(attempts, options.timeouts), &mut stopping).await {
                return;
            }
            attempts = attempts.saturating_add(1);
        }
    }
}

async fn proxy_relay_stream(
    mut relay: RelayDataStream,
    local_ws_url: String,
    mut stopping: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let mut local = connect_relay_socket(
        local_ws_url,
        MAX_RELAY_DATA_FRAME_BYTES,
        Duration::from_millis(AUTH_TIMEOUT_MS),
    )
    .await?;
    loop {
        tokio::select! {
            changed = stopping.changed() => {
                if changed.is_err() || *stopping.borrow() {
                    break;
                }
            }
            frame = relay.next() => {
                let Some(frame) = frame else { break; };
                let frame = frame.map_err(|_| Error::Closed)?;
                match frame {
                    Message::Text(_) | Message::Binary(_) => {
                        local.send(frame).await.map_err(|_| Error::Closed)?;
                    }
                    Message::Ping(bytes) => {
                        relay.send(Message::Pong(bytes)).await.map_err(|_| Error::Closed)?;
                    }
                    Message::Pong(_) => {}
                    Message::Close(_) => break,
                    Message::Frame(_) => return Err(Error::Invalid("relay data frame is invalid".into())),
                }
            }
            frame = local.next() => {
                let Some(frame) = frame else { break; };
                let frame = frame.map_err(|_| Error::Closed)?;
                match frame {
                    Message::Text(_) | Message::Binary(_) => {
                        relay.send(frame).await.map_err(|_| Error::Closed)?;
                    }
                    Message::Ping(bytes) => {
                        local.send(Message::Pong(bytes)).await.map_err(|_| Error::Closed)?;
                    }
                    Message::Pong(_) => {}
                    Message::Close(_) => break,
                    Message::Frame(_) => return Err(Error::Invalid("local data frame is invalid".into())),
                }
            }
        }
    }
    let _ = local.close(None).await;
    let _ = relay.close(None).await;
    Ok(())
}

fn load_relay_target(home: &Path, dev_mode: bool) -> Result<Option<RelayTarget>> {
    let config = load_daemon_relay_config(home)?;
    let devices = crate::pairing::load_devices(home)?;
    relay_target_from_config(&config, devices, dev_mode)
}

fn relay_target_unchanged(home: &Path, dev_mode: bool, expected: &RelayTarget) -> bool {
    load_relay_target(home, dev_mode)
        .ok()
        .flatten()
        .is_some_and(|current| {
            current.url == expected.url
                && current.route_id == expected.route_id
                && current.credential_fingerprint == expected.credential_fingerprint
        })
}

fn set_relay_error(status: &RelayStatusHandle, target: &RelayTarget, message: &str) {
    let current = status.get();
    let last_connected_at = current
        .as_ref()
        .and_then(|current| current.last_connected_at);
    let active_streams = current
        .as_ref()
        .map(|current| current.active_streams)
        .unwrap_or(0);
    let stream_failures = current
        .as_ref()
        .map(|current| current.stream_failures)
        .unwrap_or(0);
    let last_stream_error = current.and_then(|current| current.last_stream_error);
    let mut next = publish_status(
        RelayConnectionState::Error,
        Some(target.url.clone()),
        Some(target.route_id.clone()),
        Some(message.into()),
        &target.devices,
        0,
        crate::database::now(),
    );
    next.last_connected_at = last_connected_at;
    next.active_streams = active_streams;
    next.stream_failures = stream_failures;
    next.last_stream_error = last_stream_error;
    status.set(next);
}

fn reconnect_delay(attempt: u32, timeouts: RelayTimeouts) -> Duration {
    let exponent = attempt.min(10);
    let factor = 1u32 << exponent;
    timeouts
        .min_reconnect
        .checked_mul(factor)
        .unwrap_or(timeouts.max_reconnect)
        .min(timeouts.max_reconnect)
}

async fn wait_or_stop(delay: Duration, stopping: &mut tokio::sync::watch::Receiver<bool>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(delay) => false,
        changed = stopping.changed() => changed.is_err() || *stopping.borrow(),
    }
}

pub fn write_status_file(home: &Path, snapshot: &RustDaemonStatusSnapshot) -> Result<()> {
    fs::create_dir_all(home)?;
    let destination = home.join("status.json");
    let temporary = home.join(format!(
        ".status.json.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let bytes = serde_json::to_vec_pretty(snapshot)?;
    let result = (|| -> Result<()> {
        fs::write(&temporary, [bytes, b"\n".to_vec()].concat())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
        }
        fs::rename(&temporary, destination)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
mod runtime_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn config_status_and_generation_journal_match_ts_relay_contract() {
        let home = tempfile::TempDir::new().unwrap();
        let config = serde_json::json!({
            "port": 7423,
            "relay": {
                "enabled": true,
                "url": "wss://relay.example.com/root",
                "hostSecret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            }
        });
        fs::write(home.path().join("config.json"), config.to_string()).unwrap();
        let loaded = load_daemon_relay_config(home.path()).unwrap();
        assert_eq!(
            effective_relay_url(&loaded).as_deref(),
            Some("wss://relay.example.com/root")
        );

        let devices = vec![
            DeviceRecord {
                name: "ready".into(),
                token: "pairing-token".into(),
                client_pub_key: None,
                allow_shell: true,
                allow_orchestration: None,
                relay_device_id: Some("device-id-abcdefgh".into()),
                relay_token: Some("relay-token-abcdefghijkl".into()),
                relay_credential_issued: Some(true),
                created_at: 1,
                last_seen_at: None,
            },
            DeviceRecord {
                name: "legacy".into(),
                token: "pairing-token-2".into(),
                client_pub_key: None,
                allow_shell: true,
                allow_orchestration: None,
                relay_device_id: None,
                relay_token: None,
                relay_credential_issued: None,
                created_at: 1,
                last_seen_at: None,
            },
        ];
        let status = relay_status_from_config(&loaded, &devices, false);
        assert!(status.enabled);
        assert_eq!(status.state, RelayConnectionState::Connecting);
        assert_eq!(
            status.route_id.as_deref(),
            Some("CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk")
        );
        assert_eq!(status.devices.total, 2);
        assert_eq!(status.devices.ready, 0);
        assert_eq!(status.devices.needs_re_pair, 1);

        let mut journal = RelayGenerationJournal::load(home.path());
        assert_eq!(
            journal.generation_for(status.route_id.as_ref().unwrap()),
            None
        );
        assert_eq!(
            journal
                .next_generation(status.route_id.as_ref().unwrap())
                .unwrap(),
            1
        );
        assert_eq!(
            journal
                .next_generation(status.route_id.as_ref().unwrap())
                .unwrap(),
            2
        );
        let reloaded = RelayGenerationJournal::load(home.path());
        assert_eq!(
            reloaded.generation_for(status.route_id.as_ref().unwrap()),
            Some(2)
        );
    }

    #[test]
    fn device_sync_rejects_duplicate_relay_device_ids() {
        let mut devices = Vec::new();
        for name in ["one", "two"] {
            devices.push(DeviceRecord {
                name: name.into(),
                token: format!("relay-token-{name}-abcdefghijkl"),
                client_pub_key: None,
                allow_shell: true,
                allow_orchestration: None,
                relay_device_id: Some("device-id-abcdefgh".into()),
                relay_token: Some(format!("relay-token-{name}-abcdefghijkl")),
                relay_credential_issued: Some(true),
                created_at: 1,
                last_seen_at: None,
            });
        }
        assert!(device_sync_frame(&devices, 1).is_err());
    }

    #[test]
    fn relay_status_handle_writes_status_snapshot_with_relay() {
        let home = tempfile::TempDir::new().unwrap();
        let handle = RelayStatusHandle::new(home.path());
        handle.set(publish_status(
            RelayConnectionState::Offline,
            Some("wss://relay.example.com".into()),
            Some("CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk".into()),
            Some("relay network".into()),
            &[],
            0,
            5,
        ));
        handle
            .write_minimal_status(RustDaemonStatusInput {
                port: 7423,
                bind: Some("127.0.0.1".into()),
                control_token: "local-control-token".into(),
                capabilities: vec!["relay.host.v1".into()],
                session_summary: crate::protocol::SessionSummary::default(),
                sessions: Vec::new(),
                schedules: Vec::new(),
            })
            .unwrap();
        let status: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(home.path().join("status.json")).unwrap())
                .unwrap();
        assert_eq!(status["relay"]["state"], "offline");
        assert_eq!(status["relay"]["lastError"], "relay network");
        assert_eq!(status["capabilities"][0], "relay.host.v1");
    }

    #[test]
    fn relay_client_from_config_advances_generation_and_status_file_is_safe() {
        let home = tempfile::TempDir::new().unwrap();
        fs::write(
            home.path().join("config.json"),
            serde_json::json!({
                "relay": {
                    "enabled": true,
                    "url": "wss://relay.example.com/root",
                    "hostSecret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            home.path().join("devices.json"),
            serde_json::json!({"devices":[{
                "name":"ready",
                "token":"pairing-token",
                "allowShell":true,
                "relayDeviceId":"device-id-abcdefgh",
                "relayToken":"relay-token-abcdefghijkl",
                "relayCredentialIssued":true,
                "createdAt":1
            }]})
            .to_string(),
        )
        .unwrap();
        let config = load_daemon_relay_config(home.path()).unwrap();
        let client = relay_client_from_config(home.path(), &config, false)
            .unwrap()
            .unwrap();
        assert_eq!(client.generation, 1);
        let second = relay_client_from_config(home.path(), &config, false)
            .unwrap()
            .unwrap();
        assert_eq!(second.generation, 2);

        let relay = relay_status_from_config(&config, &second.devices, false);
        let snapshot = RustDaemonStatusSnapshot {
            pid: 7,
            full_access: false,
            started_at: 1,
            built_at: 2,
            port: 7423,
            bind: Some("127.0.0.1".into()),
            control_token: "local-control-token".into(),
            persistence: RustDaemonPersistence {
                pty: true,
                structured: true,
            },
            capabilities: vec!["relay.host.v1".into()],
            relay: Some(relay),
            session_summary: RustDaemonStatusSummary {
                total: 0,
                active: 0,
                attention: 0,
                terminal: 0,
                included: 0,
                omitted: 0,
                active_limit: 100,
                attention_limit: 100,
                recent_terminal_limit: 20,
                truncated: false,
            },
            sessions: Vec::new(),
            schedules: Vec::new(),
        };
        write_status_file(home.path(), &snapshot).unwrap();
        let status = fs::read_to_string(home.path().join("status.json")).unwrap();
        assert!(status.contains("relay.host.v1"));
        assert!(!status.contains("hostSecret"));
        assert!(!status.contains("relay-token-abcdefghijkl"));
        assert!(!status.contains("ticket"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(home.path().join("status.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn host_session_sends_bounded_heartbeat_roundtrip() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::accept_async;
        use tokio_tungstenite::tungstenite::Message;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (host_tcp, _) = listener.accept().await.unwrap();
            let mut host = accept_async(host_tcp).await.unwrap();
            let _auth = host.next().await.unwrap().unwrap();
            let _sync = host.next().await.unwrap().unwrap();
            host.send(Message::Text(
                json!({"type":"host.device-sync.ack","v":RELAY_PROTOCOL_VERSION,"generation":3})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
            host.send(Message::Text(
                json!({
                    "type":"host.ready",
                    "v":RELAY_PROTOCOL_VERSION,
                    "routeId":"CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk",
                    "generation":3
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
            let heartbeat = match host.next().await.unwrap().unwrap() {
                Message::Text(text) => serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                other => panic!("unexpected heartbeat frame: {other:?}"),
            };
            assert_eq!(
                heartbeat,
                json!({"type":"host.heartbeat","v":RELAY_PROTOCOL_VERSION,"generation":3})
            );
            host.send(Message::Text(
                json!({"type":"host.heartbeat.ack","v":RELAY_PROTOCOL_VERSION,"generation":3})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        });

        let client = RelayHostClient::new(
            format!("ws://127.0.0.1:{addr_port}", addr_port = addr.port()),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
            Vec::new(),
            3,
        );
        let mut session = client.connect_once().await.unwrap();
        session.heartbeat_roundtrip().await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn host_client_connects_syncs_and_accepts_stream_offer() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::accept_async;
        use tokio_tungstenite::tungstenite::Message;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (host_tcp, _) = listener.accept().await.unwrap();
            let mut host = accept_async(host_tcp).await.unwrap();
            let auth = match host.next().await.unwrap().unwrap() {
                Message::Text(text) => serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                other => panic!("unexpected host auth frame: {other:?}"),
            };
            assert_eq!(auth["v"], RELAY_PROTOCOL_VERSION);
            assert_eq!(
                auth["routeId"],
                "CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk"
            );
            assert_eq!(
                auth["hostSecret"],
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            );
            let sync = match host.next().await.unwrap().unwrap() {
                Message::Text(text) => serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                other => panic!("unexpected host sync frame: {other:?}"),
            };
            assert_eq!(sync["type"], "host.device-sync");
            assert_eq!(sync["generation"], 11);
            assert_eq!(sync["credentials"].as_array().unwrap().len(), 1);
            host.send(Message::Text(
                json!({
                    "type":"host.device-sync.ack",
                    "v":RELAY_PROTOCOL_VERSION,
                    "generation":11
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
            host.send(Message::Text(
                json!({
                    "type":"host.ready",
                    "v":RELAY_PROTOCOL_VERSION,
                    "routeId":"CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk",
                    "generation":11
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
            host.send(Message::Text(
                json!({
                    "type":"stream.offer",
                    "v":RELAY_PROTOCOL_VERSION,
                    "streamId":"stream-abcdefghij",
                    "ticket":"ticket-abcdefghijkl",
                    "deviceId":"device-id-abcdefgh",
                    "expiresAt": 8_640_000_000_000_000u64
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

            let (stream_tcp, _) = listener.accept().await.unwrap();
            let mut stream = accept_async(stream_tcp).await.unwrap();
            let accept = match stream.next().await.unwrap().unwrap() {
                Message::Text(text) => serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                other => panic!("unexpected stream accept frame: {other:?}"),
            };
            assert_eq!(
                accept,
                json!({
                    "type":"stream.accept",
                    "v":RELAY_PROTOCOL_VERSION,
                    "streamId":"stream-abcdefghij",
                    "ticket":"ticket-abcdefghijkl"
                })
            );
            stream
                .send(Message::Text(
                    json!({
                        "type":"stream.ready",
                        "v":RELAY_PROTOCOL_VERSION,
                        "streamId":"stream-abcdefghij"
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
        });

        let devices = vec![DeviceRecord {
            name: "ready".into(),
            token: "pairing-token".into(),
            client_pub_key: None,
            allow_shell: true,
            allow_orchestration: None,
            relay_device_id: Some("device-id-abcdefgh".into()),
            relay_token: Some("relay-token-abcdefghijkl".into()),
            relay_credential_issued: Some(true),
            created_at: 1,
            last_seen_at: None,
        }];
        let client = RelayHostClient::new(
            format!("ws://127.0.0.1:{addr_port}", addr_port = addr.port()),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
            devices,
            11,
        );
        let mut session = client.connect_once().await.unwrap();
        assert_eq!(session.status().state, RelayConnectionState::Online);
        assert_eq!(session.status().devices.ready, 1);
        let _stream = session.accept_one_stream().await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn host_session_reports_stream_failure_without_dropping_control() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::accept_async;
        use tokio_tungstenite::tungstenite::Message;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (host_tcp, _) = listener.accept().await.unwrap();
            let mut host = accept_async(host_tcp).await.unwrap();
            let _auth = host.next().await.unwrap().unwrap();
            let _sync = host.next().await.unwrap().unwrap();
            host.send(Message::Text(
                json!({"type":"host.device-sync.ack","v":RELAY_PROTOCOL_VERSION,"generation":12})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
            host.send(Message::Text(
                json!({
                    "type":"host.ready",
                    "v":RELAY_PROTOCOL_VERSION,
                    "routeId":"CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk",
                    "generation":12
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
            host.send(Message::Text(
                json!({
                    "type":"stream.offer",
                    "v":RELAY_PROTOCOL_VERSION,
                    "streamId":"stream-failure-abc",
                    "ticket":"ticket-abcdefghijkl",
                    "deviceId":"device-id-abcdefgh",
                    "expiresAt":MAX_RELAY_EXPIRES_AT_MS
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

            let (stream_tcp, _) = listener.accept().await.unwrap();
            let mut stream = accept_async(stream_tcp).await.unwrap();
            let accept = match stream.next().await.unwrap().unwrap() {
                Message::Text(text) => serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                other => panic!("unexpected stream accept frame: {other:?}"),
            };
            assert_eq!(accept["streamId"], "stream-failure-abc");
            stream
                .send(Message::Text(
                    json!({
                        "type":"stream.ready",
                        "v":RELAY_PROTOCOL_VERSION,
                        "streamId":"stream-failure-abc"
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
        });

        let devices = vec![DeviceRecord {
            name: "ready".into(),
            token: "pairing-token".into(),
            client_pub_key: None,
            allow_shell: true,
            allow_orchestration: None,
            relay_device_id: Some("device-id-abcdefgh".into()),
            relay_token: Some("relay-token-abcdefghijkl".into()),
            relay_credential_issued: Some(true),
            created_at: 1,
            last_seen_at: None,
        }];
        let client = RelayHostClient::new(
            format!("ws://127.0.0.1:{addr_port}", addr_port = addr.port()),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
            devices,
            12,
        );
        let mut session = client
            .connect_once_with_timeouts(RelayTimeouts {
                heartbeat: Duration::from_millis(30),
                ..RelayTimeouts::default()
            })
            .await
            .unwrap();
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let observed = statuses.clone();
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let run = tokio::spawn(async move {
            session
                .run(
                    stop_rx,
                    |_| async { Err(Error::Invalid("local websocket proxy failed".into())) },
                    move |status| observed.lock().unwrap().push(status),
                )
                .await
        });
        let failed = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(status) = statuses
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|status| status.stream_failures == 1)
                    .cloned()
                {
                    break status;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(failed.active_streams, 0);
        assert_eq!(
            failed.last_stream_error.as_deref(),
            Some("invalid request: local websocket proxy failed")
        );
        assert!(
            statuses
                .lock()
                .unwrap()
                .iter()
                .any(|status| status.active_streams == 1)
        );
        assert!(!run.is_finished());
        stop_tx.send_replace(true);
        tokio::time::timeout(Duration::from_secs(1), run)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn supervisor_publishes_disabled_status_when_config_is_disabled() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::accept_async;
        use tokio_tungstenite::tungstenite::Message;

        let home = tempfile::TempDir::new().unwrap();
        let relay_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay_addr = relay_listener.local_addr().unwrap();
        fs::write(
            home.path().join("config.json"),
            json!({
                "relay": {
                    "enabled": true,
                    "url": format!("ws://127.0.0.1:{}", relay_addr.port()),
                    "hostSecret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            home.path().join("devices.json"),
            json!({"devices":[{
                "name":"phone",
                "token":"pairing-token-abcdefghijkl",
                "allowShell":true,
                "relayDeviceId":"device-id-abcdefgh",
                "relayToken":"relay-token-abcdefghijkl",
                "relayCredentialIssued":true,
                "createdAt":1
            }]})
            .to_string(),
        )
        .unwrap();

        let relay = tokio::spawn(async move {
            let (host_tcp, _) = relay_listener.accept().await.unwrap();
            let mut host = accept_async(host_tcp).await.unwrap();
            let _auth = host.next().await.unwrap().unwrap();
            let sync = match host.next().await.unwrap().unwrap() {
                Message::Text(text) => serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                other => panic!("unexpected sync frame: {other:?}"),
            };
            let generation = sync["generation"].as_u64().unwrap();
            host.send(Message::Text(
                json!({"type":"host.device-sync.ack","v":RELAY_PROTOCOL_VERSION,"generation":generation})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
            host.send(Message::Text(
                json!({
                    "type":"host.ready",
                    "v":RELAY_PROTOCOL_VERSION,
                    "routeId":"CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk",
                    "generation":generation
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
            let _ = tokio::time::timeout(Duration::from_secs(2), host.next()).await;
        });

        let status = RelayStatusHandle::new(home.path());
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let options = RelaySupervisorOptions {
            timeouts: RelayTimeouts {
                auth: Duration::from_secs(1),
                device_sync: Duration::from_millis(100),
                ready: Duration::from_millis(100),
                heartbeat: Duration::from_secs(30),
                heartbeat_ack: Duration::from_millis(100),
                min_reconnect: Duration::from_millis(10),
                max_reconnect: Duration::from_millis(20),
            },
            config_poll: Duration::from_millis(20),
        };
        let supervisor = tokio::spawn(run_relay_supervisor(
            home.path().to_path_buf(),
            "ws://127.0.0.1:9/ws".into(),
            true,
            status.clone(),
            stop_rx,
            options,
        ));
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if status
                    .get()
                    .is_some_and(|status| status.state == RelayConnectionState::Online)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        fs::write(
            home.path().join("config.json"),
            json!({
                "relay": {
                    "enabled": false,
                    "url": format!("ws://127.0.0.1:{}", relay_addr.port()),
                    "hostSecret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                }
            })
            .to_string(),
        )
        .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if status
                    .get()
                    .is_some_and(|status| status.state == RelayConnectionState::Disabled)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        stop_tx.send_replace(true);
        tokio::time::timeout(Duration::from_secs(1), supervisor)
            .await
            .unwrap()
            .unwrap();
        relay.await.unwrap();
    }

    #[tokio::test]
    async fn supervisor_reconnects_when_relay_url_changes() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::accept_async;
        use tokio_tungstenite::tungstenite::Message;

        let home = tempfile::TempDir::new().unwrap();
        let first_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let first_addr = first_listener.local_addr().unwrap();
        let second_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second_addr = second_listener.local_addr().unwrap();
        fs::write(
            home.path().join("config.json"),
            json!({
                "relay": {
                    "enabled": true,
                    "url": format!("ws://127.0.0.1:{}", first_addr.port()),
                    "hostSecret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            home.path().join("devices.json"),
            json!({"devices":[{
                "name":"phone",
                "token":"pairing-token-abcdefghijkl",
                "allowShell":true,
                "relayDeviceId":"device-id-abcdefgh",
                "relayToken":"relay-token-abcdefghijkl",
                "relayCredentialIssued":true,
                "createdAt":1
            }]})
            .to_string(),
        )
        .unwrap();

        let first_relay = tokio::spawn(async move {
            let (host_tcp, _) = first_listener.accept().await.unwrap();
            let mut host = accept_async(host_tcp).await.unwrap();
            let _auth = host.next().await.unwrap().unwrap();
            let sync = match host.next().await.unwrap().unwrap() {
                Message::Text(text) => serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                other => panic!("unexpected first sync frame: {other:?}"),
            };
            let generation = sync["generation"].as_u64().unwrap();
            assert_eq!(generation, 1);
            host.send(Message::Text(
                json!({"type":"host.device-sync.ack","v":RELAY_PROTOCOL_VERSION,"generation":generation})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
            host.send(Message::Text(
                json!({
                    "type":"host.ready",
                    "v":RELAY_PROTOCOL_VERSION,
                    "routeId":"CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk",
                    "generation":generation
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
            match tokio::time::timeout(Duration::from_secs(2), host.next())
                .await
                .unwrap()
            {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => {}
                Some(Ok(other)) => panic!("unexpected frame after config change: {other:?}"),
            }
        });
        let second_relay = tokio::spawn(async move {
            let (host_tcp, _) = second_listener.accept().await.unwrap();
            let mut host = accept_async(host_tcp).await.unwrap();
            let _auth = host.next().await.unwrap().unwrap();
            let sync = match host.next().await.unwrap().unwrap() {
                Message::Text(text) => serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                other => panic!("unexpected second sync frame: {other:?}"),
            };
            let generation = sync["generation"].as_u64().unwrap();
            assert_eq!(generation, 2);
            host.send(Message::Text(
                json!({"type":"host.device-sync.ack","v":RELAY_PROTOCOL_VERSION,"generation":generation})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
            host.send(Message::Text(
                json!({
                    "type":"host.ready",
                    "v":RELAY_PROTOCOL_VERSION,
                    "routeId":"CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk",
                    "generation":generation
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
            let _ = tokio::time::timeout(Duration::from_secs(2), host.next()).await;
        });

        let status = RelayStatusHandle::new(home.path());
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let options = RelaySupervisorOptions {
            timeouts: RelayTimeouts {
                auth: Duration::from_secs(1),
                device_sync: Duration::from_millis(100),
                ready: Duration::from_millis(100),
                heartbeat: Duration::from_secs(30),
                heartbeat_ack: Duration::from_millis(100),
                min_reconnect: Duration::from_millis(10),
                max_reconnect: Duration::from_millis(20),
            },
            config_poll: Duration::from_millis(20),
        };
        let supervisor = tokio::spawn(run_relay_supervisor(
            home.path().to_path_buf(),
            "ws://127.0.0.1:9/ws".into(),
            true,
            status.clone(),
            stop_rx,
            options,
        ));
        let first_url = format!("ws://127.0.0.1:{}", first_addr.port());
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if status.get().is_some_and(|status| {
                    status.state == RelayConnectionState::Online
                        && status.url.as_deref() == Some(first_url.as_str())
                }) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let second_url = format!("ws://127.0.0.1:{}", second_addr.port());
        fs::write(
            home.path().join("config.json"),
            json!({
                "relay": {
                    "enabled": true,
                    "url": second_url,
                    "hostSecret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                }
            })
            .to_string(),
        )
        .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if status.get().is_some_and(|status| {
                    status.state == RelayConnectionState::Online
                        && status.url.as_deref() == Some(second_url.as_str())
                }) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            RelayGenerationJournal::load(home.path())
                .generation_for("CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk"),
            Some(2)
        );
        stop_tx.send_replace(true);
        tokio::time::timeout(Duration::from_secs(1), supervisor)
            .await
            .unwrap()
            .unwrap();
        first_relay.await.unwrap();
        second_relay.await.unwrap();
    }

    #[tokio::test]
    async fn supervisor_reconnects_and_proxies_relay_streams() {
        use base64::Engine;
        use base64::prelude::BASE64_STANDARD;
        use crypto_box::aead::Aead;
        use crypto_box::{Nonce, PublicKey, SalsaBox, SecretKey};
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::accept_async;
        use tokio_tungstenite::tungstenite::Message;

        fn key_b64(key: &[u8; 32]) -> String {
            BASE64_STANDARD.encode(key)
        }
        fn nonce(dir: u8, count: u64) -> [u8; 24] {
            let mut nonce = [0; 24];
            nonce[0] = dir;
            nonce[1..9].copy_from_slice(&count.to_be_bytes());
            nonce
        }
        fn seal(cipher: &SalsaBox, send_count: &mut u64, value: &serde_json::Value) -> String {
            let bytes = serde_json::to_vec(value).unwrap();
            let encrypted = cipher
                .encrypt(&Nonce::from(nonce(1, *send_count)), bytes.as_slice())
                .unwrap();
            *send_count += 1;
            json!({"c": BASE64_STANDARD.encode(encrypted)}).to_string()
        }
        fn open(cipher: &SalsaBox, recv_count: &mut u64, frame: &str) -> serde_json::Value {
            let value: serde_json::Value = serde_json::from_str(frame).unwrap();
            let encrypted = BASE64_STANDARD
                .decode(value["c"].as_str().unwrap())
                .unwrap();
            let plain = cipher
                .decrypt(&Nonce::from(nonce(2, *recv_count)), encrypted.as_slice())
                .unwrap();
            *recv_count += 1;
            serde_json::from_slice(&plain).unwrap()
        }

        let home = tempfile::TempDir::new().unwrap();
        let relay_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay_addr = relay_listener.local_addr().unwrap();
        let daemon_secret = SecretKey::from([9u8; 32]);
        fs::write(
            home.path().join("identity.json"),
            json!({
                "publicKey": key_b64(daemon_secret.public_key().as_bytes()),
                "secretKey": key_b64(&[9u8; 32])
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            home.path().join("config.json"),
            json!({
                "relay": {
                    "enabled": true,
                    "url": format!("ws://127.0.0.1:{}", relay_addr.port()),
                    "hostSecret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            home.path().join("devices.json"),
            json!({"devices":[{
                "name":"phone",
                "token":"pairing-token-abcdefghijkl",
                "allowShell":true,
                "relayDeviceId":"device-id-abcdefgh",
                "relayToken":"relay-token-abcdefghijkl",
                "relayCredentialIssued":true,
                "createdAt":1
            }]})
            .to_string(),
        )
        .unwrap();

        let local_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_addr = local_listener.local_addr().unwrap();
        let database = crate::worker::Database::open(home.path().to_path_buf())
            .await
            .unwrap();
        let local_api = crate::server::Api::new(
            database,
            crate::auth::Token::parse(
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
            )
            .unwrap(),
        );
        let local_server_api = local_api.clone();
        let local_server = tokio::spawn(async move {
            axum::serve(local_listener, local_server_api.router())
                .await
                .unwrap();
        });

        let relay = tokio::spawn(async move {
            let (first_tcp, _) = relay_listener.accept().await.unwrap();
            let mut first = accept_async(first_tcp).await.unwrap();
            let _ = first.next().await.unwrap().unwrap();
            let _ = first.next().await.unwrap().unwrap();
            drop(first);

            let (host_tcp, _) = relay_listener.accept().await.unwrap();
            let mut host = accept_async(host_tcp).await.unwrap();
            let _ = host.next().await.unwrap().unwrap();
            let sync = match host.next().await.unwrap().unwrap() {
                Message::Text(text) => serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                other => panic!("unexpected sync frame: {other:?}"),
            };
            let generation = sync["generation"].as_u64().unwrap();
            host.send(Message::Text(
                json!({"type":"host.device-sync.ack","v":RELAY_PROTOCOL_VERSION,"generation":generation})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
            host.send(Message::Text(
                json!({
                    "type":"host.ready",
                    "v":RELAY_PROTOCOL_VERSION,
                    "routeId":"CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk",
                    "generation":generation
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
            let heartbeat = match host.next().await.unwrap().unwrap() {
                Message::Text(text) => serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                other => panic!("unexpected heartbeat: {other:?}"),
            };
            assert_eq!(heartbeat["type"], "host.heartbeat");
            assert_eq!(heartbeat["generation"], generation);
            host.send(Message::Text(
                json!({"type":"host.heartbeat.ack","v":RELAY_PROTOCOL_VERSION,"generation":generation})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
            host.send(Message::Text(
                json!({
                    "type":"stream.offer",
                    "v":RELAY_PROTOCOL_VERSION,
                    "streamId":"stream-abcdefghij",
                    "ticket":"ticket-abcdefghijkl",
                    "deviceId":"device-id-abcdefgh",
                    "expiresAt":MAX_RELAY_EXPIRES_AT_MS
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

            let (stream_tcp, _) = relay_listener.accept().await.unwrap();
            let mut stream = accept_async(stream_tcp).await.unwrap();
            let accept = match stream.next().await.unwrap().unwrap() {
                Message::Text(text) => serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                other => panic!("unexpected stream accept: {other:?}"),
            };
            assert_eq!(accept["streamId"], "stream-abcdefghij");
            stream
                .send(Message::Text(
                    json!({"type":"stream.ready","v":RELAY_PROTOCOL_VERSION,"streamId":"stream-abcdefghij"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            let client_eph = SecretKey::from([3u8; 32]);
            stream
                .send(Message::Text(
                    json!({
                        "v": crate::remote_crypto::PROTOCOL_VERSION,
                        "eph": key_b64(client_eph.public_key().as_bytes()),
                        "cv": crate::remote_crypto::CRYPTO_VERSION,
                        "minV": crate::remote_crypto::MIN_PROTOCOL_VERSION,
                        "maxV": crate::remote_crypto::PROTOCOL_VERSION,
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            let proof = match stream.next().await.unwrap().unwrap() {
                Message::Text(text) => serde_json::from_str::<serde_json::Value>(&text).unwrap(),
                other => panic!("unexpected proof frame: {other:?}"),
            };
            let server_eph_bytes: [u8; 32] = BASE64_STANDARD
                .decode(proof["seph"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            let server_eph = PublicKey::from(server_eph_bytes);
            let cipher = SalsaBox::new(&server_eph, &client_eph);
            let mut send_count = 0;
            let mut recv_count = 0;
            let client_identity = SecretKey::from([4u8; 32]);
            stream
                .send(Message::Text(
                    seal(
                        &cipher,
                        &mut send_count,
                        &json!({
                            "type":"hello",
                            "token":"pairing-token-abcdefghijkl",
                            "clientPubKey":key_b64(client_identity.public_key().as_bytes()),
                            "clientInfo":{"platform":"relay-test","appVersion":"test"},
                        }),
                    )
                    .into(),
                ))
                .await
                .unwrap();
            let hello_ok = match stream.next().await.unwrap().unwrap() {
                Message::Text(text) => open(&cipher, &mut recv_count, &text),
                other => panic!("unexpected hello.ok frame: {other:?}"),
            };
            assert_eq!(hello_ok["type"], "hello.ok");
            stream
                .send(Message::Text(
                    seal(
                        &cipher,
                        &mut send_count,
                        &json!({"type":"connection.ping","id":"relay-ping-1"}),
                    )
                    .into(),
                ))
                .await
                .unwrap();
            let pong = match stream.next().await.unwrap().unwrap() {
                Message::Text(text) => open(&cipher, &mut recv_count, &text),
                other => panic!("unexpected pong frame: {other:?}"),
            };
            assert_eq!(pong, json!({"type":"connection.pong","id":"relay-ping-1"}));
        });

        let status = RelayStatusHandle::new(home.path());
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let options = RelaySupervisorOptions {
            timeouts: RelayTimeouts {
                auth: Duration::from_secs(1),
                device_sync: Duration::from_millis(100),
                ready: Duration::from_millis(100),
                heartbeat: Duration::from_millis(20),
                heartbeat_ack: Duration::from_millis(100),
                min_reconnect: Duration::from_millis(10),
                max_reconnect: Duration::from_millis(20),
            },
            config_poll: Duration::from_millis(20),
        };
        let supervisor = tokio::spawn(run_relay_supervisor(
            home.path().to_path_buf(),
            format!("ws://127.0.0.1:{}/ws", local_addr.port()),
            true,
            status.clone(),
            stop_rx,
            options,
        ));

        tokio::time::timeout(Duration::from_secs(3), relay)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.get().unwrap().state, RelayConnectionState::Online);
        stop_tx.send_replace(true);
        tokio::time::timeout(Duration::from_secs(1), supervisor)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            RelayGenerationJournal::load(home.path())
                .generation_for("CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk"),
            Some(2)
        );
        local_server.abort();
        local_api.database.shutdown().await.unwrap();
    }
}
