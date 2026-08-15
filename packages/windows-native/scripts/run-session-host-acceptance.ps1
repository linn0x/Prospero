[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Workspace,
  [Parameter(Mandatory = $true)][string]$NpmPath,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$exitCode = 1

try {
  Set-Location -LiteralPath $Workspace
  $env:PATH = "$(Split-Path -Parent $NpmPath);$env:PATH"
  $env:PROSPERO_WINDOWS_SIGNED_SESSION_HOST_TEST = '1'
  $output = & $NpmPath run test:windows-native --workspace=@prospero/daemon 2>&1
  $exitCode = $LASTEXITCODE
  Set-Content -LiteralPath $LogPath -Value $output -Encoding utf8
} catch {
  Add-Content -LiteralPath $LogPath -Value ($_ | Out-String) -Encoding utf8
  $exitCode = 1
} finally {
  [IO.File]::WriteAllText($ResultPath, [string]$exitCode)
}

exit $exitCode
