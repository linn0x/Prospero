use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{HostClient, HostResponse};
use crate::database::validate_id;
use crate::error::{Error, Result};
use crate::orchestration::reliability::HostIdentity;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostManifest {
    pub protocol_version: u32,
    pub identity: HostIdentity,
    pub socket_path: PathBuf,
    pub runtime_digest: String,
    pub pid: Option<u32>,
}

pub struct HostHandle {
    pub manifest: HostManifest,
    directory: PathBuf,
}

fn private_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(Error::Invalid("Host directory is not private".into()));
    }
    Ok(())
}

fn create_private_directory(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => fs::set_permissions(path, fs::Permissions::from_mode(0o700))?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    private_directory(path)
}

fn host_directory(data_dir: &Path, identity: &HostIdentity) -> Result<PathBuf> {
    validate_id(&identity.host_id)?;
    validate_id(&identity.host_epoch)?;
    Ok(data_dir
        .join("execution-hosts")
        .join(&identity.host_id)
        .join(&identity.host_epoch))
}

fn read_private(path: &Path, maximum: u64) -> Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
        || metadata.len() > maximum
    {
        return Err(Error::Invalid(
            "Host file is not private or exceeds limit".into(),
        ));
    }
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(Error::Invalid("Host file exceeds limit".into()));
    }
    Ok(bytes)
}

fn write_private(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn persist_manifest(directory: &Path, manifest: &HostManifest) -> Result<()> {
    let temporary = directory.join(format!("manifest-{}.tmp", uuid::Uuid::new_v4().simple()));
    write_private(&temporary, &serde_json::to_vec(manifest)?, 0o600)?;
    fs::rename(temporary, directory.join("manifest.json"))?;
    fs::File::open(directory)?.sync_all()?;
    Ok(())
}

fn runtime_path(data_dir: &Path, digest: &str) -> Result<PathBuf> {
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Error::Conflict);
    }
    let root = data_dir.join("execution-runtimes");
    private_directory(&root)?;
    let directory = root.join(digest);
    private_directory(&directory)?;
    Ok(directory.join("runtime"))
}

fn hash_file(file: &mut fs::File) -> Result<String> {
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut length = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        length += read as u64;
        if length > 512 * 1024 * 1024 {
            return Err(Error::Invalid("Host runtime exceeds limit".into()));
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[derive(Clone, PartialEq, Eq)]
struct PinStamp {
    device: u64,
    inode: u64,
    length: u64,
    modified: i64,
    modified_nsec: i64,
    changed: i64,
    changed_nsec: i64,
}

fn pin_stamp(metadata: &fs::Metadata) -> PinStamp {
    PinStamp {
        device: metadata.dev(),
        inode: metadata.ino(),
        length: metadata.len(),
        modified: metadata.mtime(),
        modified_nsec: metadata.mtime_nsec(),
        changed: metadata.ctime(),
        changed_nsec: metadata.ctime_nsec(),
    }
}

struct ValidatedPin {
    path: PathBuf,
    stamp: PinStamp,
    digest: String,
}
static PIN_CACHE: OnceLock<Mutex<VecDeque<ValidatedPin>>> = OnceLock::new();

fn hash_runtime(path: &Path) -> Result<String> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
        || metadata.mode() & 0o100 == 0
    {
        return Err(Error::Invalid(
            "Host runtime is not a private executable".into(),
        ));
    }
    let stamp = pin_stamp(&metadata);
    let cache = PIN_CACHE.get_or_init(|| Mutex::new(VecDeque::new()));
    if let Some(digest) = cache
        .lock()
        .map_err(|_| Error::Conflict)?
        .iter()
        .find(|entry| entry.path == path && entry.stamp == stamp)
        .map(|entry| entry.digest.clone())
    {
        return Ok(digest);
    }
    let digest = hash_file(&mut file)?;
    if pin_stamp(&file.metadata()?) != stamp {
        return Err(Error::Conflict);
    }
    let mut cache = cache.lock().map_err(|_| Error::Conflict)?;
    if cache.len() >= 128 {
        cache.pop_front();
    }
    cache.push_back(ValidatedPin {
        path: path.to_owned(),
        stamp,
        digest: digest.clone(),
    });
    Ok(digest)
}

fn pin_runtime(data_dir: &Path, binary: &Path) -> Result<(String, PathBuf)> {
    let mut source = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(binary)?;
    if !source.metadata()?.is_file() {
        return Err(Error::Invalid("invalid Host runtime".into()));
    }
    let digest = hash_file(&mut source)?;
    let root = data_dir.join("execution-runtimes");
    create_private_directory(&root)?;
    let directory = root.join(&digest);
    create_private_directory(&directory)?;
    let path = directory.join("runtime");
    if !path.try_exists()? {
        let temporary = directory.join(format!("runtime-{}.tmp", uuid::Uuid::new_v4().simple()));
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)?;
        source.seek(SeekFrom::Start(0))?;
        std::io::copy(&mut source.take(512 * 1024 * 1024 + 1), &mut target)?;
        target.sync_all()?;
        if hash_runtime(&temporary)? != digest {
            let _ = fs::remove_file(temporary);
            return Err(Error::Conflict);
        }
        fs::rename(&temporary, &path)?;
        fs::File::open(&directory)?.sync_all()?;
    }
    if hash_runtime(&path)? != digest {
        return Err(Error::Conflict);
    }
    Ok((digest, path))
}

impl HostHandle {
    pub fn open(data_dir: &Path, identity: &HostIdentity) -> Result<Self> {
        let directory = host_directory(data_dir, identity)?;
        private_directory(&data_dir.join("execution-hosts"))?;
        private_directory(directory.parent().ok_or(Error::Conflict)?)?;
        private_directory(&directory)?;
        let manifest: HostManifest =
            serde_json::from_slice(&read_private(&directory.join("manifest.json"), 16384)?)?;
        if manifest.protocol_version != 1
            || manifest.identity.host_id != identity.host_id
            || manifest.identity.host_epoch != identity.host_epoch
        {
            return Err(Error::Conflict);
        }
        let parent = manifest.socket_path.parent().ok_or(Error::Conflict)?;
        if !manifest.socket_path.is_absolute()
            || manifest
                .socket_path
                .file_name()
                .and_then(|name| name.to_str())
                != Some("control.sock")
            || !parent
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("prospero-host-"))
        {
            return Err(Error::Invalid("invalid Host socket location".into()));
        }
        private_directory(parent)?;
        let runtime = match runtime_path(data_dir, &manifest.runtime_digest) {
            Ok(path) => path,
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                directory.join("runtime")
            }
            Err(error) => return Err(error),
        };
        if hash_runtime(&runtime)? != manifest.runtime_digest {
            return Err(Error::Conflict);
        }
        Ok(Self {
            manifest,
            directory,
        })
    }

    pub fn client(&self) -> Result<HostClient> {
        let token = String::from_utf8(read_private(&self.directory.join("token"), 128)?)
            .map_err(|_| Error::Invalid("invalid Host token".into()))?;
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(Error::Invalid("invalid Host token".into()));
        }
        Ok(HostClient::with_expected_host(
            self.manifest.socket_path.clone(),
            token,
            self.manifest.identity.clone(),
        ))
    }
}

pub async fn ensure_host(
    data_dir: &Path,
    binary: &Path,
    identity: HostIdentity,
) -> Result<HostHandle> {
    let directory = host_directory(data_dir, &identity)?;
    if directory.try_exists()? {
        let handle = HostHandle::open(data_dir, &identity)?;
        verify_health(&handle).await?;
        return Ok(handle);
    }
    private_directory(data_dir)?;
    let root = data_dir.join("execution-hosts");
    create_private_directory(&root)?;
    create_private_directory(&root.join(&identity.host_id))?;
    fs::create_dir(&directory)?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    let (runtime_digest, runtime_path) = pin_runtime(data_dir, binary)?;
    let socket_directory =
        PathBuf::from("/tmp").join(format!("prospero-host-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir(&socket_directory)?;
    fs::set_permissions(&socket_directory, fs::Permissions::from_mode(0o700))?;
    let mut manifest = HostManifest {
        protocol_version: 1,
        identity,
        socket_path: socket_directory.join("control.sock"),
        runtime_digest,
        pid: None,
    };
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    write_private(&directory.join("token"), token.as_bytes(), 0o600)?;
    persist_manifest(&directory, &manifest)?;
    let mut command = tokio::process::Command::new(runtime_path);
    command
        .arg("--data-dir")
        .arg(&directory)
        .arg("--socket")
        .arg(&manifest.socket_path)
        .arg("--token-file")
        .arg(directory.join("token"))
        .arg("--host-id")
        .arg(&manifest.identity.host_id)
        .arg("--host-epoch")
        .arg(&manifest.identity.host_epoch)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    manifest.pid = child.id();
    persist_manifest(&directory, &manifest)?;
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    let handle = HostHandle {
        manifest,
        directory,
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if verify_health(&handle).await.is_ok() {
            return Ok(handle);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(Error::Timeout);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn verify_health(handle: &HostHandle) -> Result<()> {
    let response = tokio::time::timeout(Duration::from_secs(1), handle.client()?.health())
        .await
        .map_err(|_| Error::Timeout)??;
    match response {
        HostResponse::Health {
            ready: true,
            protocol_version: 1,
            identity,
            ..
        } if identity.host_id == handle.manifest.identity.host_id
            && identity.host_epoch == handle.manifest.identity.host_epoch =>
        {
            Ok(())
        }
        _ => Err(Error::Conflict),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, HostIdentity, PathBuf) {
        let data = tempfile::tempdir().unwrap();
        let sockets = tempfile::Builder::new()
            .prefix("prospero-host-")
            .tempdir()
            .unwrap();
        fs::set_permissions(data.path(), fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(sockets.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let identity = HostIdentity {
            host_id: "host".into(),
            host_epoch: "epoch".into(),
        };
        let directory = host_directory(data.path(), &identity).unwrap();
        fs::create_dir_all(&directory).unwrap();
        for path in [
            data.path().join("execution-hosts"),
            data.path().join("execution-hosts/host"),
            directory.clone(),
        ] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let source = data.path().join("source");
        write_private(&source, b"pinned", 0o700).unwrap();
        pin_runtime(data.path(), &source).unwrap();
        write_private(&directory.join("token"), "a".repeat(64).as_bytes(), 0o600).unwrap();
        persist_manifest(
            &directory,
            &HostManifest {
                protocol_version: 1,
                identity: identity.clone(),
                socket_path: sockets.path().join("control.sock"),
                runtime_digest: Sha256::digest(b"pinned")
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
                pid: None,
            },
        )
        .unwrap();
        (data, sockets, identity, directory)
    }

    #[test]
    fn reattach_checks_pinned_bytes_and_full_host_identity() {
        let (data, _sockets, identity, _directory) = fixture();
        HostHandle::open(data.path(), &identity)
            .unwrap()
            .client()
            .unwrap();
        let pinned = runtime_path(
            data.path(),
            &HostHandle::open(data.path(), &identity)
                .unwrap()
                .manifest
                .runtime_digest,
        )
        .unwrap();
        fs::write(pinned, b"changed").unwrap();
        assert!(matches!(
            HostHandle::open(data.path(), &identity),
            Err(Error::Conflict)
        ));
    }

    #[test]
    fn same_binary_reuses_one_content_pin() {
        let data = tempfile::tempdir().unwrap();
        fs::set_permissions(data.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let source = data.path().join("source");
        write_private(&source, b"pinned", 0o700).unwrap();
        let (digest, first) = pin_runtime(data.path(), &source).unwrap();
        let inode = fs::metadata(&first).unwrap().ino();
        let (second_digest, second) = pin_runtime(data.path(), &source).unwrap();
        assert_eq!(first, second);
        assert_eq!(digest, second_digest);
        assert_eq!(fs::metadata(second).unwrap().ino(), inode);
    }

    #[test]
    fn linked_or_public_capability_is_rejected() {
        let (data, _sockets, identity, directory) = fixture();
        let handle = HostHandle::open(data.path(), &identity).unwrap();
        fs::set_permissions(directory.join("token"), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(handle.client().is_err());
        fs::remove_file(directory.join("token")).unwrap();
        std::os::unix::fs::symlink(data.path().join("source"), directory.join("token")).unwrap();
        assert!(handle.client().is_err());
    }
}
