# Changelog

## 0.2.0 - 2026-10-26

- Added **Choose Model or Local GGUF** with a curated Qwen3 0.6B/1.7B/4B list.
- Added `localpilot.modelPath` for loading an existing llama.cpp-compatible GGUF file.
- Added a Model button to the chat panel and a model action to the status menu.
- Added local-model validation and a real GGUF integration test.
- Added 43 unit tests total.

## 0.1.0 - 2026-10-26

- Initial LocalPilot MVP.
- Managed QVAC CLI lifecycle on loopback with safe process-tree shutdown.
- Local chat webview with streaming responses and cancellation.
- Explain Selected Code using only the current editor selection.
- Runtime check command with QVAC doctor, server, alias, and cache diagnostics.
- Offline verification workflow and scripts.
- Unit tests, VS Code extension-host integration tests, and VSIX packaging.
