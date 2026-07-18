@echo off

rem Dieses Startskript öffnet das eigentliche PowerShell-Setup mit einer
rem passenden Ausführungsrichtlinie und gibt dessen Ergebnis an ZAIA zurück.
setlocal
title ZAIA Ollama Setup

echo Starting ZAIA Ollama app setup for Windows...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-ollama-windows.ps1"

rem Der Exit-Code muss direkt nach PowerShell gespeichert werden, damit spätere
rem Befehle ihn nicht überschreiben.
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  rem Bei einem Fehler bleibt das Fenster offen, damit die Meldung lesbar ist.
  echo Setup finished with errors. Exit code: %EXIT_CODE%
  echo.
  pause
) else (
  echo Setup finished successfully.
)

rem Übergibt den ursprünglichen PowerShell-Exit-Code an den aufrufenden Prozess.
exit /b %EXIT_CODE%
