use crate::orchestration::reliability::{ExecutionIdentity, VerifiedExitProof};
use serde::{Deserialize, Serialize};
use std::{
    io,
    path::{Path, PathBuf},
};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::{ensure_budget, serve};

#[derive(Clone, Debug)]
pub struct BudgetConfig {
    pub directory: PathBuf,
    pub capacity: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BudgetClaim {
    pub claim_id: String,
    pub identity: ExecutionIdentity,
    pub daemon_id: String,
    pub state: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum BudgetDecision {
    Granted(Box<BudgetClaim>),
    Waiting { used: u32, capacity: u32 },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub protocol_version: u32,
    pub broker_epoch: String,
    pub capacity: u32,
    pub held: u32,
    pub quarantined: u32,
    pub released: u64,
    pub ready: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "requestType", rename_all = "snake_case")]
enum Request {
    Reserve {
        token: String,
        identity: ExecutionIdentity,
        daemon_id: String,
    },
    Quarantine {
        token: String,
        identity: ExecutionIdentity,
    },
    Release {
        token: String,
        identity: ExecutionIdentity,
        proof: VerifiedExitProof,
    },
    Health {
        token: String,
    },
    Shutdown {
        token: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "responseType", rename_all = "snake_case")]
enum Response {
    Reservation { decision: BudgetDecision },
    Claim { claim: BudgetClaim },
    Health { status: BudgetStatus },
    Shutdown,
    Error { code: String, message: String },
}

#[derive(Clone)]
pub struct BudgetClient {
    socket: PathBuf,
    token: String,
    epoch: String,
}

pub fn default_directory() -> io::Result<PathBuf> {
    if let Some(path) = std::env::var_os("PROSPERO_EXECUTION_BUDGET_DIR") {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(io::Error::other("budget directory must be absolute"));
        }
        return Ok(path);
    }
    let home = std::env::var_os("HOME")
        .ok_or_else(|| io::Error::other("HOME is required for the shared execution budget"))?;
    Ok(PathBuf::from(home).join(".prospero/execution-budget"))
}

impl BudgetClient {
    pub fn from_environment() -> io::Result<Self> {
        Self::from_directory(&default_directory()?)
    }

    pub fn from_directory(directory: &Path) -> io::Result<Self> {
        #[cfg(unix)]
        {
            unix::client(directory)
        }
        #[cfg(not(unix))]
        {
            let _ = directory;
            Err(io::Error::other(
                "shared execution budget is not implemented on this platform",
            ))
        }
    }

    pub async fn reserve(
        &self,
        identity: ExecutionIdentity,
        daemon_id: String,
    ) -> io::Result<BudgetDecision> {
        match self
            .request(Request::Reserve {
                token: self.token.clone(),
                identity,
                daemon_id,
            })
            .await?
        {
            Response::Reservation { decision } => Ok(decision),
            response => Err(response_error(response)),
        }
    }

    pub async fn quarantine(&self, identity: ExecutionIdentity) -> io::Result<BudgetClaim> {
        match self
            .request(Request::Quarantine {
                token: self.token.clone(),
                identity,
            })
            .await?
        {
            Response::Claim { claim } => Ok(claim),
            response => Err(response_error(response)),
        }
    }

    pub async fn release(
        &self,
        identity: ExecutionIdentity,
        proof: VerifiedExitProof,
    ) -> io::Result<BudgetClaim> {
        match self
            .request(Request::Release {
                token: self.token.clone(),
                identity,
                proof,
            })
            .await?
        {
            Response::Claim { claim } => Ok(claim),
            response => Err(response_error(response)),
        }
    }

    pub async fn health(&self) -> io::Result<BudgetStatus> {
        match self
            .request(Request::Health {
                token: self.token.clone(),
            })
            .await?
        {
            Response::Health { status }
                if status.protocol_version == 1 && status.broker_epoch == self.epoch =>
            {
                Ok(status)
            }
            response => Err(response_error(response)),
        }
    }

    pub async fn shutdown(&self) -> io::Result<()> {
        match self
            .request(Request::Shutdown {
                token: self.token.clone(),
            })
            .await?
        {
            Response::Shutdown => Ok(()),
            response => Err(response_error(response)),
        }
    }

    async fn request(&self, request: Request) -> io::Result<Response> {
        #[cfg(unix)]
        {
            unix::request(&self.socket, request).await
        }
        #[cfg(not(unix))]
        {
            let _ = request;
            Err(io::Error::other(
                "shared execution budget is not implemented on this platform",
            ))
        }
    }
}

fn response_error(response: Response) -> io::Error {
    match response {
        Response::Error { code, message } => io::Error::other(format!("{code}: {message}")),
        _ => io::Error::other("unexpected budget broker response"),
    }
}

#[cfg(not(unix))]
pub async fn serve(_config: BudgetConfig) -> io::Result<()> {
    Err(io::Error::other(
        "shared execution budget is not implemented on this platform",
    ))
}

#[cfg(not(unix))]
pub async fn ensure_budget(
    _directory: &Path,
    _binary: &Path,
    _capacity: u32,
) -> io::Result<BudgetClient> {
    Err(io::Error::other(
        "shared execution budget is not implemented on this platform",
    ))
}
