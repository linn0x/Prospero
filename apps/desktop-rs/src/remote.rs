use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use crypto_box::aead::Aead;
use crypto_box::{Nonce, PublicKey, SalsaBox, SecretKey};
use futures_util::future::BoxFuture;
use futures_util::stream::FuturesUnordered;
use futures_util::{SinkExt, Stream, StreamExt};
use iced::futures::channel::mpsc;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

const SERVICE: &str = "ai.prospero.native.remote";
const PROTOCOL_VERSION: u8 = 16;
const MIN_PROTOCOL_VERSION: u8 = 5;
const CRYPTO_VERSION: u8 = 1;
const RELAY_VERSION: u8 = 1;
const MAX_FRAME: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayPairing {
    pub v: u8,
    pub url: String,
    pub route_id: String,
    pub device_id: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingPayload {
    pub v: u8,
    pub name: String,
    pub addrs: Vec<String>,
    pub port: u16,
    pub token: String,
    #[serde(rename = "pubKey")]
    pub pub_key: String,
    pub relay: Option<RelayPairing>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientKeys {
    public_key: String,
    secret_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostSecret {
    token: String,
    daemon_pub_key: String,
    relay: Option<RelayPairing>,
    client_keys: ClientKeys,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteHost {
    pub id: String,
    pub name: String,
    pub addrs: Vec<String>,
    pub port: u16,
    pub has_relay: bool,
    pub last_connected_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSession {
    pub id: String,
    pub agent: prospero_protocol_rs::AgentKind,
    pub kind: prospero_protocol_rs::SessionKind,
    pub title: String,
    pub cwd: String,
    pub status: prospero_protocol_rs::SessionStatus,
    pub created_at: i64,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListing {
    pub root: Option<String>,
    pub path: String,
    pub cwd: String,
    pub entries: Vec<prospero_protocol_rs::FsEntry>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteWorkspace {
    pub id: String,
    pub host_id: String,
    pub host_name: String,
    pub cwd: String,
    pub name: String,
    pub root: String,
    pub path: String,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub enum Command {
    Connect(String),
    Disconnect,
    CreateShell {
        cwd: String,
        request_id: String,
    },
    CreateAgent {
        cwd: String,
        agent: prospero_protocol_rs::AgentKind,
        request_id: String,
    },
    Attach {
        sid: String,
        last_seq: Option<i64>,
        previous: Option<String>,
    },
    Input {
        sid: String,
        data_b64: String,
    },
    Resize {
        sid: String,
        cols: u16,
        rows: u16,
    },
    Kill(String),
    ListWorkspace {
        root: String,
        path: String,
    },
    ChatSend {
        sid: String,
        text: String,
        attachments: Vec<prospero_protocol_rs::AttachmentInput>,
    },
    Interrupt(String),
    Permission {
        sid: String,
        request_id: String,
        reply: String,
    },
    Question {
        sid: String,
        request_id: String,
        question_id: String,
        value: String,
    },
}

#[derive(Debug, Clone)]
pub enum Event {
    Ready(mpsc::Sender<Command>),
    Connecting(String),
    Connected {
        host_id: String,
        sessions: Vec<RemoteSession>,
        transport: String,
        workspace_roots: bool,
    },
    Message(Value),
    Disconnected {
        host_id: String,
        error: String,
        retrying: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostFile {
    version: u8,
    hosts: Vec<RemoteHost>,
    #[serde(default)]
    workspaces: Vec<RemoteWorkspace>,
}

struct HostConnection {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    channel: SecureChannel,
}

type ConnectResult = Result<(HostConnection, Vec<RemoteSession>, String, bool), String>;
type ConnectAttempt = BoxFuture<'static, ConnectResult>;

struct ClientHandshake {
    secret: SecretKey,
    public: PublicKey,
}

struct SecureChannel {
    cipher: SalsaBox,
    send_count: u64,
    recv_count: u64,
}

impl SecureChannel {
    fn seal(&mut self, value: &Value) -> Result<String, String> {
        let nonce = nonce(1, self.send_count);
        self.send_count = self
            .send_count
            .checked_add(1)
            .ok_or_else(|| "remote counter overflow".to_owned())?;
        let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        let ciphertext = self
            .cipher
            .encrypt(&Nonce::from(nonce), bytes.as_slice())
            .map_err(|_| "remote encryption failed".to_owned())?;
        Ok(json!({"c": STANDARD.encode(ciphertext)}).to_string())
    }

    fn open(&mut self, text: &str) -> Result<Value, String> {
        let frame: Value = serde_json::from_str(text).map_err(|_| "remote frame is invalid")?;
        let ciphertext = frame
            .get("c")
            .and_then(Value::as_str)
            .ok_or_else(|| "remote frame is not encrypted".to_owned())?;
        let ciphertext = STANDARD
            .decode(ciphertext)
            .map_err(|_| "remote ciphertext is invalid".to_owned())?;
        let plaintext = self
            .cipher
            .decrypt(
                &Nonce::from(nonce(2, self.recv_count)),
                ciphertext.as_slice(),
            )
            .map_err(|_| "remote frame authentication failed".to_owned())?;
        self.recv_count = self
            .recv_count
            .checked_add(1)
            .ok_or_else(|| "remote counter overflow".to_owned())?;
        serde_json::from_slice(&plaintext).map_err(|_| "remote payload is invalid".into())
    }
}

pub fn subscription() -> impl Stream<Item = Event> {
    iced::stream::channel(100, async |mut output| {
        let (sender, mut receiver) = mpsc::channel(100);
        if output.send(Event::Ready(sender)).await.is_err() {
            return;
        }
        let mut desired: Option<String> = None;
        let mut retry = Duration::from_secs(1);
        loop {
            let Some(host_id) = desired.clone() else {
                match receiver.next().await {
                    Some(Command::Connect(id)) => desired = Some(id),
                    Some(_) => {}
                    None => return,
                }
                continue;
            };
            let _ = output.send(Event::Connecting(host_id.clone())).await;
            match connect(&host_id).await {
                Ok((mut connection, sessions, transport, workspace_roots)) => {
                    retry = Duration::from_secs(1);
                    if output
                        .send(Event::Connected {
                            host_id: host_id.clone(),
                            sessions,
                            transport,
                            workspace_roots,
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
                    let mut last_received = Instant::now();
                    let mut pending_ping: Option<(String, Instant)> = None;
                    loop {
                        tokio::select! {
                            command = receiver.next() => match command {
                                Some(Command::Connect(id)) => { desired = Some(id); break; }
                                Some(Command::Disconnect) => { desired = None; let _ = connection.socket.close(None).await; break; }
                                Some(command) => {
                                    if let Err(error) = send_command(&mut connection, command).await {
                                        let _ = output.send(Event::Disconnected { host_id: host_id.clone(), error, retrying: true }).await;
                                        break;
                                    }
                                }
                                None => return,
                            },
                            frame = connection.socket.next() => match frame {
                                Some(Ok(Message::Text(text))) => match connection.channel.open(&text) {
                                    Ok(message) => {
                                        last_received = Instant::now();
                                        if message.get("type").and_then(Value::as_str) == Some("connection.pong")
                                            && message.get("id").and_then(Value::as_str) == pending_ping.as_ref().map(|ping| ping.0.as_str())
                                        {
                                            pending_ping = None;
                                            continue;
                                        }
                                        if let Some((sid, seq)) = terminal_ack(&message) {
                                            let _ = send_value(&mut connection, json!({"type":"term.ack","sid":sid,"seq":seq})).await;
                                        }
                                        if output.send(Event::Message(message)).await.is_err() { return; }
                                    }
                                    Err(error) => {
                                        let _ = output.send(Event::Disconnected { host_id: host_id.clone(), error, retrying: false }).await;
                                        desired = None; break;
                                    }
                                },
                                Some(Ok(Message::Ping(bytes))) => { let _ = connection.socket.send(Message::Pong(bytes)).await; }
                                Some(Ok(Message::Close(frame))) => {
                                    let fatal = frame.as_ref().is_some_and(|frame| matches!(u16::from(frame.code), 4001 | 4004));
                                    let error = frame.map(|frame| frame.reason.to_string()).filter(|value| !value.is_empty()).unwrap_or_else(|| "远程电脑关闭了连接".into());
                                    let _ = output.send(Event::Disconnected { host_id: host_id.clone(), error, retrying: !fatal }).await;
                                    if fatal { desired = None; }
                                    break;
                                }
                                Some(Ok(_)) => {}
                                Some(Err(error)) => {
                                    let _ = output.send(Event::Disconnected { host_id: host_id.clone(), error: error.to_string(), retrying: true }).await;
                                    break;
                                }
                                None => {
                                    let _ = output.send(Event::Disconnected { host_id: host_id.clone(), error: "远程连接已断开".into(), retrying: true }).await;
                                    break;
                                }
                            },
                            _ = heartbeat.tick() => {
                                if pending_ping.as_ref().is_some_and(|ping| ping.1.elapsed() > Duration::from_secs(15)) {
                                    let _ = output.send(Event::Disconnected { host_id: host_id.clone(), error: "远程电脑保活超时".into(), retrying: true }).await;
                                    break;
                                }
                                if pending_ping.is_none() && last_received.elapsed() > Duration::from_secs(10) {
                                    let id = uuid::Uuid::new_v4().to_string();
                                    if send_value(&mut connection, json!({"type":"connection.ping","id":id})).await.is_err() { break; }
                                    pending_ping = Some((id, Instant::now()));
                                }
                            }
                        }
                    }
                }
                Err(error) => {
                    if output
                        .send(Event::Disconnected {
                            host_id: host_id.clone(),
                            error,
                            retrying: true,
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
            if desired.is_some() {
                tokio::select! {
                    _ = tokio::time::sleep(retry) => {}
                    command = receiver.next() => match command {
                        Some(Command::Connect(id)) => desired = Some(id),
                        Some(Command::Disconnect) => desired = None,
                        Some(_) => {}
                        None => return,
                    }
                }
                retry = (retry * 2).min(Duration::from_secs(8));
            }
        }
    })
}

async fn send_command(connection: &mut HostConnection, command: Command) -> Result<(), String> {
    let value = match command {
        Command::CreateShell { cwd, request_id } => {
            json!({"type":"session.create","requestId":request_id,"agent":"shell","kind":"pty","cwd":cwd,"cols":100,"rows":30})
        }
        Command::CreateAgent {
            cwd,
            agent,
            request_id,
        } => {
            json!({"type":"session.create","requestId":request_id,"agent":agent,"kind":"structured","cwd":cwd,"approvalPolicy":"strict"})
        }
        Command::Attach {
            sid,
            last_seq,
            previous,
        } => {
            if let Some(previous) = previous.filter(|previous| previous != &sid) {
                send_value(connection, json!({"type":"session.detach","sid":previous})).await?;
            }
            json!({"type":"session.attach","sid":sid,"lastSeq":last_seq})
        }
        Command::Input { sid, data_b64 } => {
            json!({"type":"term.input","sid":sid,"dataB64":data_b64})
        }
        Command::Resize { sid, cols, rows } => {
            json!({"type":"term.resize","sid":sid,"cols":cols,"rows":rows})
        }
        Command::Kill(sid) => json!({"type":"session.kill","sid":sid}),
        Command::ListWorkspace { root, path } => {
            json!({"type":"workspace.list","root":root,"path":path})
        }
        Command::ChatSend {
            sid,
            text,
            attachments,
        } => json!({"type":"chat.send","sid":sid,"text":text,"attachments":attachments}),
        Command::Interrupt(sid) => json!({"type":"session.interrupt","sid":sid}),
        Command::Permission {
            sid,
            request_id,
            reply,
        } => json!({"type":"permission.respond","sid":sid,"reqId":request_id,"reply":reply}),
        Command::Question {
            sid,
            request_id,
            question_id,
            value,
        } => {
            json!({"type":"question.respond","sid":sid,"reqId":request_id,"answers":[{"questionId":question_id,"values":[value]}]})
        }
        Command::Connect(_) | Command::Disconnect => return Ok(()),
    };
    send_value(connection, value).await
}

async fn send_value(connection: &mut HostConnection, value: Value) -> Result<(), String> {
    let frame = connection.channel.seal(&value)?;
    connection
        .socket
        .send(Message::Text(frame.into()))
        .await
        .map_err(|error| error.to_string())
}

fn terminal_ack(value: &Value) -> Option<(&str, i64)> {
    if !matches!(
        value.get("type")?.as_str()?,
        "term.output" | "term.snapshot"
    ) {
        return None;
    }
    Some((value.get("sid")?.as_str()?, value.get("seq")?.as_i64()?))
}

async fn connect(host_id: &str) -> ConnectResult {
    let host_id = host_id.to_owned();
    let lookup_id = host_id.clone();
    let (host, secret) = tokio::task::spawn_blocking(move || load_host(&lookup_id))
        .await
        .map_err(|error| error.to_string())??;
    let mut attempts: FuturesUnordered<ConnectAttempt> = FuturesUnordered::new();
    for addr in &host.addrs {
        let host_part = if addr.contains(':') && !addr.starts_with('[') {
            format!("[{addr}]")
        } else {
            addr.clone()
        };
        let url = format!("ws://{host_part}:{}/ws", host.port);
        let secret = secret.clone();
        attempts.push(Box::pin(async move {
            connect_url(secret, url, None)
                .await
                .map(|value| (value.0, value.1, "LAN".to_owned(), value.2))
        }));
    }
    if let Some(relay) = secret.relay.clone() {
        let url = relay_client_url(&relay.url)?;
        attempts.push(Box::pin(async move {
            if !host.addrs.is_empty() {
                tokio::time::sleep(Duration::from_millis(750)).await;
            }
            connect_url(secret, url, Some(relay))
                .await
                .map(|value| (value.0, value.1, "Relay".to_owned(), value.2))
        }));
    }
    let mut errors = Vec::new();
    while let Some(result) = attempts.next().await {
        match result {
            Ok(value) => {
                mark_connected(&host_id)?;
                return Ok(value);
            }
            Err(error) => errors.push(error),
        }
    }
    Err(errors
        .pop()
        .unwrap_or_else(|| "远程电脑没有可用地址".into()))
}

async fn connect_url(
    secret: HostSecret,
    url: String,
    relay: Option<RelayPairing>,
) -> Result<(HostConnection, Vec<RemoteSession>, bool), String> {
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(6),
        tokio_tungstenite::connect_async_with_config(
            url,
            Some(
                WebSocketConfig::default()
                    .max_message_size(Some(MAX_FRAME))
                    .max_frame_size(Some(MAX_FRAME)),
            ),
            true,
        ),
    )
    .await
    .map_err(|_| "远程连接超时".to_owned())?
    .map_err(|error| error.to_string())?;
    if let Some(relay) = relay {
        socket
            .send(Message::Text(
                json!({"type":"client.open","v":RELAY_VERSION,"routeId":relay.route_id,"deviceId":relay.device_id,"token":relay.token})
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|error| error.to_string())?;
        loop {
            let value: Value = serde_json::from_str(&recv_text(&mut socket).await?)
                .map_err(|_| "中继响应无效".to_owned())?;
            if value.get("v").and_then(Value::as_u64) != Some(u64::from(RELAY_VERSION)) {
                return Err("中继协议版本不兼容".into());
            }
            match value.get("type").and_then(Value::as_str) {
                Some("client.status") => continue,
                Some("stream.ready") => break,
                Some("error") => {
                    return Err(value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("中继连接失败")
                        .to_owned());
                }
                _ => return Err("中继握手失败".into()),
            }
        }
    }
    let (first, handshake) = client_handshake_start();
    socket
        .send(Message::Text(first.into()))
        .await
        .map_err(|error| error.to_string())?;
    let proof = recv_text(&mut socket).await?;
    let (hello, mut channel) = client_handshake_finish(handshake, &proof, &secret)?;
    socket
        .send(Message::Text(hello.into()))
        .await
        .map_err(|error| error.to_string())?;
    let hello = channel.open(&recv_text(&mut socket).await?)?;
    if hello.get("type").and_then(Value::as_str) != Some("hello.ok") {
        return Err("远程 daemon 握手失败".into());
    }
    let sessions = serde_json::from_value(hello.get("sessions").cloned().unwrap_or_default())
        .map_err(|_| "远程会话列表无效".to_owned())?;
    let workspace_roots = hello
        .get("host")
        .and_then(|host| host.get("capabilities"))
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|item| item.as_str() == Some("workspace.roots-mkdir.v1"))
        });
    Ok((
        HostConnection { socket, channel },
        sessions,
        workspace_roots,
    ))
}

async fn recv_text(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Result<String, String> {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(6), socket.next())
            .await
            .map_err(|_| "远程握手超时".to_owned())?
            .ok_or_else(|| "远程连接已关闭".to_owned())?
            .map_err(|error| error.to_string())?;
        match frame {
            Message::Text(text) => return Ok(text.to_string()),
            Message::Binary(bytes) => {
                return String::from_utf8(bytes.to_vec())
                    .map_err(|_| "远程帧不是 UTF-8".to_owned());
            }
            Message::Ping(bytes) => socket
                .send(Message::Pong(bytes))
                .await
                .map_err(|error| error.to_string())?,
            Message::Close(_) => return Err("远程连接已关闭".into()),
            _ => {}
        }
    }
}

fn client_handshake_start() -> (String, ClientHandshake) {
    let mut rng = crypto_box::aead::OsRng;
    let secret = SecretKey::generate(&mut rng);
    let public = secret.public_key();
    (
        json!({"v":PROTOCOL_VERSION,"eph":STANDARD.encode(public.as_bytes()),"cv":CRYPTO_VERSION,"minV":MIN_PROTOCOL_VERSION,"maxV":PROTOCOL_VERSION}).to_string(),
        ClientHandshake { secret, public },
    )
}

fn client_handshake_finish(
    handshake: ClientHandshake,
    text: &str,
    host: &HostSecret,
) -> Result<(String, SecureChannel), String> {
    let frame: Value = serde_json::from_str(text).map_err(|_| "服务器握手响应无效")?;
    if frame.get("v").and_then(Value::as_u64) != Some(u64::from(PROTOCOL_VERSION))
        || frame.get("cv").and_then(Value::as_u64) != Some(u64::from(CRYPTO_VERSION))
    {
        return Err("远程协议版本认证失败".into());
    }
    let server = public_key(
        frame
            .get("seph")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )?;
    let daemon = public_key(&host.daemon_pub_key)?;
    let proof = STANDARD
        .decode(frame.get("p").and_then(Value::as_str).unwrap_or_default())
        .map_err(|_| "远程身份证明无效".to_owned())?;
    let proof_box = SalsaBox::new(&daemon, &handshake.secret);
    let opened = proof_box
        .decrypt(&Nonce::from([0; 24]), proof.as_slice())
        .map_err(|_| "远程身份验证失败".to_owned())?;
    let expected = [
        &[0x50, 0x52, 0x53, 0x50, CRYPTO_VERSION, PROTOCOL_VERSION][..],
        server.as_bytes(),
        handshake.public.as_bytes(),
    ]
    .concat();
    if opened != expected {
        return Err("远程身份验证失败".into());
    }
    let mut channel = SecureChannel {
        cipher: SalsaBox::new(&server, &handshake.secret),
        send_count: 0,
        recv_count: 0,
    };
    let hello = channel.seal(&json!({
        "type":"hello",
        "token":host.token,
        "clientPubKey":host.client_keys.public_key,
        "clientInfo":{"platform":"desktop-rs","appVersion":env!("CARGO_PKG_VERSION")}
    }))?;
    Ok((hello, channel))
}

fn nonce(direction: u8, counter: u64) -> [u8; 24] {
    let mut value = [0; 24];
    value[0] = direction;
    value[1..9].copy_from_slice(&counter.to_be_bytes());
    value
}

fn public_key(value: &str) -> Result<PublicKey, String> {
    let bytes: [u8; 32] = STANDARD
        .decode(value)
        .map_err(|_| "公钥编码无效".to_owned())?
        .try_into()
        .map_err(|_| "公钥长度无效".to_owned())?;
    Ok(PublicKey::from(bytes))
}

fn relay_client_url(value: &str) -> Result<String, String> {
    let mut url = Url::parse(value).map_err(|_| "Relay URL 无效".to_owned())?;
    if url.scheme() != "wss"
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Relay URL 必须是无凭据、无 query 的 wss 地址".into());
    }
    let path = url.path().trim_end_matches('/');
    let target = if path.ends_with("/v1/client") {
        path.to_owned()
    } else if path.ends_with("/v1") {
        format!("{path}/client")
    } else {
        "/v1/client".into()
    };
    url.set_path(&target);
    Ok(url.to_string())
}

pub async fn import_pairing(uri: String) -> Result<RemoteHost, String> {
    tokio::task::spawn_blocking(move || import_pairing_sync(&uri))
        .await
        .map_err(|error| error.to_string())?
}

pub async fn list_hosts() -> Result<Vec<RemoteHost>, String> {
    tokio::task::spawn_blocking(list_hosts_sync)
        .await
        .map_err(|error| error.to_string())?
}

pub async fn list_workspaces() -> Result<Vec<RemoteWorkspace>, String> {
    tokio::task::spawn_blocking(|| load_file().map(|file| file.workspaces))
        .await
        .map_err(|error| error.to_string())?
}

pub async fn remove_host(id: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        remove_host_sync(&id)?;
        Ok(id)
    })
    .await
    .map_err(|error| error.to_string())?
}

pub async fn save_workspace(
    host: RemoteHost,
    listing: WorkspaceListing,
) -> Result<Vec<RemoteWorkspace>, String> {
    tokio::task::spawn_blocking(move || save_workspace_sync(host, listing))
        .await
        .map_err(|error| error.to_string())?
}

pub async fn remove_workspace(id: String) -> Result<Vec<RemoteWorkspace>, String> {
    tokio::task::spawn_blocking(move || {
        let mut file = load_file()?;
        file.workspaces.retain(|workspace| workspace.id != id);
        save_file(&file)?;
        Ok(file.workspaces)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn import_pairing_sync(uri: &str) -> Result<RemoteHost, String> {
    let payload = decode_pairing(uri)?;
    let id = host_id(&payload.pub_key);
    if id.is_empty() {
        return Err("配对主机身份无效".into());
    }
    let previous = secret(&id).ok();
    let client_keys = previous.map_or_else(new_client_keys, |secret| secret.client_keys);
    let secret = HostSecret {
        token: payload.token,
        daemon_pub_key: payload.pub_key,
        relay: payload.relay.clone(),
        client_keys,
    };
    let serialized = serde_json::to_string(&secret).map_err(|error| error.to_string())?;
    keyring::Entry::new(SERVICE, &id)
        .and_then(|entry| entry.set_password(&serialized))
        .map_err(|_| "系统安全存储不可用，无法保存远程配对".to_owned())?;
    let mut file = load_file()?;
    let host = RemoteHost {
        id: id.clone(),
        name: payload.name,
        addrs: payload.addrs,
        port: payload.port,
        has_relay: payload.relay.is_some(),
        last_connected_at: file
            .hosts
            .iter()
            .find(|host| host.id == id)
            .and_then(|host| host.last_connected_at),
    };
    file.hosts.retain(|item| item.id != id);
    file.hosts.push(host.clone());
    if let Err(error) = save_file(&file) {
        let _ = keyring::Entry::new(SERVICE, &id).and_then(|entry| entry.delete_credential());
        return Err(error);
    }
    Ok(host)
}

fn decode_pairing(uri: &str) -> Result<PairingPayload, String> {
    let encoded = uri
        .trim()
        .strip_prefix("prospero://pair?d=")
        .ok_or_else(|| "不是 Prospero 配对串".to_owned())?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "配对串编码无效".to_owned())?;
    let payload: PairingPayload =
        serde_json::from_slice(&bytes).map_err(|_| "配对内容无效".to_owned())?;
    if uri.len() > 65_536
        || !matches!(payload.v, 5 | 7)
        || payload.name.is_empty()
        || payload.name.chars().count() > 200
        || payload.addrs.len() > 64
        || payload
            .addrs
            .iter()
            .any(|address| address.parse::<std::net::IpAddr>().is_err())
        || !(16..=4096).contains(&payload.token.len())
        || public_key(&payload.pub_key).is_err()
        || payload.addrs.is_empty() && payload.relay.is_none()
    {
        return Err("配对内容不兼容".into());
    }
    if let Some(relay) = &payload.relay
        && (relay.v != RELAY_VERSION
            || relay_client_url(&relay.url).is_err()
            || !opaque(&relay.route_id, 43, 43)
            || !opaque(&relay.device_id, 16, 128)
            || !opaque(&relay.token, 16, 512))
    {
        return Err("Relay 配对内容无效".into());
    }
    Ok(payload)
}

fn opaque(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn host_id(public_key: &str) -> String {
    public_key
        .chars()
        .take(16)
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

fn new_client_keys() -> ClientKeys {
    let mut rng = crypto_box::aead::OsRng;
    let secret = SecretKey::generate(&mut rng);
    ClientKeys {
        public_key: STANDARD.encode(secret.public_key().as_bytes()),
        secret_key: STANDARD.encode(secret.to_bytes()),
    }
}

fn load_host(id: &str) -> Result<(RemoteHost, HostSecret), String> {
    let host = load_file()?
        .hosts
        .into_iter()
        .find(|host| host.id == id)
        .ok_or_else(|| "远程电脑不存在".to_owned())?;
    Ok((host, secret(id)?))
}

fn secret(id: &str) -> Result<HostSecret, String> {
    let raw = keyring::Entry::new(SERVICE, id)
        .and_then(|entry| entry.get_password())
        .map_err(|_| "无法从系统安全存储读取远程配对".to_owned())?;
    let secret: HostSecret =
        serde_json::from_str(&raw).map_err(|_| "远程配对凭据损坏".to_owned())?;
    let private = secret_key(&secret.client_keys.secret_key)?;
    if STANDARD.encode(private.public_key().as_bytes()) != secret.client_keys.public_key
        || public_key(&secret.daemon_pub_key).is_err()
    {
        return Err("远程配对凭据损坏".into());
    }
    Ok(secret)
}

fn secret_key(value: &str) -> Result<SecretKey, String> {
    let bytes: [u8; 32] = STANDARD
        .decode(value)
        .map_err(|_| "私钥编码无效".to_owned())?
        .try_into()
        .map_err(|_| "私钥长度无效".to_owned())?;
    Ok(SecretKey::from(bytes))
}

fn list_hosts_sync() -> Result<Vec<RemoteHost>, String> {
    Ok(load_file()?.hosts)
}

fn save_workspace_sync(
    host: RemoteHost,
    listing: WorkspaceListing,
) -> Result<Vec<RemoteWorkspace>, String> {
    if !valid_remote_cwd(&listing.cwd) || !valid_relative_path(&listing.path) {
        return Err("远程工作区路径无效".into());
    }
    let mut file = load_file()?;
    let id = URL_SAFE_NO_PAD.encode(Sha256::digest(
        format!("{}\0{}", host.id, listing.cwd).as_bytes(),
    ));
    let name = listing
        .cwd
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(&listing.cwd)
        .to_owned();
    let workspace = RemoteWorkspace {
        id: id.clone(),
        host_id: host.id,
        host_name: host.name,
        cwd: listing.cwd,
        name,
        root: listing.root.unwrap_or_else(|| "home".into()),
        path: listing.path,
        created_at: now(),
    };
    file.workspaces.retain(|item| item.id != id);
    file.workspaces.push(workspace);
    save_file(&file)?;
    Ok(file.workspaces)
}

fn remove_host_sync(id: &str) -> Result<(), String> {
    let mut file = load_file()?;
    let original = file.clone();
    file.hosts.retain(|host| host.id != id);
    file.workspaces.retain(|workspace| workspace.host_id != id);
    save_file(&file)?;
    match keyring::Entry::new(SERVICE, id).and_then(|entry| entry.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => {
            let _ = save_file(&original);
            Err("无法从系统安全存储移除远程配对".into())
        }
    }
}

fn mark_connected(id: &str) -> Result<(), String> {
    let mut file = load_file()?;
    if let Some(host) = file.hosts.iter_mut().find(|host| host.id == id) {
        host.last_connected_at = Some(now());
        save_file(&file)?;
    }
    Ok(())
}

fn load_file() -> Result<HostFile, String> {
    let path = hosts_path();
    if !path.exists() {
        return Ok(HostFile {
            version: 1,
            hosts: Vec::new(),
            workspaces: Vec::new(),
        });
    }
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() || metadata.len() > 1024 * 1024 {
        return Err("远程电脑列表无效".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0
            || metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err("远程电脑列表权限不安全".into());
        }
    }
    let file: HostFile =
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|_| "远程电脑列表无效".to_owned())?;
    if file.version != 1 || file.hosts.len() > 100 || file.workspaces.len() > 500 {
        return Err("远程电脑列表版本或数量无效".into());
    }
    Ok(file)
}

fn save_file(file: &HostFile) -> Result<(), String> {
    let path = hosts_path();
    let parent = path.parent().ok_or_else(|| "远程存储路径无效".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".remote-hosts.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(file).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    output
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    output.sync_all().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn hosts_path() -> PathBuf {
    prospero_client::default_daemon_home()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("desktop/remote-hosts.json")
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn valid_remote_cwd(value: &str) -> bool {
    if value.is_empty() || value.chars().count() > 4096 || value.chars().any(char::is_control) {
        return false;
    }
    let windows = value.as_bytes().get(1) == Some(&b':')
        && value
            .as_bytes()
            .get(2)
            .is_some_and(|value| matches!(value, b'\\' | b'/'));
    let unc = value.starts_with("\\\\");
    let separator = if windows || unc { '\\' } else { '/' };
    (value.starts_with('/') || windows || unc)
        && !value
            .split(separator)
            .any(|part| matches!(part, "." | ".."))
}

fn valid_relative_path(value: &str) -> bool {
    value.chars().count() <= 4096
        && !value.starts_with('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && !value.split('/').any(|part| matches!(part, "." | ".."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    static REMOTE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[cfg(unix)]
    struct EnvGuard(Option<std::ffi::OsString>);

    #[cfg(unix)]
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            unsafe {
                match self.0.take() {
                    Some(value) => std::env::set_var("PROSPERO_CLAUDE_BIN", value),
                    None => std::env::remove_var("PROSPERO_CLAUDE_BIN"),
                }
            }
        }
    }

    #[cfg(unix)]
    async fn receive_kind(connection: &mut HostConnection, kind: &str) -> Value {
        for _ in 0..50 {
            let value = connection
                .channel
                .open(&recv_text(&mut connection.socket).await.unwrap())
                .unwrap();
            if value.get("type").and_then(Value::as_str) == Some(kind) {
                return value;
            }
        }
        panic!("remote message {kind} not received")
    }

    #[cfg(unix)]
    async fn receive_agent_event(connection: &mut HostConnection, sid: &str, kind: &str) -> Value {
        for _ in 0..100 {
            let value = connection
                .channel
                .open(&recv_text(&mut connection.socket).await.unwrap())
                .unwrap();
            if value.get("type").and_then(Value::as_str) == Some("agent.event")
                && value.get("sid").and_then(Value::as_str) == Some(sid)
                && value
                    .get("body")
                    .and_then(|body| body.get("kind"))
                    .and_then(Value::as_str)
                    == Some(kind)
            {
                return value;
            }
        }
        panic!("remote agent event {kind} not received")
    }

    #[test]
    fn decodes_current_pairing_payload() {
        let secret = SecretKey::from([7; 32]);
        let payload = json!({
            "v": 7,
            "name": "Studio",
            "addrs": ["192.0.2.1"],
            "port": 7423,
            "token": "0123456789abcdef",
            "pubKey": STANDARD.encode(secret.public_key().as_bytes())
        });
        let uri = format!(
            "prospero://pair?d={}",
            URL_SAFE_NO_PAD.encode(payload.to_string())
        );
        let decoded = decode_pairing(&uri).unwrap();
        assert_eq!(decoded.name, "Studio");
        assert_eq!(decoded.port, 7423);
    }

    #[test]
    fn rejects_insecure_relay_and_invalid_image_sized_frame() {
        assert!(relay_client_url("ws://relay.example/v1").is_err());
        assert!(opaque(&"a".repeat(43), 43, 43));
        assert_eq!(MAX_FRAME, 16 * 1024 * 1024);
    }

    #[test]
    fn client_handshake_interoperates_with_daemon_crypto() {
        let daemon = SecretKey::from([9; 32]);
        let (first, state) = client_handshake_start();
        let server = prosperod_rs::remote_crypto::server_handshake_respond(
            &first,
            &STANDARD.encode(daemon.to_bytes()),
        )
        .unwrap();
        let keys = new_client_keys();
        let host = HostSecret {
            token: "0123456789abcdef".into(),
            daemon_pub_key: STANDARD.encode(daemon.public_key().as_bytes()),
            relay: None,
            client_keys: keys.clone(),
        };
        let (hello, mut client) = client_handshake_finish(state, &server.frame, &host).unwrap();
        let mut accepted =
            prosperod_rs::remote_crypto::server_handshake_accept(server.state, &hello).unwrap();
        assert_eq!(accepted.hello["token"], host.token);
        assert_eq!(accepted.hello["clientPubKey"], keys.public_key);
        let frame = accepted
            .channel
            .seal(&json!({"type":"hello.ok","sessions":[]}))
            .unwrap();
        assert_eq!(client.open(&frame).unwrap()["type"], "hello.ok");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn connects_to_real_daemon_websocket_and_routes_encrypted_ping() {
        let _guard = REMOTE_TEST_LOCK.lock().await;
        let directory = tempfile::tempdir().unwrap();
        let claude = directory.path().join("fake-claude");
        std::fs::write(
            &claude,
            r#"#!/bin/sh
IFS= read -r input || exit 1
printf '%s\n' '{"type":"system","subtype":"init","session_id":"native-remote-1"}'
case "$input" in
  *interrupt-me*)
    printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"call-1","name":"Bash","input":{"command":"sleep"}}]}}'
    printf '%s\n' '{"type":"control_request","request_id":"permission-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"sleep"}}}'
    while IFS= read -r control; do
      case "$control" in
        *'"subtype":"interrupt"'*)
          printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"terminal_reason":"aborted_streaming"}'
          break
          ;;
      esac
    done
    ;;
  *)
    printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}'
    printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"remote structured ok"}}}'
    printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}'
    printf '%s\n' '{"type":"result","subtype":"success","is_error":false}'
    ;;
esac
"#,
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
        let previous = std::env::var_os("PROSPERO_CLAUDE_BIN");
        unsafe {
            std::env::set_var("PROSPERO_CLAUDE_BIN", &claude);
        }
        let _environment = EnvGuard(previous);
        let database = prosperod_rs::worker::Database::open(directory.path().to_path_buf())
            .await
            .unwrap();
        let api = prosperod_rs::server::Api::new(
            database.clone(),
            prosperod_rs::auth::Token::parse("a".repeat(64)).unwrap(),
        );
        let identity = prosperod_rs::pairing::load_or_create_identity(directory.path()).unwrap();
        let device = prosperod_rs::pairing::mint_device(
            directory.path(),
            "Native desktop".into(),
            true,
            true,
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn({
            let api = api.clone();
            async move { axum::serve(listener, api.router()).await.unwrap() }
        });
        let secret = HostSecret {
            token: device.token,
            daemon_pub_key: identity.public_key,
            relay: None,
            client_keys: new_client_keys(),
        };
        let (mut connection, sessions, _) = connect_url(
            secret,
            format!("ws://127.0.0.1:{}/ws", address.port()),
            None,
        )
        .await
        .unwrap();
        assert!(sessions.is_empty());
        send_value(
            &mut connection,
            json!({"type":"connection.ping","id":"ping-1"}),
        )
        .await
        .unwrap();
        let pong = connection
            .channel
            .open(&recv_text(&mut connection.socket).await.unwrap())
            .unwrap();
        assert_eq!(pong, json!({"type":"connection.pong","id":"ping-1"}));
        send_value(
            &mut connection,
            json!({
                "type":"session.create",
                "requestId":"create-1",
                "agent":"shell",
                "kind":"pty",
                "cwd":directory.path(),
                "command":"sh",
                "cols":80,
                "rows":24
            }),
        )
        .await
        .unwrap();
        let created = receive_kind(&mut connection, "session.create.result").await;
        assert_eq!(created["type"], "session.create.result");
        assert_eq!(created["ok"], true);
        let sid = created["session"]["id"].as_str().unwrap().to_owned();
        send_value(&mut connection, json!({"type":"session.attach","sid":sid}))
            .await
            .unwrap();
        let snapshot = receive_kind(&mut connection, "term.snapshot").await;
        assert_eq!(snapshot["type"], "term.snapshot");
        send_value(
            &mut connection,
            json!({"type":"workspace.list","root":"home","path":""}),
        )
        .await
        .unwrap();
        let listing = receive_kind(&mut connection, "workspace.listing").await;
        assert_eq!(listing["root"], "home");
        assert!(
            listing["cwd"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );
        send_value(
            &mut connection,
            json!({
                "type":"term.input",
                "sid":sid,
                "dataB64":STANDARD.encode(b"printf 'REMOTE-OK\\n'\r")
            }),
        )
        .await
        .unwrap();
        let mut found = false;
        for _ in 0..20 {
            let value = connection
                .channel
                .open(&recv_text(&mut connection.socket).await.unwrap())
                .unwrap();
            if value["type"] == "term.output" {
                let bytes = STANDARD.decode(value["dataB64"].as_str().unwrap()).unwrap();
                if String::from_utf8_lossy(&bytes).contains("REMOTE-OK") {
                    found = true;
                    break;
                }
            }
        }
        assert!(found);
        send_value(&mut connection, json!({"type":"session.kill","sid":sid}))
            .await
            .unwrap();
        send_command(
            &mut connection,
            Command::CreateAgent {
                cwd: directory.path().to_string_lossy().into_owned(),
                agent: prospero_protocol_rs::AgentKind::Claude,
                request_id: "create-agent-1".into(),
            },
        )
        .await
        .unwrap();
        let created = receive_kind(&mut connection, "session.create.result").await;
        assert_eq!(created["requestId"], "create-agent-1");
        assert_eq!(created["ok"], true);
        let agent_sid = created["session"]["id"].as_str().unwrap().to_owned();
        send_command(
            &mut connection,
            Command::Attach {
                sid: agent_sid.clone(),
                last_seq: None,
                previous: None,
            },
        )
        .await
        .unwrap();
        let snapshot = receive_kind(&mut connection, "chat.snapshot").await;
        assert_eq!(snapshot["sid"], agent_sid);
        assert_eq!(snapshot["events"], json!([]));
        send_command(
            &mut connection,
            Command::ChatSend {
                sid: agent_sid.clone(),
                text: "hello-structured".into(),
                attachments: Vec::new(),
            },
        )
        .await
        .unwrap();
        let user = receive_agent_event(&mut connection, &agent_sid, "user.message").await;
        assert_eq!(user["body"]["text"], "hello-structured");
        let text = receive_agent_event(&mut connection, &agent_sid, "text.delta").await;
        assert_eq!(text["body"]["delta"], "remote structured ok");
        let ended = receive_agent_event(&mut connection, &agent_sid, "turn.end").await;
        assert_eq!(ended["body"]["finish"], "completed");
        send_command(
            &mut connection,
            Command::ChatSend {
                sid: agent_sid.clone(),
                text: "interrupt-me".into(),
                attachments: Vec::new(),
            },
        )
        .await
        .unwrap();
        let permission =
            receive_agent_event(&mut connection, &agent_sid, "permission.request").await;
        assert_eq!(permission["body"]["reqId"], "permission-1");
        send_command(&mut connection, Command::Interrupt(agent_sid.clone()))
            .await
            .unwrap();
        let interrupted = receive_agent_event(&mut connection, &agent_sid, "turn.end").await;
        assert_eq!(interrupted["body"]["finish"], "interrupted");
        send_command(&mut connection, Command::Kill(agent_sid))
            .await
            .unwrap();
        let _ = connection.socket.close(None).await;
        server.abort();
        api.stop();
        database.shutdown().await.unwrap();
    }

    #[test]
    fn validates_remote_workspace_paths() {
        assert!(valid_remote_cwd("/home/test/project"));
        assert!(valid_remote_cwd(r"C:\Users\Test"));
        assert!(valid_remote_cwd(r"\\server\share"));
        assert!(!valid_remote_cwd("relative/path"));
        assert!(!valid_remote_cwd("/tmp/../secret"));
        assert!(valid_relative_path("projects/demo"));
        assert!(!valid_relative_path("projects/../secret"));
    }

    #[test]
    fn host_id_matches_existing_clients() {
        assert_eq!(host_id("ab+/CD_1234567890tail"), "abCD123456789");
    }
}
