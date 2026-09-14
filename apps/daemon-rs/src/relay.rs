//! Relay v1 protocol primitives for the outbound host client.
//!
//! This ports the security-sensitive pieces of `packages/protocol/src/relay.ts`:
//! URL deployment policy, route/device credential derivation, and the JSON
//! control frames used by `/v1/host` and `/v1/stream`.  The runtime client is
//! layered on top of these primitives so tests can compare exact contract
//! vectors before sockets are introduced.

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
    for device in devices.iter().take(MAX_RELAY_DEVICE_CREDENTIALS + 1) {
        let Some((device_id, token)) = device_relay_credentials(device) else {
            continue;
        };
        validate_opaque_id(device_id, MAX_RELAY_DEVICE_ID_CHARS, "deviceId")?;
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
