@echo off
setlocal
title ZAIA Ollama Setup

echo Starting ZAIA Ollama setup for Windows 11...
echo.

set "SETUP_MODE=local-with-embedding"
if exist "%~dp0setup-mode.txt" set /p SETUP_MODE=<"%~dp0setup-mode.txt"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-ollama-windows.ps1" -Mode "%SETUP_MODE%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo Setup finished with errors. Exit code: %EXIT_CODE%
) else (
  echo Setup finished successfully.
)
echo.
pause
exit /b %EXIT_CODE%
