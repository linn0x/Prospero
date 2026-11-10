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
}

if (Test-Path -LiteralPath $runtimeFull) {
  Remove-Item -LiteralPath $runtimeFull -Recurse -Force
}
New-Item -ItemType Directory -Path $runtimeFull | Out-Null

$rustBinary = Join-Path $repoRoot "target\release\prosperod-rs.exe"
if (-not (Test-Path -LiteralPath $rustBinary)) {
  throw "Missing Rust daemon release binary: $rustBinary"
}
Copy-Item -LiteralPath $rustBinary -Destination (Join-Path $runtimeFull "prosperod-rs.exe")
$rustCli = Join-Path $repoRoot "target\release\prospero.exe"
if (-not (Test-Path -LiteralPath $rustCli)) {
  throw "Missing Rust worker CLI release binary: $rustCli"
}
Copy-Item -LiteralPath $rustCli -Destination (Join-Path $runtimeFull "prospero.exe")

$runtimeManifest = @{
  private = $true
  type = "module"
  prosperoRuntime = @{ platform = "win32"; architecture = $Architecture }
} | ConvertTo-Json -Depth 5
Set-Content -LiteralPath (Join-Path $runtimeFull "package.json") -Value $runtimeManifest -Encoding utf8

Write-Host "Runtime staged at $runtimeFull"
