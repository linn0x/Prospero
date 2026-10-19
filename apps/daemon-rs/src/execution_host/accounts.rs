use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::accounts::config::ConfigTarget;
use crate::accounts::managed::{self, CredentialKind};
use crate::accounts::profile::{self, ApiProfile};
use crate::database::validate_id;
use crate::error::{Error, Result};
use crate::protocol::AgentKind;
use crate::worker::Database;

const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;
const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;
const SNAPSHOT_FILE: &str = "account-snapshot.json";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AccountSnapshotRef {
    pub account_id: String,
    pub snapshot_id: String,
    pub digest: String,
    pub engine: AgentKind,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenCredential {
    kind: CredentialKind,
    secret: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenAccount {
    format_version: u32,
    operation_id: String,
    snapshot_id: String,
    account_id: String,
    requested_agent: AgentKind,
    account_agent: AgentKind,
    engine: AgentKind,
    profile: Option<ApiProfile>,
    credential: FrozenCredential,
    default_model: Option<String>,
    default_effort: Option<String>,
}

fn invalid_snapshot() -> Error {
    Error::Feature(
        "account_snapshot_invalid".into(),
        "execution account snapshot is missing, unsafe, or inconsistent".into(),
    )
}

fn supported() -> Result<()> {
    if cfg!(unix) {
        Ok(())
    } else {
        Err(Error::Feature(
            "account_snapshot_unsupported".into(),
            "private execution account snapshots are unsupported on this platform".into(),
        ))
    }
}

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn snapshot_id(operation_id: &str) -> String {
    let mut input = b"prospero-execution-account-v1\0".to_vec();
    input.extend_from_slice(operation_id.as_bytes());
    format!("account-{}", hash(&input))
}

fn validate_account_id(id: &str) -> Result<()> {
    validate_id(id)?;
    if id.len() > 100
        || matches!(
            id,
            crate::accounts::NATIVE_CLAUDE_ID | crate::agent::NATIVE_CODEX_ID
        )
    {
        return Err(invalid_snapshot());
    }
    Ok(())
}

fn validate_reference(reference: &AccountSnapshotRef) -> Result<()> {
    validate_account_id(&reference.account_id)?;
    validate_id(&reference.snapshot_id)?;
    if reference.digest.len() != 64
        || !reference
            .digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || !matches!(
            reference.engine,
            AgentKind::Claude | AgentKind::Codex | AgentKind::Opencode
        )
    {
        return Err(invalid_snapshot());
    }
    Ok(())
}

fn private_directory(path: &Path, create: bool) -> Result<()> {
    supported()?;
    if create {
        match fs::create_dir(path) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid_snapshot());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(invalid_snapshot());
        }
    }
    Ok(())
}

fn private_tree(base: &Path, directory: &Path, create: bool) -> Result<bool> {
    private_directory(base, false)?;
    let relative = directory
        .strip_prefix(base)
        .map_err(|_| invalid_snapshot())?;
    let mut current = base.to_path_buf();
    for part in relative.components() {
        let Component::Normal(name) = part else {
            return Err(invalid_snapshot());
        };
        current.push(name);
        match private_directory(&current, create) {
            Ok(()) => {}
            Err(Error::Io(error)) if !create && error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(false);
            }
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

fn source_tree(base: &Path, directory: &Path) -> Result<bool> {
    private_directory(base, false)?;
    let relative = directory
        .strip_prefix(base)
        .map_err(|_| invalid_snapshot())?;
    let mut current = base.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(invalid_snapshot());
        };
        current.push(name);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(invalid_snapshot());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() } {
                return Err(invalid_snapshot());
            }
        }
    }
    Ok(true)
}

fn read_private(path: &Path, maximum: usize) -> Result<Vec<u8>> {
    supported()?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path)?;
    let before = file.metadata()?;
    if !before.is_file() || before.len() > maximum as u64 {
        return Err(invalid_snapshot());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.uid() != unsafe { libc::geteuid() }
            || before.mode() & 0o077 != 0
            || before.nlink() != 1
        {
            return Err(invalid_snapshot());
        }
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if bytes.len() > maximum
        || before.len() != after.len()
        || before.modified()? != after.modified()?
    {
        return Err(invalid_snapshot());
    }
    Ok(bytes)
}

fn write_immutable(path: &Path, bytes: &[u8]) -> Result<()> {
    supported()?;
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(invalid_snapshot());
    }
    let parent = path.parent().ok_or_else(invalid_snapshot)?;
    private_directory(parent, false)?;
    match read_private(path, MAX_SNAPSHOT_BYTES) {
        Ok(existing) => {
            return if existing == bytes {
                Ok(())
            } else {
                Err(Error::Conflict)
            };
        }
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let temporary = parent.join(format!(".account-{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        let linked = fs::hard_link(&temporary, path);
        fs::remove_file(&temporary)?;
        match linked {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if read_private(path, MAX_SNAPSHOT_BYTES)? != bytes {
                    return Err(Error::Conflict);
                }
            }
            Err(error) => return Err(error.into()),
        }
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_frozen(snapshot: &FrozenAccount) -> Result<()> {
    if snapshot.format_version != 1 || snapshot.snapshot_id != snapshot_id(&snapshot.operation_id) {
        return Err(invalid_snapshot());
    }
    validate_id(&snapshot.operation_id)?;
    validate_account_id(&snapshot.account_id)?;
    if snapshot.credential.secret.trim().is_empty()
        || snapshot.credential.secret.len() > 8192
        || snapshot.credential.secret.contains(['\r', '\n', '\0'])
        || !matches!(
            snapshot.account_agent,
            AgentKind::Claude | AgentKind::Codex | AgentKind::Opencode
        )
    {
        return Err(invalid_snapshot());
    }
    if snapshot
        .default_model
        .as_ref()
        .is_some_and(|model| model.len() > 300 || model.contains(['\r', '\n', '\0']))
        || snapshot.default_effort.as_ref().is_some_and(|effort| {
            !matches!(
                effort.as_str(),
                "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
            )
        })
    {
        return Err(invalid_snapshot());
    }
    match snapshot.profile.as_ref() {
        Some(profile) => {
            let engine = profile::agent_kind(profile);
            if snapshot.engine != engine
                || (snapshot.account_agent != snapshot.requested_agent
                    && engine != snapshot.requested_agent)
                || snapshot.credential.kind != CredentialKind::ApiKey
            {
                return Err(invalid_snapshot());
            }
            managed::validate_profile_agent(snapshot.requested_agent, profile)
                .map_err(|_| invalid_snapshot())?;
            let label = match engine {
                AgentKind::Claude => "claude",
                AgentKind::Codex => "codex",
                AgentKind::Opencode => "opencode",
                _ => return Err(invalid_snapshot()),
            };
            profile::clean_profile(
                label,
                &profile.base_url,
                &profile.model,
                Some(&profile.provider),
                Some(profile.protocol()),
                profile
                    .model_capabilities
                    .as_ref()
                    .map(serde_json::to_value)
                    .transpose()?,
                profile
                    .headers
                    .as_ref()
                    .map(serde_json::to_value)
                    .transpose()?,
            )
            .map_err(|_| invalid_snapshot())?;
            if profile
                .model_capabilities
                .as_ref()
                .and_then(|capabilities| capabilities.tools)
                == Some(false)
            {
                return Err(Error::Feature(
                    "account_tools_disabled".into(),
                    "model profile does not permit tools for an execution worker".into(),
                ));
            }
        }
        None => {
            if snapshot.requested_agent != AgentKind::Claude
                || snapshot.account_agent != AgentKind::Claude
                || snapshot.engine != AgentKind::Claude
            {
                return Err(invalid_snapshot());
            }
        }
    }
    Ok(())
}

fn parse_snapshot(bytes: &[u8]) -> Result<FrozenAccount> {
    let snapshot: FrozenAccount = serde_json::from_slice(bytes).map_err(|_| invalid_snapshot())?;
    validate_frozen(&snapshot)?;
    Ok(snapshot)
}

fn reference(snapshot: &FrozenAccount, bytes: &[u8]) -> AccountSnapshotRef {
    AccountSnapshotRef {
        account_id: snapshot.account_id.clone(),
        snapshot_id: snapshot.snapshot_id.clone(),
        digest: hash(bytes),
        engine: snapshot.engine,
    }
}

fn existing_snapshot(
    path: &Path,
    operation_id: &str,
    agent: AgentKind,
    account_id: &str,
) -> Result<AccountSnapshotRef> {
    let bytes = read_private(path, MAX_SNAPSHOT_BYTES)?;
    let snapshot = parse_snapshot(&bytes)?;
    if snapshot.operation_id != operation_id
        || snapshot.requested_agent != agent
        || snapshot.account_id != account_id
    {
        return Err(Error::Conflict);
    }
    Ok(reference(&snapshot, &bytes))
}

pub(crate) async fn capture(
    database: &Database,
    operation_id: &str,
    agent: AgentKind,
    account_id: &str,
) -> Result<AccountSnapshotRef> {
    supported()?;
    validate_id(operation_id)?;
    validate_account_id(account_id)?;
    if !matches!(
        agent,
        AgentKind::Claude | AgentKind::Codex | AgentKind::Opencode
    ) {
        return Err(invalid_snapshot());
    }
    let data = database.directory().to_owned();
    let snapshots = data.join("execution-accounts");
    private_tree(&data, &snapshots, true)?;
    let path = snapshots.join(format!("{}.json", snapshot_id(operation_id)));
    match existing_snapshot(&path, operation_id, agent, account_id) {
        Ok(reference) => return Ok(reference),
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let operation_id = operation_id.to_owned();
    let account_id = account_id.to_owned();
    let source = database.clone();
    let snapshot = database
        .call_control("execution.account.capture", move |store| {
            if crate::accounts::source_bound_launch_error(&source, &account_id)?.is_some() {
                return Err(Error::Feature(
                    "account_source_disabled".into(),
                    "model source or route is disabled for new executions".into(),
                ));
            }
            let record = store.managed_account(&account_id)?;
            let root = managed::execution_account_root(
                &data,
                &record.id,
                record.agent,
                record.api_profile.is_some(),
            )?;
            source_tree(&data, &root)?;
            let credential_path = managed::execution_credential_path(&root);
            let credential: FrozenCredential = serde_json::from_slice(
                &read_private(&credential_path, MAX_CREDENTIAL_BYTES).map_err(|_| {
                    Error::Feature(
                        "account_credential_missing".into(),
                        "managed execution account requires a private credential".into(),
                    )
                })?,
            )
            .map_err(|_| invalid_snapshot())?;
            let defaults = managed::account_root(&data, &record.id)?;
            source_tree(&data, &defaults)?;
            let target = ConfigTarget {
                account_id: record.id.clone(),
                model: record
                    .api_profile
                    .as_ref()
                    .map(|profile| profile.model.clone()),
                model_capabilities: record
                    .api_profile
                    .as_ref()
                    .and_then(|profile| profile.model_capabilities.clone()),
                active_sessions: 0,
            };
            let (default_model, default_effort) =
                crate::accounts::config::read_defaults(&data, &target)?;
            let engine = record
                .api_profile
                .as_ref()
                .map(profile::agent_kind)
                .unwrap_or(record.agent);
            let snapshot = FrozenAccount {
                format_version: 1,
                snapshot_id: snapshot_id(&operation_id),
                operation_id,
                account_id,
                requested_agent: agent,
                account_agent: record.agent,
                engine,
                profile: record.api_profile,
                credential,
                default_model,
                default_effort,
            };
            validate_frozen(&snapshot)?;
            Ok(snapshot)
        })
        .await?;
    let bytes = serde_json::to_vec(&snapshot)?;
    match write_immutable(&path, &bytes) {
        Ok(()) => Ok(reference(&snapshot, &bytes)),
        Err(Error::Conflict) => existing_snapshot(
            &path,
            &snapshot.operation_id,
            snapshot.requested_agent,
            &snapshot.account_id,
        ),
        Err(error) => Err(error),
    }
}

pub(crate) fn stage(
    data_dir: &Path,
    host_dir: &Path,
    reference: &AccountSnapshotRef,
) -> Result<()> {
    supported()?;
    validate_reference(reference)?;
    let source = data_dir.join("execution-accounts");
    private_tree(data_dir, &source, false)?;
    private_directory(host_dir, false)?;
    let bytes = read_private(
        &source.join(format!("{}.json", reference.snapshot_id)),
        MAX_SNAPSHOT_BYTES,
    )?;
    let snapshot = parse_snapshot(&bytes)?;
    if self::reference(&snapshot, &bytes) != *reference {
        return Err(invalid_snapshot());
    }
    write_immutable(&host_dir.join(SNAPSHOT_FILE), &bytes)
}

pub(crate) async fn install(
    database: &Database,
    host_dir: &Path,
    reference: &AccountSnapshotRef,
    agent: AgentKind,
) -> Result<()> {
    supported()?;
    validate_reference(reference)?;
    private_directory(host_dir, false)?;
    let data = database.directory().to_owned();
    private_tree(host_dir, &host_dir.join("driver-state"), false)?;
    if fs::canonicalize(&data)? != fs::canonicalize(host_dir.join("driver-state"))? {
        return Err(invalid_snapshot());
    }
    let bytes = read_private(&host_dir.join(SNAPSHOT_FILE), MAX_SNAPSHOT_BYTES)?;
    let snapshot = parse_snapshot(&bytes)?;
    if self::reference(&snapshot, &bytes) != *reference || agent != reference.engine {
        return Err(invalid_snapshot());
    }
    database
        .call_control("execution.account.install", move |store| {
            let root = managed::execution_account_root(
                &data,
                &snapshot.account_id,
                snapshot.account_agent,
                snapshot.profile.is_some(),
            )?;
            private_tree(&data, &root, true)?;
            let credential = serde_json::to_vec(&snapshot.credential)?;
            write_immutable(&managed::execution_credential_path(&root), &credential)?;
            let defaults = managed::account_root(&data, &snapshot.account_id)?;
            private_tree(&data, &defaults, true)?;
            let mut content = String::new();
            if let Some(model) = &snapshot.default_model {
                content.push_str(&format!("default_model: \"{model}\"\n"));
            }
            if let Some(effort) = &snapshot.default_effort {
                content.push_str(&format!("default_effort: \"{effort}\"\n"));
            }
            write_immutable(
                &defaults.join("prospero-overrides.yaml"),
                content.as_bytes(),
            )?;
            store.install_execution_account_row(
                &snapshot.account_id,
                snapshot.account_agent,
                snapshot.profile.as_ref(),
            )
        })
        .await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::database::now;
    use crate::orchestration::reliability::{
        self, ControlEffectState, ExecutionIdentity, ExecutionState, ExitProofKind,
        ExitProofVerifier, HostCommand, HostCommandKind, HostIdentity, NewExecution, NewOperation,
        OperationKind, OperationState, OperationView, VerifiedExitProof,
    };
    use crate::orchestration::{CreateRun, CreateTask};
    use crate::protocol::{CreateSession, SessionKind};
    use rusqlite::params;
    use serde_json::json;
    use std::os::unix::fs::{PermissionsExt, symlink};

    const SECRET: &str = "synthetic-execution-account-secret-123456";

    struct Fixture {
        directory: tempfile::TempDir,
        database: Database,
    }

    async fn fixture() -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("daemon"))
            .await
            .unwrap();
        Fixture {
            directory,
            database,
        }
    }

    async fn profile_account(database: &Database, id: &str, agent: AgentKind, protocol: &str) {
        let data = database.directory().to_owned();
        let id = id.to_owned();
        let protocol = protocol.to_owned();
        database
            .call_control("test.execution.account", move |store| {
                let label = match agent {
                    AgentKind::Claude => "claude",
                    AgentKind::Codex => "codex",
                    AgentKind::Opencode => "opencode",
                    _ => unreachable!(),
                };
                let profile = profile::clean_profile(
                    label,
                    "https://synthetic.invalid/v1",
                    "fixture-model",
                    None,
                    Some(&protocol),
                    Some(json!({"tools":true,"reasoning":true,"supportedEfforts":["low","high"]})),
                    None,
                )?;
                store.insert_api_profile_account_with_id(
                    &data,
                    &id,
                    "Synthetic account",
                    agent,
                    &profile,
                    SECRET,
                )?;
                let defaults = managed::account_root(&data, &id)?;
                fs::create_dir_all(&defaults)?;
                fs::set_permissions(&defaults, fs::Permissions::from_mode(0o700))?;
                fs::write(
                    defaults.join("prospero-overrides.yaml"),
                    "default_model: fallback-model\ndefault_effort: high\n",
                )?;
                fs::set_permissions(
                    defaults.join("prospero-overrides.yaml"),
                    fs::Permissions::from_mode(0o600),
                )?;
                Ok(())
            })
            .await
            .unwrap();
    }

    async fn host(fixture: &Fixture, name: &str) -> (std::path::PathBuf, Database) {
        let directory = fixture.directory.path().join(name);
        private_directory(&directory, true).unwrap();
        let database = Database::open(directory.join("driver-state"))
            .await
            .unwrap();
        (directory, database)
    }

    #[tokio::test]
    async fn profile_snapshots_install_all_engines_without_public_credentials() {
        let fixture = fixture().await;
        for (index, account_agent, requested, protocol, engine) in [
            (
                0,
                AgentKind::Claude,
                AgentKind::Claude,
                "anthropic",
                AgentKind::Claude,
            ),
            (
                1,
                AgentKind::Codex,
                AgentKind::Codex,
                "openai_responses",
                AgentKind::Codex,
            ),
            (
                2,
                AgentKind::Codex,
                AgentKind::Codex,
                "openai_chat_completions",
                AgentKind::Opencode,
            ),
            (
                3,
                AgentKind::Opencode,
                AgentKind::Opencode,
                "openai_chat_completions",
                AgentKind::Opencode,
            ),
        ] {
            let id = format!("profile-{index}");
            profile_account(&fixture.database, &id, account_agent, protocol).await;
            let reference = capture(
                &fixture.database,
                &format!("operation-{index}"),
                requested,
                &id,
            )
            .await
            .unwrap();
            assert_eq!(reference.engine, engine);
            let public = serde_json::to_string(&reference).unwrap();
            assert!(!public.contains(SECRET));
            assert!(!public.contains("synthetic.invalid"));
            let (directory, driver) = host(&fixture, &format!("host-{index}")).await;
            stage(fixture.database.directory(), &directory, &reference).unwrap();
            stage(fixture.database.directory(), &directory, &reference).unwrap();
            install(&driver, &directory, &reference, engine)
                .await
                .unwrap();
            install(&driver, &directory, &reference, engine)
                .await
                .unwrap();
            let data = driver.directory().to_owned();
            driver
                .call_control("test.execution.installed", move |store| {
                    let record = store.managed_account(&id)?;
                    assert_eq!(record.agent, account_agent);
                    let profile = record.api_profile.as_ref().unwrap();
                    assert_eq!(profile.model, "fixture-model");
                    let target = ConfigTarget {
                        account_id: id.clone(),
                        model: Some(profile.model.clone()),
                        model_capabilities: profile.model_capabilities.clone(),
                        active_sessions: 0,
                    };
                    let (model, effort) = crate::accounts::config::read_defaults(&data, &target)?;
                    assert_eq!(model.as_deref(), Some("fallback-model"));
                    assert_eq!(effort.as_deref(), Some("high"));
                    let environment =
                        managed::profile_account_environment(&data, &id, record.agent, profile)?;
                    assert!(environment.iter().any(|(key, value)| matches!(
                        key.as_str(),
                        "ANTHROPIC_API_KEY" | "OPENAI_API_KEY"
                    ) && value == SECRET));
                    Ok(())
                })
                .await
                .unwrap();
            assert_eq!(
                fs::metadata(directory.join(SNAPSHOT_FILE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            driver.shutdown().await.unwrap();
        }
        fixture.database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn managed_claude_api_key_and_oauth_remain_isolated_and_frozen() {
        let fixture = fixture().await;
        for (index, kind) in [CredentialKind::ApiKey, CredentialKind::OauthToken]
            .into_iter()
            .enumerate()
        {
            let data = fixture.database.directory().to_owned();
            let expected = kind.clone();
            let id = fixture
                .database
                .call_control("test.managed.source", move |store| {
                    let record = store.create_managed_account(&data, "Synthetic managed Claude")?;
                    store.set_managed_credential(&data, &record.id, kind, SECRET)?;
                    Ok(record.id)
                })
                .await
                .unwrap();
            let reference = capture(
                &fixture.database,
                &format!("managed-{index}"),
                AgentKind::Claude,
                &id,
            )
            .await
            .unwrap();
            let (directory, driver) = host(&fixture, &format!("managed-host-{index}")).await;
            stage(fixture.database.directory(), &directory, &reference).unwrap();
            install(&driver, &directory, &reference, AgentKind::Claude)
                .await
                .unwrap();
            let data = driver.directory().to_owned();
            driver
                .call_control("test.managed.installed", move |store| {
                    let record = store.managed_account(&id)?;
                    assert!(record.api_profile.is_none());
                    let credential =
                        managed::read_credential(&managed::account_root(&data, &id)?)?.unwrap();
                    assert!(credential.kind == expected && credential.secret == SECRET);
                    let environment = managed::claude_environment(&data, &id, false)?;
                    let key = if expected == CredentialKind::ApiKey {
                        "ANTHROPIC_API_KEY"
                    } else {
                        "CLAUDE_CODE_OAUTH_TOKEN"
                    };
                    assert!(
                        environment
                            .iter()
                            .any(|(name, value)| name == key && value == SECRET)
                    );
                    Ok(())
                })
                .await
                .unwrap();
            driver.shutdown().await.unwrap();
        }
        fixture.database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn original_operation_keeps_account_credentials_and_defaults_after_source_changes() {
        let fixture = fixture().await;
        profile_account(
            &fixture.database,
            "frozen-account",
            AgentKind::Codex,
            "openai_responses",
        )
        .await;
        let original = capture(
            &fixture.database,
            "frozen-operation",
            AgentKind::Codex,
            "frozen-account",
        )
        .await
        .unwrap();
        let data = fixture.database.directory().to_owned();
        fixture
            .database
            .call_control("test.source.changed", move |store| {
                let root = managed::execution_account_root(
                    &data,
                    "frozen-account",
                    AgentKind::Codex,
                    true,
                )?;
                managed::write_credential(
                    &root,
                    &managed::Credential {
                        kind: CredentialKind::ApiKey,
                        secret: "different-synthetic-key-123456789".into(),
                    },
                )?;
                fs::write(
                    managed::account_root(&data, "frozen-account")?.join("prospero-overrides.yaml"),
                    "default_effort: low\n",
                )?;
                store.delete_managed_account(&data, "frozen-account")
            })
            .await
            .unwrap();
        let replay = capture(
            &fixture.database,
            "frozen-operation",
            AgentKind::Codex,
            "frozen-account",
        )
        .await
        .unwrap();
        assert!(original == replay);
        assert!(
            capture(
                &fixture.database,
                "frozen-operation",
                AgentKind::Claude,
                "frozen-account"
            )
            .await
            .is_err()
        );
        assert!(
            capture(
                &fixture.database,
                "new-operation",
                AgentKind::Codex,
                "frozen-account"
            )
            .await
            .is_err()
        );
        let (directory, driver) = host(&fixture, "frozen-host").await;
        stage(fixture.database.directory(), &directory, &replay).unwrap();
        install(&driver, &directory, &replay, AgentKind::Codex)
            .await
            .unwrap();
        let data = driver.directory().to_owned();
        driver
            .call_control("test.frozen.material", move |store| {
                let record = store.managed_account("frozen-account")?;
                let credential = managed::read_credential(&managed::execution_account_root(
                    &data,
                    "frozen-account",
                    record.agent,
                    true,
                )?)?
                .unwrap();
                assert!(credential.secret == SECRET);
                let target = ConfigTarget {
                    account_id: record.id,
                    model: record
                        .api_profile
                        .as_ref()
                        .map(|profile| profile.model.clone()),
                    model_capabilities: record
                        .api_profile
                        .and_then(|profile| profile.model_capabilities),
                    active_sessions: 0,
                };
                assert_eq!(
                    crate::accounts::config::read_defaults(&data, &target)?
                        .1
                        .as_deref(),
                    Some("high")
                );
                Ok(())
            })
            .await
            .unwrap();
        driver.shutdown().await.unwrap();
        fixture.database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn tampered_references_material_identity_and_paths_are_rejected() {
        let fixture = fixture().await;
        profile_account(
            &fixture.database,
            "bound-account",
            AgentKind::Codex,
            "openai_responses",
        )
        .await;
        let reference = capture(
            &fixture.database,
            "bound-operation",
            AgentKind::Codex,
            "bound-account",
        )
        .await
        .unwrap();
        let (directory, driver) = host(&fixture, "bound-host").await;
        let mut wrong = reference.clone();
        wrong.digest = "c".repeat(64);
        assert!(stage(fixture.database.directory(), &directory, &wrong).is_err());
        let mut wrong = reference.clone();
        wrong.account_id = "other-account".into();
        assert!(stage(fixture.database.directory(), &directory, &wrong).is_err());
        wrong = reference.clone();
        wrong.snapshot_id = "../escape".into();
        assert!(stage(fixture.database.directory(), &directory, &wrong).is_err());
        wrong = reference.clone();
        wrong.engine = AgentKind::Claude;
        assert!(stage(fixture.database.directory(), &directory, &wrong).is_err());
        stage(fixture.database.directory(), &directory, &reference).unwrap();
        assert!(
            install(&driver, &directory, &reference, AgentKind::Claude)
                .await
                .is_err()
        );
        let original = read_private(&directory.join(SNAPSHOT_FILE), MAX_SNAPSHOT_BYTES).unwrap();
        fs::write(directory.join(SNAPSHOT_FILE), b"tampered material").unwrap();
        assert!(stage(fixture.database.directory(), &directory, &reference).is_err());
        assert!(
            install(&driver, &directory, &reference, AgentKind::Codex)
                .await
                .is_err()
        );
        fs::write(directory.join(SNAPSHOT_FILE), original).unwrap();
        install(&driver, &directory, &reference, AgentKind::Codex)
            .await
            .unwrap();
        driver.shutdown().await.unwrap();
        fixture.database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn missing_credentials_and_disabled_tools_never_fall_back_to_native() {
        let fixture = fixture().await;
        profile_account(
            &fixture.database,
            "missing-account",
            AgentKind::Claude,
            "anthropic",
        )
        .await;
        let data = fixture.database.directory().to_owned();
        fixture
            .database
            .call_control("test.missing.credential", move |store| {
                let root = managed::execution_account_root(
                    &data,
                    "missing-account",
                    AgentKind::Claude,
                    true,
                )?;
                fs::remove_file(managed::execution_credential_path(&root))?;
                let record =
                    store.create_managed_account(&data, "Managed without authentication")?;
                Ok(record.id)
            })
            .await
            .unwrap();
        assert!(
            capture(
                &fixture.database,
                "missing-operation",
                AgentKind::Claude,
                "missing-account"
            )
            .await
            .is_err()
        );
        profile_account(
            &fixture.database,
            "disabled-tools",
            AgentKind::Codex,
            "openai_responses",
        )
        .await;
        fixture.database.call_control("test.tools.disabled",|store|{
            store.connection.execute("UPDATE managed_accounts SET api_profile=json_set(api_profile,'$.modelCapabilities.tools',json('false')) WHERE id='disabled-tools'",[])?;
            Ok(())
        }).await.unwrap();
        assert!(
            matches!(capture(&fixture.database,"tools-operation",AgentKind::Codex,"disabled-tools").await,Err(Error::Feature(code,_)) if code=="account_tools_disabled")
        );
        assert!(
            capture(
                &fixture.database,
                "native-operation",
                AgentKind::Claude,
                crate::accounts::NATIVE_CLAUDE_ID
            )
            .await
            .is_err()
        );
        assert!(
            capture(
                &fixture.database,
                "wrong-engine",
                AgentKind::Claude,
                "disabled-tools"
            )
            .await
            .is_err()
        );
        fixture.database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn source_snapshot_and_staged_links_and_oversized_files_are_rejected() {
        let fixture = fixture().await;
        profile_account(
            &fixture.database,
            "linked-account",
            AgentKind::Codex,
            "openai_responses",
        )
        .await;
        let reference = capture(
            &fixture.database,
            "linked-operation",
            AgentKind::Codex,
            "linked-account",
        )
        .await
        .unwrap();
        let source = fixture
            .database
            .directory()
            .join("execution-accounts")
            .join(format!("{}.json", reference.snapshot_id));
        let bytes = read_private(&source, MAX_SNAPSHOT_BYTES).unwrap();
        let outside = fixture.directory.path().join("outside.json");
        fs::write(&outside, &bytes).unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o600)).unwrap();
        fs::remove_file(&source).unwrap();
        symlink(&outside, &source).unwrap();
        let (directory, driver) = host(&fixture, "linked-host").await;
        assert!(stage(fixture.database.directory(), &directory, &reference).is_err());
        assert!(
            capture(
                &fixture.database,
                "linked-operation",
                AgentKind::Codex,
                "linked-account"
            )
            .await
            .is_err()
        );
        fs::remove_file(&source).unwrap();
        write_immutable(&source, &bytes).unwrap();
        symlink(&outside, directory.join(SNAPSHOT_FILE)).unwrap();
        assert!(stage(fixture.database.directory(), &directory, &reference).is_err());
        fs::remove_file(directory.join(SNAPSHOT_FILE)).unwrap();
        fs::write(&source, vec![b'x'; MAX_SNAPSHOT_BYTES + 1]).unwrap();
        assert!(stage(fixture.database.directory(), &directory, &reference).is_err());
        driver.shutdown().await.unwrap();
        fixture.database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn hosted_unfinalized_account_ownership_blocks_removal_and_rotation_until_proof() {
        let fixture = fixture().await;
        profile_account(
            &fixture.database,
            "owned-account",
            AgentKind::Codex,
            "openai_responses",
        )
        .await;
        let data = fixture.database.directory().to_owned();
        fixture.database.call_control("test.hosted.ownership",move|store|{
            let run=store.create_run(CreateRun{objective:"account occupancy".into(),coordinator_session_id:None})?;
            let task=store.create_task(CreateTask{run_id:run.id,title:"worker".into(),spec:"fixture".into(),skills:vec![],deps:vec![],parent_id:None})?;
            let session=store.create_session(CreateSession{agent:AgentKind::Codex,kind:SessionKind::Structured,title:"hosted placeholder".into(),workspace:"/tmp".into()})?;
            let dispatch=store.dispatch_task(&task.id,&session.id,None,None)?.dispatch;
            let identity=ExecutionIdentity{task_id:task.id,dispatch_id:Some(dispatch.id),attempt_id:session.id,execution_epoch:1,host:Some(HostIdentity{host_id:"account-host".into(),host_epoch:"account-epoch".into()}),config_digest:"a".repeat(64)};
            store.reliability_transaction(|tx|{
                tx.execute("INSERT INTO orch_host_registry(host_id,host_epoch,protocol_version,runtime_digest,capabilities,registered_at,state) VALUES('account-host','account-epoch',1,?1,'[]',?2,'active')",params!["b".repeat(64),now()])?;
                reliability::insert_execution(tx,&NewExecution{identity:identity.clone(),state:ExecutionState::Running,created_at:now()})?;
                let payload=json!({"session":{"accountId":"owned-account","agent":"codex"}});
                let request=json!({"identity":identity,"payload":payload});
                reliability::accept_operation(tx,&NewOperation{operation:OperationView{operation_id:"account-start".into(),kind:OperationKind::Start,state:OperationState::Accepted,task_id:Some(identity.task_id.clone()),attempt_id:Some(identity.attempt_id.clone()),execution_epoch:Some(1),effect_state:ControlEffectState::None,wait_reason:None,retry_after_ms:None,next_reconcile_at:None,revision:1},request_version:1,fingerprint:reliability::request_fingerprint(OperationKind::Start,1,&request),request:request.to_string(),created_at:now()})?;
                let mut command=HostCommand{command_id:"account-command".into(),operation_id:"account-start".into(),identity:identity.clone(),kind:HostCommandKind::Start,fingerprint:String::new(),payload:payload.to_string()};
                command.fingerprint=reliability::host_command_fingerprint(&command)?;
                reliability::enqueue_command(tx,&command,now())
            })?;
            assert_eq!(store.active_session_count("owned-account")?,1);
            assert!(matches!(store.delete_managed_account(&data,"owned-account"),Err(Error::InUse)));
            assert!(matches!(store.set_managed_credential(&data,"owned-account",CredentialKind::ApiKey,"rotated-synthetic-key-123456789"),Err(Error::InUse)));
            store.reliability_transaction(|tx|{
                reliability::schedule_recovery(tx,&reliability::NewRecoveryJob{job_id:"account-recovery".into(),kind:"execution".into(),object_id:identity.attempt_id.clone(),owner:"fixture".into(),next_check_at:now(),detail:None,created_at:now()})?;
                reliability::transition_execution(tx,&identity,ExecutionState::StartUnknown,None,now())
            })?;
            assert_eq!(store.active_session_count("owned-account")?,1);
            let proof=VerifiedExitProof{proof_id:"account-proof".into(),attempt_id:identity.attempt_id.clone(),execution_epoch:1,host:identity.host.clone(),config_digest:identity.config_digest.clone(),kind:ExitProofKind::DriverQuiescence,verifier:ExitProofVerifier::Driver,evidence_digest:"c".repeat(64),verified_at:now()};
            store.reliability_transaction(|tx|reliability::transition_execution(tx,&identity,ExecutionState::Finalized,Some(&proof),now()))?;
            assert_eq!(store.active_session_count("owned-account")?,0);
            store.delete_managed_account(&data,"owned-account")
        }).await.unwrap();
        fixture.database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn legacy_unknown_account_ownership_survives_archiving() {
        let fixture = fixture().await;
        profile_account(
            &fixture.database,
            "legacy-account",
            AgentKind::Codex,
            "openai_responses",
        )
        .await;
        let data = fixture.database.directory().to_owned();
        fixture
            .database
            .call_control("test.legacy.account", move |store| {
                let session = store.create_agent_session(
                    crate::agent::CreateAgentSession {
                        agent: AgentKind::Codex,
                        title: "legacy fixture".into(),
                        workspace: "/tmp".into(),
                        auto_approve: false,
                        mode: None,
                        model: None,
                        effort: None,
                        agent_preset: None,
                        account_id: Some("legacy-account".into()),
                        resume: None,
                    },
                    crate::agent::ApprovalPolicy::Manual,
                )?;
                store.archive_agent_session_for_stop(&session.id, true)?;
                assert_eq!(store.active_session_count("legacy-account")?, 1);
                assert!(matches!(
                    store.delete_managed_account(&data, "legacy-account"),
                    Err(Error::InUse)
                ));
                store.clear_agent_execution_unknown(&session.id)?;
                assert_eq!(store.active_session_count("legacy-account")?, 0);
                store.delete_managed_account(&data, "legacy-account")
            })
            .await
            .unwrap();
        fixture.database.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn disabled_model_source_rejects_new_capture_but_preserves_original_pin() {
        use crate::accounts::sources::{BindOutcome, ModelSources, SourceAction};
        let fixture = fixture().await;
        let data = fixture.database.directory().to_owned();
        let (account_id, source_id) = fixture
            .database
            .call_control("test.bound.source", move |store| {
                let mut sources = ModelSources::open(&data)?;
                let source = sources.create(serde_json::from_value::<SourceAction>(json!({"kind":"create","name":"Synthetic source","endpoints":[{"protocol":"openai_responses","baseUrl":"https://synthetic.invalid/v1"}],"credential":{"name":"Synthetic credential","apiKey":SECRET},"routes":[{"name":"Fixture route","model":"fixture-model","protocol":"openai_responses","enabled":true}]}))?)?;
                let created = sources.bind(
                    &source.id,
                    &source.routes[0].id,
                    source.revision,
                    Some(AgentKind::Codex),
                    &std::collections::HashSet::new(),
                    &std::collections::HashMap::new(),
                )?;
                let BindOutcome::Created {
                    account_id,
                    agent,
                    profile,
                    name,
                    secret,
                } = created
                else {
                    return Err(Error::Conflict);
                };
                store.insert_api_profile_account_with_id(
                    &data,
                    &account_id,
                    &name,
                    agent,
                    &profile,
                    &secret,
                )?;
                Ok((account_id, source.id))
            })
            .await
            .unwrap();
        let original = capture(
            &fixture.database,
            "source-bound-operation",
            AgentKind::Codex,
            &account_id,
        )
        .await
        .unwrap();
        let data = fixture.database.directory().to_owned();
        fixture
            .database
            .call_control("test.source.disable", move |_store| {
                let mut sources = ModelSources::open(&data)?;
                let source = sources
                    .list()
                    .into_iter()
                    .find(|source| source.id == source_id)
                    .ok_or(Error::NotFound)?;
                sources.change(
                    SourceAction::Update {
                        source_id: source.id,
                        revision: source.revision,
                        name: None,
                        enabled: Some(false),
                        endpoints: None,
                        default_route_id: None,
                    },
                    &std::collections::HashSet::new(),
                )?;
                Ok(())
            })
            .await
            .unwrap();
        assert!(
            capture(
                &fixture.database,
                "source-bound-operation",
                AgentKind::Codex,
                &account_id
            )
            .await
            .unwrap()
                == original
        );
        assert!(
            matches!(capture(&fixture.database,"new-source-operation",AgentKind::Codex,&account_id).await,Err(Error::Feature(code,_)) if code=="account_source_disabled")
        );
        fixture.database.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn managed_default_model_keeps_effective_backslashes_without_double_escaping() {
        const MODEL: &str = r"fixture\model";
        let fixture = fixture().await;
        let data = fixture.database.directory().to_owned();
        let id = fixture
            .database
            .call_control("test.managed.defaults", move |store| {
                let record = store.create_managed_account(&data, "Synthetic defaults")?;
                store.set_managed_credential(&data, &record.id, CredentialKind::ApiKey, SECRET)?;
                let file =
                    managed::account_root(&data, &record.id)?.join("prospero-overrides.yaml");
                fs::write(
                    &file,
                    format!("default_model: \"{MODEL}\"\ndefault_effort: \"high\"\n"),
                )?;
                fs::set_permissions(file, fs::Permissions::from_mode(0o600))?;
                Ok(record.id)
            })
            .await
            .unwrap();
        let reference = capture(
            &fixture.database,
            "managed-default-operation",
            AgentKind::Claude,
            &id,
        )
        .await
        .unwrap();
        let (directory, driver) = host(&fixture, "managed-default-host").await;
        stage(fixture.database.directory(), &directory, &reference).unwrap();
        install(&driver, &directory, &reference, AgentKind::Claude)
            .await
            .unwrap();
        let data = driver.directory().to_owned();
        driver
            .call_control("test.effective.defaults", move |store| {
                assert!(store.managed_account(&id)?.api_profile.is_none());
                let target = ConfigTarget {
                    account_id: id,
                    model: None,
                    model_capabilities: None,
                    active_sessions: 0,
                };
                let (model, effort) = crate::accounts::config::read_defaults(&data, &target)?;
                assert_eq!(model.as_deref(), Some(MODEL));
                assert_eq!(effort.as_deref(), Some("high"));
                Ok(())
            })
            .await
            .unwrap();
        driver.shutdown().await.unwrap();
        fixture.database.shutdown().await.unwrap();
    }
}
