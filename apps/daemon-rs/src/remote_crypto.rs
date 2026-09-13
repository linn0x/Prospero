//! SecureChannel-compatible primitives for the mobile remote WebSocket.
//!
//! Mirrors `packages/protocol/src/crypto.ts`: a three-frame handshake where the
//! daemon proves its static X25519 identity, then every application frame is a
//! JSON object encrypted with an implicit directional nonce counter.

use base64::Engine;
use base64::prelude::BASE64_STANDARD;
use crypto_box::aead::Aead;
use crypto_box::{Nonce, PublicKey, SalsaBox, SecretKey};
use serde::Deserialize;
use serde_json::{Value, json};
#[cfg(test)]
use subtle::ConstantTimeEq;

use crate::error::{Error, Result};

pub const CRYPTO_VERSION: u8 = 1;
pub const PROTOCOL_VERSION: u8 = 16;
pub const MIN_PROTOCOL_VERSION: u8 = 5;
pub const SUPPORTED_PROTOCOL_VERSIONS: &[u8] = &[16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 5];
const DIR_C2S: u8 = 1;
const DIR_S2C: u8 = 2;
const PROOF_NONCE: [u8; 24] = [0; 24];

#[derive(Debug, Deserialize)]
struct ClientHelloFrame {
    v: u8,
    eph: String,
    cv: Option<u8>,
    #[serde(rename = "minV")]
    min_v: Option<u8>,
    #[serde(rename = "maxV")]
    max_v: Option<u8>,
}

pub struct ServerHandshakeState {
    channel: SecureChannel,
    pub protocol_version: u8,
}

pub struct ServerHandshakeRespond {
    pub frame: String,
    pub state: ServerHandshakeState,
}

pub struct ServerHandshakeAccepted {
    pub hello: Value,
    pub channel: SecureChannel,
    pub protocol_version: u8,
}

pub struct SecureChannel {
    cipher: SalsaBox,
    send_dir: u8,
    send_count: u64,
    recv_count: u64,
}

impl SecureChannel {
    fn new(cipher: SalsaBox, send_dir: u8) -> Self {
        Self {
            cipher,
            send_dir,
            send_count: 0,
            recv_count: 0,
        }
    }

    pub fn seal(&mut self, value: &Value) -> Result<String> {
        let nonce = nonce_for(self.send_dir, self.send_count);
        self.send_count = self
            .send_count
            .checked_add(1)
            .ok_or_else(|| Error::Invalid("secure channel counter overflow".into()))?;
        let plaintext = serde_json::to_vec(value)?;
        let ciphertext = self
            .cipher
            .encrypt(&Nonce::from(nonce), plaintext.as_slice())
            .map_err(|_| Error::Invalid("encrypt failed".into()))?;
        Ok(json!({ "c": BASE64_STANDARD.encode(ciphertext) }).to_string())
    }

    pub fn open(&mut self, text: &str) -> Result<Value> {
        let frame: Value =
            serde_json::from_str(text).map_err(|_| Error::Invalid("frame is not JSON".into()))?;
        let ciphertext = frame
            .get("c")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Invalid("frame missing ciphertext".into()))?;
        let ciphertext = BASE64_STANDARD
            .decode(ciphertext)
            .map_err(|_| Error::Invalid("invalid ciphertext".into()))?;
        let recv_dir = if self.send_dir == DIR_C2S {
            DIR_S2C
        } else {
            DIR_C2S
        };
        let nonce = nonce_for(recv_dir, self.recv_count);
        let plaintext = self
            .cipher
            .decrypt(&Nonce::from(nonce), ciphertext.as_slice())
            .map_err(|_| {
                Error::Invalid("decrypt failed (tampered, replayed, or counter out of sync)".into())
            })?;
        self.recv_count = self
            .recv_count
            .checked_add(1)
            .ok_or_else(|| Error::Invalid("secure channel counter overflow".into()))?;
        serde_json::from_slice(&plaintext)
            .map_err(|_| Error::Invalid("frame payload is not JSON".into()))
    }
}

pub fn server_handshake_respond(
    client_frame_text: &str,
    daemon_secret_key_b64: &str,
) -> Result<ServerHandshakeRespond> {
    let frame: ClientHelloFrame = serde_json::from_str(client_frame_text)
        .map_err(|_| Error::Invalid("handshake frame is not JSON".into()))?;
    if !SUPPORTED_PROTOCOL_VERSIONS.contains(&frame.v) {
        return Err(Error::Invalid("protocol version mismatch".into()));
    }
    if frame.v >= 8
        && (frame.cv != Some(CRYPTO_VERSION)
            || frame.min_v.is_none_or(|min| min > frame.v)
            || frame.max_v.is_none_or(|max| max < frame.v))
    {
        return Err(Error::Invalid(
            "invalid authenticated version negotiation".into(),
        ));
    }
    let client_eph = public_key(&frame.eph)?;
    let daemon_secret = secret_key(daemon_secret_key_b64)?;
    let mut rng = crypto_box::aead::OsRng;
    let server_secret = SecretKey::generate(&mut rng);
    let server_public = server_secret.public_key();

    let proof_box = SalsaBox::new(&client_eph, &daemon_secret);
    let proof_payload = if frame.v >= 8 {
        negotiated_proof_payload(server_public.as_bytes(), client_eph.as_bytes(), frame.v)
    } else {
        proof_payload(server_public.as_bytes(), client_eph.as_bytes())
    };
    let proof = proof_box
        .encrypt(&Nonce::from(PROOF_NONCE), proof_payload.as_slice())
        .map_err(|_| Error::Invalid("identity proof failed".into()))?;
    let cipher = SalsaBox::new(&client_eph, &server_secret);
    let response = json!({
        "seph": BASE64_STANDARD.encode(server_public.as_bytes()),
        "p": BASE64_STANDARD.encode(proof),
        "v": frame.v,
        "cv": CRYPTO_VERSION,
    })
    .to_string();
    Ok(ServerHandshakeRespond {
        frame: response,
        state: ServerHandshakeState {
            channel: SecureChannel::new(cipher, DIR_S2C),
            protocol_version: frame.v,
        },
    })
}

pub fn server_handshake_accept(
    mut state: ServerHandshakeState,
    hello_frame_text: &str,
) -> Result<ServerHandshakeAccepted> {
    let hello = state.channel.open(hello_frame_text)?;
    if hello.get("type").and_then(Value::as_str) != Some("hello")
        || hello
            .get("token")
            .and_then(Value::as_str)
            .is_none_or(|token| token.len() < 16)
        || hello
            .get("clientPubKey")
            .and_then(Value::as_str)
            .map(public_key)
            .transpose()?
            .is_none()
        || hello.get("clientInfo").and_then(Value::as_object).is_none()
    {
        return Err(Error::Invalid("hello payload failed validation".into()));
    }
    Ok(ServerHandshakeAccepted {
        hello,
        channel: state.channel,
        protocol_version: state.protocol_version,
    })
}

fn nonce_for(dir: u8, counter: u64) -> [u8; 24] {
    let mut nonce = [0; 24];
    nonce[0] = dir;
    nonce[1..9].copy_from_slice(&counter.to_be_bytes());
    nonce
}

fn proof_payload(server_eph: &[u8; 32], client_eph: &[u8; 32]) -> Vec<u8> {
    [server_eph.as_slice(), client_eph.as_slice()].concat()
}

fn negotiated_proof_payload(server_eph: &[u8; 32], client_eph: &[u8; 32], version: u8) -> Vec<u8> {
    let mut payload = vec![0x50, 0x52, 0x53, 0x50, CRYPTO_VERSION, version];
    payload.extend_from_slice(server_eph);
    payload.extend_from_slice(client_eph);
    payload
}

fn public_key(value: &str) -> Result<PublicKey> {
    let bytes = BASE64_STANDARD
        .decode(value)
        .map_err(|_| Error::Invalid("bad public key".into()))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| Error::Invalid("bad public key".into()))?;
    Ok(PublicKey::from(bytes))
}

fn secret_key(value: &str) -> Result<SecretKey> {
    let bytes = BASE64_STANDARD
        .decode(value)
        .map_err(|_| Error::Invalid("bad secret key".into()))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| Error::Invalid("bad secret key".into()))?;
    Ok(SecretKey::from(bytes))
}

#[cfg(test)]
fn eq_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.ct_eq(b).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_channel_round_trip_and_replay_rejected() {
        let mut rng = crypto_box::aead::OsRng;
        let client_secret = SecretKey::generate(&mut rng);
        let server_secret = SecretKey::generate(&mut rng);
        let mut client = SecureChannel::new(
            SalsaBox::new(&server_secret.public_key(), &client_secret),
            DIR_C2S,
        );
        let mut server = SecureChannel::new(
            SalsaBox::new(&client_secret.public_key(), &server_secret),
            DIR_S2C,
        );

        let frame = client
            .seal(&json!({"type":"connection.ping","id":"p1"}))
            .unwrap();
        assert_eq!(server.open(&frame).unwrap()["id"], "p1");
        assert!(
            server.open(&frame).is_err(),
            "implicit counter rejects replay"
        );
        let pong = server
            .seal(&json!({"type":"connection.pong","id":"p1"}))
            .unwrap();
        assert_eq!(client.open(&pong).unwrap()["type"], "connection.pong");
    }

    #[test]
    fn server_handshake_accepts_compatible_client_frame() {
        let mut rng = crypto_box::aead::OsRng;
        let daemon_secret = SecretKey::generate(&mut rng);
        let client_secret = SecretKey::generate(&mut rng);
        let client_eph = client_secret.public_key();
        let first = json!({
            "v": PROTOCOL_VERSION,
            "eph": BASE64_STANDARD.encode(client_eph.as_bytes()),
            "cv": CRYPTO_VERSION,
            "minV": MIN_PROTOCOL_VERSION,
            "maxV": PROTOCOL_VERSION,
        })
        .to_string();
        let response =
            server_handshake_respond(&first, &BASE64_STANDARD.encode(daemon_secret.to_bytes()))
                .unwrap();
        let proof: Value = serde_json::from_str(&response.frame).unwrap();
        let server_eph = public_key(proof["seph"].as_str().unwrap()).unwrap();
        let proof_box = SalsaBox::new(&daemon_secret.public_key(), &client_secret);
        let opened = proof_box
            .decrypt(
                &Nonce::from(PROOF_NONCE),
                BASE64_STANDARD
                    .decode(proof["p"].as_str().unwrap())
                    .unwrap()
                    .as_slice(),
            )
            .unwrap();
        assert!(eq_bytes(
            &opened,
            &negotiated_proof_payload(
                server_eph.as_bytes(),
                client_eph.as_bytes(),
                PROTOCOL_VERSION
            ),
        ));
        let mut client_channel =
            SecureChannel::new(SalsaBox::new(&server_eph, &client_secret), DIR_C2S);
        let hello = json!({
            "type":"hello",
            "token":"0123456789abcdef",
            "clientPubKey": BASE64_STANDARD.encode(client_eph.as_bytes()),
            "clientInfo":{"platform":"desktop","appVersion":"test"}
        });
        let accepted =
            server_handshake_accept(response.state, &client_channel.seal(&hello).unwrap()).unwrap();
        assert_eq!(accepted.hello["token"], "0123456789abcdef");
        assert_eq!(accepted.protocol_version, PROTOCOL_VERSION);
    }
}
