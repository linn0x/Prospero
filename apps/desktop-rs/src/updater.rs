use std::path::PathBuf;

use futures_util::StreamExt;
use reqwest::header::{ACCEPT, USER_AGENT};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

const RELEASE_API: &str = "https://api.github.com/repos/linn0x/Prospero/releases/latest";
const MAX_RELEASE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_CHECKSUM_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone)]
pub struct Release {
    pub version: String,
    pub name: String,
    pub url: String,
    pub checksum_url: String,
    pub size: u64,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

pub async fn check() -> Result<Option<Release>, String> {
    let client = http()?;
    let response = client
        .get(RELEASE_API)
        .header(USER_AGENT, "Prospero-Native")
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    validate_response_url(response.url().as_str())?;
    let release: GithubRelease =
        serde_json::from_slice(&bounded_body(response, 1024 * 1024).await?)
            .map_err(|error| error.to_string())?;
    if release.draft || release.prerelease || !newer(&release.tag_name, env!("CARGO_PKG_VERSION")) {
        return Ok(None);
    }
    let version = release.tag_name.trim_start_matches('v');
    let name = artifact_name(version);
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| format!("release {} has no {name} artifact", release.tag_name))?;
    if asset.size == 0 || asset.size > MAX_RELEASE_BYTES {
        return Err("release artifact size is invalid".into());
    }
    let checksum = release
        .assets
        .iter()
        .find(|candidate| candidate.name == format!("{}.sha256", asset.name))
        .ok_or_else(|| format!("release {} has no checksum", release.tag_name))?;
    validate_download_url(&asset.browser_download_url)?;
    validate_download_url(&checksum.browser_download_url)?;
    Ok(Some(Release {
        version: version.to_owned(),
        name: asset.name.clone(),
        url: asset.browser_download_url.clone(),
        checksum_url: checksum.browser_download_url.clone(),
        size: asset.size,
    }))
}

pub async fn download(release: Release) -> Result<PathBuf, String> {
    let client = http()?;
    let response = client
        .get(&release.checksum_url)
        .header(USER_AGENT, "Prospero-Native")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let response = response
        .error_for_status()
        .map_err(|error| error.to_string())?;
    validate_response_url(response.url().as_str())?;
    let checksum = bounded_body(response, MAX_CHECKSUM_BYTES).await?;
    let expected = parse_checksum(&checksum, &release.name)?;
    let directory = download_directory()?;
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| error.to_string())?;
    let target = directory.join(&release.name);
    let temporary = directory.join(format!(".{}.download", release.name));
    let response = client
        .get(&release.url)
        .header(USER_AGENT, "Prospero-Native")
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    validate_response_url(response.url().as_str())?;
    if response
        .content_length()
        .is_some_and(|size| size == 0 || size > MAX_RELEASE_BYTES)
    {
        return Err("release artifact size is invalid".into());
    }
    let mut file = tokio::fs::File::create(&temporary)
        .await
        .map_err(|error| error.to_string())?;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut written = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        written = written.saturating_add(chunk.len() as u64);
        if written > MAX_RELEASE_BYTES || written > release.size.saturating_add(1024 * 1024) {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err("release artifact exceeded its declared size".into());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| error.to_string())?;
    }
    file.flush().await.map_err(|error| error.to_string())?;
    drop(file);
    let actual = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if actual != expected {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err("release checksum mismatch".into());
    }
    tokio::fs::rename(&temporary, &target)
        .await
        .map_err(|error| error.to_string())?;
    Ok(target)
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())
}

async fn bounded_body(response: reqwest::Response, limit: u64) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|size| size > limit) {
        return Err("release response is too large".into());
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        if body.len().saturating_add(chunk.len()) > limit as usize {
            return Err("release response is too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn artifact_name(version: &str) -> String {
    let platform = if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let architecture = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let extension = if cfg!(target_os = "macos") {
        "dmg"
    } else if cfg!(target_os = "windows") {
        "zip"
    } else {
        "deb"
    };
    format!("Prospero-Native-{version}-{platform}-{architecture}.{extension}")
}

fn newer(candidate: &str, current: &str) -> bool {
    matches!(
        (
            semver::Version::parse(candidate.trim_start_matches('v')),
            semver::Version::parse(current.trim_start_matches('v'))
        ),
        (Ok(candidate), Ok(current)) if candidate > current
    )
}

fn validate_download_url(value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "release URL is invalid".to_owned())?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url
            .path()
            .starts_with("/linn0x/Prospero/releases/download/")
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("release URL is not trusted".into());
    }
    Ok(())
}

fn validate_response_url(value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "release URL is invalid".to_owned())?;
    let trusted_host = matches!(
        url.host_str(),
        Some("api.github.com" | "github.com" | "objects.githubusercontent.com")
    ) || url
        .host_str()
        .is_some_and(|host| host.ends_with(".githubusercontent.com"));
    if url.scheme() != "https" || !trusted_host || url.username() != "" || url.password().is_some()
    {
        return Err("release response URL is not trusted".into());
    }
    Ok(())
}

fn parse_checksum(bytes: &[u8], name: &str) -> Result<String, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "release checksum is invalid".to_owned())?;
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let Some(hash) = fields.next() else {
            continue;
        };
        let file = fields.next().unwrap_or_default().trim_start_matches('*');
        if file == name && hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(hash.to_ascii_lowercase());
        }
    }
    Err("release checksum does not name the selected artifact".into())
}

fn download_directory() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("PROSPERO_UPDATE_DIR") {
        return Ok(PathBuf::from(path));
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .map(|path| path.join("Downloads/Prospero Updates"))
        .ok_or_else(|| "download directory is unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_comparison_is_strict_and_bounded() {
        assert!(newer("1.2.4", "1.2.3"));
        assert!(newer("v2.0.0-beta.1", "1.9.9"));
        assert!(!newer("1.2.3", "1.2.3"));
        assert!(!newer("1.2.3-beta.1", "1.2.3"));
        assert!(!newer("invalid", "1.2.3"));
    }

    #[test]
    fn release_asset_name_is_native_and_platform_specific() {
        let name = artifact_name("1.2.3");
        assert!(name.starts_with("Prospero-Native-1.2.3-"));
        assert!(!name.contains("Electron"));
    }

    #[test]
    fn checksum_must_match_the_selected_asset() {
        let hash = "a".repeat(64);
        let body = format!("{hash}  Prospero-1.0.0-linux-x64.AppImage\n");
        assert_eq!(
            parse_checksum(body.as_bytes(), "Prospero-1.0.0-linux-x64.AppImage").unwrap(),
            hash
        );
        assert!(parse_checksum(body.as_bytes(), "other").is_err());
    }

    #[test]
    fn only_project_release_urls_are_trusted() {
        assert!(
            validate_download_url(
                "https://github.com/linn0x/Prospero/releases/download/v1/Prospero.dmg"
            )
            .is_ok()
        );
        assert!(validate_download_url("https://example.com/Prospero.dmg").is_err());
        assert!(
            validate_download_url(
                "https://github.com/other/Prospero/releases/download/v1/Prospero.dmg"
            )
            .is_err()
        );
        assert!(validate_response_url("https://objects.githubusercontent.com/path").is_ok());
        assert!(validate_response_url("https://evil.example/path").is_err());
    }
}
