use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use prospero_client::{Client, default_daemon_home};

const LABEL: &str = "ai.prospero.daemon.rust";

pub enum CommandKind {
    Install,
    Uninstall,
    Start,
    Status,
}

pub fn requested_command() -> Option<CommandKind> {
    std::env::args().find_map(|argument| match argument.as_str() {
        "--service-install" => Some(CommandKind::Install),
        "--service-uninstall" => Some(CommandKind::Uninstall),
        "--service-start" => Some(CommandKind::Start),
        "--service-status" => Some(CommandKind::Status),
        _ => None,
    })
}

pub fn run(command: CommandKind) -> Result<String, String> {
    match command {
        CommandKind::Install => {
            let output = install()?;
            wait_for_ready_blocking()?;
            Ok(output)
        }
        CommandKind::Uninstall => uninstall(),
        CommandKind::Start => {
            let output = start()?;
            wait_for_ready_blocking()?;
            Ok(output)
        }
        CommandKind::Status => status(),
    }
}

pub async fn attach_or_start() -> Result<Client, String> {
    let home = default_daemon_home();
    if let Ok(client) = healthy_client(&home).await {
        return Ok(client);
    }
    start()?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(client) = healthy_client(&home).await {
            return Ok(client);
        }
        if Instant::now() >= deadline {
            return Err("Rust daemon service did not become ready".into());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

pub async fn diagnostics() -> Result<String, String> {
    tokio::task::spawn_blocking(diagnostics_sync)
        .await
        .map_err(|error| error.to_string())?
}

fn diagnostics_sync() -> Result<String, String> {
    let status = status().unwrap_or_else(|error| error);
    let logs = platform_logs().unwrap_or_default();
    Ok(redact(&format!(
        "Service status\n{status}\n\nRecent logs\n{logs}"
    )))
}

#[cfg(target_os = "macos")]
fn platform_logs() -> Result<String, String> {
    let root = user_home()?.join("Library/Logs/Prospero");
    Ok(format!(
        "stdout\n{}\n\nstderr\n{}",
        tail(&root.join("prosperod-rs.out.log"), 64 * 1024),
        tail(&root.join("prosperod-rs.err.log"), 64 * 1024)
    ))
}

#[cfg(target_os = "linux")]
fn platform_logs() -> Result<String, String> {
    run_program(
        "journalctl",
        &[
            "--user",
            "-u",
            &format!("{LABEL}.service"),
            "-n",
            "300",
            "--no-pager",
        ],
    )
}

#[cfg(target_os = "windows")]
fn platform_logs() -> Result<String, String> {
    status()
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn platform_logs() -> Result<String, String> {
    Ok(String::new())
}

#[cfg(target_os = "macos")]
fn tail(path: &Path, limit: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let length = file.metadata().map(|value| value.len()).unwrap_or_default();
    let start = length.saturating_sub(limit);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    if file.take(limit).read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn redact(value: &str) -> String {
    value
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if [
                "authorization",
                "api_key",
                "apikey",
                "host_secret",
                "hostsecret",
            ]
            .iter()
            .any(|marker| lower.contains(marker))
            {
                "[redacted sensitive log line]".to_owned()
            } else if let Some(index) = lower.find("bearer ") {
                format!("{}Bearer [redacted]", &line[..index])
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn healthy_client(home: &Path) -> Result<Client, String> {
    let client = Client::from_home(home).map_err(|error| error.to_string())?;
    let health = client.health().await.map_err(|error| error.to_string())?;
    if health.api_version != prospero_protocol_rs::API_VERSION || health.backend != "rust" {
        return Err("Rust daemon API version mismatch".into());
    }
    Ok(client)
}

fn wait_for_ready_blocking() -> Result<(), String> {
    let home = default_daemon_home();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if runtime.block_on(healthy_client(&home)).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("Rust daemon service did not become ready".into());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn service_environment(daemon: &Path, data: &Path, home: &Path) -> Vec<(String, String)> {
    let mut environment = vec![
        ("HOME".into(), home.display().to_string()),
        ("PATH".into(), service_path(daemon, home)),
        ("PROSPERO_HOME".into(), data.display().to_string()),
        (
            "PROSPERO_LEGACY_HOME".into(),
            home.join(".prospero").display().to_string(),
        ),
    ];
    let node = home.join(".local/share/bytedcli/node/bin/node");
    if is_executable(&node) {
        environment.push(("PROSPERO_NODE".into(), node.display().to_string()));
    }
    environment
}

fn service_path(daemon: &Path, home: &Path) -> String {
    let mut entries = Vec::new();
    if let Some(directory) = daemon.parent() {
        push_path(&mut entries, directory.to_path_buf());
    }
    for path in [
        home.join(".local/bin"),
        home.join(".cargo/bin"),
        home.join(".local/share/bytedcli/node/bin"),
        home.join(".grok/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ] {
        push_path(&mut entries, path);
    }
    if let Some(path) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&path) {
            push_path(&mut entries, entry);
        }
    }
    std::env::join_paths(entries)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into())
}

fn push_path(entries: &mut Vec<PathBuf>, path: PathBuf) {
    if path.as_os_str().is_empty() || entries.iter().any(|entry| entry == &path) {
        return;
    }
    entries.push(path);
}

fn daemon_binary() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("PROSPERO_RUST_BINARY").map(PathBuf::from) {
        return executable(path);
    }
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let directory = current
        .parent()
        .ok_or_else(|| "native desktop executable has no parent directory".to_owned())?;
    #[cfg(target_os = "macos")]
    let candidates = [
        directory
            .parent()
            .map(|contents| contents.join("Resources/runtime/prosperod-rs")),
        Some(directory.join("prosperod-rs")),
    ];
    #[cfg(target_os = "linux")]
    let candidates = [Some(directory.join("prosperod-rs")), None];
    #[cfg(target_os = "windows")]
    let candidates = [Some(directory.join("prosperod-rs.exe")), None];
    candidates
        .into_iter()
        .flatten()
        .find(|path| is_executable(path))
        .ok_or_else(|| "installed Rust daemon binary is missing".into())
}

fn executable(path: PathBuf) -> Result<PathBuf, String> {
    if is_executable(&path) {
        Ok(path)
    } else {
        Err(format!(
            "Rust daemon binary is not executable: {}",
            path.display()
        ))
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(target_os = "macos")]
fn install() -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;
    let daemon = daemon_binary()?;
    let data = default_daemon_home();
    let user_home = user_home()?;
    let agents = user_home.join("Library/LaunchAgents");
    let logs = user_home.join("Library/Logs/Prospero");
    let plist = agents.join(format!("{LABEL}.plist"));
    fs::create_dir_all(&agents).map_err(|error| error.to_string())?;
    fs::create_dir_all(&data).map_err(|error| error.to_string())?;
    fs::create_dir_all(&logs).map_err(|error| error.to_string())?;
    let body = launchd_plist(&daemon, &data, &user_home, &logs);
    let temporary = agents.join(format!(".{LABEL}.{}.tmp", std::process::id()));
    fs::write(&temporary, body).map_err(|error| error.to_string())?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    fs::rename(&temporary, &plist).map_err(|error| error.to_string())?;
    let service = format!("user/{}/{LABEL}", unsafe { libc::getuid() });
    let domain = format!("user/{}", unsafe { libc::getuid() });
    launchctl_bootout_and_wait(&service);
    launchctl_bootstrap(
        &domain,
        &service,
        plist
            .to_str()
            .ok_or_else(|| "service path is not UTF-8".to_owned())?,
    )?;
    run_program("launchctl", &["enable", &service])?;
    run_program("launchctl", &["kickstart", "-k", &service])?;
    Ok(format!("installed {service}"))
}

#[cfg(target_os = "macos")]
fn uninstall() -> Result<String, String> {
    let user_home = user_home()?;
    let plist = user_home.join(format!("Library/LaunchAgents/{LABEL}.plist"));
    let service = format!("user/{}/{LABEL}", unsafe { libc::getuid() });
    let _ = run_program("launchctl", &["bootout", &service]);
    if plist.exists() {
        fs::remove_file(&plist).map_err(|error| error.to_string())?;
    }
    Ok(format!("uninstalled {service}"))
}

#[cfg(target_os = "macos")]
fn start() -> Result<String, String> {
    let service = format!("user/{}/{LABEL}", unsafe { libc::getuid() });
    if run_program("launchctl", &["kickstart", &service]).is_err() {
        return install();
    }
    Ok(format!("started {service}"))
}

#[cfg(target_os = "macos")]
fn status() -> Result<String, String> {
    let service = format!("user/{}/{LABEL}", unsafe { libc::getuid() });
    run_program("launchctl", &["print", &service])
}

#[cfg(target_os = "macos")]
fn launchctl_bootout_and_wait(service: &str) {
    let _ = run_program("launchctl", &["bootout", service]);
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        if run_program("launchctl", &["print", service]).is_err() {
            return;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

#[cfg(target_os = "macos")]
fn launchctl_bootstrap(domain: &str, service: &str, plist: &str) -> Result<String, String> {
    let mut last = String::new();
    for attempt in 0..8 {
        launchctl_bootout_and_wait(service);
        std::thread::sleep(Duration::from_millis(250 * (attempt + 1)));
        match run_program("launchctl", &["bootstrap", domain, plist]) {
            Ok(output) => return Ok(output),
            Err(error) => {
                last = error;
            }
        }
    }
    Err(last)
}

#[cfg(target_os = "macos")]
fn launchd_plist(daemon: &Path, data: &Path, home: &Path, logs: &Path) -> String {
    let environment = launchd_environment(&service_environment(daemon, data, home));
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>{LABEL}</string>\n<key>ProgramArguments</key><array><string>{}</string><string>start</string><string>--home</string><string>{}</string></array>\n<key>EnvironmentVariables</key><dict>{}</dict>\n<key>WorkingDirectory</key><string>{}</string>\n<key>LimitLoadToSessionType</key><string>Background</string>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>\n<key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string><key>Umask</key><integer>63</integer>\n</dict></plist>\n",
        xml(&daemon.display().to_string()),
        xml(&data.display().to_string()),
        environment,
        xml(&home.display().to_string()),
        xml(&logs.join("prosperod-rs.out.log").display().to_string()),
        xml(&logs.join("prosperod-rs.err.log").display().to_string()),
    )
}

#[cfg(target_os = "linux")]
fn install() -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;
    let daemon = daemon_binary()?;
    let data = default_daemon_home();
    let user_home = user_home()?;
    let unit_dir = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home.join(".config"))
        .join("systemd/user");
    let unit = unit_dir.join(format!("{LABEL}.service"));
    fs::create_dir_all(&unit_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&data).map_err(|error| error.to_string())?;
    let environment = systemd_environment(&service_environment(&daemon, &data, &user_home));
    let body = format!(
        "[Unit]\nDescription=Prospero Rust daemon\nAfter=network-online.target\n\n[Service]\nType=simple\n{}ExecStart={} start --home {}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n",
        environment,
        systemd_escape(&daemon),
        systemd_escape(&data),
    );
    let temporary = unit_dir.join(format!(".{LABEL}.{}.tmp", std::process::id()));
    fs::write(&temporary, body).map_err(|error| error.to_string())?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    fs::rename(&temporary, &unit).map_err(|error| error.to_string())?;
    run_program("systemctl", &["--user", "daemon-reload"])?;
    run_program(
        "systemctl",
        &["--user", "enable", "--now", &format!("{LABEL}.service")],
    )?;
    Ok(format!("installed {LABEL}.service"))
}

#[cfg(target_os = "linux")]
fn uninstall() -> Result<String, String> {
    let user_home = user_home()?;
    let unit_dir = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home.join(".config"))
        .join("systemd/user");
    let _ = run_program(
        "systemctl",
        &["--user", "disable", "--now", &format!("{LABEL}.service")],
    );
    let unit = unit_dir.join(format!("{LABEL}.service"));
    if unit.exists() {
        fs::remove_file(unit).map_err(|error| error.to_string())?;
    }
    run_program("systemctl", &["--user", "daemon-reload"])?;
    Ok(format!("uninstalled {LABEL}.service"))
}

#[cfg(target_os = "linux")]
fn start() -> Result<String, String> {
    if run_program(
        "systemctl",
        &["--user", "start", &format!("{LABEL}.service")],
    )
    .is_err()
    {
        return install();
    }
    Ok(format!("started {LABEL}.service"))
}

#[cfg(target_os = "linux")]
fn status() -> Result<String, String> {
    run_program(
        "systemctl",
        &[
            "--user",
            "status",
            "--no-pager",
            &format!("{LABEL}.service"),
        ],
    )
}

#[cfg(target_os = "windows")]
fn install() -> Result<String, String> {
    let daemon = daemon_binary()?;
    let data = default_daemon_home();
    fs::create_dir_all(&data).map_err(|error| error.to_string())?;
    let task = windows_task(&daemon, &data);
    let _ = run_program("schtasks.exe", &["/Delete", "/TN", LABEL, "/F"]);
    run_program(
        "schtasks.exe",
        &[
            "/Create", "/TN", LABEL, "/SC", "ONLOGON", "/TR", &task, "/RL", "LIMITED", "/F",
        ],
    )?;
    run_program("schtasks.exe", &["/Run", "/TN", LABEL])?;
    Ok(format!("installed {LABEL}"))
}

#[cfg(target_os = "windows")]
fn uninstall() -> Result<String, String> {
    run_program("schtasks.exe", &["/End", "/TN", LABEL]).ok();
    run_program("schtasks.exe", &["/Delete", "/TN", LABEL, "/F"])?;
    Ok(format!("uninstalled {LABEL}"))
}

#[cfg(target_os = "windows")]
fn start() -> Result<String, String> {
    if run_program("schtasks.exe", &["/Run", "/TN", LABEL]).is_err() {
        return install();
    }
    Ok(format!("started {LABEL}"))
}

#[cfg(target_os = "windows")]
fn status() -> Result<String, String> {
    run_program(
        "schtasks.exe",
        &["/Query", "/TN", LABEL, "/V", "/FO", "LIST"],
    )
}

#[cfg(target_os = "windows")]
fn windows_task(daemon: &Path, data: &Path) -> String {
    format!(
        "\"{}\" start --home \"{}\"",
        daemon.display(),
        data.display()
    )
}

fn user_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "user home is unavailable".into())
}

fn run_program(program: &str, arguments: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(arguments)
        .output()
        .map_err(|error| format!("{program}: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(format!("{program}: {}{}", stdout.trim(), stderr.trim()))
    }
}

#[cfg(target_os = "macos")]
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
fn launchd_environment(environment: &[(String, String)]) -> String {
    environment
        .iter()
        .map(|(key, value)| format!("<key>{}</key><string>{}</string>", xml(key), xml(value)))
        .collect::<Vec<_>>()
        .join("")
}

#[cfg(target_os = "linux")]
fn systemd_environment(environment: &[(String, String)]) -> String {
    environment
        .iter()
        .map(|(key, value)| {
            format!(
                "Environment=\"{}={}\"\n",
                key.replace('\\', "\\\\").replace('"', "\\\""),
                value.replace('\\', "\\\\").replace('"', "\\\"")
            )
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn systemd_escape(path: &Path) -> String {
    let value = path.display().to_string();
    format!("\"{}\"", value.replace('\\', "\\\\").replace('\"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn launchd_definition_escapes_paths_and_keeps_daemon_independent() {
        let plist = launchd_plist(
            Path::new("/Applications/A&B.app/prosperod-rs"),
            Path::new("/tmp/a<b"),
            Path::new("/Users/test"),
            Path::new("/tmp/logs"),
        );
        assert!(plist.contains("A&amp;B.app"));
        assert!(plist.contains("a&lt;b"));
        assert!(plist.contains("<key>KeepAlive</key><true/>"));
        assert!(plist.contains("<key>PROSPERO_HOME</key><string>/tmp/a&lt;b</string>"));
        assert!(plist.contains("/Applications/A&amp;B.app"));
        assert!(plist.contains("/Users/test/.local/bin"));
        assert!(plist.contains("/Users/test/.cargo/bin"));
        assert!(!plist.contains("prospero-desktop"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn systemd_environment_keeps_runtime_and_user_cli_paths() {
        let daemon = Path::new("/opt/Prospero/bin/prosperod-rs");
        let home = Path::new("/home/test");
        let environment = service_environment(daemon, Path::new("/data/prospero"), home);
        let path = environment
            .iter()
            .find(|(key, _)| key == "PATH")
            .map(|(_, value)| value)
            .unwrap();
        assert!(path.contains("/opt/Prospero/bin"));
        assert!(path.contains("/home/test/.local/bin"));
        assert!(path.contains("/home/test/.cargo/bin"));
        let unit = systemd_environment(&environment);
        assert!(unit.contains("Environment=\"PROSPERO_HOME=/data/prospero\""));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_task_quotes_binary_and_data_paths() {
        let task = windows_task(
            Path::new(r"C:\Program Files\Prospero\prosperod-rs.exe"),
            Path::new(r"C:\Users\Test\AppData\Prospero Rust\daemon"),
        );
        assert_eq!(
            task,
            r#""C:\Program Files\Prospero\prosperod-rs.exe" start --home "C:\Users\Test\AppData\Prospero Rust\daemon""#
        );
    }
}
