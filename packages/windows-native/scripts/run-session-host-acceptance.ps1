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
  # Windows PowerShell 5 surfaces native stderr as NativeCommandError when the
  # caller uses Stop. Keep collecting the complete npm output and trust the
  # native exit code, then restore fail-fast behavior for the harness itself.
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & $NpmPath run test:windows-native --workspace=@prospero/daemon 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  Set-Content -LiteralPath $LogPath -Value $output -Encoding utf8
} catch {
  Add-Content -LiteralPath $LogPath -Value ($_ | Out-String) -Encoding utf8
  $exitCode = 1
} finally {
  [IO.File]::WriteAllText($ResultPath, [string]$exitCode)
}

exit $exitCode
