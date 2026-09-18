$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$version = if ($env:PROSPERO_VERSION) { $env:PROSPERO_VERSION } else { "0.1.0" }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$stage = Join-Path $repoRoot "target/package/prospero-$version-windows-$arch"
$archive = Join-Path $repoRoot "target/package/Prospero-Native-$version-windows-$arch.zip"

cargo build --manifest-path (Join-Path $repoRoot "Cargo.toml") --release --locked -p prospero-desktop -p prosperod-rs
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item (Join-Path $repoRoot "target/release/prospero-desktop.exe") (Join-Path $stage "Prospero.exe")
Copy-Item (Join-Path $repoRoot "target/release/prosperod-rs.exe") (Join-Path $stage "prosperod-rs.exe")
Copy-Item (Join-Path $repoRoot "target/release/prospero.exe") (Join-Path $stage "prospero.exe")
@'
$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $env:LOCALAPPDATA "Programs\Prospero"
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item (Join-Path $source "Prospero.exe") $target -Force
Copy-Item (Join-Path $source "prosperod-rs.exe") $target -Force
Copy-Item (Join-Path $source "prospero.exe") $target -Force
& (Join-Path $target "Prospero.exe") --service-install
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs\Prospero.lnk"))
$shortcut.TargetPath = Join-Path $target "Prospero.exe"
$shortcut.Save()
Write-Output "Installed Prospero to $target"
'@ | Set-Content -LiteralPath (Join-Path $stage "Install-Prospero.ps1") -Encoding utf8
@'
$ErrorActionPreference = "Stop"
$target = Join-Path $env:LOCALAPPDATA "Programs\Prospero"
if (Test-Path (Join-Path $target "Prospero.exe")) { & (Join-Path $target "Prospero.exe") --service-uninstall }
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs\Prospero.lnk") -Force -ErrorAction SilentlyContinue
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', "Start-Sleep -Seconds 1; Remove-Item -LiteralPath '$($target.Replace("'", "''"))' -Recurse -Force")
'@ | Set-Content -LiteralPath (Join-Path $stage "Uninstall-Prospero.ps1") -Encoding utf8
if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $archive
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
"$hash  $(Split-Path -Leaf $archive)" | Set-Content -LiteralPath "$archive.sha256" -Encoding ascii
Write-Output $archive
