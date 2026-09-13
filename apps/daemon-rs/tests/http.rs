use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use futures_util::StreamExt;
use prosperod_rs::agent::CreateAgentSession as CreateAgentRun;
use prosperod_rs::auth::Token;
use prosperod_rs::protocol::{
    AgentKind, CreateSession, MessageRole, SessionKind, TimelineBody, TimelineWrite, ToolState,
};
use prosperod_rs::server::Api;
use prosperod_rs::worker::Database;
use serde_json::{Value, json};
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use tempfile::TempDir;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async fn fixture() -> (TempDir, Api, String) {
    fixture_workspace("/synthetic").await
}

async fn fixture_workspace(workspace: impl AsRef<Path>) -> (TempDir, Api, String) {
    let directory = TempDir::new().unwrap();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();
    let workspace = workspace.as_ref().to_string_lossy().to_string();
    let head = database
        .call(move |store| {
            store.create_session(CreateSession {
                agent: AgentKind::Codex,
                kind: SessionKind::Structured,
                title: "Example".into(),
                workspace,
            })
        })
        .await
        .unwrap();
    (
        directory,
        Api::new(database, Token::parse(SECRET.into()).unwrap()),
        head.id,
    )
}

fn request(uri: &str) -> axum::http::request::Builder {
    Request::builder()
        .uri(uri)
        .header("authorization", format!("Bearer {SECRET}"))
}

async fn body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}

#[tokio::test]
async fn every_endpoint_requires_auth_and_rejects_browser_origins() {
    let (_directory, api, _) = fixture().await;
    for uri in [
        "/v1/health",
        "/v1/sessions",
        "/v1/sessions/summary",
        "/v1/sessions/lookup",
        "/v1/workspaces",
        "/v1/sessions/example/timeline",
        "/v1/sessions/example/timeline/entry/body",
        "/v1/terminals",
        "/v1/terminals/example/output",
        "/v1/terminals/example/snapshot",
        "/v1/terminals/example/input",
        "/v1/terminals/example/resize",
        "/v1/terminals/example/close",
        "/v1/agent-sessions/example/tool-output?callId=call_1",
        "/v1/sessions/example/workspace-summary?requestId=req1",
        "/v1/sessions/example/fs/list?path=",
        "/v1/sessions/example/fs/read?path=file.txt",
        "/v1/sessions/example/fs/get?path=file.txt&offset=0&length=1",
        "/v1/sessions/example/search",
        "/v1/sessions/example/git/status",
        "/v1/sessions/example/git/diff?path=file.txt&staged=false",
        "/v1/sessions/example/git/history",
        "/v1/events?scope=sessions",
        "/unknown",
    ] {
        let response = api
            .router()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body(response).await["code"], "unauthorized");
    }
    let response = api
        .router()
        .oneshot(
            request("/v1/health")
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
            request("/v1/health")
                .header("authorization", format!("Bearer {SECRET}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn tool_output_route_returns_persisted_tool_text() {
    let (_directory, api, id) = fixture().await;
    let session_id = id.clone();
    api.database
        .call(move |store| {
            store.write_timeline(
                &session_id,
                TimelineWrite {
                    id: "call_1".into(),
                    turn_id: "turn1".into(),
                    expected_revision: 0,
                    body: TimelineBody::Tool {
                        name: "Bash".into(),
                        state: ToolState::Success,
                        summary: "preview".into(),
                    },
                    text: "full tool output".into(),
                    replace: false,
                    subagent_id: None,
                },
            )
        })
        .await
        .unwrap();
    let response = api
        .router()
        .oneshot(
            request(&format!(
                "/v1/agent-sessions/{id}/tool-output?callId=call_1"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        body(response).await,
        json!({"output":"full tool output","truncated":false})
    );
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn project_fs_routes_are_session_scoped_and_bounded() {
    let workspace = TempDir::new().unwrap();
    std::fs::create_dir(workspace.path().join("src")).unwrap();
    std::fs::write(workspace.path().join("src/main.txt"), b"hello").unwrap();
    std::fs::write(workspace.path().join("image.bin"), b"a\0b").unwrap();
    let outside = TempDir::new().unwrap();
    std::fs::write(outside.path().join("secret.txt"), b"secret").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        workspace.path().join("link-out"),
    )
    .unwrap();

    let (_directory, api, id) = fixture_workspace(workspace.path()).await;
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/fs/list?path="))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let listing = body(response).await;
    assert_eq!(listing["type"], "fs.listing");
    assert_eq!(listing["entries"][0]["name"], "src");
    assert!(
        !listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["name"] == ".git")
    );

    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/fs/read?path=src%2Fmain.txt"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await["contentB64"], "aGVsbG8=");

    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/fs/read?path=image.bin"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await["binary"], true);

    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/fs/read?path=.git%2Fconfig"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/fs/write"))
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"path":"new.txt","contentB64":"cnVzdA=="}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await["size"], 4);
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("new.txt")).unwrap(),
        "rust"
    );

    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/fs/write"))
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"path":"created.txt","contentB64":"","createNew":true}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        std::fs::read(workspace.path().join("created.txt")).unwrap(),
        b""
    );
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/fs/write"))
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"path":"created.txt","contentB64":"b29wcw==","createNew":true})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        std::fs::read(workspace.path().join("created.txt")).unwrap(),
        b""
    );

    let empty_sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/fs/write"))
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"path":"created.txt","contentB64":"5L2g5aW9DQrkuJbnlYwK","expectedVersion":empty_sha}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("created.txt")).unwrap(),
        "你好\r\n世界\n"
    );
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/fs/write"))
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"path":"created.txt","contentB64":"c3RhbGU=","expectedVersion":empty_sha}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("created.txt")).unwrap(),
        "你好\r\n世界\n"
    );

    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/fs/write"))
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"path":".git/config","contentB64":"","createNew":true}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let response = api
        .router()
        .oneshot(
            request(&format!(
                "/v1/sessions/{id}/fs/get?path=new.txt&offset=1&length=2"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await["dataB64"], "dXM=");

    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/fs/mkdir"))
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(json!({"path":"tmp"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(workspace.path().join("tmp").is_dir());

    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/search"))
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"query":"rust","caseSensitive":false,"wholeWord":true,"pathFilter":""})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let search = body(response).await;
    assert_eq!(search["matches"].as_array().unwrap().len(), 1);
    assert_eq!(search["matches"][0]["path"], "new.txt");
    assert_eq!(search["matches"][0]["line"], 1);
    assert_eq!(search["matches"][0]["column"], 1);

    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/fs/rename"))
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"path":"new.txt","to":"tmp/renamed.txt"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(workspace.path().join("tmp/renamed.txt").is_file());

    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/fs/remove"))
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(json!({"path":"tmp/renamed.txt"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!workspace.path().join("tmp/renamed.txt").exists());

    #[cfg(unix)]
    {
        let response = api
            .router()
            .oneshot(
                request(&format!("/v1/sessions/{id}/fs/read?path=link-out"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        std::os::unix::fs::symlink("src/main.txt", workspace.path().join("link-in")).unwrap();
        let response = api
            .router()
            .oneshot(
                request(&format!("/v1/sessions/{id}/fs/write"))
                    .method("POST")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"path":"link-in","contentB64":"bXV0YXRlZA=="}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("src/main.txt")).unwrap(),
            "hello"
        );
        let response = api
            .router()
            .oneshot(
                request(&format!("/v1/sessions/{id}/fs/rename"))
                    .method("POST")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"path":"link-in","to":"link-renamed"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(workspace.path().join("link-in").exists());
    }

    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn project_git_routes_report_diff_and_mutate_index() {
    let workspace = TempDir::new().unwrap();
    Command::new("git")
        .args(["init", "-b", "main"])
        .current_dir(workspace.path())
        .output()
        .unwrap();
    std::fs::write(workspace.path().join("file.txt"), "one\n").unwrap();
    Command::new("git")
        .args(["add", "file.txt"])
        .current_dir(workspace.path())
        .output()
        .unwrap();
    Command::new("git")
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "initial",
        ])
        .current_dir(workspace.path())
        .output()
        .unwrap();
    std::fs::write(workspace.path().join("file.txt"), "two\n").unwrap();
    std::fs::write(workspace.path().join("new.txt"), "new\n").unwrap();

    let (_directory, api, id) = fixture_workspace(workspace.path()).await;
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/git/status"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let status = body(response).await;
    assert_eq!(status["branch"], "main");
    assert!(
        status["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "file.txt")
    );
    assert!(
        status["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "new.txt" && file["untracked"] == true)
    );

    let response = api
        .router()
        .oneshot(
            request(&format!(
                "/v1/sessions/{id}/git/diff?path=new.txt&staged=false"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        body(response).await["patch"]
            .as_str()
            .unwrap()
            .contains("+new")
    );

    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/git/stage"))
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"paths":["file.txt"],"unstage":false}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await["op"], "stage");

    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/git/history"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let history = body(response).await;
    assert_eq!(history["type"], "git.history.result");
    assert_eq!(history["entries"][0]["subject"], "initial");
    assert_eq!(history["entries"][0]["author"], "test");

    let response = api
        .router()
        .oneshot(
            request(&format!(
                "/v1/sessions/{id}/workspace-summary?requestId=req1"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let summary = body(response).await;
    assert_eq!(summary["type"], "workspace.summary.result");
    assert_eq!(summary["requestId"], "req1");
    assert_eq!(summary["branch"], "main");
    assert!(summary["sizeBytes"].as_u64().unwrap() >= 8);

    std::fs::create_dir(workspace.path().join("removed")).unwrap();
    std::fs::write(
        workspace.path().join("removed/file.txt"),
        "old
",
    )
    .unwrap();
    Command::new("git")
        .args(["add", "removed/file.txt"])
        .current_dir(workspace.path())
        .output()
        .unwrap();
    Command::new("git")
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "add removed",
        ])
        .current_dir(workspace.path())
        .output()
        .unwrap();
    std::fs::remove_dir_all(workspace.path().join("removed")).unwrap();
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/git/stage"))
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"paths":["removed/file.txt"],"unstage":false}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = api
        .router()
        .oneshot(
            request(&format!(
                "/v1/sessions/{id}/git/diff?path=removed%2Ffile.txt&staged=true"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        body(response).await["patch"]
            .as_str()
            .unwrap()
            .contains("-old")
    );

    Command::new("git")
        .args(["reset", "--hard", "HEAD"])
        .current_dir(workspace.path())
        .output()
        .unwrap();
    Command::new("git")
        .args(["mv", "file.txt", "renamed.txt"])
        .current_dir(workspace.path())
        .output()
        .unwrap();
    std::fs::write(
        workspace.path().join("renamed.txt"),
        "three
",
    )
    .unwrap();
    let response = api
        .router()
        .oneshot(
            request(&format!(
                "/v1/sessions/{id}/git/diff?path=renamed.txt&staged=true"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let patch = body(response).await["patch"].as_str().unwrap().to_owned();
    assert_eq!(patch, "");
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/git/status"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let status = body(response).await;
    assert!(
        status["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| { file["path"] == "renamed.txt" && file["originalPath"] == "file.txt" })
    );

    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn rename_commits_then_replays_without_exposing_a_global_snapshot() {
    let (_directory, api, id) = fixture().await;
    let response = api
        .router()
        .oneshot(request("/v1/sessions?limit=1").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let page = body(response).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["id"], id);
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}"))
                .method("PATCH")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"revision":1,"title":"Renamed"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await["revision"], 2);
    let response = api
        .router()
        .oneshot(
            request("/v1/events?scope=sessions&afterSeq=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let page = body(response).await;
    assert_eq!(page["items"][0]["kind"], "session.updated");
    assert_eq!(page["items"][0]["data"]["title"], "Renamed");
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}"))
                .method("PATCH")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"revision":1,"title":"Stale"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn invalid_queries_and_unknown_mutations_are_rejected() {
    let (_directory, api, id) = fixture().await;
    for uri in [
        "/v1/sessions?limit=201",
        "/v1/sessions?unexpected=true",
        "/v1/sessions?workspace=",
        "/v1/sessions?text=%2A",
        "/v1/sessions/summary?unexpected=true",
        "/v1/workspaces?limit=201",
        "/v1/events?scope=sessions&afterSeq=-1",
        "/v1/events?scope=sessions&afterSeq=100",
        "/v1/events?scope=sessions&limit=0",
    ] {
        let response = api
            .router()
            .oneshot(request(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}");
    }
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}"))
                .method("PATCH")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"revision":1,"title":"Changed","status":"running"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn content_is_binary_and_bounded() {
    let (_directory, api, id) = fixture().await;
    let saved = id.clone();
    api.database
        .call(move |store| store.append_content(&saved, "history", 0, b"hello"))
        .await
        .unwrap();
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/content/history?offset=0"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.headers()["content-type"],
        "application/octet-stream"
    );
    assert_eq!(response.headers()["x-next-offset"], "5");
    assert_eq!(
        &to_bytes(response.into_body(), 10).await.unwrap()[..],
        b"hello"
    );
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn stream_replays_then_delivers_committed_changes_and_stops() {
    let (_directory, api, id) = fixture().await;
    let response = api
        .router()
        .oneshot(
            request("/v1/events/stream?scope=sessions&afterSeq=0")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.into_body().into_data_stream();
    let connected = tokio::time::timeout(Duration::from_secs(1), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        String::from_utf8(connected.to_vec())
            .unwrap()
            .contains("connected")
    );
    let first = tokio::time::timeout(Duration::from_secs(1), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let text = String::from_utf8(first.to_vec()).unwrap();
    assert!(text.contains("id: 1"));
    assert!(text.contains("session.created"));
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}"))
                .method("PATCH")
                .header("content-type", "application/json")
                .body(Body::from(json!({"revision":1,"title":"Live"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let next = tokio::time::timeout(Duration::from_secs(1), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        String::from_utf8(next.to_vec())
            .unwrap()
            .contains("session.updated")
    );
    api.stop();
    assert!(
        tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .is_none()
    );
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn stream_limit_is_released_when_responses_are_dropped() {
    let (_directory, api, _) = fixture().await;
    let mut streams = Vec::new();
    for _ in 0..16 {
        let response = api
            .router()
            .oneshot(
                request("/v1/events/stream?scope=sessions&afterSeq=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        streams.push(response);
    }
    let response = api
        .router()
        .oneshot(
            request("/v1/events/stream?scope=sessions&afterSeq=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    drop(streams.pop());
    let response = api
        .router()
        .oneshot(
            request("/v1/events/stream?scope=sessions&afterSeq=1")
                .header("last-event-id", "1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    drop(response);
    drop(streams);
    api.stop();
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn timeline_routes_expose_previews_and_generation_checked_body_pages() {
    let (_directory, api, id) = fixture().await;
    let saved = id.clone();
    api.database
        .call(move |store| {
            store.write_timeline(
                &saved,
                TimelineWrite {
                    id: "message".into(),
                    turn_id: "turn".into(),
                    expected_revision: 0,
                    body: TimelineBody::Message {
                        role: MessageRole::Assistant,
                        final_answer: true,
                        attachments: Vec::new(),
                    },
                    text: "中🦀".repeat(5000),
                    replace: false,
                    subagent_id: None,
                },
            )
        })
        .await
        .unwrap();
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/timeline"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let page = body(response).await;
    assert_eq!(page["items"][0]["truncated"], true);
    assert_eq!(page["items"][0]["body"]["finalAnswer"], true);
    let response = api
        .router()
        .oneshot(
            request(&format!(
                "/v1/sessions/{id}/timeline/message/body?generation=1"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(body(response).await["text"], "中🦀".repeat(5000));
    let response = api
        .router()
        .oneshot(
            request(&format!(
                "/v1/sessions/{id}/timeline/message/body?generation=2"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/sessions/{id}/timeline?before=2&after=1"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    api.database.shutdown().await.unwrap();
}

#[tokio::test]
async fn usage_endpoint_matches_legacy_control_envelope() {
    let directory = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let database = Database::open(directory.path().to_path_buf())
        .await
        .unwrap();
    let api = Api::new(database.clone(), Token::parse(SECRET.into()).unwrap());
    let head = api
        .agents
        .create(CreateAgentRun {
            agent: prosperod_rs::protocol::AgentKind::Claude,
            title: "Claude".into(),
            workspace: workspace.path().to_str().unwrap().into(),
            auto_approve: false,
            model: None,
            effort: None,
            account_id: None,
        })
        .await
        .unwrap();
    let response = api
        .router()
        .oneshot(
            request(&format!("/v1/usage?sid={}", head.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let usage = body(response).await;
    assert_eq!(usage["type"], "usage.result");
    assert_eq!(usage["sid"], head.id);
    assert_eq!(usage["available"], false);
    assert_eq!(usage["windows"].as_array().unwrap().len(), 0);
    assert!(usage["reason"].as_str().unwrap().contains("还没产生用量"));
    let response = api
        .router()
        .oneshot(request("/v1/usage").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let usage = body(response).await;
    assert_eq!(usage["type"], "usage.result");
    assert!(usage.get("sid").is_none());
    assert!(usage["accounts"].is_array());
    database.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn usage_without_sid_reads_codex_account_limits_from_app_server() {
    use std::os::unix::fs::PermissionsExt;

    struct EnvGuard;
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("PROSPERO_CODEX_BIN");
            }
        }
    }

    let (directory, api, _) = fixture().await;
    let codex = directory.path().join("fake-codex.py");
    std::fs::write(
        &codex,
        r#"#!/usr/bin/env python3
import json, sys
if sys.argv[1:] != ["app-server"]:
    sys.exit(3)
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if "id" not in msg:
        continue
    rid = msg["id"]
    if method == "initialize":
        result = {}
    elif method == "account/read":
        result = {"account": {"id": "acct"}}
    elif method == "account/rateLimits/read":
        result = {"rateLimitsByLimitId": {"codex": {
            "planType": "pro",
            "primary": {"usedPercent": 42.5, "windowDurationMins": 300, "resetsAt": 1700000000},
            "secondary": {"usedPercent": 9, "windowDurationMins": 10080},
            "credits": {"unlimited": False, "balance": "12.34"},
            "individualLimit": {"limit": "20", "used": "5", "remainingPercent": 75}
        }}}
    elif method == "account/usage/read":
        result = {"summary": {"lifetimeTokens": "1234"}, "dailyUsageBuckets": [
            {"startDate": "2026-09-12", "tokens": 10},
            {"startDate": "2026-09-13", "tokens": "22"}
        ]}
    else:
        result = {}
    sys.stdout.write(json.dumps({"id": rid, "result": result}) + "\n")
    sys.stdout.flush()
"#,
    )
    .unwrap();
    std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
    let _env = EnvGuard;
    unsafe {
        std::env::set_var("PROSPERO_CODEX_BIN", &codex);
    }

    let response = api
        .router()
        .oneshot(request("/v1/usage").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let usage = body(response).await;
    let accounts = usage["accounts"].as_array().unwrap();
    let codex = accounts
        .iter()
        .find(|account| account["accountId"] == "native-codex")
        .expect("native codex usage account");
    assert_eq!(codex["agent"], "codex");
    assert_eq!(codex["source"], "subscription");
    assert_eq!(codex["available"], true);
    assert_eq!(codex["subscription"], "pro");
    assert_eq!(codex["lifetimeTokens"], 1234);
    assert_eq!(codex["creditsBalance"], "12.34");
    assert_eq!(codex["spendRemainingPercent"], 75.0);
    assert_eq!(codex["windows"][0]["label"], "5 小时");
    assert_eq!(codex["windows"][0]["utilization"], 42.5);
    assert_eq!(codex["windows"][0]["resetsAt"], "2023-11-14T22:13:20.000Z");
    assert_eq!(codex["windows"][1]["label"], "7 天");
    assert_eq!(codex["dailyUsage"][1]["tokens"], 22);
    api.database.shutdown().await.unwrap();
}
