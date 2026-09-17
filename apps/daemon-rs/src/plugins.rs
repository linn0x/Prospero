use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::net::TcpListener;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::database::now;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PluginServiceMode {
    Manual,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PluginServiceHealth {
    Unknown,
    Healthy,
    Unhealthy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PluginServiceStatus {
    Stopped,
    Starting,
    Running,
    Exited,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginServiceManifest {
    pub id: String,
    pub mode: PluginServiceMode,
    pub command: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub port_env: String,
    pub health_path: Option<String>,
    pub config_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProsperoPluginManifest {
    pub schema_version: String,
    pub name: String,
    pub version: Option<String>,
    pub root: String,
    pub manifest_path: String,
    pub skills_root: Option<String>,
    pub agents_root: Option<String>,
    pub runtime_root: Option<String>,
    pub bootstrap: Option<String>,
    pub services: Vec<PluginServiceManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicPluginService {
    pub id: String,
    pub mode: PluginServiceMode,
    pub command: Vec<String>,
    pub cwd: String,
    pub env_keys: Vec<String>,
    pub port_env: String,
    pub health_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicProsperoPlugin {
    pub name: String,
    pub version: Option<String>,
    pub root: String,
    pub skills_root: Option<String>,
    pub agents_root: Option<String>,
    pub runtime_root: Option<String>,
    pub bootstrap: Option<String>,
    pub services: Vec<PublicPluginService>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiscoveryError {
    pub root: String,
    pub manifest_path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicPluginDiscoveryResult {
    pub items: Vec<PublicProsperoPlugin>,
    pub errors: Vec<PluginDiscoveryError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginServiceExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
    #[ts(type = "number")]
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginServiceState {
    pub plugin_id: String,
    pub service_id: String,
    pub mode: PluginServiceMode,
    pub status: PluginServiceStatus,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    #[ts(type = "number | null")]
    pub started_at: Option<i64>,
    #[ts(type = "number")]
    pub updated_at: i64,
    pub last_exit: Option<PluginServiceExit>,
    pub last_error: Option<String>,
    pub health: PluginServiceHealth,
    #[ts(type = "number | null")]
    pub health_checked_at: Option<i64>,
    pub health_error: Option<String>,
    pub config_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginServiceLogFiles {
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginServiceView {
    pub plugin_id: String,
    pub service_id: String,
    pub mode: PluginServiceMode,
    pub status: PluginServiceStatus,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    #[ts(type = "number | null")]
    pub started_at: Option<i64>,
    #[ts(type = "number")]
    pub updated_at: i64,
    pub last_exit: Option<PluginServiceExit>,
    pub last_error: Option<String>,
    pub health: PluginServiceHealth,
    #[ts(type = "number | null")]
    pub health_checked_at: Option<i64>,
    pub health_error: Option<String>,
    pub config_key: String,
    pub configured: bool,
    pub plugin_root: Option<String>,
    pub command: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub log_files: PluginServiceLogFiles,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginServiceList {
    pub items: Vec<PluginServiceView>,
    pub errors: Vec<PluginDiscoveryError>,
}

#[derive(Clone)]
pub struct PluginServiceSupervisor(Arc<SupervisorState>);

#[derive(Clone)]
pub struct PluginServiceSupervisorOptions {
    pub home: PathBuf,
    pub daemon_port: u16,
    pub control_token_path: PathBuf,
    pub control_socket_path: String,
}

struct SupervisorState {
    home: PathBuf,
    store: PluginServiceStore,
    control: std::sync::Mutex<PluginServiceControl>,
    running: Mutex<HashMap<String, Arc<Runtime>>>,
    operations: Mutex<()>,
}

#[derive(Clone)]
struct PluginServiceControl {
    daemon_port: u16,
    control_token_path: PathBuf,
    control_socket_path: String,
}

struct Runtime {
    child: Mutex<Child>,
    plugin: ProsperoPluginManifest,
    service: PluginServiceManifest,
    port: u16,
    started_at: i64,
    stopping: AtomicBool,
}

#[derive(Clone)]
struct PluginServiceStore {
    root: PathBuf,
    logs_root: PathBuf,
    state_file: PathBuf,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StateFile {
    #[serde(default)]
    items: BTreeMap<String, PluginServiceState>,
}

impl PluginServiceSupervisor {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        let home = home.into();
        Self(Arc::new(SupervisorState {
            store: PluginServiceStore::new(&home),
            control: std::sync::Mutex::new(PluginServiceControl {
                daemon_port: 0,
                control_token_path: home.join("control.token"),
                control_socket_path: control_socket_path(&home),
            }),
            home,
            running: Mutex::new(HashMap::new()),
            operations: Mutex::new(()),
        }))
    }

    pub fn configure(
        &self,
        daemon_port: u16,
        control_token_path: PathBuf,
        control_socket_path: String,
    ) {
        if let Ok(mut control) = self.0.control.lock() {
            control.daemon_port = daemon_port;
            control.control_token_path = control_token_path;
            control.control_socket_path = control_socket_path;
        }
    }

    pub fn plugins(&self) -> PublicPluginDiscoveryResult {
        let discovered = discover_prospero_plugins(&self.0.home);
        PublicPluginDiscoveryResult {
            items: discovered.plugins.into_iter().map(public_plugin).collect(),
            errors: discovered.errors,
        }
    }

    pub async fn list(&self) -> Result<PluginServiceList> {
        self.0.store.ensure()?;
        let discovered = discover_prospero_plugins(&self.0.home);
        let mut configured = HashSet::new();
        let mut items = Vec::new();
        for plugin in &discovered.plugins {
            for service in &plugin.services {
                let key = plugin_service_key(&plugin.name, &service.id);
                configured.insert(key.clone());
                let state = self.status_for(plugin, service).await?;
                items.push(view_for(&self.0.store, plugin, service, state));
            }
        }
        for state in self.0.store.list()? {
            if configured.contains(&plugin_service_key(&state.plugin_id, &state.service_id)) {
                continue;
            }
            items.push(orphan_view(&self.0.store, state));
        }
        items.sort_by(|a, b| {
            plugin_service_key(&a.plugin_id, &a.service_id)
                .cmp(&plugin_service_key(&b.plugin_id, &b.service_id))
        });
        Ok(PluginServiceList {
            items,
            errors: discovered.errors,
        })
    }

    pub async fn start_auto(&self) {
        let discovered = discover_prospero_plugins(&self.0.home);
        for plugin in discovered.plugins {
            for service in plugin.services {
                if service.mode != PluginServiceMode::Auto {
                    continue;
                }
                if let Err(error) = self.start(&plugin.name, &service.id).await {
                    let state = state_now(PluginServiceState {
                        plugin_id: plugin.name.clone(),
                        service_id: service.id.clone(),
                        mode: service.mode,
                        status: PluginServiceStatus::Failed,
                        pid: None,
                        port: None,
                        started_at: None,
                        updated_at: 0,
                        last_exit: None,
                        last_error: Some(error.to_string()),
                        health: PluginServiceHealth::Unknown,
                        health_checked_at: None,
                        health_error: None,
                        config_key: service.config_key.clone(),
                    });
                    let _ = self.0.store.update(&state);
                }
            }
        }
    }

    pub async fn start(&self, plugin_id: &str, service_id: &str) -> Result<PluginServiceView> {
        validate_plugin_id(plugin_id, "pluginId")?;
        validate_plugin_id(service_id, "serviceId")?;
        let _guard = self.0.operations.lock().await;
        self.start_unlocked(plugin_id, service_id).await
    }

    pub async fn stop(&self, plugin_id: &str, service_id: &str) -> Result<PluginServiceView> {
        validate_plugin_id(plugin_id, "pluginId")?;
        validate_plugin_id(service_id, "serviceId")?;
        let _guard = self.0.operations.lock().await;
        self.stop_unlocked(plugin_id, service_id).await
    }

    pub async fn restart(&self, plugin_id: &str, service_id: &str) -> Result<PluginServiceView> {
        validate_plugin_id(plugin_id, "pluginId")?;
        validate_plugin_id(service_id, "serviceId")?;
        let _guard = self.0.operations.lock().await;
        let _ = self.stop_unlocked(plugin_id, service_id).await;
        self.start_unlocked(plugin_id, service_id).await
    }

    pub async fn check_health(
        &self,
        plugin_id: &str,
        service_id: &str,
    ) -> Result<PluginServiceView> {
        validate_plugin_id(plugin_id, "pluginId")?;
        validate_plugin_id(service_id, "serviceId")?;
        let found = self.find_service(plugin_id, service_id)?;
        let Some((plugin, service)) = found else {
            let Some(state) = self.0.store.get(plugin_id, service_id)? else {
                return Err(Error::Feature(
                    "plugin_service_not_found".into(),
                    "plugin service not found".into(),
                ));
            };
            let state = state_now(PluginServiceState {
                health: PluginServiceHealth::Unknown,
                health_checked_at: Some(now()),
                health_error: Some("service is not configured".into()),
                ..state
            });
            self.0.store.update(&state)?;
            return Ok(orphan_view(&self.0.store, state));
        };
        let state = self.status_for(&plugin, &service).await?;
        if service.health_path.is_none()
            || state.port.is_none()
            || state.status != PluginServiceStatus::Running
        {
            let next = state_now(PluginServiceState {
                health: PluginServiceHealth::Unknown,
                health_checked_at: Some(now()),
                health_error: service
                    .health_path
                    .as_ref()
                    .map(|_| "service is not running".into()),
                ..state
            });
            self.0.store.update(&next)?;
            return Ok(view_for(&self.0.store, &plugin, &service, next));
        }
        let health_path = service.health_path.clone().unwrap_or_default();
        let url = format!(
            "http://127.0.0.1:{}{}",
            state.port.unwrap_or_default(),
            health_path
        );
        let checked = now();
        let outcome = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|error| Error::Invalid(error.to_string()))?
            .get(url)
            .send()
            .await;
        let next = match outcome {
            Ok(response) if response.status().is_success() => state_now(PluginServiceState {
                health: PluginServiceHealth::Healthy,
                health_checked_at: Some(checked),
                health_error: None,
                ..state
            }),
            Ok(response) => state_now(PluginServiceState {
                health: PluginServiceHealth::Unhealthy,
                health_checked_at: Some(checked),
                health_error: Some(format!("status {}", response.status().as_u16())),
                ..state
            }),
            Err(error) => state_now(PluginServiceState {
                health: PluginServiceHealth::Unhealthy,
                health_checked_at: Some(checked),
                health_error: Some(error.to_string()),
                ..state
            }),
        };
        self.0.store.update(&next)?;
        Ok(view_for(&self.0.store, &plugin, &service, next))
    }

    pub async fn stop_all(&self) {
        let keys = self
            .0
            .running
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            let Some((plugin_id, service_id)) = key.split_once('/') else {
                continue;
            };
            let _ = self.stop(plugin_id, service_id).await;
        }
        if let Ok(list) = self.list().await {
            for item in list.items {
                if item.configured
                    && item.status == PluginServiceStatus::Running
                    && item.pid.is_some()
                {
                    let _ = self.stop(&item.plugin_id, &item.service_id).await;
                }
            }
        }
    }

    async fn start_unlocked(&self, plugin_id: &str, service_id: &str) -> Result<PluginServiceView> {
        self.0.store.ensure()?;
        let (plugin, service) = self.require_service(plugin_id, service_id)?;
        let key = plugin_service_key(&plugin.name, &service.id);
        if let Some(runtime) = self.0.running.lock().await.get(&key).cloned() {
            if runtime.service.config_key == service.config_key
                && runtime_exit(&runtime).await?.is_none()
            {
                let state = running_state(
                    &plugin,
                    &service,
                    Some(runtime.pid().await),
                    runtime.port,
                    runtime.started_at,
                );
                self.0.store.update(&state)?;
                return Ok(view_for(&self.0.store, &plugin, &service, state));
            }
            self.0.running.lock().await.remove(&key);
        }
        let existing = status_from_state(
            self.0.store.get(&plugin.name, &service.id)?,
            &plugin,
            &service,
        );
        if existing.status == PluginServiceStatus::Running
            && process_matches_service(existing.pid, &service)
        {
            self.0.store.update(&existing)?;
            return Ok(view_for(&self.0.store, &plugin, &service, existing));
        }
        let port = loopback_port()?;
        let started_at = now();
        self.0.store.update(&state_now(PluginServiceState {
            plugin_id: plugin.name.clone(),
            service_id: service.id.clone(),
            mode: service.mode,
            status: PluginServiceStatus::Starting,
            pid: None,
            port: Some(port),
            started_at: Some(started_at),
            updated_at: 0,
            last_exit: None,
            last_error: None,
            health: PluginServiceHealth::Unknown,
            health_checked_at: None,
            health_error: None,
            config_key: service.config_key.clone(),
        }))?;
        let child = match self.spawn_child(&plugin, &service, port) {
            Ok(child) => child,
            Err(error) => {
                let state = state_now(PluginServiceState {
                    plugin_id: plugin.name.clone(),
                    service_id: service.id.clone(),
                    mode: service.mode,
                    status: PluginServiceStatus::Failed,
                    pid: None,
                    port: None,
                    started_at: Some(started_at),
                    updated_at: 0,
                    last_exit: None,
                    last_error: Some(error.to_string()),
                    health: PluginServiceHealth::Unknown,
                    health_checked_at: None,
                    health_error: None,
                    config_key: service.config_key.clone(),
                });
                self.0.store.update(&state)?;
                return Err(error);
            }
        };
        let pid = child.id();
        let runtime = Arc::new(Runtime {
            child: Mutex::new(child),
            plugin: plugin.clone(),
            service: service.clone(),
            port,
            started_at,
            stopping: AtomicBool::new(false),
        });
        self.0
            .running
            .lock()
            .await
            .insert(key.clone(), runtime.clone());
        let running = running_state(&plugin, &service, Some(pid), port, started_at);
        self.0.store.update(&running)?;
        self.watch_runtime_exit(key.clone(), runtime.clone());
        tokio::time::sleep(Duration::from_millis(75)).await;
        if let Some(exit) = runtime_exit(&runtime).await? {
            self.0.running.lock().await.remove(&key);
            let state = state_now(PluginServiceState {
                plugin_id: plugin.name.clone(),
                service_id: service.id.clone(),
                mode: service.mode,
                status: PluginServiceStatus::Exited,
                pid: None,
                port: None,
                started_at: Some(started_at),
                updated_at: 0,
                last_exit: Some(exit),
                last_error: None,
                health: PluginServiceHealth::Unknown,
                health_checked_at: None,
                health_error: None,
                config_key: service.config_key.clone(),
            });
            self.0.store.update(&state)?;
            return Ok(view_for(&self.0.store, &plugin, &service, state));
        }
        if service.health_path.is_some() {
            let supervisor = self.clone();
            let plugin_id = plugin.name.clone();
            let service_id = service.id.clone();
            tokio::spawn(async move {
                let _ = supervisor.check_health(&plugin_id, &service_id).await;
            });
        }
        Ok(view_for(&self.0.store, &plugin, &service, running))
    }

    fn watch_runtime_exit(&self, key: String, runtime: Arc<Runtime>) {
        let supervisor = self.clone();
        tokio::spawn(async move {
            let exit = loop {
                match runtime_exit(&runtime).await {
                    Ok(Some(exit)) => break Some(exit),
                    Ok(None) => tokio::time::sleep(Duration::from_millis(250)).await,
                    Err(error) => {
                        let state = state_now(PluginServiceState {
                            plugin_id: runtime.plugin.name.clone(),
                            service_id: runtime.service.id.clone(),
                            mode: runtime.service.mode,
                            status: PluginServiceStatus::Failed,
                            pid: None,
                            port: None,
                            started_at: Some(runtime.started_at),
                            updated_at: 0,
                            last_exit: None,
                            last_error: Some(error.to_string()),
                            health: PluginServiceHealth::Unknown,
                            health_checked_at: None,
                            health_error: None,
                            config_key: runtime.service.config_key.clone(),
                        });
                        let _ = supervisor.0.store.update(&state);
                        supervisor.0.running.lock().await.remove(&key);
                        return;
                    }
                }
            };
            supervisor.0.running.lock().await.remove(&key);
            let previous = supervisor
                .0
                .store
                .get(&runtime.plugin.name, &runtime.service.id)
                .unwrap_or_default();
            let state = state_now(PluginServiceState {
                plugin_id: runtime.plugin.name.clone(),
                service_id: runtime.service.id.clone(),
                mode: runtime.service.mode,
                status: if runtime.stopping.load(Ordering::Acquire) {
                    PluginServiceStatus::Stopped
                } else {
                    PluginServiceStatus::Exited
                },
                pid: None,
                port: None,
                started_at: previous
                    .as_ref()
                    .and_then(|state| state.started_at)
                    .or(Some(runtime.started_at)),
                updated_at: 0,
                last_exit: exit,
                last_error: if runtime.stopping.load(Ordering::Acquire) {
                    None
                } else {
                    previous.and_then(|state| state.last_error)
                },
                health: PluginServiceHealth::Unknown,
                health_checked_at: None,
                health_error: None,
                config_key: runtime.service.config_key.clone(),
            });
            let _ = supervisor.0.store.update(&state);
        });
    }

    async fn stop_unlocked(&self, plugin_id: &str, service_id: &str) -> Result<PluginServiceView> {
        let key = plugin_service_key(plugin_id, service_id);
        if let Some(runtime) = self.0.running.lock().await.remove(&key) {
            return self.stop_runtime(runtime).await;
        }
        let found = self.find_service(plugin_id, service_id)?;
        let state = match &found {
            Some((plugin, service)) => {
                status_from_state(self.0.store.get(plugin_id, service_id)?, plugin, service)
            }
            None => self.0.store.get(plugin_id, service_id)?.ok_or_else(|| {
                Error::Feature(
                    "plugin_service_not_found".into(),
                    "plugin service not found".into(),
                )
            })?,
        };
        if let Some((_, service)) = &found
            && let Some(pid) = state.pid
            && process_matches_service(Some(pid), service)
        {
            terminate_pid(pid)?;
        }
        let stopped = state_now(PluginServiceState {
            plugin_id: plugin_id.to_owned(),
            service_id: service_id.to_owned(),
            mode: found
                .as_ref()
                .map(|(_, service)| service.mode)
                .unwrap_or(state.mode),
            status: PluginServiceStatus::Stopped,
            pid: None,
            port: None,
            started_at: state.started_at,
            updated_at: 0,
            last_exit: if state.pid.is_some() {
                Some(PluginServiceExit {
                    code: None,
                    signal: Some("SIGTERM".into()),
                    at: now(),
                })
            } else {
                state.last_exit
            },
            last_error: None,
            health: PluginServiceHealth::Unknown,
            health_checked_at: None,
            health_error: None,
            config_key: found
                .as_ref()
                .map(|(_, service)| service.config_key.clone())
                .unwrap_or(state.config_key),
        });
        self.0.store.update(&stopped)?;
        Ok(match found {
            Some((plugin, service)) => view_for(&self.0.store, &plugin, &service, stopped),
            None => orphan_view(&self.0.store, stopped),
        })
    }

    async fn stop_runtime(&self, runtime: Arc<Runtime>) -> Result<PluginServiceView> {
        runtime.stopping.store(true, Ordering::Release);
        let exit = terminate_child(&runtime).await?;
        let state = state_now(PluginServiceState {
            plugin_id: runtime.plugin.name.clone(),
            service_id: runtime.service.id.clone(),
            mode: runtime.service.mode,
            status: PluginServiceStatus::Stopped,
            pid: None,
            port: None,
            started_at: Some(runtime.started_at),
            updated_at: 0,
            last_exit: exit.or_else(|| {
                Some(PluginServiceExit {
                    code: None,
                    signal: Some("SIGTERM".into()),
                    at: now(),
                })
            }),
            last_error: None,
            health: PluginServiceHealth::Unknown,
            health_checked_at: None,
            health_error: None,
            config_key: runtime.service.config_key.clone(),
        });
        self.0.store.update(&state)?;
        Ok(view_for(
            &self.0.store,
            &runtime.plugin,
            &runtime.service,
            state,
        ))
    }

    async fn status_for(
        &self,
        plugin: &ProsperoPluginManifest,
        service: &PluginServiceManifest,
    ) -> Result<PluginServiceState> {
        let key = plugin_service_key(&plugin.name, &service.id);
        if let Some(runtime) = self.0.running.lock().await.get(&key).cloned()
            && runtime.service.config_key == service.config_key
        {
            if let Some(exit) = runtime_exit(&runtime).await? {
                self.0.running.lock().await.remove(&key);
                let state = state_now(PluginServiceState {
                    plugin_id: plugin.name.clone(),
                    service_id: service.id.clone(),
                    mode: service.mode,
                    status: if runtime.stopping.load(Ordering::Acquire) {
                        PluginServiceStatus::Stopped
                    } else {
                        PluginServiceStatus::Exited
                    },
                    pid: None,
                    port: None,
                    started_at: Some(runtime.started_at),
                    updated_at: 0,
                    last_exit: Some(exit),
                    last_error: None,
                    health: PluginServiceHealth::Unknown,
                    health_checked_at: None,
                    health_error: None,
                    config_key: service.config_key.clone(),
                });
                self.0.store.update(&state)?;
                return Ok(state);
            }
            let state = running_state(
                plugin,
                service,
                Some(runtime.pid().await),
                runtime.port,
                runtime.started_at,
            );
            self.0.store.update(&state)?;
            return Ok(state);
        }
        let state = status_from_state(
            self.0.store.get(&plugin.name, &service.id)?,
            plugin,
            service,
        );
        if state.status == PluginServiceStatus::Exited {
            self.0.store.update(&state)?;
        }
        Ok(state)
    }

    fn spawn_child(
        &self,
        plugin: &ProsperoPluginManifest,
        service: &PluginServiceManifest,
        port: u16,
    ) -> Result<Child> {
        let logs = self.0.store.log_files(&plugin.name, &service.id);
        let stdout = private_log(&logs.stdout)?;
        let stderr = private_log(&logs.stderr)?;
        let command = command_path(service.command.first().ok_or_else(|| {
            Error::Invalid("service.command must be a non-empty argv array".into())
        })?);
        let control = self.0.control.lock().map_err(|_| Error::Closed)?.clone();
        let mut child = Command::new(command);
        child.args(service.command.iter().skip(1));
        child.current_dir(&service.cwd);
        child.env_clear();
        for (key, value) in base_env() {
            child.env(key, value);
        }
        for (key, value) in &service.env {
            child.env(key, value);
        }
        child.env("PROSPERO_HOME", &self.0.home);
        child.env("PROSPERO_PLUGIN_ID", &plugin.name);
        child.env("PROSPERO_PLUGIN_DIR", &plugin.root);
        child.env(
            "PROSPERO_PLUGIN_RUNTIME",
            plugin.runtime_root.as_deref().unwrap_or(&plugin.root),
        );
        child.env("PROSPERO_CONTROL_TOKEN_PATH", &control.control_token_path);
        child.env("PROSPERO_CONTROL_SOCKET_PATH", &control.control_socket_path);
        child.env(
            "PROSPERO_CONTROL_HTTP",
            format!("http://127.0.0.1:{}", control.daemon_port),
        );
        child.env(&service.port_env, port.to_string());
        child.stdin(Stdio::null());
        child.stdout(Stdio::from(stdout));
        child.stderr(Stdio::from(stderr));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            child.creation_flags(0x08000000);
        }
        child.spawn().map_err(Into::into)
    }

    fn find_service(
        &self,
        plugin_id: &str,
        service_id: &str,
    ) -> Result<Option<(ProsperoPluginManifest, PluginServiceManifest)>> {
        let discovered = discover_prospero_plugins(&self.0.home);
        Ok(discovered
            .plugins
            .into_iter()
            .find(|plugin| plugin.name == plugin_id)
            .and_then(|plugin| {
                plugin
                    .services
                    .iter()
                    .find(|service| service.id == service_id)
                    .cloned()
                    .map(|service| (plugin, service))
            }))
    }

    fn require_service(
        &self,
        plugin_id: &str,
        service_id: &str,
    ) -> Result<(ProsperoPluginManifest, PluginServiceManifest)> {
        self.find_service(plugin_id, service_id)?.ok_or_else(|| {
            Error::Feature(
                "plugin_service_not_found".into(),
                "plugin service not found".into(),
            )
        })
    }
}

impl Runtime {
    async fn pid(&self) -> u32 {
        self.child.lock().await.id()
    }
}

impl PluginServiceStore {
    fn new(home: &Path) -> Self {
        let root = home.join("plugin-services");
        Self {
            logs_root: root.join("logs"),
            state_file: root.join("state.json"),
            root,
        }
    }

    fn ensure(&self) -> Result<()> {
        private_dir(&self.root)?;
        private_dir(&self.logs_root)
    }

    fn list(&self) -> Result<Vec<PluginServiceState>> {
        Ok(read_state(&self.state_file).items.into_values().collect())
    }

    fn get(&self, plugin_id: &str, service_id: &str) -> Result<Option<PluginServiceState>> {
        Ok(read_state(&self.state_file)
            .items
            .remove(&plugin_service_key(plugin_id, service_id)))
    }

    fn update(&self, state: &PluginServiceState) -> Result<()> {
        self.ensure()?;
        let mut file = read_state(&self.state_file);
        file.items.insert(
            plugin_service_key(&state.plugin_id, &state.service_id),
            state.clone(),
        );
        write_private_json(&self.state_file, &file)
    }

    fn log_files(&self, plugin_id: &str, service_id: &str) -> PluginServiceLogFiles {
        let base = format!("{plugin_id}.{service_id}");
        PluginServiceLogFiles {
            stdout: self
                .logs_root
                .join(format!("{base}.out.log"))
                .to_string_lossy()
                .into_owned(),
            stderr: self
                .logs_root
                .join(format!("{base}.err.log"))
                .to_string_lossy()
                .into_owned(),
        }
    }
}

pub fn plugin_service_key(plugin_id: &str, service_id: &str) -> String {
    format!("{plugin_id}/{service_id}")
}

pub fn control_socket_path(home: &Path) -> String {
    #[cfg(windows)]
    {
        let digest = hex_sha256(home.to_string_lossy().to_lowercase().as_bytes());
        format!(r"\\\\.\\pipe\\prospero-{}", &digest[..32])
    }
    #[cfg(not(windows))]
    {
        home.join("control.sock").to_string_lossy().into_owned()
    }
}

pub fn discover_prospero_plugins(home: &Path) -> PluginDiscoveryResult {
    let root = plugin_install_root(home);
    let mut errors = Vec::new();
    let mut plugins = Vec::new();
    if let Err(error) = ensure_private_directory(home).and_then(|_| ensure_private_directory(&root))
    {
        return PluginDiscoveryResult {
            plugins,
            errors: vec![PluginDiscoveryError {
                root: root.to_string_lossy().into_owned(),
                manifest_path: None,
                message: error.to_string(),
            }],
        };
    }
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) => {
            return PluginDiscoveryResult {
                plugins,
                errors: vec![PluginDiscoveryError {
                    root: root.to_string_lossy().into_owned(),
                    manifest_path: None,
                    message: error.to_string(),
                }],
            };
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".backup") || name.contains(".backup-") {
            continue;
        }
        let plugin_root = root.join(&name);
        let file_type = match entry.file_type() {
            Ok(value) => value,
            Err(error) => {
                errors.push(PluginDiscoveryError {
                    root: plugin_root.to_string_lossy().into_owned(),
                    manifest_path: None,
                    message: error.to_string(),
                });
                continue;
            }
        };
        if !file_type.is_dir() {
            if file_type.is_symlink() {
                errors.push(PluginDiscoveryError {
                    root: plugin_root.to_string_lossy().into_owned(),
                    manifest_path: None,
                    message: "plugin root cannot be a symlink".into(),
                });
            }
            continue;
        }
        let manifest_path = plugin_root.join("prospero-plugin.json");
        match parse_plugin_manifest(&plugin_root, &manifest_path) {
            Ok(plugin) if plugin.name == name => plugins.push(plugin),
            Ok(_) => errors.push(PluginDiscoveryError {
                root: plugin_root.to_string_lossy().into_owned(),
                manifest_path: Some(manifest_path.to_string_lossy().into_owned()),
                message: "manifest name must match plugin directory".into(),
            }),
            Err(Error::Io(error)) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => errors.push(PluginDiscoveryError {
                root: plugin_root.to_string_lossy().into_owned(),
                manifest_path: Some(manifest_path.to_string_lossy().into_owned()),
                message: error.to_string(),
            }),
        }
    }
    plugins.sort_by(|a, b| a.name.cmp(&b.name));
    PluginDiscoveryResult { plugins, errors }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginDiscoveryResult {
    pub plugins: Vec<ProsperoPluginManifest>,
    pub errors: Vec<PluginDiscoveryError>,
}

fn public_plugin(plugin: ProsperoPluginManifest) -> PublicProsperoPlugin {
    PublicProsperoPlugin {
        name: plugin.name,
        version: plugin.version,
        root: plugin.root,
        skills_root: plugin.skills_root,
        agents_root: plugin.agents_root,
        runtime_root: plugin.runtime_root,
        bootstrap: plugin.bootstrap,
        services: plugin
            .services
            .into_iter()
            .map(|service| PublicPluginService {
                id: service.id,
                mode: service.mode,
                command: service.command,
                cwd: service.cwd,
                env_keys: service.env.keys().cloned().collect(),
                port_env: service.port_env,
                health_path: service.health_path,
            })
            .collect(),
    }
}

fn plugin_install_root(home: &Path) -> PathBuf {
    home.join("plugins")
}

fn parse_plugin_manifest(
    plugin_root: &Path,
    manifest_path: &Path,
) -> Result<ProsperoPluginManifest> {
    let metadata = fs::symlink_metadata(plugin_root)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::Invalid("plugin root must be a directory".into()));
    }
    let root = absolute_path(plugin_root)?;
    let root_real = root.canonicalize()?;
    let value: JsonValue = serde_json::from_str(&fs::read_to_string(manifest_path)?)?;
    assert_no_secret_fields(&value, &[])?;
    let raw = value
        .as_object()
        .ok_or_else(|| Error::Invalid("manifest must be an object".into()))?;
    if raw.get("schema_version").and_then(JsonValue::as_str) != Some("prospero-plugin/v1") {
        return Err(Error::Invalid("schema_version is invalid".into()));
    }
    let name = string_value(raw.get("name"), "name", 64)?;
    validate_plugin_id(&name, "name")?;
    let version = optional_string(raw.get("version"), "version", 512)?;
    let services_raw = raw.get("services").unwrap_or(&JsonValue::Null);
    let services = match services_raw {
        JsonValue::Null => Vec::new(),
        JsonValue::Array(items) if items.len() <= 32 => {
            let mut seen = HashSet::new();
            let mut services = Vec::new();
            for item in items {
                let service = parse_service(&root, &root_real, item)?;
                if !seen.insert(service.id.clone()) {
                    return Err(Error::Invalid(format!(
                        "duplicate service id: {}",
                        service.id
                    )));
                }
                services.push(service);
            }
            services
        }
        _ => return Err(Error::Invalid("services must be an array".into())),
    };
    Ok(ProsperoPluginManifest {
        schema_version: "prospero-plugin/v1".into(),
        name,
        version,
        root: root.to_string_lossy().into_owned(),
        manifest_path: absolute_path(manifest_path)?.to_string_lossy().into_owned(),
        skills_root: relative_field(raw, "skills_root", &root, &root_real)?,
        agents_root: relative_field(raw, "agents_root", &root, &root_real)?,
        runtime_root: relative_field(raw, "runtime_root", &root, &root_real)?,
        bootstrap: relative_field(raw, "bootstrap", &root, &root_real)?,
        services,
    })
}

fn parse_service(
    root: &Path,
    root_real: &Path,
    value: &JsonValue,
) -> Result<PluginServiceManifest> {
    let raw = value
        .as_object()
        .ok_or_else(|| Error::Invalid("service must be an object".into()))?;
    let id = string_value(raw.get("id"), "service.id", 64)?;
    validate_plugin_id(&id, "service.id")?;
    let mode = match optional_string(raw.get("mode"), "service.mode", 16)?.as_deref() {
        None | Some("manual") => PluginServiceMode::Manual,
        Some("auto") => PluginServiceMode::Auto,
        _ => return Err(Error::Invalid("service.mode is invalid".into())),
    };
    if raw.get("command").is_some_and(JsonValue::is_string) {
        return Err(Error::Invalid(
            "service.command must be an argv array".into(),
        ));
    }
    let cwd = resolve_within_plugin(
        root,
        root_real,
        optional_string(raw.get("cwd"), "service.cwd", 512)?
            .as_deref()
            .unwrap_or("."),
        root,
    )?;
    let cwd_metadata = fs::symlink_metadata(&cwd)?;
    if !cwd_metadata.is_dir() || cwd_metadata.file_type().is_symlink() {
        return Err(Error::Invalid(
            "service.cwd must be a directory inside plugin root".into(),
        ));
    }
    let command_raw = raw
        .get("command")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| Error::Invalid("service.command must be a non-empty argv array".into()))?;
    if command_raw.is_empty() || command_raw.len() > 64 {
        return Err(Error::Invalid(
            "service.command must be a non-empty argv array".into(),
        ));
    }
    let command = command_raw
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let value = string_value(Some(item), &format!("service.command.{index}"), 2048)?;
            if path_like(&value) {
                let base = if Path::new(&value).is_absolute()
                    || value.starts_with('.')
                    || (!value.contains('/') && !value.contains('\\'))
                {
                    &cwd
                } else {
                    root
                };
                Ok(resolve_within_plugin(root, root_real, &value, base)?
                    .to_string_lossy()
                    .into_owned())
            } else {
                Ok(value)
            }
        })
        .collect::<Result<Vec<_>>>()?;
    let env = parse_env(raw.get("env"))?;
    let port_env = optional_string(raw.get("port_env"), "service.port_env", 128)?
        .unwrap_or_else(|| "PORT".into());
    validate_env_name(&port_env, "service.port_env")?;
    let health_path = parse_health_path(raw.get("health_path"))?;
    let config_key = plugin_config_key(&id, mode, &command, &cwd, &env, &port_env, &health_path)?;
    Ok(PluginServiceManifest {
        id,
        mode,
        command,
        cwd: cwd.to_string_lossy().into_owned(),
        env,
        port_env,
        health_path,
        config_key,
    })
}

fn relative_field(
    raw: &serde_json::Map<String, JsonValue>,
    key: &str,
    root: &Path,
    root_real: &Path,
) -> Result<Option<String>> {
    optional_string(raw.get(key), key, 512)?
        .map(|value| {
            resolve_within_plugin(root, root_real, &value, root)
                .map(|path| path.to_string_lossy().into_owned())
        })
        .transpose()
}

fn string_value(value: Option<&JsonValue>, context: &str, max: usize) -> Result<String> {
    let Some(value) = value.and_then(JsonValue::as_str) else {
        return Err(Error::Invalid(format!(
            "{context} must be a non-empty string"
        )));
    };
    if value.is_empty() || value.len() > max || value.contains('\0') {
        return Err(Error::Invalid(format!(
            "{context} must be a non-empty string"
        )));
    }
    Ok(value.to_owned())
}

fn optional_string(value: Option<&JsonValue>, context: &str, max: usize) -> Result<Option<String>> {
    match value {
        None => Ok(None),
        Some(value) => string_value(Some(value), context, max).map(Some),
    }
}

fn validate_plugin_id(value: &str, context: &str) -> Result<()> {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return Err(Error::Invalid(format!("{context} is invalid")));
    };
    if !first.is_ascii_lowercase()
        || value.len() > 64
        || !bytes.all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
    {
        return Err(Error::Invalid(format!("{context} is invalid")));
    }
    Ok(())
}

fn validate_env_name(value: &str, context: &str) -> Result<()> {
    let mut chars = value.bytes();
    let Some(first) = chars.next() else {
        return Err(Error::Invalid(format!("{context} is invalid")));
    };
    if !(first.is_ascii_alphabetic() || first == b'_')
        || value.len() > 128
        || !chars.all(|c| c.is_ascii_alphanumeric() || c == b'_')
    {
        return Err(Error::Invalid(format!("{context} is invalid")));
    }
    Ok(())
}

fn contains_secret_name(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value.contains("token") || value.contains("secret") || value.contains("cookie")
}

fn assert_no_secret_fields(value: &JsonValue, path: &[String]) -> Result<()> {
    match value {
        JsonValue::String(value) if contains_secret_name(value) => {
            return Err(Error::Invalid(format!(
                "{} must not contain secret material",
                secret_path(path)
            )));
        }
        JsonValue::String(_) => {}
        JsonValue::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                let mut next = path.to_vec();
                next.push(index.to_string());
                assert_no_secret_fields(item, &next)?;
            }
        }
        JsonValue::Object(object) => {
            for (key, item) in object {
                let mut next = path.to_vec();
                next.push(key.clone());
                if contains_secret_name(key) {
                    return Err(Error::Invalid(format!(
                        "{} must not contain secret material",
                        secret_path(&next)
                    )));
                }
                assert_no_secret_fields(item, &next)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn secret_path(path: &[String]) -> String {
    if path.is_empty() {
        "manifest".into()
    } else {
        path.join(".")
    }
}

fn parse_env(value: Option<&JsonValue>) -> Result<BTreeMap<String, String>> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let raw = value
        .as_object()
        .ok_or_else(|| Error::Invalid("service.env must be an object".into()))?;
    if raw.len() > 128 {
        return Err(Error::Invalid("service.env has too many entries".into()));
    }
    let mut out = BTreeMap::new();
    for (key, value) in raw {
        validate_env_name(key, &format!("service.env.{key}"))?;
        out.insert(
            key.clone(),
            string_value(Some(value), &format!("service.env.{key}"), 4096)?,
        );
    }
    Ok(out)
}

fn parse_health_path(value: Option<&JsonValue>) -> Result<Option<String>> {
    let Some(value) = optional_string(value, "service.health_path", 256)? else {
        return Ok(None);
    };
    if !value.starts_with('/') || value.contains("://") {
        return Err(Error::Invalid("service.health_path is invalid".into()));
    }
    Ok(Some(value))
}

fn path_like(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if value.contains("://") {
        return false;
    }
    value.starts_with('.')
        || value.starts_with('/')
        || value.contains('/')
        || value.contains('\\')
        || [".cjs", ".js", ".mjs", ".py", ".sh", ".ts"]
            .iter()
            .any(|suffix| lower.ends_with(suffix))
}

fn resolve_within_plugin(root: &Path, root_real: &Path, raw: &str, base: &Path) -> Result<PathBuf> {
    let target = normalize_absolute(if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        base.join(raw)
    })?;
    if !target.starts_with(root) {
        return Err(Error::Invalid(format!("{raw} escapes plugin root")));
    }
    let ancestor = existing_ancestor(&target);
    let real = ancestor
        .canonicalize()
        .map_err(|_| Error::Invalid(format!("{raw} cannot be resolved")))?;
    if !real.starts_with(root_real) {
        return Err(Error::Invalid(format!("{raw} escapes plugin root")));
    }
    Ok(target)
}

fn absolute_path(path: &Path) -> Result<PathBuf> {
    normalize_absolute(if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    })
}

fn normalize_absolute(path: PathBuf) -> Result<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return Err(Error::Invalid("path escapes root".into()));
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    Ok(out)
}

fn existing_ancestor(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    while !current.exists() {
        if !current.pop() {
            break;
        }
    }
    current
}

fn plugin_config_key(
    id: &str,
    mode: PluginServiceMode,
    command: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    port_env: &str,
    health_path: &Option<String>,
) -> Result<String> {
    let payload = serde_json::to_vec(&json!({
        "id": id,
        "mode": mode,
        "command": command,
        "cwd": cwd.to_string_lossy(),
        "env": env,
        "portEnv": port_env,
        "healthPath": health_path,
    }))?;
    Ok(hex_sha256(&payload))
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn read_state(path: &Path) -> StateFile {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<StateFile>(&raw).ok())
        .unwrap_or_default()
}

fn write_private_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::Invalid("invalid state path".into()))?;
    private_dir(parent)?;
    let tmp = path.with_file_name(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec_pretty(value)?;
    fs::write(&tmp, [bytes, b"\\n".to_vec()].concat())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(tmp, path)?;
    Ok(())
}

fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::Invalid(format!(
            "{} is not a safe directory",
            path.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(Error::Invalid(format!(
                "{} is not owned by the current user",
                path.display()
            )));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<()> {
    private_dir(path)
}

fn state_now(mut state: PluginServiceState) -> PluginServiceState {
    state.updated_at = now();
    state
}

fn stopped_state(
    plugin: &ProsperoPluginManifest,
    service: &PluginServiceManifest,
) -> PluginServiceState {
    state_now(PluginServiceState {
        plugin_id: plugin.name.clone(),
        service_id: service.id.clone(),
        mode: service.mode,
        status: PluginServiceStatus::Stopped,
        pid: None,
        port: None,
        started_at: None,
        updated_at: 0,
        last_exit: None,
        last_error: None,
        health: PluginServiceHealth::Unknown,
        health_checked_at: None,
        health_error: None,
        config_key: service.config_key.clone(),
    })
}

fn running_state(
    plugin: &ProsperoPluginManifest,
    service: &PluginServiceManifest,
    pid: Option<u32>,
    port: u16,
    started_at: i64,
) -> PluginServiceState {
    state_now(PluginServiceState {
        plugin_id: plugin.name.clone(),
        service_id: service.id.clone(),
        mode: service.mode,
        status: PluginServiceStatus::Running,
        pid,
        port: Some(port),
        started_at: Some(started_at),
        updated_at: 0,
        last_exit: None,
        last_error: None,
        health: PluginServiceHealth::Unknown,
        health_checked_at: None,
        health_error: None,
        config_key: service.config_key.clone(),
    })
}

fn status_from_state(
    state: Option<PluginServiceState>,
    plugin: &ProsperoPluginManifest,
    service: &PluginServiceManifest,
) -> PluginServiceState {
    if let Some(state) = state.filter(|state| state.config_key == service.config_key) {
        if state.status == PluginServiceStatus::Running
            && !process_matches_service(state.pid, service)
        {
            return state_now(PluginServiceState {
                status: PluginServiceStatus::Exited,
                pid: None,
                port: None,
                ..state
            });
        }
        return state;
    }
    stopped_state(plugin, service)
}

fn view_for(
    store: &PluginServiceStore,
    plugin: &ProsperoPluginManifest,
    service: &PluginServiceManifest,
    state: PluginServiceState,
) -> PluginServiceView {
    PluginServiceView {
        plugin_id: state.plugin_id,
        service_id: state.service_id,
        mode: state.mode,
        status: state.status,
        pid: state.pid,
        port: state.port,
        started_at: state.started_at,
        updated_at: state.updated_at,
        last_exit: state.last_exit,
        last_error: state.last_error,
        health: state.health,
        health_checked_at: state.health_checked_at,
        health_error: state.health_error,
        config_key: state.config_key,
        configured: true,
        plugin_root: Some(plugin.root.clone()),
        command: Some(service.command.clone()),
        cwd: Some(service.cwd.clone()),
        log_files: store.log_files(&plugin.name, &service.id),
    }
}

fn orphan_view(store: &PluginServiceStore, state: PluginServiceState) -> PluginServiceView {
    let log_files = store.log_files(&state.plugin_id, &state.service_id);
    PluginServiceView {
        plugin_id: state.plugin_id,
        service_id: state.service_id,
        mode: state.mode,
        status: state.status,
        pid: state.pid,
        port: state.port,
        started_at: state.started_at,
        updated_at: state.updated_at,
        last_exit: state.last_exit,
        last_error: state.last_error,
        health: state.health,
        health_checked_at: state.health_checked_at,
        health_error: state.health_error,
        config_key: state.config_key,
        configured: false,
        plugin_root: None,
        command: None,
        cwd: None,
        log_files,
    }
}

fn loopback_port() -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn base_env() -> BTreeMap<String, String> {
    [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SystemRoot",
        "ComSpec",
        "PATHEXT",
    ]
    .into_iter()
    .filter_map(|key| std::env::var(key).ok().map(|value| (key.to_owned(), value)))
    .collect()
}

fn command_path(value: &str) -> String {
    if value == "node" {
        std::env::var("PROSPERO_NODE")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| value.to_owned())
    } else {
        value.to_owned()
    }
}

fn private_log(path: &str) -> Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}

async fn runtime_exit(runtime: &Runtime) -> Result<Option<PluginServiceExit>> {
    let mut child = runtime.child.lock().await;
    Ok(child.try_wait()?.map(exit_payload))
}

async fn terminate_child(runtime: &Runtime) -> Result<Option<PluginServiceExit>> {
    let pid = runtime.child.lock().await.id();
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = runtime.child.lock().await.kill();
    }
    if let Some(exit) = wait_child(runtime, Duration::from_secs(5)).await? {
        return Ok(Some(exit));
    }
    let _ = runtime.child.lock().await.kill();
    wait_child(runtime, Duration::from_secs(3)).await
}

async fn wait_child(runtime: &Runtime, timeout: Duration) -> Result<Option<PluginServiceExit>> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(exit) = runtime_exit(runtime).await? {
            return Ok(Some(exit));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(None);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn exit_payload(status: ExitStatus) -> PluginServiceExit {
    PluginServiceExit {
        code: status.code(),
        signal: exit_signal(&status),
        at: now(),
    }
}

#[cfg(unix)]
fn exit_signal(status: &ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|signal| format!("SIG{signal}"))
}

#[cfg(not(unix))]
fn exit_signal(_status: &ExitStatus) -> Option<String> {
    None
}

fn process_alive(pid: Option<u32>) -> bool {
    let Some(pid) = pid.filter(|pid| *pid > 1) else {
        return false;
    };
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as i32, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .ok()
            .is_some_and(|output| {
                String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
            })
    }
}

fn process_command(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .filter(|value| !value.is_empty())
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

fn process_matches_service(pid: Option<u32>, service: &PluginServiceManifest) -> bool {
    let Some(pid) = pid else {
        return false;
    };
    if !process_alive(Some(pid)) {
        return false;
    }
    let Some(command) = process_command(pid) else {
        return false;
    };
    service
        .command
        .iter()
        .filter(|part| Path::new(part.as_str()).is_absolute())
        .any(|part| command.contains(part))
}

fn terminate_pid(pid: u32) -> Result<()> {
    #[cfg(unix)]
    {
        unsafe {
            if libc::kill(pid as i32, libc::SIGTERM) != 0
                && std::io::Error::last_os_error().kind() != ErrorKind::NotFound
            {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()?;
        Ok(())
    }
}
