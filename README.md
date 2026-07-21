# ZAIA – Zotero AI Assistant

ZAIA erweitert Zotero um einen KI-gestützten Assistenten für die Arbeit mit
wissenschaftlichen Publikationen. Das Add-on beantwortet allgemeine Fragen,
fasst Paper zusammen und durchsucht die eigene Zotero-Bibliothek nach
inhaltlich passenden Textstellen. Als Chat-Backend kann wahlweise KISSKI/SAIA
in der Cloud oder ein lokales Ollama-Modell verwendet werden.

## Funktionen

- Chat direkt in Zotero als Seitenleiste oder separates Pop-out-Fenster
- lokale Chat-Modelle über Ollama und Cloud-Modelle über KISSKI/SAIA
- kontextbezogene Fragen zu einzelnen, gefilterten oder allen Papern
- semantische, stichwortbasierte und hybride Suche in PDF-Inhalten
- automatische Kontextauswahl durch eine Router-KI mit regelbasierten Fallbacks
- Berücksichtigung von Zotero-Metadaten wie Titel, Autorenschaft, Jahr und Tags
- Unterstützung von persönlichen Bibliotheken und Gruppenbibliotheken
- lokaler Index-Manager zum Indexieren, Aktualisieren und Löschen von Papern
- lokale Speicherung von Chatverläufen und Favoriten in einer SQLite-Datenbank
- Tastaturkürzel für die wichtigsten Chat-Aktionen

## Funktionsweise

ZAIA trennt die Entscheidung über den benötigten Kontext von der eigentlichen
Antwort. Die Router-KI ordnet eine Anfrage zunächst einer von fünf Routen zu:
kein Zotero-Kontext, Metadaten, ein einzelnes Paper, gefilterte Paper oder die
gesamte Bibliothek. Anschließend sucht ZAIA nur im ausgewählten Bereich nach
passenden Informationen.

```text
Nutzerfrage
    │
    ▼
Router-KI ──► Kontextbereich bestimmen
    │
    ▼
lokale Suche in Metadaten und Paper-Auszügen
    │
    ▼
ausgewählte Quellen + Chatverlauf
    │
    ▼
lokales Ollama- oder KISSKI-Chat-Modell
    │
    ▼
Antwort in Zotero
```

Für die Paper-Suche extrahiert ZAIA den Text aus PDF-Anhängen, bereinigt ihn
und teilt ihn in überlappende Abschnitte. Das lokale Embedding-Modell
`bge-m3:latest` wandelt diese Abschnitte in Vektoren mit 1.024 Dimensionen um.
Orama speichert Text, Vektor, Seitenzahl und Zotero-Zuordnung in einem lokalen
Index. Bei einer Anfrage kombiniert ZAIA semantische Ähnlichkeit mit
Volltexttreffern und übergibt nur die relevantesten Auszüge an das Chat-Modell.

## Betriebsmodi und Voraussetzungen

- Zotero 9.0.4 oder neuer
- Windows oder macOS für das automatische Ollama-Setup
- Internetzugang für KISSKI und Modelldownloads
- ein KISSKI API-Key für den Cloud-Modus

| Chat-Modus | Semantische Suche | Benötigt                                               |
| ---------- | ----------------- | ------------------------------------------------------ |
| Cloud      | aus               | KISSKI API-Key, erreichbare Cloud-API und Cloud-Modell |
| Cloud      | an                | Cloud-Voraussetzungen, Ollama und `bge-m3:latest`      |
| Lokal      | aus               | Ollama und das ausgewählte lokale Chat-Modell          |
| Lokal      | an                | Ollama, lokales Chat-Modell und `bge-m3:latest`        |

Das lokale Standard-Chatmodell ist `qwen2.5:3b`. Weitere lokale Modelle können
im ZAIA-Modellfenster heruntergeladen und anschließend ausgewählt werden. Ist
die semantische Suche deaktiviert oder kann kein Embedding erzeugt werden,
verwendet ZAIA eine stichwortbasierte Volltextsuche.

## Einrichtung in Zotero

1. ZAIA installieren und Zotero neu starten.
2. Unter **Einstellungen → ZAIA** den gewünschten Chat-Provider konfigurieren.
3. Für KISSKI den API-Key eintragen, die Modelle laden und die Verbindung
   testen.
4. Für den lokalen Betrieb Ollama einrichten und ein Chat-Modell auswählen.
   Unter Windows und macOS kann ZAIA die signierte Ollama-Desktop-App
   installieren. Modelle werden danach getrennt über ZAIA heruntergeladen.
5. Die semantische Suche nach Bedarf aktivieren und `bge-m3:latest`
   bereitstellen.
6. Im Index-Manager die gewünschten Paper oder die Bibliothek indexieren.

ZAIA prüft Ollama erst vor einer lokalen Aktion. Ist Ollama installiert, aber
nicht erreichbar, startet das Add-on `ollama serve` im Hintergrund. Nur ein von
ZAIA gestarteter Prozess wird beim Herunterfahren wieder beendet. Ein bereits
extern laufender oder entfernter Ollama-Dienst bleibt unverändert.

> Nach dem Wechsel von der Stichwortsuche zur semantischen Suche müssen bereits
> indexierte Dokumente im Index-Manager neu aufgebaut werden. Erst dadurch
> erhalten sie echte Embedding-Vektoren.

## Datenschutz und lokale Daten

Embedding-Erzeugung, Suchindex und Chatverläufe bleiben in der
Standardkonfiguration lokal im Zotero-Datenverzeichnis. Der Orama-Index enthält
aufbereitete Paper-Auszüge und daraus abgeleitete Vektoren; Chats werden in
`zaia/zaia-chats.sqlite` gespeichert.

Bei Verwendung von KISSKI werden die Chatnachrichten und – sofern in den
Einstellungen aktiviert – die ausgewählten Paper-Auszüge an den konfigurierten
Cloud-Endpunkt übertragen. Wird KISSKI auch als Router verwendet, werden der
aktuelle Prompt und die freigegebenen Kandidaten-Metadaten übertragen. Der
Router erhält dabei weder den bisherigen Chatverlauf noch vollständige
PDF-Texte. Bei benutzerdefinierten entfernten Ollama- oder Embedding-Endpunkten
verlassen die entsprechenden Daten ebenfalls das lokale Gerät.

## Tastaturkürzel

Auf macOS wird `Cmd`, auf Windows und Linux `Ctrl` verwendet.

| Kürzel             | Aktion                                           |
| ------------------ | ------------------------------------------------ |
| `Cmd/Ctrl+Shift+I` | ZAIA öffnen, fokussieren oder schließen          |
| `Cmd/Ctrl+Shift+M` | neuen Chat starten                               |
| `Cmd/Ctrl+Shift+P` | Pop-out öffnen oder fokussieren                  |
| `Cmd/Ctrl+Shift+F` | aktiven Chat favorisieren oder Favorit entfernen |
| `Cmd/Ctrl+Shift+T` | Kontextfenster öffnen                            |
| `Cmd/Ctrl+Shift+D` | Modellauswahl öffnen oder fokussieren            |

Bekannte Zotero-Standardkürzel werden nicht registriert oder überschrieben.

## Entwicklung

```bash
git clone https://github.com/Rausch6/wi-projekt-gruppe-2-sose-2026.git
cd wi-projekt-gruppe-2-sose-2026
npm install
```

Für den Entwicklungsstart muss eine `.env` mit den lokalen Zotero-Pfaden
angelegt werden, insbesondere mit `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` und
`ZOTERO_PLUGIN_PROFILE_PATH`. Danach stehen folgende Befehle zur Verfügung:

```bash
npm start       # Zotero mit Hot Reload starten
npm test        # Unit- und Integrationstests ausführen
npm run build   # Add-on bauen und TypeScript prüfen
npm run lint:check
```

Die automatisierten Tests verwenden Mocks für Zotero, Ollama und KISSKI. Sie
benötigen daher keine Zotero-Installation, keinen API-Key, kein lokales Modell
und keine echte Paper-Sammlung.

## Projektstruktur

| Pfad                                       | Inhalt                                                  |
| ------------------------------------------ | ------------------------------------------------------- |
| [`addon/`](addon/)                         | Manifest, Oberflächen, Styles, Icons und Lokalisierung  |
| [`src/ai/`](src/ai/)                       | Provider für KISSKI, Ollama und Embeddings              |
| [`src/core/`](src/core/)                   | Routing, Indexierung, Retrieval und Chat-Persistenz     |
| [`src/ui/`](src/ui/)                       | Seitenleiste, Pop-out, Modell- und Indexfenster         |
| [`setup/`](setup/)                         | signaturgeprüfte Ollama-Installer für Windows und macOS |
| [`tests/unit/`](tests/unit/)               | isolierte Tests der Kernmodule                          |
| [`tests/integration/`](tests/integration/) | Tests der Provider- und Paper-Kontext-Pipelines         |

## Dokumentation

- [Router-KI](docs/router-ki.md) – Routen, Heuristiken und Fallbacks
- [Embedding-Modell](docs/Embedding.md) – Vektorisierung mit `bge-m3`
- [Orama](docs/orama.md) – lokaler Suchindex und Suchmodi
- [Indexierungsprozess](docs/indexing.md) – Verarbeitung vom PDF bis zum Index
- [Projektstruktur](docs/Projektstruktur.md) – Aufbau und Zuständigkeiten
- [Unit-Tests](docs/unit%20tests.md) und
  [Integrationstests](docs/integrationstests.md)
- [Shortcuts](docs/zaia-shortcuts.md)
- [Ollama-Setup](setup/README.md)

## Lizenz

ZAIA wird gemäß der Projektkonfiguration unter der MIT-Lizenz
veröffentlicht. Siehe [license.txt](license.txt) für Details.

---

_ZAIA · Gruppe 2 · WI-Projekt SoSe 2026_
