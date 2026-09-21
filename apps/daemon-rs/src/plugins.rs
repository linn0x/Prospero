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
    #[serde(default)]
    pub restart_count: u32,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub next_restart_at: Option<i64>,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub restart_window_started_at: Option<i64>,
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
    pub restart_count: u32,
    #[ts(type = "number | null")]
    pub next_restart_at: Option<i64>,
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
    operations: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    shutdown: AtomicBool,
    policy: SupervisorPolicy,
}

#[derive(Clone)]
struct PluginServiceControl {
    daemon_port: u16,
    control_token_path: PathBuf,
    control_socket_path: String,
}

struct Runtime {
    pid: u32,
    child: Mutex<Child>,
    process_tree: ProcessTree,
    plugin: ProsperoPluginManifest,
    service: PluginServiceManifest,
    port: u16,
    started_at: i64,
    stopping: AtomicBool,
}

#[cfg(unix)]
struct ProcessTree {
    group: i32,
}

#[cfg(windows)]
struct ProcessTree {
    job: isize,
}

#[derive(Clone)]
struct PluginServiceStore {
    root: PathBuf,
    logs_root: PathBuf,
    state_file: PathBuf,
    lock: Arc<std::sync::Mutex<()>>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StateFile {
    #[serde(default)]
    items: BTreeMap<String, PluginServiceState>,
}

#[derive(Clone)]
struct SupervisorPolicy {
    health_interval: Duration,
    health_failure_limit: u32,
    restart_window: Duration,
    restart_limit: u32,
    restart_delays: Arc<[Duration]>,
}

impl Default for SupervisorPolicy {
    fn default() -> Self {
        Self {
            health_interval: Duration::from_secs(10),
            health_failure_limit: 6,
            restart_window: Duration::from_secs(300),
            restart_limit: 8,
            restart_delays: [
                Duration::from_millis(500),
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(5),
                Duration::from_secs(10),
                Duration::from_secs(30),
            ]
            .into(),
        }
    }
}

impl PluginServiceSupervisor {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self::with_policy(home.into(), SupervisorPolicy::default())
    }

    fn with_policy(home: PathBuf, policy: SupervisorPolicy) -> Self {
        Self(Arc::new(SupervisorState {
            store: PluginServiceStore::new(&home),
            control: std::sync::Mutex::new(PluginServiceControl {
                daemon_port: 0,
                control_token_path: home.join("control.token"),
                control_socket_path: control_socket_path(&home),
            }),
            home,
            running: Mutex::new(HashMap::new()),
            operations: Mutex::new(HashMap::new()),
            shutdown: AtomicBool::new(false),
            policy,
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
        let running = self.0.running.lock().await.clone();
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.list_snapshot(running))
            .await
            .map_err(|_| Error::Closed)?
    }

    fn list_snapshot(&self, running: HashMap<String, Arc<Runtime>>) -> Result<PluginServiceList> {
        self.0.store.ensure()?;
        let discovered = discover_prospero_plugins(&self.0.home);
        let mut previous: BTreeMap<_, _> = self
            .0
            .store
            .list()?
            .into_iter()
            .map(|state| {
                (
                    plugin_service_key(&state.plugin_id, &state.service_id),
                    state,
                )
            })
            .collect();
        let mut items = Vec::new();
        let mut updates = Vec::new();
        for plugin in &discovered.plugins {
            for service in &plugin.services {
                let key = plugin_service_key(&plugin.name, &service.id);
                let old = previous.remove(&key);
                let runtime = running
                    .get(&key)
                    .filter(|runtime| runtime.service.config_key == service.config_key)
                    // The runtime map was captured before the store snapshot.
                    // A stop/exit/restart may have committed in between. Never
                    // resurrect that old generation or erase its backoff.
                    .filter(|runtime| {
                        old.as_ref().is_none_or(|state| {
                            state.started_at == Some(runtime.started_at)
                                && matches!(
                                    state.status,
                                    PluginServiceStatus::Starting | PluginServiceStatus::Running
                                )
                                && state.pid.is_none_or(|pid| pid == runtime.pid)
                        })
                    });
                let mut state = match runtime {
                    Some(runtime) => running_state_with_previous(
                        plugin,
                        service,
                        Some(runtime.pid),
                        runtime.port,
                        runtime.started_at,
                        old.clone(),
                    ),
                    None => status_from_state(old.clone(), plugin, service),
                };
                if let Some(old) = &old {
                    let mut same = state.clone();
                    same.updated_at = old.updated_at;
                    if same == *old {
                        state.updated_at = old.updated_at;
                    }
                }
                if (runtime.is_some() || state.status == PluginServiceStatus::Exited)
                    && old.as_ref() != Some(&state)
                {
                    updates.push((old, state.clone()));
                }
                items.push(view_for(&self.0.store, plugin, service, state));
            }
        }
        self.0.store.update_observed(updates)?;
        items.extend(
            previous
                .into_values()
                .map(|state| orphan_view(&self.0.store, state)),
        );
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
        self.0.shutdown.store(false, Ordering::Release);
        let discovered = discover_prospero_plugins(&self.0.home);
        for plugin in discovered.plugins {
            for service in plugin.services {
                if service.mode != PluginServiceMode::Auto {
                    continue;
                }
                if let Ok(Some(state)) = self.0.store.get(&plugin.name, &service.id)
                    && state.config_key == service.config_key
                    && state.status == PluginServiceStatus::Exited
                {
                    if state.next_restart_at.is_some() {
                        self.schedule_restart(plugin.name.clone(), service.id.clone(), state);
                        continue;
                    }
                    if state.restart_count > self.0.policy.restart_limit {
                        continue;
                    }
                }
                if let Err(error) = self.start(&plugin.name, &service.id).await {
                    let base = PluginServiceState {
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
                        restart_count: 0,
                        next_restart_at: None,
                        restart_window_started_at: None,
                        config_key: service.config_key.clone(),
                    };
                    let restart = restart_schedule(&base, &self.0.policy);
                    let state = state_now(PluginServiceState {
                        status: PluginServiceStatus::Exited,
                        restart_count: restart.0,
                        next_restart_at: restart.1,
                        restart_window_started_at: restart.2,
                        ..base
                    });
                    let _ = self.0.store.update(&state);
                    self.schedule_restart(plugin.name.clone(), service.id.clone(), state);
                }
            }
        }
    }

    pub async fn start(&self, plugin_id: &str, service_id: &str) -> Result<PluginServiceView> {
        validate_plugin_id(plugin_id, "pluginId")?;
        validate_plugin_id(service_id, "serviceId")?;
        let operation = self.operation(plugin_id, service_id).await;
        let _guard = operation.lock().await;
        self.start_unlocked(plugin_id, service_id, true).await
    }

    pub async fn stop(&self, plugin_id: &str, service_id: &str) -> Result<PluginServiceView> {
        validate_plugin_id(plugin_id, "pluginId")?;
        validate_plugin_id(service_id, "serviceId")?;
        let operation = self.operation(plugin_id, service_id).await;
        let _guard = operation.lock().await;
        self.stop_unlocked(plugin_id, service_id).await
    }

    pub async fn restart(&self, plugin_id: &str, service_id: &str) -> Result<PluginServiceView> {
        validate_plugin_id(plugin_id, "pluginId")?;
        validate_plugin_id(service_id, "serviceId")?;
        let operation = self.operation(plugin_id, service_id).await;
        let _guard = operation.lock().await;
        let key = plugin_service_key(plugin_id, service_id);
        let runtime = { self.0.running.lock().await.remove(&key) };
        if let Some(runtime) = runtime {
            runtime.stopping.store(true, Ordering::Release);
            kill_child(&runtime).await?;
        } else if let Some((_, service)) = self.find_service(plugin_id, service_id)?
            && let Some(pid) = self
                .0
                .store
                .get(plugin_id, service_id)?
                .and_then(|state| state.pid)
            && process_matches_service(Some(pid), &service)
        {
            kill_pid(pid)?;
        }
        self.start_unlocked(plugin_id, service_id, true).await
    }

    async fn operation(&self, plugin_id: &str, service_id: &str) -> Arc<Mutex<()>> {
        self.0
            .operations
            .lock()
            .await
            .entry(plugin_service_key(plugin_id, service_id))
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
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
            let operation = self.operation(plugin_id, service_id).await;
            let _guard = operation.lock().await;
            let current = self.status_for(&plugin, &service).await?;
            if !same_service_instance(&state, &current) {
                return Ok(view_for(&self.0.store, &plugin, &service, current));
            }
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
        let operation = self.operation(plugin_id, service_id).await;
        let _guard = operation.lock().await;
        let current = self.status_for(&plugin, &service).await?;
        if !same_service_instance(&state, &current) {
            return Ok(view_for(&self.0.store, &plugin, &service, current));
        }
        let next = match outcome {
            Ok(response) if response.status().is_success() => state_now(PluginServiceState {
                health: PluginServiceHealth::Healthy,
                health_checked_at: Some(checked),
                health_error: None,
                ..current
            }),
            Ok(response) => state_now(PluginServiceState {
                health: PluginServiceHealth::Unhealthy,
                health_checked_at: Some(checked),
                health_error: Some(format!("status {}", response.status().as_u16())),
                ..current
            }),
            Err(error) => state_now(PluginServiceState {
                health: PluginServiceHealth::Unhealthy,
                health_checked_at: Some(checked),
                health_error: Some(error.to_string()),
                ..current
            }),
        };
        self.0.store.update(&next)?;
        Ok(view_for(&self.0.store, &plugin, &service, next))
    }

    pub async fn stop_all(&self) {
        self.0.shutdown.store(true, Ordering::Release);
        let mut keys = self
            .0
            .running
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<HashSet<_>>();
        if let Ok(list) = self.list().await {
            for item in list.items {
                if item.configured
                    && item.status == PluginServiceStatus::Running
                    && item.pid.is_some()
                {
                    keys.insert(plugin_service_key(&item.plugin_id, &item.service_id));
                }
            }
        }
        futures_util::future::join_all(keys.into_iter().filter_map(|key| {
            let (plugin_id, service_id) = key.split_once('/')?;
            let supervisor = self.clone();
            let plugin_id = plugin_id.to_owned();
            let service_id = service_id.to_owned();
            Some(async move {
                let _ = supervisor.stop(&plugin_id, &service_id).await;
            })
        }))
        .await;
    }

    async fn start_unlocked(
        &self,
        plugin_id: &str,
        service_id: &str,
        reset_restart: bool,
    ) -> Result<PluginServiceView> {
        self.0.store.ensure()?;
        let (plugin, service) = self.require_service(plugin_id, service_id)?;
        let key = plugin_service_key(&plugin.name, &service.id);
        let current = { self.0.running.lock().await.get(&key).cloned() };
        if let Some(runtime) = current {
            let exit = runtime_exit(&runtime).await?;
            if runtime.service.config_key == service.config_key && exit.is_none() {
                let state = running_state_with_previous(
                    &plugin,
                    &service,
                    Some(runtime.pid().await),
                    runtime.port,
                    runtime.started_at,
                    self.0.store.get(&plugin.name, &service.id)?,
                );
                self.0.store.update(&state)?;
                return Ok(view_for(&self.0.store, &plugin, &service, state));
            }
            let removed = {
                let mut running = self.0.running.lock().await;
                if running
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(current, &runtime))
                {
                    running.remove(&key);
                    true
                } else {
                    false
                }
            };
            if removed && exit.is_none() {
                runtime.stopping.store(true, Ordering::Release);
                tokio::spawn(async move {
                    let _ = terminate_child(&runtime).await;
                });
            }
        }
        let existing = status_from_state(
            self.0.store.get(&plugin.name, &service.id)?,
            &plugin,
            &service,
        );
        let restart_count = if reset_restart {
            0
        } else {
            existing.restart_count
        };
        let restart_window_started_at = if reset_restart {
            None
        } else {
            existing.restart_window_started_at
        };
        if existing.status == PluginServiceStatus::Running
            && process_matches_service(existing.pid, &service)
            && let Some(pid) = existing.pid
        {
            kill_pid(pid)?;
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
            restart_count,
            next_restart_at: None,
            restart_window_started_at,
            config_key: service.config_key.clone(),
        }))?;
        let mut child = match self.spawn_child(&plugin, &service, port) {
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
                    restart_count,
                    next_restart_at: None,
                    restart_window_started_at,
                    config_key: service.config_key.clone(),
                });
                self.0.store.update(&state)?;
                return Err(error);
            }
        };
        let pid = child.id();
        let process_tree = match ProcessTree::new(&child) {
            Ok(process_tree) => process_tree,
            Err(error) => {
                let _ = child.kill();
                return Err(error);
            }
        };
        let runtime = Arc::new(Runtime {
            pid,
            child: Mutex::new(child),
            process_tree,
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
        let running = PluginServiceState {
            restart_count,
            restart_window_started_at,
            ..running
        };
        self.0.store.update(&running)?;
        self.watch_runtime_exit(key.clone(), runtime.clone());
        self.watch_stability(runtime.clone());
        if service.health_path.is_some() {
            self.watch_health(plugin.name.clone(), service.id.clone(), runtime.clone());
        }
        Ok(view_for(&self.0.store, &plugin, &service, running))
    }

    fn watch_stability(&self, runtime: Arc<Runtime>) {
        let supervisor = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(supervisor.0.policy.restart_window).await;
            if supervisor.0.shutdown.load(Ordering::Acquire)
                || runtime.stopping.load(Ordering::Acquire)
                || !supervisor
                    .runtime_is_current(&runtime.plugin.name, &runtime.service.id, &runtime)
                    .await
            {
                return;
            }
            let operation = supervisor
                .operation(&runtime.plugin.name, &runtime.service.id)
                .await;
            let _guard = operation.lock().await;
            let Ok(Some(current)) = supervisor
                .0
                .store
                .get(&runtime.plugin.name, &runtime.service.id)
            else {
                return;
            };
            if same_runtime(&current, &runtime) {
                let stable = state_now(PluginServiceState {
                    restart_count: 0,
                    next_restart_at: None,
                    restart_window_started_at: None,
                    ..current
                });
                let _ = supervisor.0.store.update(&stable);
            }
        });
    }

    fn watch_health(&self, plugin_id: String, service_id: String, runtime: Arc<Runtime>) {
        let supervisor = self.clone();
        tokio::spawn(async move {
            let mut failures = 0;
            loop {
                if supervisor.0.shutdown.load(Ordering::Acquire)
                    || runtime.stopping.load(Ordering::Acquire)
                    || !supervisor
                        .runtime_is_current(&plugin_id, &service_id, &runtime)
                        .await
                {
                    return;
                }
                match supervisor.check_health(&plugin_id, &service_id).await {
                    Ok(view) if view.health == PluginServiceHealth::Healthy => failures = 0,
                    Ok(view) if view.status != PluginServiceStatus::Running => return,
                    Ok(_) | Err(_) => failures += 1,
                }
                if failures >= supervisor.0.policy.health_failure_limit
                    && runtime.service.mode == PluginServiceMode::Auto
                {
                    supervisor.replace_unhealthy(runtime.clone()).await;
                    return;
                }
                tokio::time::sleep(supervisor.0.policy.health_interval).await;
            }
        });
    }

    async fn runtime_is_current(
        &self,
        plugin_id: &str,
        service_id: &str,
        runtime: &Arc<Runtime>,
    ) -> bool {
        self.0
            .running
            .lock()
            .await
            .get(&plugin_service_key(plugin_id, service_id))
            .is_some_and(|current| Arc::ptr_eq(current, runtime))
    }

    async fn replace_unhealthy(&self, runtime: Arc<Runtime>) {
        let operation = self
            .operation(&runtime.plugin.name, &runtime.service.id)
            .await;
        let _guard = operation.lock().await;
        if !self
            .runtime_is_current(&runtime.plugin.name, &runtime.service.id, &runtime)
            .await
        {
            return;
        }
        let _ = kill_child(&runtime).await;
    }

    fn watch_runtime_exit(&self, key: String, runtime: Arc<Runtime>) {
        let supervisor = self.clone();
        tokio::spawn(async move {
            let result = loop {
                match runtime_exit(&runtime).await {
                    Ok(Some(exit)) => break Ok(exit),
                    Ok(None) => tokio::time::sleep(Duration::from_millis(250)).await,
                    Err(error) => break Err(error),
                }
            };
            let operation = supervisor
                .operation(&runtime.plugin.name, &runtime.service.id)
                .await;
            let _guard = operation.lock().await;
            let mut running = supervisor.0.running.lock().await;
            if !running
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &runtime))
            {
                return;
            }
            running.remove(&key);
            drop(running);
            let previous = supervisor
                .0
                .store
                .get(&runtime.plugin.name, &runtime.service.id)
                .unwrap_or_default();
            let automatic = runtime.service.mode == PluginServiceMode::Auto
                && !supervisor.0.shutdown.load(Ordering::Acquire)
                && !runtime.stopping.load(Ordering::Acquire);
            let restart = if automatic {
                previous
                    .as_ref()
                    .map(|state| restart_schedule(state, &supervisor.0.policy))
                    .unwrap_or_else(|| {
                        restart_schedule(
                            &running_state(
                                &runtime.plugin,
                                &runtime.service,
                                None,
                                runtime.port,
                                runtime.started_at,
                            ),
                            &supervisor.0.policy,
                        )
                    })
            } else {
                (0, None, None)
            };
            let (status, last_exit, last_error) = match result {
                Ok(exit) => (
                    if runtime.stopping.load(Ordering::Acquire) && !automatic {
                        PluginServiceStatus::Stopped
                    } else {
                        PluginServiceStatus::Exited
                    },
                    Some(exit),
                    if runtime.stopping.load(Ordering::Acquire) && !automatic {
                        None
                    } else {
                        previous.as_ref().and_then(|state| state.last_error.clone())
                    },
                ),
                Err(error) => (PluginServiceStatus::Failed, None, Some(error.to_string())),
            };
            let state = state_now(PluginServiceState {
                plugin_id: runtime.plugin.name.clone(),
                service_id: runtime.service.id.clone(),
                mode: runtime.service.mode,
                status,
                pid: None,
                port: None,
                started_at: previous
                    .as_ref()
                    .and_then(|state| state.started_at)
                    .or(Some(runtime.started_at)),
                updated_at: 0,
                last_exit,
                last_error,
                health: PluginServiceHealth::Unknown,
                health_checked_at: None,
                health_error: None,
                restart_count: restart.0,
                next_restart_at: restart.1,
                restart_window_started_at: restart.2,
                config_key: runtime.service.config_key.clone(),
            });
            let _ = supervisor.0.store.update(&state);
            if automatic {
                supervisor.schedule_restart(
                    runtime.plugin.name.clone(),
                    runtime.service.id.clone(),
                    state,
                );
            }
        });
    }

    fn schedule_restart(&self, plugin_id: String, service_id: String, state: PluginServiceState) {
        let supervisor = self.clone();
        tokio::spawn(async move {
            let Some(next) = state.next_restart_at else {
                return;
            };
            tokio::time::sleep(Duration::from_millis(
                next.saturating_sub(now()).max(0) as u64
            ))
            .await;
            if supervisor.0.shutdown.load(Ordering::Acquire) {
                return;
            }
            let operation = supervisor.operation(&plugin_id, &service_id).await;
            let _guard = operation.lock().await;
            if supervisor.0.shutdown.load(Ordering::Acquire) {
                return;
            }
            let current = match supervisor.0.store.get(&plugin_id, &service_id) {
                Ok(Some(current)) => current,
                _ => return,
            };
            if current.mode != PluginServiceMode::Auto
                || current.status != PluginServiceStatus::Exited
                || current.next_restart_at != Some(next)
            {
                return;
            }
            if let Err(error) = supervisor
                .start_unlocked(&plugin_id, &service_id, false)
                .await
            {
                let restart = restart_schedule(&current, &supervisor.0.policy);
                let failed = state_now(PluginServiceState {
                    status: PluginServiceStatus::Exited,
                    last_error: Some(error.to_string()),
                    restart_count: restart.0,
                    next_restart_at: restart.1,
                    restart_window_started_at: restart.2,
                    ..current
                });
                let _ = supervisor.0.store.update(&failed);
                supervisor.schedule_restart(plugin_id, service_id, failed);
            }
        });
    }

    async fn stop_unlocked(&self, plugin_id: &str, service_id: &str) -> Result<PluginServiceView> {
        let key = plugin_service_key(plugin_id, service_id);
        let runtime = { self.0.running.lock().await.remove(&key) };
        if let Some(runtime) = runtime {
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
            terminate_tree(pid)?;
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
            restart_count: 0,
            next_restart_at: None,
            restart_window_started_at: None,
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
            restart_count: 0,
            next_restart_at: None,
            restart_window_started_at: None,
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
        let current = { self.0.running.lock().await.get(&key).cloned() };
        if let Some(runtime) =
            current.filter(|runtime| runtime.service.config_key == service.config_key)
        {
            let state = running_state_with_previous(
                plugin,
                service,
                Some(runtime.pid().await),
                runtime.port,
                runtime.started_at,
                self.0.store.get(&plugin.name, &service.id)?,
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
        #[cfg(unix)]
        unsafe {
            use std::os::unix::process::CommandExt;
            child.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            child.creation_flags(0x08000000 | 0x00000200);
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
        self.pid
    }
}

#[cfg(unix)]
impl ProcessTree {
    fn new(child: &Child) -> Result<Self> {
        Ok(Self {
            group: child.id() as i32,
        })
    }

    fn signal(&self, signal: i32) -> Result<()> {
        let result = unsafe { libc::kill(-self.group, signal) };
        if result != 0 && std::io::Error::last_os_error().kind() != ErrorKind::NotFound {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl ProcessTree {
    fn new(child: &Child) -> Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() || job == INVALID_HANDLE_VALUE {
                return Err(std::io::Error::last_os_error().into());
            }
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                CloseHandle(job);
                return Err(std::io::Error::last_os_error().into());
            }
            let assigned = AssignProcessToJobObject(job, child.as_raw_handle() as _);
            if assigned == 0 {
                CloseHandle(job);
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(Self { job: job as isize })
        }
    }

    fn terminate(&self) -> Result<()> {
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if unsafe { TerminateJobObject(self.job as HANDLE, 1) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(
                self.job as windows_sys::Win32::Foundation::HANDLE,
            );
        }
    }
}

impl PluginServiceStore {
    fn new(home: &Path) -> Self {
        let root = home.join("plugin-services");
        Self {
            logs_root: root.join("logs"),
            state_file: root.join("state.json"),
            root,
            lock: Arc::new(std::sync::Mutex::new(())),
        }
    }

    fn ensure(&self) -> Result<()> {
        private_dir(&self.root)?;
        private_dir(&self.logs_root)
    }

    fn list(&self) -> Result<Vec<PluginServiceState>> {
        let _guard = self.lock.lock().map_err(|_| Error::Closed)?;
        Ok(read_state(&self.state_file)?.items.into_values().collect())
    }

    fn get(&self, plugin_id: &str, service_id: &str) -> Result<Option<PluginServiceState>> {
        let _guard = self.lock.lock().map_err(|_| Error::Closed)?;
        Ok(read_state(&self.state_file)?
            .items
            .remove(&plugin_service_key(plugin_id, service_id)))
    }

    fn update(&self, state: &PluginServiceState) -> Result<()> {
        let _guard = self.lock.lock().map_err(|_| Error::Closed)?;
        self.ensure()?;
        let mut file = read_state(&self.state_file)?;
        file.items.insert(
            plugin_service_key(&state.plugin_id, &state.service_id),
            state.clone(),
        );
        write_private_json(&self.state_file, &file)
    }

    // A list request reconciles changed rows in one transaction-like file update.
    // Do not overwrite health/restart changes made after the list snapshot.
    fn update_observed(
        &self,
        updates: Vec<(Option<PluginServiceState>, PluginServiceState)>,
    ) -> Result<()> {
        if updates.is_empty() {
            return Ok(());
        }
        let _guard = self.lock.lock().map_err(|_| Error::Closed)?;
        let mut file = read_state(&self.state_file)?;
        let mut changed = false;
        for (previous, state) in updates {
            let key = plugin_service_key(&state.plugin_id, &state.service_id);
            if file.items.get(&key) == previous.as_ref() {
                file.items.insert(key, state);
                changed = true;
            }
        }
        if changed {
            write_private_json(&self.state_file, &file)?;
        }
        Ok(())
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

fn read_state(path: &Path) -> Result<StateFile> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(StateFile::default()),
        Err(error) => return Err(error.into()),
    };
    match serde_json::from_slice(&raw) {
        Ok(state) => Ok(state),
        Err(_) => {
            let repaired = raw
                .strip_suffix(b"\\n")
                .ok_or_else(|| Error::Invalid("plugin service state is invalid".into()))?;
            serde_json::from_slice(repaired)
                .map_err(|_| Error::Invalid("plugin service state is invalid".into()))
        }
    }
}

fn write_private_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::Invalid("invalid state path".into()))?;
    private_dir(parent)?;
    let tmp = path.with_file_name(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec_pretty(value)?;
    fs::write(&tmp, [bytes, b"\n".to_vec()].concat())?;
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

fn restart_schedule(
    state: &PluginServiceState,
    policy: &SupervisorPolicy,
) -> (u32, Option<i64>, Option<i64>) {
    let current = now();
    let window_ms = policy.restart_window.as_millis() as i64;
    let active_window = state
        .restart_window_started_at
        .is_some_and(|started| current.saturating_sub(started) <= window_ms);
    let window = if active_window {
        state.restart_window_started_at.unwrap_or(current)
    } else {
        current
    };
    let count = if active_window {
        state.restart_count.saturating_add(1)
    } else {
        1
    };
    if count > policy.restart_limit {
        return (count, None, Some(window));
    }
    let delay = policy
        .restart_delays
        .get(count.saturating_sub(1) as usize)
        .copied()
        .unwrap_or_else(|| *policy.restart_delays.last().unwrap());
    (
        count,
        Some(current.saturating_add(delay.as_millis() as i64)),
        Some(window),
    )
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
        restart_count: 0,
        next_restart_at: None,
        restart_window_started_at: None,
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
        restart_count: 0,
        next_restart_at: None,
        restart_window_started_at: None,
        config_key: service.config_key.clone(),
    })
}

fn running_state_with_previous(
    plugin: &ProsperoPluginManifest,
    service: &PluginServiceManifest,
    pid: Option<u32>,
    port: u16,
    started_at: i64,
    previous: Option<PluginServiceState>,
) -> PluginServiceState {
    let mut state = running_state(plugin, service, pid, port, started_at);
    if let Some(previous) = previous.filter(|previous| {
        previous.config_key == service.config_key
            && previous.pid == pid
            && previous.started_at == Some(started_at)
    }) {
        state.health = previous.health;
        state.health_checked_at = previous.health_checked_at;
        state.health_error = previous.health_error;
        state.restart_count = previous.restart_count;
        state.next_restart_at = previous.next_restart_at;
        state.restart_window_started_at = previous.restart_window_started_at;
    }
    state
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

fn same_service_instance(left: &PluginServiceState, right: &PluginServiceState) -> bool {
    left.config_key == right.config_key
        && left.pid == right.pid
        && left.port == right.port
        && left.started_at == right.started_at
}

fn same_runtime(state: &PluginServiceState, runtime: &Runtime) -> bool {
    state.config_key == runtime.service.config_key
        && state.port == Some(runtime.port)
        && state.started_at == Some(runtime.started_at)
        && state.status == PluginServiceStatus::Running
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
        restart_count: state.restart_count,
        next_restart_at: state.next_restart_at,
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
        restart_count: state.restart_count,
        next_restart_at: state.next_restart_at,
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
    #[cfg(unix)]
    runtime.process_tree.signal(libc::SIGTERM)?;
    #[cfg(not(unix))]
    runtime.process_tree.terminate()?;
    if let Some(exit) = wait_child(runtime, Duration::from_secs(5)).await? {
        return Ok(Some(exit));
    }
    #[cfg(unix)]
    runtime.process_tree.signal(libc::SIGKILL)?;
    #[cfg(not(unix))]
    runtime.process_tree.terminate()?;
    wait_child(runtime, Duration::from_secs(3)).await
}

async fn kill_child(runtime: &Runtime) -> Result<()> {
    #[cfg(unix)]
    {
        runtime.process_tree.signal(libc::SIGKILL)
    }
    #[cfg(not(unix))]
    {
        runtime.process_tree.terminate()
    }
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

fn terminate_tree(pid: u32) -> Result<()> {
    #[cfg(unix)]
    {
        signal_tree(pid, libc::SIGTERM)
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()?;
        Ok(())
    }
}

fn kill_pid(pid: u32) -> Result<()> {
    #[cfg(unix)]
    {
        signal_tree(pid, libc::SIGKILL)
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()?;
        Ok(())
    }
}

#[cfg(unix)]
fn signal_tree(pid: u32, signal: i32) -> Result<()> {
    let group = unsafe { libc::kill(-(pid as i32), signal) };
    if group == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() != Some(libc::ESRCH) {
        return Err(error.into());
    }
    let process = unsafe { libc::kill(pid as i32, signal) };
    if process != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn service_mode(
        id: &str,
        mode: PluginServiceMode,
        command: Vec<String>,
        health_path: Option<&str>,
    ) -> JsonValue {
        let mut value = json!({
            "id": id,
            "mode": mode,
            "command": command,
            "cwd": "runtime",
            "port_env": "PORT",
        });
        if let Some(path) = health_path {
            value["health_path"] = json!(path);
        }
        value
    }

    fn service(id: &str, command: Vec<String>, health_path: Option<&str>) -> JsonValue {
        service_mode(id, PluginServiceMode::Manual, command, health_path)
    }

    fn policy() -> SupervisorPolicy {
        SupervisorPolicy {
            health_interval: Duration::from_millis(25),
            health_failure_limit: 2,
            restart_window: Duration::from_secs(5),
            restart_limit: 3,
            restart_delays: [
                Duration::from_millis(25),
                Duration::from_millis(50),
                Duration::from_millis(100),
            ]
            .into(),
        }
    }

    fn plugin(home: &Path, services: Vec<JsonValue>) -> PathBuf {
        let root = home.join("plugins/test-plugin");
        fs::create_dir_all(root.join("runtime")).unwrap();
        fs::write(
            root.join("prospero-plugin.json"),
            serde_json::to_vec(&json!({
                "schema_version": "prospero-plugin/v1",
                "name": "test-plugin",
                "services": services,
            }))
            .unwrap(),
        )
        .unwrap();
        root
    }

    fn script(root: &Path, name: &str, body: &str) -> String {
        let path = root.join("runtime").join(name);
        fs::write(&path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path.to_string_lossy().into_owned()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listing_unchanged_services_does_not_rewrite_state() {
        use std::os::unix::fs::MetadataExt;
        let directory = TempDir::new().unwrap();
        let root = plugin(directory.path(), Vec::new());
        let command = script(&root, "fixture.sh", "#!/bin/sh\nexit 0\n");
        plugin(
            directory.path(),
            (0..8)
                .map(|i| service(&format!("service-{i}"), vec![command.clone()], None))
                .collect(),
        );
        let supervisor = PluginServiceSupervisor::new(directory.path());
        let discovered = discover_prospero_plugins(directory.path());
        let manifest = &discovered.plugins[0];
        for service in &manifest.services {
            let mut state = stopped_state(manifest, service);
            state.status = PluginServiceStatus::Exited;
            state.updated_at = 123;
            supervisor.0.store.update(&state).unwrap();
        }
        let path = &supervisor.0.store.state_file;
        let before = fs::metadata(path).unwrap();
        assert_eq!(supervisor.list().await.unwrap().items.len(), 8);
        assert_eq!(supervisor.list().await.unwrap().items.len(), 8);
        let after = fs::metadata(path).unwrap();
        assert_eq!(before.ino(), after.ino());
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());
    }

    #[test]
    fn batched_list_reconciliation_preserves_concurrent_health_changes() {
        let directory = TempDir::new().unwrap();
        let root = plugin(directory.path(), Vec::new());
        let command = script(&root, "fixture.sh", "#!/bin/sh\nexit 0\n");
        plugin(
            directory.path(),
            vec![service("worker", vec![command], None)],
        );
        let discovered = discover_prospero_plugins(directory.path());
        let manifest = &discovered.plugins[0];
        let store = PluginServiceStore::new(directory.path());
        let before = stopped_state(manifest, &manifest.services[0]);
        store.update(&before).unwrap();
        let mut newer = before.clone();
        newer.health_checked_at = Some(1234);
        newer.updated_at += 1;
        store.update(&newer).unwrap();
        let mut stale = before.clone();
        stale.status = PluginServiceStatus::Exited;
        store.update_observed(vec![(Some(before), stale)]).unwrap();
        assert_eq!(store.get("test-plugin", "worker").unwrap().unwrap(), newer);
    }

    #[test]
    fn state_store_repairs_legacy_suffix_and_preserves_all_services() {
        let directory = TempDir::new().unwrap();
        let store = PluginServiceStore::new(directory.path());
        let first = PluginServiceState {
            plugin_id: "test-plugin".into(),
            service_id: "first".into(),
            mode: PluginServiceMode::Manual,
            status: PluginServiceStatus::Running,
            pid: Some(101),
            port: Some(4101),
            started_at: Some(1),
            updated_at: 1,
            last_exit: None,
            last_error: None,
            health: PluginServiceHealth::Unknown,
            health_checked_at: None,
            health_error: None,
            restart_count: 0,
            next_restart_at: None,
            restart_window_started_at: None,
            config_key: "first".into(),
        };
        let mut file = StateFile::default();
        file.items
            .insert(plugin_service_key("test-plugin", "first"), first);
        fs::create_dir_all(store.state_file.parent().unwrap()).unwrap();
        let mut bytes = serde_json::to_vec_pretty(&file).unwrap();
        bytes.extend_from_slice(b"\\n");
        fs::write(&store.state_file, bytes).unwrap();
        let second = PluginServiceState {
            plugin_id: "test-plugin".into(),
            service_id: "second".into(),
            mode: PluginServiceMode::Manual,
            status: PluginServiceStatus::Stopped,
            pid: None,
            port: None,
            started_at: None,
            updated_at: 2,
            last_exit: None,
            last_error: None,
            health: PluginServiceHealth::Unknown,
            health_checked_at: None,
            health_error: None,
            restart_count: 0,
            next_restart_at: None,
            restart_window_started_at: None,
            config_key: "second".into(),
        };
        store.update(&second).unwrap();
        let parsed: StateFile =
            serde_json::from_slice(&fs::read(&store.state_file).unwrap()).unwrap();
        assert_eq!(parsed.items.len(), 2);
        assert_eq!(fs::read(&store.state_file).unwrap().last(), Some(&b'\n'));
    }

    #[test]
    fn invalid_state_is_not_silently_replaced() {
        let directory = TempDir::new().unwrap();
        let store = PluginServiceStore::new(directory.path());
        fs::create_dir_all(store.state_file.parent().unwrap()).unwrap();
        fs::write(&store.state_file, b"{broken").unwrap();
        let state = stopped_state(
            &ProsperoPluginManifest {
                schema_version: "prospero-plugin/v1".into(),
                name: "test-plugin".into(),
                version: None,
                root: directory.path().to_string_lossy().into_owned(),
                manifest_path: String::new(),
                skills_root: None,
                agents_root: None,
                runtime_root: None,
                bootstrap: None,
                services: Vec::new(),
            },
            &PluginServiceManifest {
                id: "first".into(),
                mode: PluginServiceMode::Manual,
                command: vec!["true".into()],
                cwd: directory.path().to_string_lossy().into_owned(),
                env: BTreeMap::new(),
                port_env: "PORT".into(),
                health_path: None,
                config_key: "first".into(),
            },
        );
        assert!(store.update(&state).is_err());
        assert_eq!(fs::read(&store.state_file).unwrap(), b"{broken");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn start_returns_after_spawn_without_waiting_for_health() {
        let directory = TempDir::new().unwrap();
        let root = plugin(directory.path(), Vec::new());
        let command = script(&root, "service.sh", "#!/bin/sh\nsleep 30\n");
        let services = vec![service("slow-health", vec![command], Some("/health"))];
        plugin(directory.path(), services);
        let supervisor = PluginServiceSupervisor::new(directory.path());
        let started = tokio::time::timeout(
            Duration::from_secs(1),
            supervisor.start("test-plugin", "slow-health"),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(started.status, PluginServiceStatus::Running);
        assert_eq!(started.health, PluginServiceHealth::Unknown);
        supervisor.stop_all().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exited_service_can_restart_after_supervisor_recreation() {
        let directory = TempDir::new().unwrap();
        let root = plugin(directory.path(), Vec::new());
        let command = script(&root, "service.sh", "#!/bin/sh\nsleep 30\n");
        let services = vec![service("worker", vec![command], None)];
        plugin(directory.path(), services);
        let supervisor = PluginServiceSupervisor::new(directory.path());
        let first = supervisor.start("test-plugin", "worker").await.unwrap();
        let first_pid = first.pid.unwrap();
        unsafe {
            libc::kill(first_pid as i32, libc::SIGKILL);
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            let state = supervisor.list().await.unwrap().items.remove(0);
            if state.status == PluginServiceStatus::Exited {
                break;
            }
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        drop(supervisor);
        let replacement = PluginServiceSupervisor::new(directory.path());
        let second = replacement.start("test-plugin", "worker").await.unwrap();
        assert_eq!(second.status, PluginServiceStatus::Running);
        assert_ne!(second.pid, Some(first_pid));
        tokio::time::sleep(Duration::from_millis(400)).await;
        let current = replacement.list().await.unwrap().items.remove(0);
        assert_eq!(current.status, PluginServiceStatus::Running);
        assert_eq!(current.pid, second.pid);
        replacement.stop_all().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restart_spawns_replacement_before_old_exit_completes() {
        let directory = TempDir::new().unwrap();
        let root = plugin(directory.path(), Vec::new());
        let command = script(
            &root,
            "service.sh",
            "#!/bin/sh\ntrap 'sleep 2; exit 0' TERM\nsleep 30\n",
        );
        let services = vec![service("worker", vec![command], None)];
        plugin(directory.path(), services);
        let supervisor = PluginServiceSupervisor::new(directory.path());
        let first = supervisor.start("test-plugin", "worker").await.unwrap();
        let restarted = tokio::time::timeout(
            Duration::from_secs(1),
            supervisor.restart("test-plugin", "worker"),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(restarted.status, PluginServiceStatus::Running);
        assert_ne!(restarted.pid, first.pid);
        tokio::time::sleep(Duration::from_millis(400)).await;
        let current = supervisor.list().await.unwrap().items.remove(0);
        assert_eq!(current.status, PluginServiceStatus::Running);
        assert_eq!(current.pid, restarted.pid);
        supervisor.stop_all().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn slow_stop_does_not_block_another_service_start() {
        let directory = TempDir::new().unwrap();
        let root = plugin(directory.path(), Vec::new());
        let slow = script(
            &root,
            "slow.sh",
            "#!/bin/sh\ntrap '' TERM\ntouch ready\nwhile :; do sleep 1; done\n",
        );
        let fast = script(&root, "fast.sh", "#!/bin/sh\nsleep 30\n");
        plugin(
            directory.path(),
            vec![
                service("slow", vec![slow], None),
                service("fast", vec![fast], None),
            ],
        );
        let supervisor = PluginServiceSupervisor::new(directory.path());
        supervisor.start("test-plugin", "slow").await.unwrap();
        let ready = root.join("runtime/ready");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while !ready.exists() {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let stopping = tokio::spawn({
            let supervisor = supervisor.clone();
            async move { supervisor.stop("test-plugin", "slow").await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let started = tokio::time::timeout(
            Duration::from_secs(4),
            supervisor.start("test-plugin", "fast"),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(started.status, PluginServiceStatus::Running);
        assert!(!stopping.is_finished());
        stopping.await.unwrap().unwrap();
        supervisor.stop_all().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stale_list_snapshot_cannot_resurrect_stopped_generation() {
        let directory = TempDir::new().unwrap();
        let root = plugin(directory.path(), Vec::new());
        let command = script(&root, "service.sh", "#!/bin/sh\nsleep 30\n");
        plugin(
            directory.path(),
            vec![service_mode(
                "worker",
                PluginServiceMode::Manual,
                vec![command],
                None,
            )],
        );
        let supervisor =
            PluginServiceSupervisor::with_policy(directory.path().to_path_buf(), policy());
        supervisor.start("test-plugin", "worker").await.unwrap();
        let stale = supervisor.0.running.lock().await.clone();
        supervisor.stop("test-plugin", "worker").await.unwrap();
        let listed = supervisor.list_snapshot(stale).unwrap();
        assert_eq!(listed.items[0].status, PluginServiceStatus::Stopped);
        assert_eq!(
            supervisor
                .0
                .store
                .get("test-plugin", "worker")
                .unwrap()
                .unwrap()
                .status,
            PluginServiceStatus::Stopped
        );
        supervisor.stop_all().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn auto_service_respawns_with_persisted_backoff() {
        let directory = TempDir::new().unwrap();
        let root = plugin(directory.path(), Vec::new());
        let command = script(&root, "service.sh", "#!/bin/sh\nsleep 30\n");
        plugin(
            directory.path(),
            vec![service_mode(
                "worker",
                PluginServiceMode::Auto,
                vec![command],
                None,
            )],
        );
        let supervisor =
            PluginServiceSupervisor::with_policy(directory.path().to_path_buf(), policy());
        let first = supervisor.start("test-plugin", "worker").await.unwrap();
        unsafe {
            libc::kill(first.pid.unwrap() as i32, libc::SIGKILL);
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let second = loop {
            let current = supervisor.list().await.unwrap().items.remove(0);
            if current.status == PluginServiceStatus::Running && current.pid != first.pid {
                break current;
            }
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        assert_eq!(second.restart_count, 1);
        assert_eq!(second.next_restart_at, None);
        let persisted = supervisor
            .0
            .store
            .get("test-plugin", "worker")
            .unwrap()
            .unwrap();
        assert_eq!(persisted.restart_count, 1);
        supervisor.stop_all().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn auto_restart_backoff_is_bounded() {
        let directory = TempDir::new().unwrap();
        let root = plugin(directory.path(), Vec::new());
        let command = script(&root, "service.sh", "#!/bin/sh\nexit 1\n");
        plugin(
            directory.path(),
            vec![service_mode(
                "worker",
                PluginServiceMode::Auto,
                vec![command],
                None,
            )],
        );
        let supervisor =
            PluginServiceSupervisor::with_policy(directory.path().to_path_buf(), policy());
        supervisor.start("test-plugin", "worker").await.unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            let state = supervisor
                .0
                .store
                .get("test-plugin", "worker")
                .unwrap()
                .unwrap();
            if state.restart_count > supervisor.0.policy.restart_limit {
                assert_eq!(state.status, PluginServiceStatus::Exited);
                assert_eq!(state.next_restart_at, None);
                break;
            }
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        supervisor.stop_all().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn manual_service_does_not_auto_respawn() {
        let directory = TempDir::new().unwrap();
        let root = plugin(directory.path(), Vec::new());
        let command = script(&root, "service.sh", "#!/bin/sh\nsleep 30\n");
        plugin(
            directory.path(),
            vec![service("worker", vec![command], None)],
        );
        let supervisor =
            PluginServiceSupervisor::with_policy(directory.path().to_path_buf(), policy());
        let first = supervisor.start("test-plugin", "worker").await.unwrap();
        unsafe {
            libc::kill(first.pid.unwrap() as i32, libc::SIGKILL);
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        let current = supervisor.list().await.unwrap().items.remove(0);
        assert_eq!(current.status, PluginServiceStatus::Exited);
        assert_eq!(current.pid, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn health_failures_restart_only_auto_services() {
        let directory = TempDir::new().unwrap();
        let root = plugin(directory.path(), Vec::new());
        let command = script(&root, "service.sh", "#!/bin/sh\nsleep 30\n");
        plugin(
            directory.path(),
            vec![service_mode(
                "worker",
                PluginServiceMode::Auto,
                vec![command],
                Some("/health"),
            )],
        );
        let supervisor =
            PluginServiceSupervisor::with_policy(directory.path().to_path_buf(), policy());
        let first = supervisor.start("test-plugin", "worker").await.unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            let current = supervisor.list().await.unwrap().items.remove(0);
            if current.status == PluginServiceStatus::Running && current.pid != first.pid {
                assert_eq!(current.restart_count, 1);
                break;
            }
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        supervisor.stop_all().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_terminates_the_complete_process_group() {
        let directory = TempDir::new().unwrap();
        let root = plugin(directory.path(), Vec::new());
        let command = script(
            &root,
            "service.sh",
            "#!/bin/sh\nsleep 30 & echo $! > grandchild.pid\nwait\n",
        );
        plugin(
            directory.path(),
            vec![service("worker", vec![command], None)],
        );
        let supervisor = PluginServiceSupervisor::new(directory.path());
        supervisor.start("test-plugin", "worker").await.unwrap();
        let pid_file = root.join("runtime/grandchild.pid");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while !pid_file.exists() {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let grandchild = fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        supervisor.stop("test-plugin", "worker").await.unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while process_alive(Some(grandchild)) {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
