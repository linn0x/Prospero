param(
  [string]$NodeExecutable = "",
  [ValidateSet("x64", "arm64")]
  [string]$Architecture = "x64",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path (Join-Path $appRoot "..\..")).Path
$runtimeRoot = Join-Path $appRoot ".runtime"
$runtimeFull = [IO.Path]::GetFullPath($runtimeRoot)
if (-not $runtimeFull.StartsWith($appRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to stage runtime outside the Windows desktop package"
}

if (-not $SkipBuild) {
  & npm.cmd run build --workspace=@prospero/protocol
  if ($LASTEXITCODE -ne 0) { throw "Protocol build failed" }
  & npm.cmd run build --workspace=@prospero/windows-native
  if ($LASTEXITCODE -ne 0) { throw "Windows native package build failed" }
  & npm.cmd run build --workspace=@prospero/daemon
  if ($LASTEXITCODE -ne 0) { throw "Daemon build failed" }
}

if (Test-Path -LiteralPath $runtimeFull) {
  Remove-Item -LiteralPath $runtimeFull -Recurse -Force
}
New-Item -ItemType Directory -Path $runtimeFull | Out-Null
$nodeRoot = Join-Path $runtimeFull "node"
$daemonRoot = Join-Path $runtimeFull "daemon"
New-Item -ItemType Directory -Path $nodeRoot, $daemonRoot | Out-Null

if ([string]::IsNullOrWhiteSpace($NodeExecutable)) {
  $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
}
$nodeResolved = (Resolve-Path $NodeExecutable).Path
Copy-Item -LiteralPath $nodeResolved -Destination (Join-Path $nodeRoot "node.exe")
$nodeLicense = Join-Path (Split-Path $nodeResolved) "LICENSE"
if (Test-Path -LiteralPath $nodeLicense) {
  Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $nodeRoot "LICENSE")
}

$packRoot = Join-Path $runtimeFull "packs"
$npmCache = Join-Path $repoRoot ".npm-cache"
New-Item -ItemType Directory -Path $packRoot | Out-Null
Push-Location $repoRoot
try {
  & npm.cmd pack ./packages/protocol --pack-destination $packRoot --cache $npmCache
  if ($LASTEXITCODE -ne 0) { throw "Protocol runtime pack failed" }
  & npm.cmd pack ./packages/windows-native --pack-destination $packRoot --cache $npmCache
  if ($LASTEXITCODE -ne 0) { throw "Windows native runtime pack failed" }
  & npm.cmd pack ./apps/daemon --pack-destination $packRoot --ignore-scripts --cache $npmCache
  if ($LASTEXITCODE -ne 0) { throw "Daemon runtime pack failed" }
} finally {
  Pop-Location
}

$protocolPack = Get-ChildItem -LiteralPath $packRoot -Filter "prospero-protocol-*.tgz" | Select-Object -First 1
$nativePack = Get-ChildItem -LiteralPath $packRoot -Filter "prospero-windows-native-*.tgz" | Select-Object -First 1
$daemonPack = Get-ChildItem -LiteralPath $packRoot -Filter "prospero-daemon-*.tgz" | Select-Object -First 1
if (-not $protocolPack -or -not $nativePack -or -not $daemonPack) { throw "Runtime package staging is incomplete" }

$runtimeManifest = @{
  private = $true
  type = "module"
  dependencies = @{
    "@prospero/protocol" = "file:packs/$($protocolPack.Name)"
    "@prospero/windows-native" = "file:packs/$($nativePack.Name)"
    "@prospero/daemon" = "file:packs/$($daemonPack.Name)"
  }
} | ConvertTo-Json -Depth 5
Set-Content -LiteralPath (Join-Path $runtimeFull "package.json") -Value $runtimeManifest -Encoding utf8

Push-Location $runtimeFull
try {
  & npm.cmd install --omit=dev --ignore-scripts --no-audit --no-fund --cache $npmCache --os win32 --cpu $Architecture
  if ($LASTEXITCODE -ne 0) { throw "Runtime dependency install failed" }
} finally {
  Pop-Location
}

$installedDaemon = Join-Path $runtimeFull "node_modules\@prospero\daemon"
if (-not (Test-Path -LiteralPath (Join-Path $installedDaemon "dist\cli.js"))) {
  throw "Installed runtime does not contain daemon/dist/cli.js"
}
Copy-Item -Path (Join-Path $installedDaemon "*") -Destination $daemonRoot -Recurse -Force

# Keep the runtime self-contained without carrying build-only material or the
# other Windows architecture. These removals are confined to the freshly
# recreated .runtime staging tree above.
$oppositeArchitecture = if ($Architecture -eq "x64") { "arm64" } else { "x64" }
$pruneTargets = @(
  (Join-Path $runtimeFull "node_modules\node-pty\prebuilds\darwin-arm64"),
  (Join-Path $runtimeFull "node_modules\node-pty\prebuilds\darwin-x64"),
  (Join-Path $runtimeFull "node_modules\node-pty\prebuilds\win32-$oppositeArchitecture"),
  (Join-Path $runtimeFull "node_modules\node-pty\third_party\conpty\1.23.251008001\win10-$oppositeArchitecture"),
  (Join-Path $runtimeFull "node_modules\@prospero\daemon")
)
foreach ($target in $pruneTargets) {
  if (Test-Path -LiteralPath $target) {
    $resolvedTarget = (Resolve-Path $target).Path
    if (-not $resolvedTarget.StartsWith($runtimeFull, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe runtime prune target" }
    Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
  }
}
Get-ChildItem -LiteralPath $runtimeFull -Recurse -File | Where-Object {
  $_.Extension -in @(".map", ".ts", ".pdb") -or $_.Name -match "^(README|CHANGELOG|HISTORY)(\..*)?$"
} | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "Runtime staged at $runtimeFull"
