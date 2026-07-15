$ErrorActionPreference = "Stop"

$DownloadUrl = "https://ollama.com/download/OllamaSetup.exe"
$ResultFile = Join-Path $PSScriptRoot "setup-result.json"
$ResultTempFile = Join-Path $PSScriptRoot "setup-result.json.tmp"
$InstallerPath = Join-Path $PSScriptRoot "OllamaSetup.exe"
$script:ResultWritten = $false

function Write-Result {
  param(
    [ValidateSet("success", "cancelled", "error")]
    [string]$Status,
    [string]$Code
  )

  $json = @{ status = $Status; code = $Code } | ConvertTo-Json -Compress
  $utf8WithoutBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
  [System.IO.File]::WriteAllText($ResultTempFile, $json, $utf8WithoutBom)
  Move-Item -Path $ResultTempFile -Destination $ResultFile -Force
  $script:ResultWritten = $true
}

function Complete-Setup {
  param(
    [string]$Status,
    [string]$Code,
    [int]$ExitCode = 0
  )

  Write-Result -Status $Status -Code $Code
  exit $ExitCode
}

trap {
  if (-not $script:ResultWritten) {
    Write-Result -Status "error" -Code "installation-failed"
  }
  Write-Host "Setup fehlgeschlagen: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

function Write-Step($Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Confirm-Step($Question) {
  while ($true) {
    $answer = Read-Host "$Question [Y/N]"
    if ($answer -match "^[YyJj]") { return $true }
    if ($answer -match "^[Nn]" -or $answer -eq "") { return $false }
  }
}

function Find-Ollama {
  $command = Get-Command "ollama" -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
    "$env:LOCALAPPDATA\Ollama\ollama.exe",
    "$env:ProgramFiles\Ollama\ollama.exe",
    "${env:ProgramFiles(x86)}\Ollama\ollama.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }

  return $null
}

Write-Host "ZAIA Ollama-App-Setup - Windows" -ForegroundColor Green
Write-Host ""
Write-Host "Dieses Setup installiert nur die Ollama-App."
Write-Host "Modelle werden anschließend direkt in ZAIA ausgewählt und heruntergeladen."

$ollamaPath = Find-Ollama
if ($ollamaPath) {
  Write-Step "Ollama ist bereits installiert"
  Write-Host $ollamaPath
  Complete-Setup -Status "success" -Code "already-installed"
}

Write-Step "Ollama wurde nicht gefunden"
Write-Host "Quelle: $DownloadUrl"
Write-Host "Vor der Installation wird die digitale Signatur des Installers geprüft."
if (-not (Confirm-Step "Offizielle Ollama-App jetzt herunterladen und installieren?")) {
  Write-Host "Installation abgebrochen."
  Complete-Setup -Status "cancelled" -Code "user-cancelled"
}

Write-Step "Offizieller Ollama-Installer wird heruntergeladen"
try {
  Invoke-WebRequest -Uri $DownloadUrl -OutFile $InstallerPath -UseBasicParsing
} catch {
  Write-Result -Status "error" -Code "download-failed"
  throw
}

Write-Step "Download wird geprüft"
$signature = Get-AuthenticodeSignature -FilePath $InstallerPath
if ($signature.Status -ne "Valid" -or -not $signature.SignerCertificate) {
  Write-Result -Status "error" -Code "invalid-signature"
  throw "Die digitale Signatur des Ollama-Installers ist ungültig."
}
if ($signature.SignerCertificate.Subject -notmatch "Ollama") {
  Write-Result -Status "error" -Code "unexpected-publisher"
  throw "Der Ollama-Installer wurde von einem unerwarteten Herausgeber signiert."
}

Write-Step "Ollama wird installiert"
$installer = Start-Process -FilePath $InstallerPath -Wait -PassThru
if ($installer.ExitCode -ne 0) {
  Write-Result -Status "error" -Code "installer-exit-$($installer.ExitCode)"
  throw "Der Ollama-Installer wurde mit Code $($installer.ExitCode) beendet."
}

$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
  [System.Environment]::GetEnvironmentVariable("Path", "User")

for ($attempt = 0; $attempt -lt 30; $attempt++) {
  $ollamaPath = Find-Ollama
  if ($ollamaPath) { break }
  Start-Sleep -Seconds 1
}

if (-not $ollamaPath) {
  Write-Result -Status "error" -Code "not-found-after-install"
  throw "Ollama wurde nach der Installation nicht gefunden."
}

Write-Step "Ollama-App wurde installiert"
Write-Host $ollamaPath
Complete-Setup -Status "success" -Code "installed"
