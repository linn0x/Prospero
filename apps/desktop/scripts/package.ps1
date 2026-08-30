param(
  [ValidateSet("x64", "arm64")]
  [string]$Architecture = "x64",
  [string]$NodeExecutable = ""
)

$ErrorActionPreference = "Stop"
$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
& (Join-Path $PSScriptRoot "prepare-runtime.ps1") -NodeExecutable $NodeExecutable -Architecture $Architecture
if ($LASTEXITCODE -ne 0) { throw "Runtime preparation failed" }
Push-Location $appRoot
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "Electron application build failed" }
  & npx.cmd electron-builder --win nsis zip --$Architecture
  if ($LASTEXITCODE -ne 0) { throw "Windows installer build failed" }
} finally {
  Pop-Location
}
