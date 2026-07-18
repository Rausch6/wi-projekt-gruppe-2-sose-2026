# Behandelt alle PowerShell-Fehler als abbrechende Fehler, damit der zentrale
# Trap den Fehlschlag zuverlässig an ZAIA melden kann.
$ErrorActionPreference = "Stop"

# Zentrale Pfade und Statusvariablen für Download und Rückmeldung an ZAIA.
$DownloadUrl = "https://ollama.com/download/OllamaSetup.exe"
$ResultFile = Join-Path $PSScriptRoot "setup-result.json"
$ResultTempFile = Join-Path $PSScriptRoot "setup-result.json.tmp"
$InstallerPath = Join-Path $PSScriptRoot "OllamaSetup.exe"
$script:ResultWritten = $false

function Write-Result {
  # Schreibt das Ergebnis ohne UTF-8-BOM zunächst temporär und verschiebt es
  # anschließend atomar an den von ZAIA erwarteten Ort.
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
  # Speichert den Abschlussstatus und beendet das Setup mit dem gewünschten Code.
  param(
    [string]$Status,
    [string]$Code,
    [int]$ExitCode = 0
  )

  Write-Result -Status $Status -Code $Code
  exit $ExitCode
}

trap {
  # Fängt unerwartete Fehler ab und stellt eine auswertbare Ergebnisdatei sicher.
  if (-not $script:ResultWritten) {
    Write-Result -Status "error" -Code "installation-failed"
  }
  Write-Host "Setup fehlgeschlagen: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

function Write-Step($Message) {
  # Gibt einen gut sichtbaren Abschnitt im Terminal aus.
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Confirm-Step($Question) {
  # Akzeptiert neben englischem Y/N auch das deutsche J für Ja.
  while ($true) {
    $answer = Read-Host "$Question [Y/N]"
    if ($answer -match "^[YyJj]") { return $true }
    if ($answer -match "^[Nn]" -or $answer -eq "") { return $false }
  }
}

function Find-Ollama {
  # Prüft zuerst den PATH und danach die üblichen Installationsorte.
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
# Informiert den Benutzer über den Umfang dieses Setups.
Write-Host ""
Write-Host "Dieses Setup installiert nur die Ollama-App."
Write-Host "Modelle werden anschließend direkt in ZAIA ausgewählt und heruntergeladen."

$ollamaPath = Find-Ollama
# Eine vorhandene Installation muss nicht erneut heruntergeladen werden.
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
# Lädt ausschließlich den offiziellen Installer in das Setup-Verzeichnis.
try {
  Invoke-WebRequest -Uri $DownloadUrl -OutFile $InstallerPath -UseBasicParsing
} catch {
  Write-Result -Status "error" -Code "download-failed"
  throw
}

Write-Step "Download wird geprüft"
# Prüft sowohl die Gültigkeit der Authenticode-Signatur als auch den erwarteten
# Herausgeber, bevor der Installer ausgeführt wird.
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
# Wartet auf den Installer und übernimmt einen von null abweichenden Exit-Code
# als Setup-Fehler.
$installer = Start-Process -FilePath $InstallerPath -Wait -PassThru
if ($installer.ExitCode -ne 0) {
  Write-Result -Status "error" -Code "installer-exit-$($installer.ExitCode)"
  throw "Der Ollama-Installer wurde mit Code $($installer.ExitCode) beendet."
}

# Aktualisiert den PATH der laufenden PowerShell-Sitzung nach der Installation.
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
  [System.Environment]::GetEnvironmentVariable("Path", "User")

# Wartet bis zu 30 Sekunden darauf, dass die Ollama-CLI auffindbar wird.
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
