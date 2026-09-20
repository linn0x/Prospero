use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use prosperod_rs::auth::Token;
use prosperod_rs::protocol::{
    API_VERSION, AgentKind, CreateSession, DATABASE_QUEUE_CAPACITY, MessageRole, SessionKind,
    SessionStatus, TimelineBody, TimelineWrite, UpdateSession,
};
use prosperod_rs::server::Api;
use prosperod_rs::worker::Database;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

static CLI_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const FAKE_CLAUDE: &str = r#"#!/usr/bin/env python3
import json, sys, time
sys.stdout.write(json.dumps({"type": "system", "subtype": "init", "session_id": "fake-remote-worker"}) + "\n")
sys.stdout.flush()
sys.stdin.readline()
while True:
    time.sleep(1)
"#;

async fn fixture() -> (TempDir, Api) {
    let directory = TempDir::new().unwrap();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();
    (
        directory,
        Api::new(database, Token::parse(SECRET.into()).unwrap()),
    )
}

async fn health(api: &Api) -> (StatusCode, Value) {
    let response = api
        .router()
        .oneshot(
            Request::builder()
                .uri("/v1/health")
                .header("authorization", format!("Bearer {SECRET}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    (status, body)
}

async fn api_request(api: &Api, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
    let response = api
        .router()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("authorization", format!("Bearer {SECRET}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    (status, value)
}

fn key_b64(key: &[u8; 32]) -> String {
    use base64::Engine;
    use base64::prelude::BASE64_STANDARD;
    BASE64_STANDARD.encode(key)
}

fn nonce(dir: u8, count: u64) -> [u8; 24] {
    let mut n = [0; 24];
    n[0] = dir;
    n[1..9].copy_from_slice(&count.to_be_bytes());
    n
}

fn seal(cipher: &crypto_box::SalsaBox, send_count: &mut u64, value: &Value) -> String {
    use base64::Engine;
    use base64::prelude::BASE64_STANDARD;
    use crypto_box::Nonce;
    use crypto_box::aead::Aead;
    let bytes = serde_json::to_vec(value).unwrap();
    let encrypted = cipher
        .encrypt(&Nonce::from(nonce(1, *send_count)), bytes.as_slice())
        .unwrap();
    *send_count += 1;
    json!({"c": BASE64_STANDARD.encode(encrypted)}).to_string()
}

fn open(cipher: &crypto_box::SalsaBox, recv_count: &mut u64, frame: &str) -> Value {
    use base64::Engine;
    use base64::prelude::BASE64_STANDARD;
    use crypto_box::Nonce;
    use crypto_box::aead::Aead;
    let value: Value = serde_json::from_str(frame).unwrap();
    let encrypted = BASE64_STANDARD
        .decode(value["c"].as_str().unwrap())
        .unwrap();
    let plain = cipher
        .decrypt(&Nonce::from(nonce(2, *recv_count)), encrypted.as_slice())
        .unwrap();
    *recv_count += 1;
    serde_json::from_slice(&plain).unwrap()
}

#[tokio::test]
async fn health_dto_reports_rust_http_contract() {
    let (_directory, api) = fixture().await;
    let (status, body) = health(&api).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["apiVersion"], json!(API_VERSION));
    assert_eq!(body["backend"], "rust");
    assert_eq!(body["daemonVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(body["buildId"], "development");
    assert_eq!(body["activeRuntimeSessions"], 0);
    assert_eq!(
        body["databaseQueueCapacity"],
        json!(DATABASE_QUEUE_CAPACITY)
    );
    assert_eq!(body["database"]["alive"], true);
    assert_eq!(body["database"]["queueDepth"], 0);
    assert!(body["database"]["lastError"].is_null());
    assert_eq!(body["persistence"]["structured"], true);
    assert_eq!(body["persistence"]["pty"], cfg!(unix));
    assert!(body["capabilities"].as_array().unwrap().len() > 5);
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_rejects_a_stale_build_identity() {
    let (_directory, api) = fixture().await;
    let (status, body) = api_request(
        &api,
        "POST",
        "/v1/shutdown?expectedBuildId=stale",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "conflict");
    let (status, _) = health(&api).await;
    assert_eq!(status, StatusCode::OK);
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn health_capabilities_are_explicitly_local_http_not_mobile_ws() {
    let (_directory, api) = fixture().await;
    let (_status, body) = health(&api).await;
    let capabilities = body["capabilities"].as_array().unwrap();
    for expected in [
        "session.metadata",
        "session.search",
        "session.timeline",
        "events.stream",
        "terminal.pty",
        #[cfg(unix)]
        "terminal.unix",
        #[cfg(windows)]
        "terminal.windows.conpty",
        "agent.api-protocols.v1",
        "agent.api-validation.v1",
        "agent.api-engine-validation.v1",
        "agent.account.api.models",
        "agent.account.config",
        "conversation.search.v1",
        "chat.attachment-previews.v1",
        "agent.deepseek-harness.v1",
        "model.sources.v1",
        "relay.host.v1",
    ] {
        assert!(
            capabilities.iter().any(|capability| capability == expected),
            "missing health capability {expected}"
        );
    }
    for remote_only in [
        "session.create-result.v1",
        "fs.put-ack.v1",
        "workspace.summary.v1",
        "agent.accounts.v1",
        "orchestration.snapshot.v1",
        "orchestration.manual.v1",
    ] {
        assert!(
            !capabilities
                .iter()
                .any(|capability| capability == remote_only),
            "Rust local health must not imply unimplemented mobile/remote WS capability {remote_only}"
        );
    }
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn health_prefers_live_relay_supervisor_status() {
    let (_directory, api) = fixture().await;
    api.relay_status
        .set(prosperod_rs::relay::RelayRuntimeStatus {
            enabled: true,
            state: prosperod_rs::relay::RelayConnectionState::Online,
            url: Some("wss://relay.example.com".into()),
            route_id: Some("CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk".into()),
            updated_at: 2,
            last_connected_at: Some(1),
            last_error: None,
            devices: prosperod_rs::relay::RelayRuntimeDeviceStatus {
                total: 2,
                ready: 1,
                needs_re_pair: 1,
            },
            active_streams: 0,
            stream_failures: 0,
            last_stream_error: None,
        });
    let (status, body) = health(&api).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["relay"]["state"], "online");
    assert_eq!(body["relay"]["devices"]["ready"], 1);
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn device_pairing_routes_are_authenticated_and_never_list_secrets() {
    use base64::Engine;
    use base64::prelude::BASE64_URL_SAFE_NO_PAD;

    let (directory, api) = fixture().await;
    let host_secret = prosperod_rs::relay::generate_relay_host_secret();
    prosperod_rs::relay::save_relay_config_raw(
        directory.path(),
        true,
        Some("wss://relay.example.com".into()),
        Some(host_secret.clone()),
    )
    .unwrap();

    let response = api
        .router()
        .oneshot(
            Request::builder()
                .uri("/v1/devices")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let (status, paired) = api_request(
        &api,
        "POST",
        "/v1/pairings",
        json!({
            "name": "iPhone",
            "allowShell": true,
            "allowOrchestration": true
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(paired["device"]["name"], "iPhone");
    assert_eq!(paired["device"]["relayReady"], true);
    let serialized = paired.to_string();
    assert!(!serialized.contains(&host_secret));
    for forbidden in ["clientPubKey", "relayToken", "relayDeviceId"] {
        assert!(!serialized.contains(forbidden));
    }
    let uri = paired["uri"].as_str().unwrap();
    let payload = uri.strip_prefix("prospero://pair?d=").unwrap();
    let decoded: Value =
        serde_json::from_slice(&BASE64_URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
    assert_eq!(decoded["v"], 7);
    assert_eq!(decoded["relay"]["url"], "wss://relay.example.com");
    assert!(decoded["token"].as_str().unwrap().len() >= 32);
    assert!(decoded["relay"]["token"].as_str().unwrap().len() >= 32);

    let (status, devices) = api_request(&api, "GET", "/v1/devices", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(devices["items"].as_array().unwrap().len(), 1);
    assert_eq!(devices["items"][0]["relayReady"], true);
    let listed = devices.to_string();
    for forbidden in ["token", "clientPubKey", "relayDeviceId", "relayToken"] {
        assert!(!listed.contains(forbidden));
    }

    let id = devices["items"][0]["id"].as_str().unwrap();
    let (status, revoked) =
        api_request(&api, "DELETE", &format!("/v1/devices/{id}"), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(revoked["ok"], true);
    assert!(
        prosperod_rs::pairing::load_devices(directory.path())
            .unwrap()
            .is_empty()
    );
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn relay_routes_prefer_live_status_and_rotate_without_exposing_secret() {
    let (directory, api) = fixture().await;
    let host_secret = prosperod_rs::relay::generate_relay_host_secret();
    prosperod_rs::relay::save_relay_config_raw(
        directory.path(),
        true,
        Some("wss://relay.example.com".into()),
        Some(host_secret.clone()),
    )
    .unwrap();
    let device =
        prosperod_rs::pairing::mint_device(directory.path(), "phone".into(), true, true).unwrap();
    let issued = prosperod_rs::pairing::issue_relay_credentials(&device);
    prosperod_rs::pairing::persist_relay_credentials(directory.path(), &issued).unwrap();
    api.relay_status
        .set(prosperod_rs::relay::RelayRuntimeStatus {
            enabled: true,
            state: prosperod_rs::relay::RelayConnectionState::Online,
            url: Some("wss://relay.example.com".into()),
            route_id: Some("CG1dTxTscx5Vm84XPQRwkXjI61ziPLQNbj7La6EVEyk".into()),
            updated_at: 2,
            last_connected_at: Some(1),
            last_error: None,
            devices: prosperod_rs::relay::RelayRuntimeDeviceStatus {
                total: 1,
                ready: 1,
                needs_re_pair: 0,
            },
            active_streams: 2,
            stream_failures: 1,
            last_stream_error: Some("closed".into()),
        });

    let (status, relay) = api_request(&api, "GET", "/v1/relay", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(relay["runtime"]["state"], "online");
    assert_eq!(relay["runtime"]["activeStreams"], 2);
    assert!(!relay.to_string().contains(&host_secret));

    let (status, relay) = api_request(&api, "PATCH", "/v1/relay", json!({"rotateKey": true})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(relay["rePairRequired"], true);
    assert_ne!(
        prosperod_rs::relay::load_daemon_relay_config(directory.path())
            .unwrap()
            .relay
            .unwrap()
            .host_secret
            .unwrap(),
        host_secret
    );
    let devices = prosperod_rs::pairing::load_devices(directory.path()).unwrap();
    assert!(prosperod_rs::relay::device_relay_credentials(&devices[0]).is_none());
    assert!(!relay.to_string().contains("hostSecret"));
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn status_projection_writes_legacy_desktop_snapshot_shape() {
    let (directory, api) = fixture().await;
    let session = api
        .database
        .call(|store| {
            let session = store.create_session(CreateSession {
                agent: AgentKind::Claude,
                kind: SessionKind::Structured,
                title: "Needs approval".into(),
                workspace: "/tmp/project".into(),
            })?;
            store.update_session(
                &session.id,
                UpdateSession {
                    revision: session.revision,
                    title: None,
                    lifecycle: None,
                    status: Some(SessionStatus::WaitingPermission),
                },
            )
        })
        .await
        .unwrap();
    api.write_status_projection(7423, Some("127.0.0.1".into()), SECRET.into())
        .await
        .unwrap();
    let status: Value = serde_json::from_str(
        &std::fs::read_to_string(directory.path().join("status.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(status["controlToken"], SECRET);
    assert_eq!(status["sessionSummary"]["attention"], 1);
    assert_eq!(status["sessionSummary"]["terminal"], 0);
    assert_eq!(status["sessions"][0]["id"], session.id);
    assert_eq!(status["sessions"][0]["status"], "waiting_approval");
    assert_eq!(status["sessions"][0]["pendingPermissions"], 1);
    assert_eq!(status["sessions"][0]["pendingQuestions"], 0);
    assert!(
        status["sessions"][0]["busySince"]
            .as_i64()
            .is_some_and(|value| value >= session.created_at)
    );
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn status_projection_sends_notify_when_attention_increases() {
    let (directory, api) = fixture().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<Value>();
    let notify_server = tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0u8; 1024];
        loop {
            let read = stream.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .or_else(|| {
                    headers
                        .lines()
                        .find_map(|line| line.strip_prefix("Content-Length:"))
                })
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            let body_start = header_end + 4;
            while request.len() < body_start + length {
                let read = stream.read(&mut buffer).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            seen_tx
                .send(serde_json::from_slice(&request[body_start..body_start + length]).unwrap())
                .unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                .await
                .unwrap();
            break;
        }
    });
    std::fs::write(
        directory.path().join("config.json"),
        json!({"notify":{"url":format!("http://{addr}/notify")}}).to_string(),
    )
    .unwrap();
    api.write_status_projection(7423, None, SECRET.into())
        .await
        .unwrap();
    api.database
        .call(|store| {
            let session = store.create_session(CreateSession {
                agent: AgentKind::Claude,
                kind: SessionKind::Structured,
                title: "Needs input".into(),
                workspace: "/tmp/project".into(),
            })?;
            store.update_session(
                &session.id,
                UpdateSession {
                    revision: session.revision,
                    title: None,
                    lifecycle: None,
                    status: Some(SessionStatus::WaitingInput),
                },
            )?;
            Ok(())
        })
        .await
        .unwrap();
    api.write_status_projection(7423, None, SECRET.into())
        .await
        .unwrap();
    let body = tokio::time::timeout(std::time::Duration::from_secs(2), seen_rx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(body["title"], "Prospero 等待你的处理");
    assert!(
        body["body"]
            .as_str()
            .unwrap()
            .contains("1 个审批或问题需要处理")
    );
    notify_server.await.unwrap();
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn direct_ws_boundary_uses_encrypted_pairing_not_http_bearer() {
    let (_directory, api) = fixture().await;
    let response = api
        .router()
        .oneshot(
            Request::builder()
                .uri("/ws")
                .header("origin", "https://example.invalid")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let response = api
        .router()
        .oneshot(
            Request::builder()
                .uri("/ws")
                .header("connection", "upgrade")
                .header("upgrade", "websocket")
                .header("sec-websocket-version", "13")
                .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // `tower::ServiceExt::oneshot` cannot provide hyper's upgrade extension;
    // reaching 426 proves the route is a real WebSocket boundary. `/ws` does
    // not require the local HTTP bearer because it authenticates inside the
    // encrypted pairing handshake, matching the mobile/relay protocol.
    assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED);
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn remote_ws_connections_are_bounded_and_release_on_drop() {
    use tokio_tungstenite::tungstenite::http::StatusCode as WsStatusCode;

    let (_directory, api) = fixture().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_api = api.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, server_api.router()).await.unwrap();
    });
    let url = format!("ws://{addr}/ws");
    let mut sockets = Vec::new();
    for _ in 0..16 {
        let (socket, _) = tokio_tungstenite::connect_async(url.as_str())
            .await
            .unwrap();
        sockets.push(socket);
    }
    match tokio_tungstenite::connect_async(url.as_str()).await {
        Ok(_) => panic!("remote websocket limit should reject the 17th connection"),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status(), WsStatusCode::SERVICE_UNAVAILABLE);
        }
        Err(other) => panic!("unexpected websocket failure: {other:?}"),
    }
    drop(sockets.pop());
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let (socket, _) = tokio_tungstenite::connect_async(url.as_str())
        .await
        .unwrap();
    drop(socket);
    drop(sockets);
    server.abort();
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn remote_ws_idle_handshake_times_out() {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

    let directory = TempDir::new().unwrap();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();
    let api = Api::new(database, Token::parse(SECRET.into()).unwrap())
        .with_remote_ws_handshake_timeout(std::time::Duration::from_millis(50));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_api = api.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, server_api.router()).await.unwrap();
    });
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .unwrap();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(1), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    match frame {
        Message::Close(Some(close)) => assert_eq!(close.code, CloseCode::Library(4003)),
        other => panic!("unexpected idle handshake close frame: {other:?}"),
    }
    server.abort();
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn remote_ws_live_connection_closes_after_device_revoke() {
    use base64::Engine;
    use base64::prelude::BASE64_STANDARD;
    use crypto_box::{PublicKey, SalsaBox, SecretKey};
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

    let (directory, api) = fixture().await;
    let daemon_secret = SecretKey::from([9u8; 32]);
    std::fs::write(
        directory.path().join("identity.json"),
        json!({"publicKey": key_b64(daemon_secret.public_key().as_bytes()), "secretKey": key_b64(&[9u8; 32])}).to_string(),
    )
    .unwrap();
    std::fs::write(
        directory.path().join("devices.json"),
        json!({"devices":[{"name":"phone","token":"paired-token-123456","allowShell":true,"createdAt":1}]}).to_string(),
    )
    .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_api = api.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, server_api.router()).await.unwrap();
    });

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .unwrap();
    let client_eph = SecretKey::from([3u8; 32]);
    ws.send(Message::Text(
        json!({
            "v": prosperod_rs::remote_crypto::PROTOCOL_VERSION,
            "eph": key_b64(client_eph.public_key().as_bytes()),
            "cv": prosperod_rs::remote_crypto::CRYPTO_VERSION,
            "minV": prosperod_rs::remote_crypto::MIN_PROTOCOL_VERSION,
            "maxV": prosperod_rs::remote_crypto::PROTOCOL_VERSION,
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    let proof = match ws.next().await.unwrap().unwrap() {
        Message::Text(text) => serde_json::from_str::<Value>(&text).unwrap(),
        other => panic!("unexpected proof frame: {other:?}"),
    };
    let server_eph_bytes: [u8; 32] = BASE64_STANDARD
        .decode(proof["seph"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let cipher = SalsaBox::new(&PublicKey::from(server_eph_bytes), &client_eph);
    let mut send_count = 0;
    let mut recv_count = 0;
    let client_identity = SecretKey::from([4u8; 32]);
    ws.send(Message::Text(
        seal(
            &cipher,
            &mut send_count,
            &json!({
                "type":"hello",
                "token":"paired-token-123456",
                "clientPubKey":key_b64(client_identity.public_key().as_bytes()),
                "clientInfo":{"platform":"desktop","appVersion":"test"},
            }),
        )
        .into(),
    ))
    .await
    .unwrap();
    match ws.next().await.unwrap().unwrap() {
        Message::Text(text) => {
            assert_eq!(open(&cipher, &mut recv_count, &text)["type"], "hello.ok");
        }
        other => panic!("unexpected hello frame: {other:?}"),
    }

    std::fs::write(
        directory.path().join("devices.json"),
        json!({"devices":[]}).to_string(),
    )
    .unwrap();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    match frame {
        Message::Close(Some(close)) => assert_eq!(close.code, CloseCode::Library(4004)),
        other => panic!("unexpected revoke close frame: {other:?}"),
    }
    server.abort();
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn encrypted_ws_handshake_authenticates_and_routes_ping() {
    use base64::Engine;
    use base64::prelude::BASE64_STANDARD;
    use crypto_box::{PublicKey, SalsaBox, SecretKey};
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let (directory, api) = fixture().await;
    let _cli_env = CLI_ENV_LOCK.lock().await;
    let fake_claude = directory.path().join("fake-claude.py");
    std::fs::write(&fake_claude, FAKE_CLAUDE).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake_claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let previous_claude_bin = std::env::var_os("PROSPERO_CLAUDE_BIN");
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &fake_claude);
    }
    let daemon_secret = SecretKey::from([9u8; 32]);
    std::fs::write(
        directory.path().join("identity.json"),
        json!({"publicKey": key_b64(daemon_secret.public_key().as_bytes()), "secretKey": key_b64(&[9u8; 32])}).to_string(),
    )
    .unwrap();
    std::fs::write(
        directory.path().join("devices.json"),
        json!({"devices":[{"name":"phone","token":"paired-token-123456","allowShell":true,"createdAt":1}]}).to_string(),
    )
    .unwrap();
    let seeded = api
        .database
        .call(|store| store.seed_conversation(1))
        .await
        .unwrap();
    let seeded_for_history = seeded.id.clone();
    api.database
        .call(move |store| {
            for index in 0..120 {
                store.write_timeline(
                    &seeded_for_history,
                    TimelineWrite {
                        id: format!("remote-history-{index}"),
                        turn_id: format!("remote-history-turn-{index}"),
                        expected_revision: 0,
                        body: TimelineBody::Message {
                            role: MessageRole::User,
                            final_answer: false,
                            attachments: Vec::new(),
                        },
                        text: format!("history event {index}"),
                        replace: false,
                        subagent_id: None,
                    },
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_api = api.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, server_api.router()).await.unwrap();
    });

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .unwrap();
    let client_eph = SecretKey::from([3u8; 32]);
    ws.send(Message::Text(
        json!({
            "v": prosperod_rs::remote_crypto::PROTOCOL_VERSION,
            "eph": key_b64(client_eph.public_key().as_bytes()),
            "cv": prosperod_rs::remote_crypto::CRYPTO_VERSION,
            "minV": prosperod_rs::remote_crypto::MIN_PROTOCOL_VERSION,
            "maxV": prosperod_rs::remote_crypto::PROTOCOL_VERSION,
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    let proof = match ws.next().await.unwrap().unwrap() {
        Message::Text(text) => serde_json::from_str::<Value>(&text).unwrap(),
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
    ws.send(Message::Text(
        seal(
            &cipher,
            &mut send_count,
            &json!({
                "type":"hello",
                "token":"paired-token-123456",
                "clientPubKey":key_b64(client_identity.public_key().as_bytes()),
                "clientInfo":{"platform":"desktop","appVersion":"test"},
            }),
        )
        .into(),
    ))
    .await
    .unwrap();
    let hello_ok = match ws.next().await.unwrap().unwrap() {
        Message::Text(text) => open(&cipher, &mut recv_count, &text),
        other => panic!("unexpected hello.ok frame: {other:?}"),
    };
    assert_eq!(hello_ok["type"], "hello.ok");
    assert_eq!(hello_ok["host"]["negotiatedProtocolVersion"], json!(16));
    assert!(
        hello_ok["host"]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|capability| capability == "agent.deepseek-harness.v1")
    );
    assert!(hello_ok["sessions"].as_array().unwrap().is_empty());

    ws.send(Message::Text(
        seal(
            &cipher,
            &mut send_count,
            &json!({"type":"connection.ping","id":"ping-1"}),
        )
        .into(),
    ))
    .await
    .unwrap();
    let pong = match ws.next().await.unwrap().unwrap() {
        Message::Text(text) => open(&cipher, &mut recv_count, &text),
        other => panic!("unexpected pong frame: {other:?}"),
    };
    assert_eq!(pong, json!({"type":"connection.pong","id":"ping-1"}));

    ws.send(Message::Text(
        seal(
            &cipher,
            &mut send_count,
            &json!({"type":"workspace.list","path":"","root":"home"}),
        )
        .into(),
    ))
    .await
    .unwrap();
    let listing = match ws.next().await.unwrap().unwrap() {
        Message::Text(text) => open(&cipher, &mut recv_count, &text),
        other => panic!("unexpected workspace listing frame: {other:?}"),
    };
    assert_eq!(listing["type"], "workspace.listing");
    assert_eq!(listing["root"], "home");
    assert!(listing["cwd"].as_str().unwrap().starts_with('/'));
    assert!(listing["entries"].is_array());

    ws.send(Message::Text(
        seal(
            &cipher,
            &mut send_count,
            &json!({"type":"orchestration.run.create","objective":"remote ws run"}),
        )
        .into(),
    ))
    .await
    .unwrap();
    let orchestration = match ws.next().await.unwrap().unwrap() {
        Message::Text(text) => open(&cipher, &mut recv_count, &text),
        other => panic!("unexpected orchestration frame: {other:?}"),
    };
    assert_eq!(orchestration["type"], "orchestration.snapshot");
    let runs = orchestration["snapshot"]["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["objective"], "remote ws run");
    assert!(orchestration["snapshot"]["tasks"].is_array());
    assert!(orchestration["snapshot"]["dispatches"].is_array());
    assert!(orchestration["snapshot"]["gates"].is_array());
    assert!(orchestration["snapshot"]["worktreeAssets"].is_array());
    let remote_run_id = runs[0]["id"].as_str().unwrap().to_owned();

    ws.send(Message::Text(
        seal(
            &cipher,
            &mut send_count,
            &json!({
                "type":"orchestration.task.create",
                "runId":remote_run_id,
                "title":"remote worker",
                "spec":"do it",
                "operationId":"remote-task-op-1"
            }),
        )
        .into(),
    ))
    .await
    .unwrap();
    let task_snapshot = match ws.next().await.unwrap().unwrap() {
        Message::Text(text) => open(&cipher, &mut recv_count, &text),
        other => panic!("unexpected task snapshot frame: {other:?}"),
    };
    assert_eq!(task_snapshot["type"], "orchestration.snapshot");
    assert_eq!(
        task_snapshot["snapshot"]["tasks"].as_array().unwrap().len(),
        1
    );

    ws.send(Message::Text(
        seal(
            &cipher,
            &mut send_count,
            &json!({
                "type":"orchestration.automation.start",
                "runId":remote_run_id,
                "agent":"claude",
                "approvalPolicy":"standard",
                "workspace":"current",
                "cwd":directory.path(),
                "operationId":"remote-auto-start-1"
            }),
        )
        .into(),
    ))
    .await
    .unwrap();
    let auto_snapshot = match ws.next().await.unwrap().unwrap() {
        Message::Text(text) => open(&cipher, &mut recv_count, &text),
        other => panic!("unexpected automation snapshot frame: {other:?}"),
    };
    assert_eq!(auto_snapshot["type"], "orchestration.snapshot");
    let auto_run = auto_snapshot["snapshot"]["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|run| run["id"] == remote_run_id)
        .unwrap();
    assert_eq!(auto_run["automation"]["state"], "running");
    assert_eq!(
        auto_snapshot["snapshot"]["dispatches"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    ws.send(Message::Text(
        seal(
            &cipher,
            &mut send_count,
            &json!({
                "type":"orchestration.automation.pause",
                "runId":remote_run_id,
                "operationId":"remote-auto-pause-1"
            }),
        )
        .into(),
    ))
    .await
    .unwrap();
    let mut paused_snapshot = Value::Null;
    for _ in 0..5 {
        let frame = match ws.next().await.unwrap().unwrap() {
            Message::Text(text) => open(&cipher, &mut recv_count, &text),
            other => panic!("unexpected automation pause frame: {other:?}"),
        };
        if frame["type"] == "orchestration.snapshot" {
            paused_snapshot = frame;
            break;
        }
    }
    assert_eq!(
        paused_snapshot["type"], "orchestration.snapshot",
        "{paused_snapshot}"
    );
    let paused_run = paused_snapshot["snapshot"]["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|run| run["id"] == remote_run_id)
        .unwrap();
    assert_eq!(paused_run["automation"]["state"], "paused");

    ws.send(Message::Text(
        seal(
            &cipher,
            &mut send_count,
            &json!({"type":"agent.accounts.list","requestId":"accounts-1"}),
        )
        .into(),
    ))
    .await
    .unwrap();
    let accounts = match ws.next().await.unwrap().unwrap() {
        Message::Text(text) => open(&cipher, &mut recv_count, &text),
        other => panic!("unexpected accounts frame: {other:?}"),
    };
    assert_eq!(accounts["type"], "agent.accounts.result");
    assert_eq!(accounts["requestId"], "accounts-1");
    assert_eq!(accounts["action"], "list");
    assert!(accounts["accounts"].is_array());

    ws.send(Message::Text(
        seal(
            &cipher,
            &mut send_count,
            &json!({"type":"session.attach","sid":seeded.id}),
        )
        .into(),
    ))
    .await
    .unwrap();
    let chat = match ws.next().await.unwrap().unwrap() {
        Message::Text(text) => open(&cipher, &mut recv_count, &text),
        other => panic!("unexpected chat snapshot frame: {other:?}"),
    };
    assert_eq!(chat["type"], "chat.snapshot");
    assert_eq!(chat["sid"], seeded.id);
    let events = chat["events"].as_array().unwrap();
    assert!(
        events.len() > 100,
        "chat snapshot should page through full timeline history"
    );
    assert!(events.iter().any(|event| event["kind"] == "user.message"));
    assert!(
        events
            .iter()
            .any(|event| event["text"] == "history event 119")
    );
    assert!(events.iter().any(|event| event["kind"] == "text.delta"));
    assert!(events.iter().any(|event| event["kind"] == "tool.start"));
    assert!(events.iter().any(|event| event["kind"] == "tool.end"));
    assert!(events.iter().any(|event| event["kind"] == "turn.end"));
    let ev_seq = chat["evSeq"].as_i64().unwrap();

    let live_sid = seeded.id.clone();
    api.database
        .call(move |store| {
            store.write_timeline(
                &live_sid,
                TimelineWrite {
                    id: "remote-live-message".into(),
                    turn_id: "remote-live-turn".into(),
                    expected_revision: 0,
                    body: TimelineBody::Message {
                        role: MessageRole::Assistant,
                        final_answer: true,
                        attachments: Vec::new(),
                    },
                    text: "live update from rust".into(),
                    replace: false,
                    subagent_id: None,
                },
            )
        })
        .await
        .unwrap();
    api.publish();
    let live = match tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        Message::Text(text) => open(&cipher, &mut recv_count, &text),
        other => panic!("unexpected live chat frame: {other:?}"),
    };
    assert_eq!(live["type"], "agent.event");
    assert_eq!(live["sid"], seeded.id);
    assert!(live["evSeq"].as_i64().unwrap() > ev_seq);
    assert_eq!(live["body"]["kind"], "text.delta");
    assert_eq!(live["body"]["delta"], "live update from rust");

    server.abort();
    unsafe {
        if let Some(previous) = previous_claude_bin {
            std::env::set_var("PROSPERO_CLAUDE_BIN", previous);
        } else {
            std::env::remove_var("PROSPERO_CLAUDE_BIN");
        }
    }
}
