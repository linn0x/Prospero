mod claude;
mod runtime;
mod store;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use runtime::Agents;

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAgentSession {
    pub title: String,
    pub workspace: String,
    #[serde(default)]
    pub auto_approve: bool,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSend {
    pub text: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionDecision {
    pub request_id: String,
    pub allow: bool,
}
