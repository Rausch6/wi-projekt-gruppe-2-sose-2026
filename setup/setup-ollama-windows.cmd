@echo off
setlocal
title ZAIA Ollama Setup

echo Starting ZAIA Ollama setup for Windows 11...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-ollama-windows.ps1"
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
