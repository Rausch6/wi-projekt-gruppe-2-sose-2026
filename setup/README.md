# ZAIA Ollama setup

This folder contains double-click setup helpers for the local ZAIA LLM runtime.

## Windows 11

Double-click:

```text
setup-ollama-windows.cmd
```

The script opens a classic terminal installer flow, asks before installing
Ollama, starts the local service, and downloads:

```text
qwen2.5:3b
bge-m3:latest
```

## macOS

Double-click:

```text
setup-ollama-macos.command
```

If macOS blocks the file because it is not executable, run once in Terminal:

```sh
chmod +x setup/setup-ollama-macos.command
```

## Plugin defaults

The plugin already uses the same local configuration:

```text
Ollama base URL:  http://localhost:11434
Ollama model:     qwen2.5:3b
Embedding model:  bge-m3:latest
```

If you changed these values in Zotero preferences, set them back to the values
above.
