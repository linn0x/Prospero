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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RelayConnectionState {
    Disabled,
    Offline,
    Connecting,
    Syncing,
    Online,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayRuntimeDeviceStatus {
    pub total: usize,
    pub ready: usize,
    pub needs_re_pair: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayRuntimeStatus {
    pub enabled: bool,
    pub state: RelayConnectionState,
    pub url: Option<String>,
    pub route_id: Option<String>,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connected_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub devices: RelayRuntimeDeviceStatus,
}

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
    control: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    url: String,
    route_id: String,
    generation: u64,
    ready_devices: usize,
    ready_device_ids: HashSet<String>,
    active_stream_ids: HashSet<String>,
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
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        validate_relay_url(&self.url, true)?;
        let route_id = derive_relay_route_id(&self.host_secret)?;
        let endpoint = relay_endpoint(&self.url, RELAY_HOST_PATH)?;
        let (mut control, _) = tokio::time::timeout(
            Duration::from_millis(AUTH_TIMEOUT_MS),
            tokio_tungstenite::connect_async(endpoint),
        )
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|error| Error::Invalid(format!("relay host connect failed: {error}")))?;
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
            let Some(frame) = tokio::time::timeout(
                Duration::from_millis(DEVICE_SYNC_TIMEOUT_MS + READY_TIMEOUT_MS),
                control.next(),
            )
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
                    ready_devices,
                    ready_device_ids,
                    active_stream_ids: HashSet::new(),
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
                total: self.ready_devices,
                ready: self.ready_devices,
                needs_re_pair: 0,
            },
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

        let Some(frame) = tokio::time::timeout(
            Duration::from_millis(HEARTBEAT_ACK_TIMEOUT_MS),
            self.control.next(),
        )
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
    pub async fn accept_one_stream(
        &mut self,
    ) -> Result<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    > {
        use futures_util::{SinkExt, StreamExt};
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
            if !self.active_stream_ids.insert(stream_id.clone()) {
                self.revoke_stream(&stream_id, "normal").await?;
                continue;
            }
            let accept = stream_accept_frame(&stream_id, &ticket)?;
            let endpoint = relay_endpoint(&self.url, RELAY_STREAM_PATH)?;
            let (mut stream, _) = tokio::time::timeout(
                Duration::from_millis(AUTH_TIMEOUT_MS),
                tokio_tungstenite::connect_async(endpoint),
            )
            .await
            .map_err(|_| Error::Timeout)?
            .map_err(|error| Error::Invalid(format!("relay stream connect failed: {error}")))?;
            stream
                .send(Message::Text(serde_json::to_string(&accept)?.into()))
                .await
                .map_err(|error| Error::Invalid(format!("relay stream accept failed: {error}")))?;
            let Some(frame) =
                tokio::time::timeout(Duration::from_millis(READY_TIMEOUT_MS), stream.next())
                    .await
                    .map_err(|_| Error::Timeout)?
            else {
                return Err(Error::Invalid("relay stream closed before ready".into()));
            };
            let frame =
                frame.map_err(|error| Error::Invalid(format!("relay stream failed: {error}")))?;
            let Message::Text(text) = frame else {
                return Err(Error::Invalid("relay stream control must be text".into()));
            };
            let ready: serde_json::Value = serde_json::from_str(&text)?;
            if ready["type"].as_str() == Some("stream.ready")
                && ready["v"] == RELAY_PROTOCOL_VERSION
                && ready["streamId"].as_str() == Some(stream_id.as_str())
            {
                return Ok(stream);
            }
            return Err(Error::Invalid("relay stream did not become ready".into()));
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
    pub session_summary: crate::protocol::SessionSummary,
    pub sessions: Vec<crate::protocol::SessionHead>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RustDaemonPersistence {
    pub pty: bool,
    pub structured: bool,
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
            session_summary: crate::protocol::SessionSummary::default(),
            sessions: Vec::new(),
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
}
