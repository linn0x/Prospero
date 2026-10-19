use super::{
    BudgetClaim, BudgetClient, BudgetConfig, BudgetDecision, BudgetStatus, Request, Response,
};
use crate::{
    database::{now, validate_id},
    orchestration::reliability::{
        ExecutionIdentity, ExitProofKind, ExitProofVerifier, VerifiedExitProof,
    },
};
use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{Mutex, Semaphore, watch},
    time::timeout,
};

const MAX_REQUEST: usize = 32 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_CLAIMS: u64 = 1_000_000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    protocol_version: u32,
    socket: PathBuf,
    broker_epoch: String,
}

struct Store {
    connection: Connection,
    _writer: File,
    capacity: u32,
    epoch: String,
}

fn other(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn private_directory(path: &Path, create: bool) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(other("budget paths must be absolute"));
    }
    if create {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(other("budget directory is not private"));
    }
    Ok(())
}

fn open_private(path: &Path, create: bool, maximum: u64) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(create)
        .create(create)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
        || metadata.len() > maximum
    {
        return Err(other("budget file is not private or exceeds limit"));
    }
    Ok(file)
}

fn read_private(path: &Path, maximum: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open_private(path, false, maximum)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(other("budget file exceeds limit"));
    }
    Ok(bytes)
}

fn load_token(directory: &Path, create: bool) -> io::Result<String> {
    let path = directory.join("token");
    if create && !path.try_exists()? {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)?;
        file.write_all(
            format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            )
            .as_bytes(),
        )?;
        file.sync_all()?;
        File::open(directory)?.sync_all()?;
    }
    let token = String::from_utf8(read_private(&path, 128)?).map_err(other)?;
    if !valid_digest(&token) {
        return Err(other("invalid budget token"));
    }
    Ok(token)
}

pub(super) fn client(directory: &Path) -> io::Result<BudgetClient> {
    private_directory(directory, false)?;
    let manifest: Manifest =
        serde_json::from_slice(&read_private(&directory.join("manifest.json"), 8192)?)
            .map_err(other)?;
    if manifest.protocol_version != 1
        || manifest.socket.file_name().and_then(|name| name.to_str()) != Some("control.sock")
    {
        return Err(other("unsupported or invalid budget manifest"));
    }
    let parent = manifest
        .socket
        .parent()
        .ok_or_else(|| other("budget socket has no directory"))?;
    private_directory(parent, false)?;
    if !parent
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("prospero-budget-"))
    {
        return Err(other("invalid budget socket directory"));
    }
    Ok(BudgetClient {
        socket: manifest.socket,
        token: load_token(directory, false)?,
        epoch: manifest.broker_epoch,
    })
}

pub async fn ensure_budget(
    directory: &Path,
    binary: &Path,
    capacity: u32,
) -> io::Result<BudgetClient> {
    if capacity == 0 {
        return Err(other("budget capacity must be positive"));
    }
    if let Ok(client) = client(directory)
        && client.health().await.is_ok_and(|status| status.ready)
    {
        return Ok(client);
    }
    private_directory(directory, true)?;
    let mut command = tokio::process::Command::new(binary);
    command
        .arg("--directory")
        .arg(directory)
        .arg("--capacity")
        .arg(capacity.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = command.spawn()?;
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(client) = client(directory)
            && client.health().await.is_ok_and(|status| status.ready)
        {
            return Ok(client);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(other("budget unavailable; new admission remains closed"));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

impl Store {
    fn open(config: &BudgetConfig) -> io::Result<Self> {
        let writer = open_private(&config.directory.join("writer.lock"), true, 128)?;
        writer.try_lock_exclusive()?;
        let path = config.directory.join("budget.sqlite");
        open_private(&path, true, 512 * 1024 * 1024)?;
        for suffix in ["-wal", "-shm", "-journal"] {
            let sidecar = config.directory.join(format!("budget.sqlite{suffix}"));
            if fs::symlink_metadata(&sidecar).is_ok() {
                open_private(&sidecar, false, 512 * 1024 * 1024)?;
            }
        }
        let connection = Connection::open(path).map_err(other)?;
        connection
            .busy_timeout(Duration::from_millis(500))
            .map_err(other)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-2048; PRAGMA max_page_count=131072;").map_err(other)?;
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(other)?;
        let application: u32 = connection
            .query_row("PRAGMA application_id", [], |r| r.get(0))
            .map_err(other)?;
        if version == 0 && application == 0 {
            connection.execute_batch("BEGIN IMMEDIATE; CREATE TABLE budget_claims(claim_id TEXT PRIMARY KEY,execution_key TEXT NOT NULL UNIQUE,identity TEXT NOT NULL,daemon_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('held','quarantined','released')),proof TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT; CREATE INDEX budget_active ON budget_claims(state) WHERE state IN ('held','quarantined'); PRAGMA application_id=1346523714; PRAGMA user_version=1; COMMIT;").map_err(other)?;
        } else if version != 1 || application != 1346523714 {
            return Err(other("unsupported budget ledger schema"));
        }
        Ok(Self {
            connection,
            _writer: writer,
            capacity: config.capacity,
            epoch: uuid::Uuid::new_v4().simple().to_string(),
        })
    }

    fn get(&self, id: &str) -> io::Result<Option<BudgetClaim>> {
        self.connection
            .query_row(
                "SELECT identity,daemon_id,state FROM budget_claims WHERE claim_id=?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(other)?
            .map(|(identity, daemon_id, state)| {
                Ok(BudgetClaim {
                    claim_id: id.into(),
                    identity: serde_json::from_str(&identity).map_err(other)?,
                    daemon_id,
                    state,
                })
            })
            .transpose()
    }

    fn reserve(
        &mut self,
        identity: ExecutionIdentity,
        daemon_id: String,
    ) -> io::Result<BudgetDecision> {
        validate_identity(&identity)?;
        validate_id(&daemon_id).map_err(other)?;
        let encoded = serde_json::to_string(&identity).map_err(other)?;
        let id = digest(encoded.as_bytes());
        let host = identity
            .host
            .as_ref()
            .ok_or_else(|| other("budget claim requires Host identity"))?;
        let execution_key = digest(
            &serde_json::to_vec(&(&host.host_id, &host.host_epoch, &identity.attempt_id))
                .map_err(other)?,
        );
        let previous: Option<String> = self
            .connection
            .query_row(
                "SELECT claim_id FROM budget_claims WHERE execution_key=?1",
                [&execution_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(other)?;
        if previous.as_ref().is_some_and(|previous| previous != &id) {
            return Err(other(
                "budget execution identity conflicts with an existing claim",
            ));
        }
        if let Some(claim) = self.get(&id)? {
            if claim.identity != identity
                || claim.daemon_id != daemon_id
                || claim.state == "released"
            {
                return Err(other("budget claim identity conflicts with existing claim"));
            }
            return Ok(BudgetDecision::Granted(Box::new(claim)));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(other)?;
        let used: u32 = transaction
            .query_row(
                "SELECT count(*) FROM budget_claims WHERE state IN ('held','quarantined')",
                [],
                |r| r.get(0),
            )
            .map_err(other)?;
        if used >= self.capacity {
            return Ok(BudgetDecision::Waiting {
                used,
                capacity: self.capacity,
            });
        }
        let count: i64 = transaction
            .query_row("SELECT count(*) FROM budget_claims", [], |r| r.get(0))
            .map_err(other)?;
        let pages: i64 = transaction
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .map_err(other)?;
        if count >= MAX_CLAIMS as i64 || pages >= 127_000 {
            return Err(other(
                "budget ledger admission limit reached; release space is reserved",
            ));
        }
        transaction.execute("INSERT INTO budget_claims(claim_id,execution_key,identity,daemon_id,state,created_at,updated_at)VALUES(?1,?2,?3,?4,'held',?5,?5)",params![id,execution_key,encoded,daemon_id,now()]).map_err(other)?;
        transaction.commit().map_err(other)?;
        Ok(BudgetDecision::Granted(Box::new(BudgetClaim {
            claim_id: id,
            identity,
            daemon_id,
            state: "held".into(),
        })))
    }

    fn quarantine(&mut self, identity: ExecutionIdentity) -> io::Result<BudgetClaim> {
        validate_identity(&identity)?;
        let id = digest(&serde_json::to_vec(&identity).map_err(other)?);
        let mut claim = self
            .get(&id)?
            .ok_or_else(|| other("budget claim not found"))?;
        if claim.identity != identity || claim.state == "released" {
            return Err(other("budget claim cannot be quarantined"));
        }
        self.connection.execute("UPDATE budget_claims SET state='quarantined',updated_at=?2 WHERE claim_id=?1 AND state='held'",params![id,now()]).map_err(other)?;
        claim.state = "quarantined".into();
        Ok(claim)
    }

    fn release(
        &mut self,
        identity: ExecutionIdentity,
        proof: VerifiedExitProof,
    ) -> io::Result<BudgetClaim> {
        validate_identity(&identity)?;
        validate_id(&proof.proof_id).map_err(other)?;
        let valid_verifier = matches!(
            (proof.kind, proof.verifier),
            (ExitProofKind::DriverQuiescence, ExitProofVerifier::Driver)
                | (
                    ExitProofKind::HostProcessExit,
                    ExitProofVerifier::ExecutionHost
                )
                | (
                    ExitProofKind::StartupNotStarted,
                    ExitProofVerifier::StartupCoordinator
                )
        );
        if proof.attempt_id != identity.attempt_id
            || proof.execution_epoch != identity.execution_epoch
            || proof.host != identity.host
            || proof.config_digest != identity.config_digest
            || !valid_digest(&proof.evidence_digest)
            || proof.verified_at <= 0
            || !valid_verifier
        {
            return Err(other(
                "budget release requires a matching verified process exit or not-started proof",
            ));
        }
        let id = digest(&serde_json::to_vec(&identity).map_err(other)?);
        let encoded = serde_json::to_string(&proof).map_err(other)?;
        let mut claim = match self.get(&id)? {
            Some(claim) => claim,
            None => {
                let host = identity
                    .host
                    .as_ref()
                    .ok_or_else(|| other("budget claim requires Host identity"))?;
                let execution_key = digest(
                    &serde_json::to_vec(&(&host.host_id, &host.host_epoch, &identity.attempt_id))
                        .map_err(other)?,
                );
                self.connection.execute("INSERT INTO budget_claims(claim_id,execution_key,identity,daemon_id,state,proof,created_at,updated_at)VALUES(?1,?2,?3,'released-before-reserve','released',?4,?5,?5)",params![id,execution_key,serde_json::to_string(&identity).map_err(other)?,encoded,now()]).map_err(other)?;
                return Ok(BudgetClaim {
                    claim_id: id,
                    identity,
                    daemon_id: "released-before-reserve".into(),
                    state: "released".into(),
                });
            }
        };
        if claim.identity != identity {
            return Err(other("budget release identity mismatch"));
        }
        if claim.state == "released" {
            let original: String = self
                .connection
                .query_row(
                    "SELECT proof FROM budget_claims WHERE claim_id=?1",
                    [&id],
                    |r| r.get(0),
                )
                .map_err(other)?;
            if original != encoded {
                return Err(other("budget release proof conflicts with original proof"));
            }
            return Ok(claim);
        }
        self.connection.execute("UPDATE budget_claims SET state='released',proof=?2,updated_at=?3 WHERE claim_id=?1 AND state IN ('held','quarantined')",params![id,encoded,now()]).map_err(other)?;
        claim.state = "released".into();
        Ok(claim)
    }

    fn status(&self) -> io::Result<BudgetStatus> {
        let counts=self.connection.query_row("SELECT COALESCE(sum(state='held'),0),COALESCE(sum(state='quarantined'),0),COALESCE(sum(state='released'),0)FROM budget_claims",[],|r|Ok((r.get::<_,u32>(0)?,r.get::<_,u32>(1)?,r.get::<_,i64>(2)?))).map_err(other)?;
        Ok(BudgetStatus {
            protocol_version: 1,
            broker_epoch: self.epoch.clone(),
            capacity: self.capacity,
            held: counts.0,
            quarantined: counts.1,
            released: counts.2.max(0) as u64,
            ready: true,
        })
    }
}

fn validate_identity(identity: &ExecutionIdentity) -> io::Result<()> {
    for id in [&identity.task_id, &identity.attempt_id] {
        validate_id(id).map_err(other)?;
    }
    if let Some(dispatch) = &identity.dispatch_id {
        validate_id(dispatch).map_err(other)?;
    }
    let host = identity
        .host
        .as_ref()
        .ok_or_else(|| other("budget claim requires Host identity"))?;
    validate_id(&host.host_id).map_err(other)?;
    validate_id(&host.host_epoch).map_err(other)?;
    if identity.execution_epoch == 0
        || identity.execution_epoch > i64::MAX as u64
        || !valid_digest(&identity.config_digest)
    {
        return Err(other("budget claim execution identity is incomplete"));
    }
    Ok(())
}

pub async fn serve(config: BudgetConfig) -> io::Result<()> {
    if config.capacity == 0 {
        return Err(other("budget capacity must be positive"));
    }
    private_directory(&config.directory, true)?;
    let store = Store::open(&config)?;
    let token = load_token(&config.directory, true)?;
    let socket_directory =
        PathBuf::from("/tmp").join(format!("prospero-budget-{}", uuid::Uuid::new_v4().simple()));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&socket_directory)?;
    let socket = socket_directory.join("control.sock");
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
    let manifest = Manifest {
        protocol_version: 1,
        socket: socket.clone(),
        broker_epoch: store.epoch.clone(),
    };
    let temporary = config
        .directory
        .join(format!("manifest-{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)?;
    file.write_all(&serde_json::to_vec(&manifest).map_err(other)?)?;
    file.sync_all()?;
    fs::rename(temporary, config.directory.join("manifest.json"))?;
    File::open(&config.directory)?.sync_all()?;
    let store = Arc::new(Mutex::new(store));
    let token = Arc::new(token);
    let semaphore = Arc::new(Semaphore::new(64));
    let (shutdown, mut stopping) = watch::channel(false);
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            _=stopping.changed()=>break,
            _=terminate.recv()=>break,
            signal=tokio::signal::ctrl_c()=>{signal?;break;},
            accepted=listener.accept()=>{
                let (stream,_)=accepted?;
                let Ok(permit)=semaphore.clone().try_acquire_owned()else{drop(stream);continue;};
                let store=store.clone();let token=token.clone();let shutdown=shutdown.clone();
                tokio::spawn(async move {let _permit=permit;let _=connection(stream,store,token,shutdown).await;});
            }
        }
    }
    drop(listener);
    let _ = fs::remove_file(&socket);
    let _ = fs::remove_dir(&socket_directory);
    Ok(())
}

async fn connection(
    stream: UnixStream,
    store: Arc<Mutex<Store>>,
    token: Arc<String>,
    shutdown: watch::Sender<bool>,
) -> io::Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let bytes = timeout(REQUEST_TIMEOUT, bounded_line(&mut reader))
        .await
        .map_err(other)??;
    let request: Request = serde_json::from_slice(&bytes).map_err(other)?;
    let provided = match &request {
        Request::Reserve { token, .. }
        | Request::Quarantine { token, .. }
        | Request::Release { token, .. }
        | Request::Health { token }
        | Request::Shutdown { token } => token,
    };
    if token.len() != provided.len() || !bool::from(token.as_bytes().ct_eq(provided.as_bytes())) {
        return write_response(
            &mut writer,
            Response::Error {
                code: "UNAUTHORIZED".into(),
                message: "invalid budget capability".into(),
            },
        )
        .await;
    }
    let stop = matches!(request, Request::Shutdown { .. });
    let result: io::Result<Response> = match request {
        Request::Reserve {
            identity,
            daemon_id,
            ..
        } => store
            .lock()
            .await
            .reserve(identity, daemon_id)
            .map(|decision| Response::Reservation { decision }),
        Request::Quarantine { identity, .. } => store
            .lock()
            .await
            .quarantine(identity)
            .map(|claim| Response::Claim { claim }),
        Request::Release {
            identity, proof, ..
        } => store
            .lock()
            .await
            .release(identity, proof)
            .map(|claim| Response::Claim { claim }),
        Request::Health { .. } => store
            .lock()
            .await
            .status()
            .map(|status| Response::Health { status }),
        Request::Shutdown { .. } => Ok(Response::Shutdown),
    };
    let response = result.unwrap_or_else(|error| Response::Error {
        code: "BUDGET_REJECTED".into(),
        message: error.to_string(),
    });
    let result = write_response(&mut writer, response).await;
    if stop {
        shutdown.send_replace(true);
    }
    result
}

pub(super) async fn request(socket: &Path, request: Request) -> io::Result<Response> {
    timeout(REQUEST_TIMEOUT, async {
        let mut stream = UnixStream::connect(socket).await?;
        let mut bytes = serde_json::to_vec(&request).map_err(other)?;
        if bytes.len() >= MAX_REQUEST {
            return Err(other("budget request exceeds size limit"));
        }
        bytes.push(b'\n');
        stream.write_all(&bytes).await?;
        stream.flush().await?;
        let mut reader = BufReader::new(stream);
        serde_json::from_slice(&bounded_line(&mut reader).await?).map_err(other)
    })
    .await
    .map_err(other)?
}

async fn write_response(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    response: Response,
) -> io::Result<()> {
    timeout(REQUEST_TIMEOUT, async {
        let mut bytes = serde_json::to_vec(&response).map_err(other)?;
        bytes.push(b'\n');
        writer.write_all(&bytes).await?;
        writer.shutdown().await
    })
    .await
    .map_err(other)?
}

async fn bounded_line(reader: &mut (impl AsyncBufRead + Unpin)) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(bytes);
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if bytes.len() + count > MAX_REQUEST {
            return Err(other("budget request exceeds size limit"));
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if bytes.last() == Some(&b'\n') {
            return Ok(bytes);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::reliability::HostIdentity;

    fn identity(name: &str) -> ExecutionIdentity {
        ExecutionIdentity {
            task_id: format!("task-{name}"),
            dispatch_id: Some(format!("dispatch-{name}")),
            attempt_id: format!("attempt-{name}"),
            execution_epoch: 1,
            host: Some(HostIdentity {
                host_id: format!("host-{name}"),
                host_epoch: "epoch".into(),
            }),
            config_digest: "a".repeat(64),
        }
    }

    fn fixture() -> (tempfile::TempDir, BudgetConfig) {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let config = BudgetConfig {
            directory: directory.path().into(),
            capacity: 1,
        };
        (directory, config)
    }

    #[test]
    fn singleton_writer_and_restart_preserve_quarantined_claims() {
        let (_directory, config) = fixture();
        let mut store = Store::open(&config).unwrap();
        assert!(Store::open(&config).is_err());
        assert!(matches!(
            store.reserve(identity("a"), "daemon-a".into()).unwrap(),
            BudgetDecision::Granted(_)
        ));
        store.quarantine(identity("a")).unwrap();
        drop(store);
        let mut restarted = Store::open(&config).unwrap();
        assert_eq!(restarted.status().unwrap().quarantined, 1);
        assert!(matches!(
            restarted.reserve(identity("b"), "daemon-b".into()).unwrap(),
            BudgetDecision::Waiting {
                used: 1,
                capacity: 1
            }
        ));
        assert!(
            matches!(restarted.reserve(identity("a"),"daemon-a".into()).unwrap(),BudgetDecision::Granted(claim) if claim.state=="quarantined")
        );
    }

    #[test]
    fn release_before_reserve_persists_a_fence_and_proof_identity() {
        let (_directory, config) = fixture();
        let mut store = Store::open(&config).unwrap();
        let identity = identity("unclaimed");
        let proof = VerifiedExitProof {
            proof_id: "proof-unclaimed".into(),
            attempt_id: identity.attempt_id.clone(),
            execution_epoch: 1,
            host: identity.host.clone(),
            config_digest: identity.config_digest.clone(),
            kind: ExitProofKind::StartupNotStarted,
            verifier: ExitProofVerifier::StartupCoordinator,
            evidence_digest: "b".repeat(64),
            verified_at: now(),
        };
        let released = store.release(identity.clone(), proof.clone()).unwrap();
        assert_eq!(released.state, "released");
        assert_eq!(store.status().unwrap().held, 0);
        assert_eq!(store.status().unwrap().released, 1);
        assert_eq!(
            store.release(identity.clone(), proof.clone()).unwrap(),
            released
        );
        let mut conflicting = proof.clone();
        conflicting.proof_id = "other-proof".into();
        assert!(store.release(identity.clone(), conflicting).is_err());
        drop(store);
        let mut reopened = Store::open(&config).unwrap();
        assert!(reopened.reserve(identity.clone(), "daemon".into()).is_err());
        assert_eq!(reopened.release(identity, proof).unwrap(), released);
    }

    #[test]
    fn identity_conflicts_and_proof_mismatch_never_release_capacity() {
        let (_directory, config) = fixture();
        let mut store = Store::open(&config).unwrap();
        let identity = identity("a");
        store.reserve(identity.clone(), "daemon-a".into()).unwrap();
        let mut changed = identity.clone();
        changed.config_digest = "b".repeat(64);
        assert!(store.reserve(changed, "daemon-a".into()).is_err());
        let mut proof = VerifiedExitProof {
            proof_id: "proof-a".into(),
            attempt_id: identity.attempt_id.clone(),
            execution_epoch: 2,
            host: identity.host.clone(),
            config_digest: identity.config_digest.clone(),
            kind: ExitProofKind::DriverQuiescence,
            verifier: ExitProofVerifier::Driver,
            evidence_digest: "b".repeat(64),
            verified_at: now(),
        };
        assert!(store.release(identity.clone(), proof.clone()).is_err());
        assert_eq!(store.status().unwrap().held, 1);
        proof.execution_epoch = 1;
        assert_eq!(
            store
                .release(identity.clone(), proof.clone())
                .unwrap()
                .state,
            "released"
        );
        assert_eq!(
            store.release(identity.clone(), proof).unwrap().state,
            "released"
        );
        assert!(store.reserve(identity, "daemon-a".into()).is_err());
    }
}
