param(
  [ValidateSet('Debug', 'Release')]
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$msbuildCandidates = @(
  'C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe',
  'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe',
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\MSBuild.exe"
)
$msbuild = $msbuildCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $msbuild) { throw 'MSBuild not found. Install Visual Studio Build Tools with .NET desktop development.' }

$outputDirectory = Join-Path $projectRoot "bin\$Configuration"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$output = Join-Path $outputDirectory 'ProsperoShell.exe'
$objectDirectory = Join-Path $projectRoot 'obj'
New-Item -ItemType Directory -Path $objectDirectory -Force | Out-Null
$iconSource = Join-Path $projectRoot '..\mobile\assets\images\icon.png'
$applicationIcon = Join-Path $objectDirectory 'Prospero.ico'

Add-Type -AssemblyName System.Drawing
$sourceImage = [System.Drawing.Image]::FromFile($iconSource)
$iconPayloads = @()
try {
  foreach ($iconSize in @(16, 24, 32, 48, 256)) {
    $iconBitmap = New-Object System.Drawing.Bitmap $iconSize, $iconSize
    $iconGraphics = [System.Drawing.Graphics]::FromImage($iconBitmap)
    try {
      $iconGraphics.Clear([System.Drawing.Color]::Transparent)
      $iconGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $iconGraphics.DrawImage($sourceImage, 0, 0, $iconSize, $iconSize)
      $memory = New-Object System.IO.MemoryStream
      try {
        $iconBitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
        $iconPayloads += ,@($iconSize, $memory.ToArray())
      } finally { $memory.Dispose() }
    } finally { $iconGraphics.Dispose(); $iconBitmap.Dispose() }
  }
} finally {
  $sourceImage.Dispose()
}
$iconStream = [System.IO.File]::Create($applicationIcon)
$iconWriter = New-Object System.IO.BinaryWriter $iconStream
try {
  $iconWriter.Write([UInt16]0); $iconWriter.Write([UInt16]1); $iconWriter.Write([UInt16]$iconPayloads.Count)
  $payloadOffset = 6 + (16 * $iconPayloads.Count)
  foreach ($payload in $iconPayloads) {
    $sizeByte = if ($payload[0] -eq 256) { 0 } else { [byte]$payload[0] }
    $iconWriter.Write([byte]$sizeByte); $iconWriter.Write([byte]$sizeByte)
    $iconWriter.Write([byte]0); $iconWriter.Write([byte]0)
    $iconWriter.Write([UInt16]1); $iconWriter.Write([UInt16]32)
    $iconWriter.Write([UInt32]$payload[1].Length); $iconWriter.Write([UInt32]$payloadOffset)
    $payloadOffset += $payload[1].Length
  }
  foreach ($payload in $iconPayloads) { $iconWriter.Write([byte[]]$payload[1]) }
} finally { $iconWriter.Dispose(); $iconStream.Dispose() }
$frameworkPath = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
& $msbuild (Join-Path $projectRoot 'Prospero.WindowsShell.csproj') /nologo /t:Rebuild "/p:Configuration=$Configuration" /p:Platform=AnyCPU "/p:FrameworkPathOverride=$frameworkPath" /verbosity:minimal
if ($LASTEXITCODE -ne 0) { throw "Windows shell build failed (exit $LASTEXITCODE)" }
Write-Host "Built $output"
