# ZAIA Ollama app setup

This folder contains the platform launchers used when ZAIA cannot find a local
Ollama installation. The helpers install only the Ollama desktop app. Chat and
embedding models are downloaded separately through ZAIA, where their progress
can be displayed and cancelled.

Each launch runs in its own temporary directory. The helper writes its final
state to `setup-result.json`, allowing ZAIA to react to success, cancellation,
or failure and to start and verify the local service automatically.

## Security

The setup does not execute a remotely downloaded shell or PowerShell script.
It downloads the current official desktop artifact directly from
`https://ollama.com/download` and verifies its platform signature before
installation:

- macOS: `Ollama-darwin.zip`, checked with `codesign` and Gatekeeper (`spctl`)
- Windows: `OllamaSetup.exe`, checked with `Get-AuthenticodeSignature` and the
  expected Ollama publisher

## Windows

ZAIA launches `setup-ollama-windows.cmd`, which opens the PowerShell helper and
waits for the signed Ollama installer to finish.

## macOS

ZAIA launches `setup-ollama-macos.command`. The verified app is installed to
`/Applications`, or to `~/Applications` when the system-wide directory is not
writable.

## Plugin defaults

```text
Ollama base URL:  http://localhost:11434
Ollama model:     qwen2.5:3b
Embedding model:  bge-m3:latest
```

During regular use ZAIA starts `ollama serve` silently when a local operation
needs it. ZAIA only stops a process that it started itself unless the user
explicitly chooses the complete termination action.
