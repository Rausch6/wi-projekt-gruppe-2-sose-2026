#!/bin/bash
set -euo pipefail

CHAT_MODEL="qwen2.5:3b"
EMBEDDING_MODEL="bge-m3:latest"
BASE_URL="http://localhost:11434"
INSTALL_COMMAND="curl -fsSL https://ollama.com/install.sh | sh"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUP_MODE="$(tr -d '\r\n' < "$SCRIPT_DIR/setup-mode.txt" 2>/dev/null || true)"
SETUP_MODE="${SETUP_MODE:-local-with-embedding}"

case "$SETUP_MODE" in
  embedding)
    INSTALL_CHAT_MODEL=false
    INSTALL_EMBEDDING_MODEL=true
    ;;
  local)
    INSTALL_CHAT_MODEL=true
    INSTALL_EMBEDDING_MODEL=false
    ;;
  local-with-embedding)
    INSTALL_CHAT_MODEL=true
    INSTALL_EMBEDDING_MODEL=true
    ;;
  *)
    echo "Unknown setup mode: $SETUP_MODE"
    exit 1
    ;;
esac

SETUP_OLLAMA_PID=""

cleanup() {
  if [ -n "$SETUP_OLLAMA_PID" ] && kill -0 "$SETUP_OLLAMA_PID" 2>/dev/null; then
    kill "$SETUP_OLLAMA_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT

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
  nohup "$ollama_path" serve >/tmp/zaia-ollama.log 2>&1 &
  SETUP_OLLAMA_PID=$!
}

installed_models() {
  "$OLLAMA_PATH" list 2>/dev/null | awk 'NR > 1 { print $1 }' || true
}

ensure_model_installed() {
  local model="$1"
  local label="$2"

  if installed_models | grep -Fxq "$model"; then
    step "$label already installed"
    echo "$model"
    return 0
  fi

  step "$label $model is not installed"
  echo "This download can take a while and may use several GB of disk space."
  if ! confirm "Download $model now?"; then
    echo "$label download cancelled by user."
    exit 1
  fi

  step "Downloading $model"
  "$OLLAMA_PATH" pull "$model"
}

verify_model_installed() {
  local model="$1"
  local label="$2"

  step "Verifying $label"
  if ! installed_models | grep -Fxq "$model"; then
    echo "$label $model was not found after download."
    exit 1
  fi
}

clear
echo "ZAIA Ollama Setup - macOS"
echo "Setup mode: $SETUP_MODE"
echo "This setup installs Ollama and downloads only the models needed for the selected ZAIA mode."
echo "ZAIA expects Ollama at $BASE_URL."

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

if [ "$INSTALL_CHAT_MODEL" = true ]; then
  ensure_model_installed "$CHAT_MODEL" "Chat model"
fi
if [ "$INSTALL_EMBEDDING_MODEL" = true ]; then
  ensure_model_installed "$EMBEDDING_MODEL" "Embedding model"
fi

if [ "$INSTALL_CHAT_MODEL" = true ]; then
  verify_model_installed "$CHAT_MODEL" "chat model"
fi
if [ "$INSTALL_EMBEDDING_MODEL" = true ]; then
  verify_model_installed "$EMBEDDING_MODEL" "embedding model"
fi

step "ZAIA local LLM configuration"
echo "Base URL:        $BASE_URL"
if [ "$INSTALL_CHAT_MODEL" = true ]; then
  echo "Chat model:      $CHAT_MODEL"
fi
if [ "$INSTALL_EMBEDDING_MODEL" = true ]; then
  echo "Embedding model: $EMBEDDING_MODEL"
fi
echo ""
echo "The plugin defaults already match these values."
echo "If you changed Zotero preferences manually, set the Ollama and embedding base URLs to $BASE_URL."
echo ""
echo "Done."
echo ""
read -r -p "Press Enter to close this window..."
