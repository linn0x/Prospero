use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use prosperod_rs::auth::Token;
use prosperod_rs::protocol::{API_VERSION, DATABASE_QUEUE_CAPACITY};
use prosperod_rs::server::Api;
use prosperod_rs::worker::Database;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

#[tokio::test]
async fn health_dto_reports_rust_http_contract() {
    let (_directory, api) = fixture().await;
    let (status, body) = health(&api).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["apiVersion"], json!(API_VERSION));
    assert_eq!(body["backend"], "rust");
    assert_eq!(body["activeRuntimeSessions"], 0);
    assert_eq!(
        body["databaseQueueCapacity"],
        json!(DATABASE_QUEUE_CAPACITY)
    );
    assert!(body["capabilities"].as_array().unwrap().len() > 5);
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
        "agent.api-protocols.v1",
        "agent.api-validation.v1",
        "agent.api-engine-validation.v1",
        "agent.account.api.models",
        "agent.account.config",
        "conversation.search.v1",
        "chat.attachment-previews.v1",
        "model.sources.v1",
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
async fn encrypted_ws_handshake_authenticates_and_routes_ping() {
    use base64::Engine;
    use base64::prelude::BASE64_STANDARD;
    use crypto_box::aead::Aead;
    use crypto_box::{Nonce, PublicKey, SalsaBox, SecretKey};
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    fn key_b64(key: &[u8; 32]) -> String {
        BASE64_STANDARD.encode(key)
    }
    fn nonce(dir: u8, count: u64) -> [u8; 24] {
        let mut n = [0; 24];
        n[0] = dir;
        n[1..9].copy_from_slice(&count.to_be_bytes());
        n
    }
    fn seal(cipher: &SalsaBox, send_count: &mut u64, value: &Value) -> String {
        let bytes = serde_json::to_vec(value).unwrap();
        let encrypted = cipher
            .encrypt(&Nonce::from(nonce(1, *send_count)), bytes.as_slice())
            .unwrap();
        *send_count += 1;
        json!({"c": BASE64_STANDARD.encode(encrypted)}).to_string()
    }
    fn open(cipher: &SalsaBox, recv_count: &mut u64, frame: &str) -> Value {
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
    let server = tokio::spawn(async move {
        axum::serve(listener, api.router()).await.unwrap();
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

    server.abort();
}
