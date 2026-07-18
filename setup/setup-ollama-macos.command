#!/bin/bash

# Bei Fehlern sofort abbrechen, nicht gesetzte Variablen melden und Fehler in
# Pipelines weiterreichen.
set -euo pipefail

# Zentrale Pfade und Statusvariablen für Download und Rückmeldung an ZAIA.
DOWNLOAD_URL="https://ollama.com/download/Ollama-darwin.zip"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULT_FILE="$SCRIPT_DIR/setup-result.json"
DOWNLOAD_DIR=""
RESULT_WRITTEN=false

write_result() {
  # Das Ergebnis wird zunächst temporär geschrieben und anschließend atomar
  # verschoben, damit ZAIA keine unvollständige JSON-Datei einliest.
  local status="$1"
  local code="$2"
  local temp_result="$RESULT_FILE.tmp"
  printf '{"status":"%s","code":"%s"}\n' "$status" "$code" > "$temp_result"
  /bin/mv -f "$temp_result" "$RESULT_FILE"
  RESULT_WRITTEN=true
}

finish() {
  # Speichert den Abschlussstatus und beendet das Setup mit dem gewünschten Code.
  write_result "$1" "$2"
  exit "${3:-0}"
}

cleanup() {
  # Entfernt temporäre Downloads und stellt auch bei unerwarteten Fehlern sicher,
  # dass ZAIA ein auswertbares Ergebnis erhält.
  if [ -n "$DOWNLOAD_DIR" ] && [ -d "$DOWNLOAD_DIR" ]; then
    rm -rf "$DOWNLOAD_DIR"
  fi
  if [ "$RESULT_WRITTEN" != true ]; then
    write_result "error" "installation-failed"
  fi
}

trap cleanup EXIT INT TERM

# Gibt einen gut sichtbaren Abschnitt im Terminal aus.
step() {
  printf "\n==> %s\n" "$1"
}

confirm() {
  # Akzeptiert neben englischem Y/N auch das deutsche J für Ja.
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
  # Prüft zuerst den PATH und danach die üblichen Installationsorte.
  if command -v ollama >/dev/null 2>&1; then
    command -v ollama
    return 0
  fi

  local candidates=(
    "/usr/local/bin/ollama"
    "/opt/homebrew/bin/ollama"
    "/Applications/Ollama.app/Contents/Resources/ollama"
    "$HOME/Applications/Ollama.app/Contents/Resources/ollama"
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

clear
# Informiert den Benutzer über den Umfang dieses Setups.
echo "ZAIA Ollama-App-Setup - macOS"
echo ""
echo "Dieses Setup installiert nur die Ollama-App."
echo "Modelle werden anschließend direkt in ZAIA ausgewählt und heruntergeladen."

OLLAMA_PATH="$(find_ollama || true)"
# Eine vorhandene Installation muss nicht erneut heruntergeladen werden.
if [ -n "$OLLAMA_PATH" ]; then
  step "Ollama ist bereits installiert"
  echo "$OLLAMA_PATH"
  finish "success" "already-installed"
fi

step "Ollama wurde nicht gefunden"
echo "Quelle: $DOWNLOAD_URL"
echo "Vor der Installation prüft macOS die Signatur und Freigabe der App."
if ! confirm "Offizielle Ollama-App jetzt herunterladen und installieren?"; then
  echo "Installation abgebrochen."
  finish "cancelled" "user-cancelled"
fi

# Das Download-Verzeichnis liegt neben dem Skript und wird beim Beenden entfernt.
DOWNLOAD_DIR="$(mktemp -d "$SCRIPT_DIR/download.XXXXXX")"
ARCHIVE_PATH="$DOWNLOAD_DIR/Ollama-darwin.zip"
APP_SOURCE="$DOWNLOAD_DIR/Ollama.app"

step "Offizielle Ollama-App wird heruntergeladen"
# curl folgt Weiterleitungen und bricht bei HTTP-Fehlern zuverlässig ab.
if ! /usr/bin/curl --fail --show-error --location --progress-bar \
  --output "$ARCHIVE_PATH" "$DOWNLOAD_URL"; then
  echo "Download fehlgeschlagen."
  finish "error" "download-failed" 1
fi

step "Download wird geprüft"
# Archivstruktur, Code-Signatur und Gatekeeper-Freigabe werden vor dem Kopieren
# der App geprüft.
if ! /usr/bin/unzip -q "$ARCHIVE_PATH" -d "$DOWNLOAD_DIR" || [ ! -d "$APP_SOURCE" ]; then
  echo "Das heruntergeladene Archiv ist ungültig."
  finish "error" "invalid-archive" 1
fi
if ! /usr/bin/codesign --verify --deep --strict "$APP_SOURCE"; then
  echo "Die Code-Signatur der Ollama-App ist ungültig."
  finish "error" "invalid-signature" 1
fi
if ! /usr/sbin/spctl --assess --type execute "$APP_SOURCE"; then
  echo "macOS hat die Ollama-App nicht als vertrauenswürdig freigegeben."
  finish "error" "not-notarized" 1
fi

INSTALL_ROOT="/Applications"
# Ohne Schreibrecht in /Applications wird benutzerspezifisch installiert.
if [ ! -w "$INSTALL_ROOT" ]; then
  INSTALL_ROOT="$HOME/Applications"
  /bin/mkdir -p "$INSTALL_ROOT"
fi
TARGET_APP="$INSTALL_ROOT/Ollama.app"

if [ -e "$TARGET_APP" ]; then
  echo "Am Installationsort existiert bereits eine unvollständige Ollama-App."
  finish "error" "target-exists" 1
fi

step "Ollama wird installiert"
# ditto erhält die Struktur und Metadaten des macOS-App-Bundles.
if ! /usr/bin/ditto "$APP_SOURCE" "$TARGET_APP"; then
  echo "Die Ollama-App konnte nicht nach $INSTALL_ROOT kopiert werden."
  finish "error" "install-failed" 1
fi

OLLAMA_PATH="$(find_ollama || true)"
# Abschließend wird geprüft, ob die installierte CLI tatsächlich auffindbar ist.
if [ -z "$OLLAMA_PATH" ]; then
  echo "Ollama wurde nach der Installation nicht gefunden."
  finish "error" "not-found-after-install" 1
fi

step "Ollama-App wurde installiert"
echo "$TARGET_APP"
# Startet die Desktop-App im Hintergrund; ein Startfehler macht die erfolgreiche
# Installation nicht rückgängig.
/usr/bin/open "$TARGET_APP" --args hidden >/dev/null 2>&1 || true
finish "success" "installed"
