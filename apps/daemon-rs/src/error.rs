use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResourceBackpressure {
    pub retry_after_ms: u64,
    pub operation: String,
    pub resource: String,
    pub queue_depth: usize,
    pub queue_capacity: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub side_effect_committed: Option<bool>,
}

impl std::fmt::Display for ResourceBackpressure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} is at capacity", self.resource)
    }
}

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
    #[error("resource is busy")]
    Busy,
    #[error("{0}")]
    Backpressure(ResourceBackpressure),
    #[error("runtime worker is unavailable")]
    Closed,
    #[error("database worker is unavailable: {0}")]
    DatabaseUnavailable(String),
    #[error("database operation failed: {0}")]
    DatabaseOperationFailed(String),
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
    #[error("{1}")]
    Feature(String, String),
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resource: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub side_effect_committed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub queue_depth: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub queue_capacity: Option<usize>,
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
            Self::Backpressure(_) => ("busy", true),
            Self::Closed => ("unavailable", true),
            Self::DatabaseUnavailable(_) => ("unavailable", true),
            Self::DatabaseOperationFailed(_) => ("database_operation_failed", true),
            Self::AlreadyRunning => ("already_running", false),
            Self::Schema => ("unsupported_schema", false),
            Self::Feature(code, _) => (code.as_str(), false),
            Self::Storage(_) | Self::Io(_) | Self::Json(_) => ("storage", false),
        };
        let pressure = match self {
            Self::Backpressure(pressure) => Some(pressure),
            _ => None,
        };
        ErrorBody {
            code: code.into(),
            message: self.to_string(),
            retryable,
            retry_after_ms: pressure
                .map(|value| value.retry_after_ms)
                .or_else(|| matches!(self, Self::Busy).then_some(100)),
            operation: pressure.map(|value| value.operation.clone()),
            resource: pressure.map(|value| value.resource.clone()),
            side_effect_committed: pressure.and_then(|value| value.side_effect_committed),
            queue_depth: pressure.map(|value| value.queue_depth),
            queue_capacity: pressure.map(|value| value.queue_capacity),
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
