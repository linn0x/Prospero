param([Parameter(Mandatory = $true)][string]$StatePath)
$ErrorActionPreference = 'Stop'
$file = [IO.File]::Open($StatePath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  [Console]::WriteLine('locked')
  [Console]::Out.Flush()
  [Console]::ReadLine() | Out-Null
  # Reproduce the interval between publishing a file name and closing the
  # exclusive atomic-write handle. No file contents or ACLs are changed.
  Start-Sleep -Milliseconds 80
} finally {
  $file.Dispose()
}
