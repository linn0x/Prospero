#[cfg(unix)]
pub mod launcher;
#[cfg(not(unix))]
#[path = "unsupported.rs"]
pub mod launcher;
#[cfg(unix)]
mod server;

use std::{fs::OpenOptions, io::Read, path::PathBuf};

use serde::{Deserialize, Serialize};

use crate::orchestration::reliability::{
    CommandReceipt, HostCommand, HostIdentity, InteractionReply,
};

#[cfg(unix)]
pub use server::serve;

#[cfg(not(unix))]
pub async fn serve(_config: HostConfig) -> std::io::Result<()> {
    Err(std::io::Error::other(
        "execution Host private IPC is not implemented for this platform",
    ))
}

pub const HOST_PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug)]
pub struct HostConfig {
    pub data_dir: PathBuf,
    pub socket_path: PathBuf,
    pub token_file: PathBuf,
    pub host_id: String,
    pub host_epoch: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "requestType", rename_all = "snake_case")]
pub enum HostRequest {
    Command {
        token: String,
        command: HostCommand,
    },
    Events {
        token: String,
        after_sequence: u64,
        limit: usize,
    },
    InteractionReply {
        token: String,
        reply: InteractionReply,
    },
    CommandQuery {
        token: String,
        command_id: String,
    },
    Shutdown {
        token: String,
        #[serde(default)]
        acknowledged_sequence: Option<u64>,
    },
    Health {
        token: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEvent {
    pub event_id: String,
    pub identity: crate::orchestration::reliability::ExecutionIdentity,
    pub sequence: u64,
    pub kind: String,
    pub payload: String,
    pub observed_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEventPage {
    pub protocol_version: u32,
    pub events: Vec<HostEvent>,
    pub next_sequence: u64,
    pub gap: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCommandDetail {
    pub command: HostCommand,
    pub receipt: CommandReceipt,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "responseType", rename_all = "snake_case")]
pub enum HostResponse {
    Command {
        receipt: CommandReceipt,
    },
    Events {
        page: HostEventPage,
    },
    CommandDetail {
        detail: Box<HostCommandDetail>,
    },
    Shutdown {
        accepted: bool,
        identity: HostIdentity,
    },
    Health {
        ready: bool,
        protocol_version: u32,
        identity: HostIdentity,
        capabilities: Vec<String>,
        unresolved_attempts: usize,
    },
    Error {
        code: String,
        message: String,
    },
}

pub struct HostClient {
    socket_path: PathBuf,
    token: String,
    expected_host: Option<HostIdentity>,
}

impl HostClient {
    pub fn new(socket_path: PathBuf, token: String) -> Self {
        Self {
            socket_path,
            token,
            expected_host: None,
        }
    }

    pub fn with_expected_host(
        socket_path: PathBuf,
        token: String,
        expected_host: HostIdentity,
    ) -> Self {
        Self {
            socket_path,
            token,
            expected_host: Some(expected_host),
        }
    }

    pub fn from_token_file(socket_path: PathBuf, token_file: PathBuf) -> std::io::Result<Self> {
        let token = read_private_token(&token_file)?;
        Ok(Self::new(socket_path, token))
    }

    pub fn from_token_file_for_host(
        socket_path: PathBuf,
        token_file: PathBuf,
        expected_host: HostIdentity,
    ) -> std::io::Result<Self> {
        let mut client = Self::from_token_file(socket_path, token_file)?;
        client.expected_host = Some(expected_host);
        Ok(client)
    }

    pub async fn command(&self, command: HostCommand) -> std::io::Result<CommandReceipt> {
        let expected_identity = command.identity.clone();
        let expected_id = command.command_id.clone();
        match self
            .request(HostRequest::Command {
                token: self.token.clone(),
                command,
            })
            .await?
        {
            HostResponse::Command { receipt } => {
                self.verify_host(receipt.identity.host.as_ref())?;
                if receipt.identity != expected_identity || receipt.command_id != expected_id {
                    return Err(std::io::Error::other(
                        "Host command receipt identity mismatch",
                    ));
                }
                Ok(receipt)
            }
            HostResponse::Error { code, message } => {
                Err(std::io::Error::other(format!("{code}: {message}")))
            }
            _ => Err(std::io::Error::other("unexpected execution Host response")),
        }
    }

    pub async fn events(
        &self,
        after_sequence: u64,
        limit: usize,
    ) -> std::io::Result<HostEventPage> {
        match self
            .request(HostRequest::Events {
                token: self.token.clone(),
                after_sequence,
                limit,
            })
            .await?
        {
            HostResponse::Events { page } => {
                if page.protocol_version != HOST_PROTOCOL_VERSION {
                    return Err(std::io::Error::other("unsupported execution Host protocol"));
                }
                for event in &page.events {
                    self.verify_host(event.identity.host.as_ref())?;
                }
                Ok(page)
            }
            HostResponse::Error { code, message } => {
                Err(std::io::Error::other(format!("{code}: {message}")))
            }
            _ => Err(std::io::Error::other("unexpected execution Host response")),
        }
    }

    pub async fn interaction_reply(
        &self,
        reply: InteractionReply,
    ) -> std::io::Result<CommandReceipt> {
        self.verify_host(reply.identity.host.as_ref())?;
        let expected_identity = reply.identity.clone();
        let expected_id = reply.command_id.clone();
        match self
            .request(HostRequest::InteractionReply {
                token: self.token.clone(),
                reply,
            })
            .await?
        {
            HostResponse::Command { receipt } => {
                self.verify_host(receipt.identity.host.as_ref())?;
                if receipt.identity != expected_identity || receipt.command_id != expected_id {
                    return Err(std::io::Error::other(
                        "Host interaction receipt identity mismatch",
                    ));
                }
                Ok(receipt)
            }
            HostResponse::Error { code, message } => {
                Err(std::io::Error::other(format!("{code}: {message}")))
            }
            _ => Err(std::io::Error::other("unexpected execution Host response")),
        }
    }

    pub async fn command_detail(
        &self,
        command_id: impl Into<String>,
    ) -> std::io::Result<HostCommandDetail> {
        let command_id = command_id.into();
        match self
            .request(HostRequest::CommandQuery {
                token: self.token.clone(),
                command_id: command_id.clone(),
            })
            .await?
        {
            HostResponse::CommandDetail { detail } => {
                self.verify_host(detail.command.identity.host.as_ref())?;
                if detail.command.command_id != command_id
                    || detail.receipt.command_id != command_id
                    || detail.command.identity != detail.receipt.identity
                {
                    return Err(std::io::Error::other(
                        "Host command detail identity mismatch",
                    ));
                }
                Ok(*detail)
            }
            HostResponse::Error { code, message } => {
                Err(std::io::Error::other(format!("{code}: {message}")))
            }
            _ => Err(std::io::Error::other("unexpected execution Host response")),
        }
    }

    pub async fn shutdown(&self) -> std::io::Result<()> {
        self.shutdown_request(None).await
    }

    pub async fn shutdown_when_drained(&self, acknowledged_sequence: u64) -> std::io::Result<()> {
        self.shutdown_request(Some(acknowledged_sequence)).await
    }

    async fn shutdown_request(&self, acknowledged_sequence: Option<u64>) -> std::io::Result<()> {
        match self
            .request(HostRequest::Shutdown {
                token: self.token.clone(),
                acknowledged_sequence,
            })
            .await?
        {
            HostResponse::Shutdown {
                accepted: true,
                identity,
            } => self.verify_host(Some(&identity)),
            HostResponse::Error { code, message } => {
                Err(std::io::Error::other(format!("{code}: {message}")))
            }
            _ => Err(std::io::Error::other("unexpected execution Host response")),
        }
    }

    pub async fn health(&self) -> std::io::Result<HostResponse> {
        let response = self
            .request(HostRequest::Health {
                token: self.token.clone(),
            })
            .await?;
        match &response {
            HostResponse::Health {
                protocol_version,
                identity,
                ..
            } => {
                if *protocol_version != HOST_PROTOCOL_VERSION {
                    return Err(std::io::Error::other("unsupported execution Host protocol"));
                }
                self.verify_host(Some(identity))?;
            }
            HostResponse::Error { code, message } => {
                return Err(std::io::Error::other(format!("{code}: {message}")));
            }
            _ => return Err(std::io::Error::other("unexpected execution Host response")),
        }
        Ok(response)
    }

    async fn request(&self, request: HostRequest) -> std::io::Result<HostResponse> {
        #[cfg(unix)]
        {
            server::request(&self.socket_path, request).await
        }
        #[cfg(not(unix))]
        {
            let _ = request;
            let _ = &self.socket_path;
            Err(std::io::Error::other(
                "execution Host private IPC is not implemented for this platform",
            ))
        }
    }

    fn verify_host(&self, actual: Option<&HostIdentity>) -> std::io::Result<()> {
        let Some(expected) = &self.expected_host else {
            return Ok(());
        };
        if actual.is_some_and(|actual| {
            actual.host_id == expected.host_id && actual.host_epoch == expected.host_epoch
        }) {
            Ok(())
        } else {
            Err(std::io::Error::other("execution Host identity mismatch"))
        }
    }
}

fn read_private_token(path: &std::path::Path) -> std::io::Result<String> {
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || metadata.nlink() != 1
            || metadata.len() > 128
        {
            return Err(std::io::Error::other(
                "Host token file is not private or exceeds its limit",
            ));
        }
        let mut bytes = Vec::new();
        file.take(129).read_to_end(&mut bytes)?;
        if bytes.len() > 128 {
            return Err(std::io::Error::other("Host token file exceeds its limit"));
        }
        bytes
    };
    #[cfg(not(unix))]
    let bytes = {
        let metadata = std::fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 128 {
            return Err(std::io::Error::other("invalid Host token file"));
        }
        let mut bytes = Vec::new();
        OpenOptions::new()
            .read(true)
            .open(path)?
            .take(129)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 128 {
            return Err(std::io::Error::other("Host token file exceeds its limit"));
        }
        bytes
    };
    let token =
        String::from_utf8(bytes).map_err(|_| std::io::Error::other("Host token is not ASCII"))?;
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(std::io::Error::other("invalid Host token"));
    }
    Ok(token)
}
