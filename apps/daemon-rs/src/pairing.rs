//! Mobile pairing metadata used by the encrypted remote WebSocket boundary.
//!
//! This is the Rust counterpart of the TypeScript daemon's `pairing.ts` store
//! for the pieces the WebSocket server must consume first: existing daemon
//! identity, paired-device records, and hello authentication with TOFU client
//! public-key binding.  Key generation / QR rendering and relay credentials are
//! still driven by the TS CLI until the remaining remote stack is ported.

use std::fs;
use std::path::Path;

use base64::Engine;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPairB64 {
    pub public_key: String,
    pub secret_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub name: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_pub_key: Option<String>,
    pub allow_shell: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_orchestration: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_credential_issued: Option<bool>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(
        rename = "lastSeenAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_seen_at: Option<i64>,
}

impl DeviceRecord {
    pub fn can_orchestrate(&self) -> bool {
        self.allow_shell && self.allow_orchestration.unwrap_or(self.allow_shell)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthFailure {
    UnknownToken,
    KeyMismatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DevicesFile {
    #[serde(default)]
    devices: Vec<DeviceRecord>,
}

pub fn load_identity(home: &Path) -> Result<KeyPairB64> {
    let raw = fs::read_to_string(home.join("identity.json"))?;
    let identity: KeyPairB64 = serde_json::from_str(&raw)
        .map_err(|_| Error::Invalid("invalid pairing identity".into()))?;
    validate_b64_key(&identity.public_key)?;
    validate_b64_key(&identity.secret_key)?;
    Ok(identity)
}

pub fn load_devices(home: &Path) -> Result<Vec<DeviceRecord>> {
    let path = home.join("devices.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path)?;
    let file: DevicesFile =
        serde_json::from_str(&raw).map_err(|_| Error::Invalid("invalid pairing devices".into()))?;
    Ok(file.devices)
}

fn save_devices(home: &Path, devices: &[DeviceRecord]) -> Result<()> {
    fs::create_dir_all(home)?;
    let path = home.join("devices.json");
    let tmp = home.join(format!(
        ".devices.json.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let bytes = serde_json::to_vec_pretty(&DevicesFile {
        devices: devices.to_vec(),
    })?;
    fs::write(&tmp, [bytes, b"\n".to_vec()].concat())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(tmp, path)?;
    Ok(())
}

pub fn authenticate(
    home: &Path,
    token: &str,
    client_pub_key: &str,
) -> Result<std::result::Result<DeviceRecord, AuthFailure>> {
    validate_b64_key(client_pub_key)?;
    let mut devices = load_devices(home)?;
    let Some(index) = devices
        .iter()
        .position(|device| token_equal(&device.token, token))
    else {
        return Ok(Err(AuthFailure::UnknownToken));
    };
    if devices[index]
        .client_pub_key
        .as_deref()
        .is_some_and(|known| known != client_pub_key)
    {
        return Ok(Err(AuthFailure::KeyMismatch));
    }
    devices[index].client_pub_key = Some(client_pub_key.to_owned());
    devices[index].last_seen_at = Some(crate::database::now());
    let device = devices[index].clone();
    save_devices(home, &devices)?;
    Ok(Ok(device))
}

fn token_equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.as_bytes().ct_eq(b.as_bytes()).into()
}

fn validate_b64_key(value: &str) -> Result<()> {
    let decoded = base64::prelude::BASE64_STANDARD
        .decode(value)
        .map_err(|_| Error::Invalid("invalid pairing public key".into()))?;
    if decoded.len() != 32 {
        return Err(Error::Invalid("invalid pairing public key".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::prelude::BASE64_STANDARD;
    use tempfile::TempDir;

    fn key(byte: u8) -> String {
        BASE64_STANDARD.encode([byte; 32])
    }

    #[test]
    fn authenticate_binds_client_key_and_updates_last_seen() {
        let home = TempDir::new().unwrap();
        save_devices(
            home.path(),
            &[DeviceRecord {
                name: "phone".into(),
                token: "secret-token-123456".into(),
                client_pub_key: None,
                allow_shell: true,
                allow_orchestration: None,
                relay_device_id: None,
                relay_token: None,
                relay_credential_issued: None,
                created_at: 1,
                last_seen_at: None,
            }],
        )
        .unwrap();

        let device = authenticate(home.path(), "secret-token-123456", &key(7))
            .unwrap()
            .unwrap();
        assert_eq!(device.client_pub_key.as_deref(), Some(key(7).as_str()));
        assert!(device.last_seen_at.unwrap() > 0);
        assert!(device.can_orchestrate());

        let device = authenticate(home.path(), "secret-token-123456", &key(7))
            .unwrap()
            .unwrap();
        assert_eq!(device.name, "phone");
        assert_eq!(
            authenticate(home.path(), "wrong-token-123456", &key(7)).unwrap(),
            Err(AuthFailure::UnknownToken)
        );
        assert_eq!(
            authenticate(home.path(), "secret-token-123456", &key(8)).unwrap(),
            Err(AuthFailure::KeyMismatch)
        );
    }

    #[test]
    fn load_identity_validates_key_lengths() {
        let home = TempDir::new().unwrap();
        fs::write(
            home.path().join("identity.json"),
            serde_json::json!({"publicKey": key(1), "secretKey": key(2)}).to_string(),
        )
        .unwrap();
        let identity = load_identity(home.path()).unwrap();
        assert_eq!(identity.public_key, key(1));
        fs::write(
            home.path().join("identity.json"),
            serde_json::json!({"publicKey": "bad", "secretKey": key(2)}).to_string(),
        )
        .unwrap();
        assert!(load_identity(home.path()).is_err());
    }
}
