$ErrorActionPreference = "Stop"

$Model = "qwen2.5:3b"
$BaseUrl = "http://localhost:11434"
$InstallCommand = "irm https://ollama.com/install.ps1 | iex"

function Write-Step($Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Confirm-Step($Question) {
  while ($true) {
    $answer = Read-Host "$Question [Y/N]"
    if ($answer -match "^[YyJj]") { return $true }
    if ($answer -match "^[Nn]") { return $false }
  }
}

function Find-Ollama {
  $command = Get-Command "ollama" -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
    "$env:ProgramFiles\Ollama\ollama.exe",
    "${env:ProgramFiles(x86)}\Ollama\ollama.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }

  return $null
}

function Test-OllamaApi {
  try {
    Invoke-RestMethod -Uri "$BaseUrl/api/tags" -Method Get -TimeoutSec 3 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Wait-ForOllamaApi {
  param([int]$Seconds = 45)

  Write-Step "Waiting for Ollama service at $BaseUrl"
  for ($i = 1; $i -le $Seconds; $i++) {
    if (Test-OllamaApi) {
      Write-Host "Ollama service is reachable."
      return $true
    }
    Start-Sleep -Seconds 1
  }

  return $false
}

function Start-OllamaService {
  param([string]$OllamaPath)

  if (Test-OllamaApi) { return }

  Write-Step "Starting Ollama in the background"
  try {
    Start-Process -FilePath $OllamaPath -ArgumentList "serve" -WindowStyle Hidden | Out-Null
  } catch {
    Write-Warning "Could not start 'ollama serve': $($_.Exception.Message)"
    Write-Host "If the Ollama desktop app is installed, start it from the Start menu."
  }
}

function Get-InstalledModels {
  try {
    $response = Invoke-RestMethod -Uri "$BaseUrl/api/tags" -Method Get -TimeoutSec 10
    return @($response.models | ForEach-Object { $_.name })
  } catch {
    return @()
  }
}

Write-Host "ZAIA Ollama Setup - Windows 11" -ForegroundColor Green
Write-Host "This setup installs Ollama, starts the local service, and downloads $Model."
Write-Host "ZAIA expects Ollama at $BaseUrl with model $Model."

$ollamaPath = Find-Ollama
if (-not $ollamaPath) {
  Write-Step "Ollama was not found"
  Write-Host "The official Ollama Windows install command is:"
  Write-Host "  $InstallCommand"
  if (-not (Confirm-Step "Install Ollama now?")) {
    throw "Installation cancelled by user."
  }

  Write-Step "Installing Ollama"
  Invoke-Expression $InstallCommand

  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [System.Environment]::GetEnvironmentVariable("Path", "User")
  $ollamaPath = Find-Ollama
}

if (-not $ollamaPath) {
  Write-Host "Ollama CLI was not found after installation."
  Write-Host "Opening the official download page as fallback..."
  Start-Process "https://ollama.com/download"
  throw "Please finish the Ollama installation manually and run this setup again."
}

Write-Step "Using Ollama CLI"
Write-Host $ollamaPath

Start-OllamaService -OllamaPath $ollamaPath
if (-not (Wait-ForOllamaApi)) {
  throw "Ollama service did not become reachable at $BaseUrl."
}

$installedModels = Get-InstalledModels
if ($installedModels -contains $Model) {
  Write-Step "Model already installed"
  Write-Host $Model
} else {
  Write-Step "Model $Model is not installed"
  Write-Host "This download can take a while and may use several GB of disk space."
  if (-not (Confirm-Step "Download $Model now?")) {
    throw "Model download cancelled by user."
  }

  Write-Step "Downloading $Model"
  & $ollamaPath pull $Model
}

Write-Step "Verifying local model"
$installedModels = Get-InstalledModels
if ($installedModels -notcontains $Model) {
  throw "Model $Model was not found after download."
}

Write-Step "ZAIA local LLM configuration"
Write-Host "Base URL: $BaseUrl"
Write-Host "Model:    $Model"
Write-Host ""
Write-Host "The plugin defaults already match these values."
Write-Host "If you changed Zotero preferences manually, set Ollama base URL to $BaseUrl and model to $Model."
Write-Host ""
Write-Host "Done."
