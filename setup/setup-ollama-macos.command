#!/bin/bash
set -euo pipefail

MODEL="qwen2.5:3b"
BASE_URL="http://localhost:11434"
INSTALL_COMMAND="curl -fsSL https://ollama.com/install.sh | sh"

step() {
  printf "\n==> %s\n" "$1"
}

confirm() {
  local question="$1"
  local answer
  while true; do
    read -r -p "$question [y/N] " answer
    case "$answer" in
      [YyJj]*) return 0 ;;
      [Nn]*|"") return 1 ;;
    esac
  done
}

find_ollama() {
  if command -v ollama >/dev/null 2>&1; then
    command -v ollama
    return 0
  fi

  local candidates=(
    "/usr/local/bin/ollama"
    "/opt/homebrew/bin/ollama"
    "/Applications/Ollama.app/Contents/Resources/ollama"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -x "$candidate" ]; then
      printf "%s\n" "$candidate"
      return 0
    fi
  done

  return 1
}

api_reachable() {
  curl -fsS "$BASE_URL/api/tags" >/dev/null 2>&1
}

wait_for_api() {
  local seconds="${1:-45}"
  local i

  step "Waiting for Ollama service at $BASE_URL"
  for ((i = 1; i <= seconds; i++)); do
    if api_reachable; then
      echo "Ollama service is reachable."
      return 0
    fi
    sleep 1
  done

  return 1
}

start_ollama() {
  local ollama_path="$1"

  if api_reachable; then
    return 0
  fi

  step "Starting Ollama in the background"
  if [ -d "/Applications/Ollama.app" ]; then
    open -a Ollama || true
  fi

  if ! api_reachable; then
    nohup "$ollama_path" serve >/tmp/zaia-ollama.log 2>&1 &
  fi
}

installed_models() {
  "$OLLAMA_PATH" list 2>/dev/null | awk 'NR > 1 { print $1 }' || true
}

clear
echo "ZAIA Ollama Setup - macOS"
echo "This setup installs Ollama, starts the local service, and downloads $MODEL."
echo "ZAIA expects Ollama at $BASE_URL with model $MODEL."

OLLAMA_PATH="$(find_ollama || true)"
if [ -z "$OLLAMA_PATH" ]; then
  step "Ollama was not found"
  echo "The official Ollama macOS install command is:"
  echo "  $INSTALL_COMMAND"
  if ! confirm "Install Ollama now?"; then
    echo "Installation cancelled by user."
    exit 1
  fi

  step "Installing Ollama"
  /bin/bash -c "$INSTALL_COMMAND"
  OLLAMA_PATH="$(find_ollama || true)"
fi

if [ -z "$OLLAMA_PATH" ]; then
  echo "Ollama CLI was not found after installation."
  echo "Opening the official download page as fallback..."
  open "https://ollama.com/download"
  echo "Please finish the Ollama installation manually and run this setup again."
  exit 1
fi

step "Using Ollama CLI"
echo "$OLLAMA_PATH"

start_ollama "$OLLAMA_PATH"
if ! wait_for_api; then
  echo "Ollama service did not become reachable at $BASE_URL."
  exit 1
fi

if installed_models | grep -Fxq "$MODEL"; then
  step "Model already installed"
  echo "$MODEL"
else
  step "Model $MODEL is not installed"
  echo "This download can take a while and may use several GB of disk space."
  if ! confirm "Download $MODEL now?"; then
    echo "Model download cancelled by user."
    exit 1
  fi

  step "Downloading $MODEL"
  "$OLLAMA_PATH" pull "$MODEL"
fi

step "Verifying local model"
if ! installed_models | grep -Fxq "$MODEL"; then
  echo "Model $MODEL was not found after download."
  exit 1
fi

step "ZAIA local LLM configuration"
echo "Base URL: $BASE_URL"
echo "Model:    $MODEL"
echo ""
echo "The plugin defaults already match these values."
echo "If you changed Zotero preferences manually, set Ollama base URL to $BASE_URL and model to $MODEL."
echo ""
echo "Done."
echo ""
read -r -p "Press Enter to close this window..."
