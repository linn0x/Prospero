use super::HostClient;
use crate::{
    error::{Error, Result},
    orchestration::reliability::HostIdentity,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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
}
impl HostHandle {
    pub(crate) fn directory(&self) -> Result<&Path> {
        Err(unsupported())
    }

    pub fn open(_data_dir: &Path, _identity: &HostIdentity) -> Result<Self> {
        Err(unsupported())
    }
    pub fn client(&self) -> Result<HostClient> {
        Err(unsupported())
    }
}
pub async fn ensure_host(
    _data_dir: &Path,
    _binary: &Path,
    _identity: HostIdentity,
) -> Result<HostHandle> {
    Err(unsupported())
}
fn unsupported() -> Error {
    Error::Invalid("execution Host ownership is not implemented on this platform".into())
}
