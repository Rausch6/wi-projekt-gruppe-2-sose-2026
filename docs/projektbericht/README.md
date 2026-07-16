# ZAIA Projektbericht

Diese Fassung basiert auf dem bereitgestellten kompakten LaTeX-Template und dem
Projektstand im Repository vom 16. Juli 2026. Der Bericht verwendet Satoshi fuer
den Grundtext und Clash Display fuer Ueberschriften.

## Titeldaten

Modul, Semester, Betreuer, Projektteam und Abgabedatum sind vollstaendig auf der
Titelseite eingetragen. Die Teamnamen und Rollen stammen aus der im Plugin
enthaltenen Ueber-ZAIA-Seite. Technischer Funktionsumfang, Versionsangaben, Tests
und Architektur wurden aus Quellcode, Konfiguration und Repository-Historie
abgeleitet.

## Lokale Schriftdateien

Die Schriftdateien werden aufgrund ihrer Fontshare-Lizenz nicht im oeffentlichen
Repository oder im weitergegebenen ZIP verteilt. Fuer die Kompilierung werden
folgende lokal vorhandenen OTF-Dateien erwartet:

```text
fonts/Satoshi_Complete/Fonts/OTF/Satoshi-Regular.otf
fonts/Satoshi_Complete/Fonts/OTF/Satoshi-Italic.otf
fonts/Satoshi_Complete/Fonts/OTF/Satoshi-Bold.otf
fonts/Satoshi_Complete/Fonts/OTF/Satoshi-BoldItalic.otf
fonts/ClashDisplay_Complete/Fonts/OTF/ClashDisplay-Medium.otf
fonts/ClashDisplay_Complete/Fonts/OTF/ClashDisplay-Semibold.otf
fonts/ClashDisplay_Complete/Fonts/OTF/ClashDisplay-Bold.otf
```

## Kompilieren

Mit einer lokalen XeLaTeX-Installation:

```bash
latexmk -xelatex main.tex
```

Oder mit Tectonic:

```bash
tectonic main.tex
```

pdfLaTeX wird wegen der eingebundenen OTF-Schriften nicht unterstuetzt. Eine
bereits lokal kompilierte Fassung liegt als `main.pdf` bei. Das verteilte ZIP
enthaelt bewusst keine Fontdateien und ist deshalb ohne die oben genannten
lokalen Dateien nicht neu kompilierbar.

## Inhaltlicher Hinweis

Die Wettbewerbsanalyse verwendet verlinkte offizielle Produktquellen mit Stand
Juli 2026. Preise und Funktionsumfaenge externer Angebote koennen sich aendern
und sollten unmittelbar vor der Abgabe noch einmal geprueft werden.
