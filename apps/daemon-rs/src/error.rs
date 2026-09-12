use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unauthorized")]
    Unauthorized,
    #[error("request origin is not allowed")]
    Forbidden,
    #[error("request timed out")]
    Timeout,
    #[error("terminal input may be incomplete; session stopped")]
    TerminalInput,
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error("record not found")]
    NotFound,
    #[error("record changed; reload before retrying")]
    Conflict,
    #[error("account is still in use by an active session")]
    InUse,
    #[error("连接测试繁忙，请稍后重试")]
    ApiTestBusy,
    #[error("这个 Profile 正在测试连接，请等待测试结束")]
    ApiTestInFlight,
    #[error("database queue is full")]
    Busy,
    #[error("database worker is unavailable")]
    Closed,
    #[error("another daemon owns this data directory")]
    AlreadyRunning,
    #[error("unsupported or incomplete database schema")]
    Schema,
    #[error("storage operation failed")]
    Storage(#[from] rusqlite::Error),
    #[error("filesystem operation failed")]
    Io(#[from] std::io::Error),
    #[error("stored data is invalid")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl Error {
    pub fn public(&self) -> ErrorBody {
        let (code, retryable) = match self {
            Self::Unauthorized => ("unauthorized", false),
            Self::Forbidden => ("forbidden", false),
            Self::Timeout => ("timeout", true),
            Self::TerminalInput => ("terminal_input_failed", false),
            Self::Invalid(_) => ("invalid_request", false),
            Self::NotFound => ("not_found", false),
            Self::Conflict => ("conflict", false),
            Self::InUse => ("in_use", false),
            Self::ApiTestBusy | Self::ApiTestInFlight => ("busy", false),
            Self::Busy => ("busy", true),
            Self::Closed => ("unavailable", true),
            Self::AlreadyRunning => ("already_running", false),
            Self::Schema => ("unsupported_schema", false),
            Self::Storage(_) | Self::Io(_) | Self::Json(_) => ("storage", false),
        };
        ErrorBody {
            code: code.into(),
            message: self.to_string(),
            retryable,
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
