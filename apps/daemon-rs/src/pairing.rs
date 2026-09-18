//! Mobile pairing metadata used by the encrypted remote WebSocket boundary.
//!
//! This is the Rust counterpart of the TypeScript daemon's `pairing.ts` store
//! for the pieces the WebSocket server must consume first: existing daemon
//! identity, paired-device records, and hello authentication with TOFU client
//! public-key binding.  Key generation / QR rendering and relay credentials are
//! still driven by the TS CLI until the remaining remote stack is ported.

use std::fs;
use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;

use base64::Engine;
use base64::prelude::{BASE64_STANDARD, BASE64_URL_SAFE_NO_PAD};
use crypto_box::SecretKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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

pub fn load_or_create_identity(home: &Path) -> Result<KeyPairB64> {
    match load_identity(home) {
        Ok(identity) => Ok(identity),
        Err(crate::error::Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut rng = crypto_box::aead::OsRng;
            let secret = SecretKey::generate(&mut rng);
            let identity = KeyPairB64 {
                public_key: BASE64_STANDARD.encode(secret.public_key().as_bytes()),
                secret_key: BASE64_STANDARD.encode(secret.to_bytes()),
            };
            write_private_json(home, "identity.json", &identity)?;
            Ok(identity)
        }
        Err(error) => Err(error),
    }
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

pub fn save_devices(home: &Path, devices: &[DeviceRecord]) -> Result<()> {
    write_private_json(
        home,
        "devices.json",
        &DevicesFile {
            devices: devices.to_vec(),
        },
    )
}

pub fn write_private_json<T: Serialize>(home: &Path, name: &str, value: &T) -> Result<()> {
    fs::create_dir_all(home)?;
    let path = home.join(name);
    let tmp = home.join(format!(".{}.{}.tmp", name, uuid::Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec_pretty(value)?;
    fs::write(&tmp, [bytes, b"\n".to_vec()].concat())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(tmp, path)?;
    Ok(())
}

pub fn random_b64url(bytes: usize) -> String {
    let mut out = Vec::with_capacity(bytes);
    while out.len() < bytes {
        out.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    out.truncate(bytes);
    BASE64_URL_SAFE_NO_PAD.encode(out)
}

pub fn host_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Prospero".into())
}

pub fn pairing_addrs(bind: Option<&str>) -> Result<Vec<String>> {
    let Some(bind) = bind.filter(|value| *value != "0.0.0.0" && *value != "::") else {
        return Ok(candidate_addrs());
    };
    let ip = if let Ok(ip) = bind.parse::<IpAddr>() {
        ip
    } else {
        named_interface_addr(bind).map(IpAddr::V4).ok_or_else(|| {
            Error::Invalid(format!("unknown network address or interface: {bind}"))
        })?
    };
    if ip.is_unspecified() {
        Ok(candidate_addrs())
    } else {
        Ok(vec![ip.to_string()])
    }
}

fn candidate_addrs() -> Vec<String> {
    let mut en = Vec::new();
    let mut utun = Vec::new();
    let mut other = Vec::new();
    for (name, ip) in interface_addrs() {
        if unusable_addr(&ip) {
            continue;
        }
        let value = ip.to_string();
        if en.contains(&value) || utun.contains(&value) || other.contains(&value) {
            continue;
        }
        if name.starts_with("en") {
            en.push(value);
        } else if name.starts_with("utun") {
            utun.push(value);
        } else {
            other.push(value);
        }
    }
    en.into_iter().chain(utun).chain(other).collect()
}

fn named_interface_addr(name: &str) -> Option<Ipv4Addr> {
    interface_addrs()
        .into_iter()
        .find_map(|(candidate, ip)| (candidate == name).then_some(ip))
}

fn unusable_addr(addr: &Ipv4Addr) -> bool {
    let octets = addr.octets();
    (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
        || (octets[0] == 169 && octets[1] == 254)
        || octets[3] == 0
}

#[cfg(unix)]
fn interface_addrs() -> Vec<(String, Ipv4Addr)> {
    use std::ffi::CStr;
    let mut head = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cursor = head;
    while !cursor.is_null() {
        let item = unsafe { &*cursor };
        if !item.ifa_addr.is_null()
            && unsafe { (*item.ifa_addr).sa_family as i32 } == libc::AF_INET
            && (item.ifa_flags & libc::IFF_LOOPBACK as u32) == 0
        {
            let name = unsafe { CStr::from_ptr(item.ifa_name) }
                .to_string_lossy()
                .into_owned();
            let addr = unsafe { &*(item.ifa_addr as *const libc::sockaddr_in) };
            out.push((name, Ipv4Addr::from(addr.sin_addr.s_addr.to_ne_bytes())));
        }
        cursor = item.ifa_next;
    }
    unsafe {
        libc::freeifaddrs(head);
    }
    out
}

#[cfg(not(unix))]
fn interface_addrs() -> Vec<(String, Ipv4Addr)> {
    Vec::new()
}

pub fn mint_device(
    home: &Path,
    name: String,
    allow_shell: bool,
    allow_orchestration: bool,
) -> Result<DeviceRecord> {
    let device = DeviceRecord {
        name,
        token: random_b64url(24),
        client_pub_key: None,
        allow_shell,
        allow_orchestration: Some(allow_orchestration),
        relay_device_id: None,
        relay_token: None,
        relay_credential_issued: None,
        created_at: crate::database::now(),
        last_seen_at: None,
    };
    let mut devices = load_devices(home)?;
    devices.push(device.clone());
    save_devices(home, &devices)?;
    Ok(device)
}

pub fn issue_relay_credentials(device: &DeviceRecord) -> DeviceRecord {
    let mut issued = device.clone();
    issued.relay_device_id = Some(random_b64url(24));
    issued.relay_token = Some(random_b64url(32));
    issued.relay_credential_issued = Some(true);
    issued
}

pub fn persist_relay_credentials(home: &Path, issued: &DeviceRecord) -> Result<()> {
    if issued.relay_device_id.is_none()
        || issued.relay_token.is_none()
        || issued.relay_credential_issued != Some(true)
    {
        return Err(Error::Invalid(
            "cannot persist relay credentials that were not issued in a pairing QR".into(),
        ));
    }
    let mut devices = load_devices(home)?;
    let Some(index) = devices
        .iter()
        .position(|device| token_equal(&device.token, &issued.token))
    else {
        return Err(Error::Invalid(
            "paired device disappeared before relay credentials could be saved".into(),
        ));
    };
    devices[index] = issued.clone();
    save_devices(home, &devices)
}

pub fn device_id(device: &DeviceRecord) -> String {
    BASE64_URL_SAFE_NO_PAD.encode(Sha256::digest(device.token.as_bytes()))
}

pub fn revoke_device(home: &Path, id: &str) -> Result<Option<DeviceRecord>> {
    let mut devices = load_devices(home)?;
    let Some(index) = devices.iter().position(|device| device_id(device) == id) else {
        return Ok(None);
    };
    let removed = devices.remove(index);
    save_devices(home, &devices)?;
    Ok(Some(removed))
}

pub fn rotate_identity(home: &Path) -> Result<KeyPairB64> {
    let mut rng = crypto_box::aead::OsRng;
    let secret = SecretKey::generate(&mut rng);
    let identity = KeyPairB64 {
        public_key: BASE64_STANDARD.encode(secret.public_key().as_bytes()),
        secret_key: BASE64_STANDARD.encode(secret.to_bytes()),
    };
    write_private_json(home, "identity.json", &identity)?;
    save_devices(home, &[])?;
    Ok(identity)
}

pub fn clear_relay_credentials(home: &Path) -> Result<usize> {
    let mut devices = load_devices(home)?;
    let count = devices.len();
    for device in &mut devices {
        device.relay_device_id = None;
        device.relay_token = None;
        device.relay_credential_issued = None;
    }
    save_devices(home, &devices)?;
    Ok(count)
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
