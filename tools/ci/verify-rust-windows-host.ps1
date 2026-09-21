[CmdletBinding()]
param(
  [ValidateSet('Launch', 'Run')][string]$Mode = 'Launch',
  [Parameter(Mandatory = $true)][string]$Workspace,
  [Parameter(Mandatory = $true)][string]$TestExecutable,
  [Parameter(Mandatory = $true)][string]$NodePath,
  [string]$LogPath,
  [string]$ResultPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Mode -eq 'Run') {
  $exitCode = 1
  try {
    Set-Location -LiteralPath $Workspace
    $env:PATH = "$(Split-Path -Parent $NodePath);$env:PATH"
    $previousPreference = $ErrorActionPreference
    try {
      # Windows PowerShell 5 must collect native stderr without converting it
      # into a terminating PowerShell exception. Native exit codes stay gating.
      $ErrorActionPreference = 'Continue'
      $output = & $TestExecutable conpty_shell_survives_daemon_restarts_and_explicit_close_archives_it --exact --nocapture 2>&1
      $testExit = $LASTEXITCODE
      Set-Content -LiteralPath $LogPath -Value $output -Encoding utf8
      if ($testExit -ne 0 -or (($output -join "`n") -notmatch 'running 1 test')) {
        throw "The required Rust ConPTY lifecycle case did not pass (exit $testExit)"
      }
      $output = & $NodePath tools/perf/rust-daemon-acceptance.mjs --release --seconds 20 --sessions 8 --output target/prospero-acceptance/windows-native.json 2>&1
      $exitCode = $LASTEXITCODE
      Add-Content -LiteralPath $LogPath -Value $output -Encoding utf8
    } finally { $ErrorActionPreference = $previousPreference }
  } catch {
    Add-Content -LiteralPath $LogPath -Value ($_ | Out-String) -Encoding utf8
    $exitCode = 1
  } finally {
    [IO.File]::WriteAllText($ResultPath, [string]$exitCode)
  }
  exit $exitCode
}

if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This launcher requires a disposable GitHub Actions runner' }

# Match the existing Windows Session Host acceptance setup: the hosted runner
# Job forbids durable child breakaway. A bounded one-shot task runs this owned
# fixture outside that Job, and is always removed. No test is silently skipped.
$tag = "$env:GITHUB_RUN_ID-$env:RUNNER_ARCH"
$taskName = "Prospero-Rust-Host-$tag"
$launcher = Join-Path $env:RUNNER_TEMP "prospero-rust-host-$tag.ps1"
$LogPath = Join-Path $env:RUNNER_TEMP "prospero-rust-host-$tag.log"
$ResultPath = Join-Path $env:RUNNER_TEMP "prospero-rust-host-$tag.result"
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
foreach ($value in @($PSCommandPath, $Workspace, $TestExecutable, $NodePath, $LogPath, $ResultPath, $launcher, $powerShell)) {
  if ($value.Contains("'") -or $value.Contains('"')) { throw 'Unsupported quote in acceptance path' }
}
Set-Content -LiteralPath $launcher -Encoding utf8 -Value @(
  "& '$PSCommandPath' -Mode Run -Workspace '$Workspace' -TestExecutable '$TestExecutable' -NodePath '$NodePath' -LogPath '$LogPath' -ResultPath '$ResultPath'",
  'exit $LASTEXITCODE'
)
$command = "`"$powerShell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`""
if ($command.Length -gt 261) { throw 'Scheduled launcher command is too long' }
try {
  $startTime = (Get-Date).AddMinutes(1).ToString('HH:mm')
  & schtasks.exe /Create /TN $taskName /SC ONCE /ST $startTime /TR $command /RU SYSTEM /RL HIGHEST /F
  if ($LASTEXITCODE -ne 0) { throw 'Could not register Rust host acceptance task' }
  & schtasks.exe /Run /TN $taskName
  if ($LASTEXITCODE -ne 0) { throw 'Could not start Rust host acceptance task' }
  $deadline = (Get-Date).AddMinutes(5)
  while (-not (Test-Path -LiteralPath $ResultPath)) {
    if ((Get-Date) -ge $deadline) { throw 'Rust host acceptance timed out' }
    Start-Sleep -Seconds 1
  }
  if (Test-Path -LiteralPath $LogPath) { Get-Content -LiteralPath $LogPath }
  $result = [int]((Get-Content -LiteralPath $ResultPath -Raw).Trim())
  if ($result -ne 0) { throw "Rust host acceptance failed: $result" }
} finally {
  & schtasks.exe /End /TN $taskName 2>$null | Out-Null
  & schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null
  Remove-Item -LiteralPath $launcher -ErrorAction SilentlyContinue
}
