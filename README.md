# ZAIA – Zotero AI Assistant

ZAIA verbindet Zotero wahlweise mit KISSKI/SAIA oder einem lokalen
Ollama-Modell. Passende Paper-Auszüge können über eine lokale semantische
Suche ausgewählt werden.

## Voraussetzungen

- Zotero 9.0.4 oder neuer
- Windows oder macOS für das automatische Ollama-Setup
- Internetzugang für KISSKI und Modelldownloads
- KISSKI API-Key für den Cloud-Modus

## Setup- und Readiness-Logik

| Modus | Semantische Suche | Voraussetzungen                                        |
| ----- | ----------------- | ------------------------------------------------------ |
| Cloud | aus               | KISSKI API-Key, erreichbare Cloud-API und Cloud-Modell |
| Cloud | an                | Cloud-Voraussetzungen, Ollama und `bge-m3:latest`      |
| Lokal | aus               | Ollama und das ausgewählte Chat-Modell                 |
| Lokal | an                | Ollama, Chat-Modell und `bge-m3:latest`                |

Das lokale Standardmodell ist `qwen2.5:3b`. Weitere lokale Chat-Modelle werden
im ZAIA-Modellfenster heruntergeladen und erst danach auswählbar.

Wenn die semantische Suche deaktiviert ist, verwendet ZAIA eine
stichwortbasierte Suche. Im reinen Cloud-Modus wird Ollama dann weder geprüft
noch gestartet oder angesprochen.

## Ollama-Lifecycle

ZAIA prüft Ollama erst unmittelbar vor einer lokalen Aktion. Ist Ollama
installiert, aber nicht erreichbar, startet ZAIA `ollama serve` unsichtbar im
Hintergrund. Einen von ZAIA gestarteten Prozess beendet das Add-on beim
Herunterfahren wieder. Ein bereits extern laufender Ollama-Prozess wird weder
neu gestartet noch beendet.

Das automatische Prozess- und Installationsmanagement unterstützt derzeit
Windows und macOS. Benutzerdefinierte entfernte Ollama-Endpunkte werden nicht
lokal gestartet.

Nach einem Wechsel von stichwortbasierter zu semantischer Suche sollten bereits
keywordbasiert indexierte Dokumente über den Index-Manager neu aufgebaut werden,
damit sie echte Embedding-Vektoren erhalten.

## Entwicklung

```bash
npm install
npm test
npm run build
```

Die betriebssystemspezifischen Installationsskripte und ihre Modi sind unter
[`setup/`](setup/) dokumentiert.
