# Changelog

## 0.12.0 - 2026-10-26

- Added optional Agent internet tools: `web_search` (DuckDuckGo) and `fetch_url`.
- Internet is behind a separate **Net** toggle, off by default; web tools are not sent to the model unless enabled.
- Blocks loopback/private/local hosts and credentials; fetched content is truncated and treated as untrusted.
- The offline demo can keep Net off; no web tools are available in that mode.
- Added unit tests for web-tool gating, private URL rejection, and DuckDuckGo parsing.

## 0.11.0 - 2026-10-26

- Added experimental Agent mode in the chat footer.
- Added workspace tools: list_files, read_file, write_file, replace_in_file.
- File writes/edits require a diff preview and explicit Apply; paths outside the workspace and destructive traversal are rejected.
- Enabled QVAC tool calling in the generated model config.
- Agent mode has no internet, URL-fetch, or shell tool by design.
- Added unit tests for file tools and QVAC tool-call parsing.

## 0.10.0 - 2026-10-26

- Added a model download progress bar with downloaded / total size and percent.
- Added red **SLOW** warnings to larger catalog models and large cached models.
- Confirmed download progress with a fresh 382 MB model download; the finalized progress reported 382,156,480 / 382,156,480 bytes.
- Kept the minimal welcome/chat UI, cached-model list, and first-token timer.

## 0.9.0 - 2026-10-26

- Added detection of models already downloaded in `~/.qvac/models`, listed under **Already on this PC**; no repeated download.
- Added the model-cache path and an **Open models folder** action to setup.
- Stable header with one power button and reserved space; no Start/Stop layout jumping.
- Chat layout: user messages right, assistant messages left.
- Added a live "waiting for first token" timer and clearer streaming status for CPU latency.
- Reduced the default output cap to 256 tokens.
- Setup page shows a fixed feedback area and always-available local-file browser.

## 0.8.0 - 2026-10-26

- Polished the minimal sidebar UI: compact status labels ("Running", "Stopped"), friendly model label, and cleaner header actions.
- Added rendered UI previews for setup, chat, and Activity Bar placement.
- No change to the 0.7.0 trimmed QVAC bundle or model-download behavior.

## 0.7.0 - 2026-10-26

- Trimmed the bundled Windows QVAC runtime to the chat/LLM components and Vulkan/CPU backends.
- Removed unused QVAC image/speech/translation/OCR/audio addons and CUDA/HIP backend libraries from the bundled runtime.
- Reduced the bundled QVAC runtime from about 2.5 GB to about 631 MB installed and the Windows VSIX from ~1 GB to ~257 MB, while keeping QVAC LLM inference in the extension.
- The welcome page still lets the user download Qwen3 0.6B/1.7B or select a local GGUF; no model is preloaded.
- Added `scripts/slim-qvac-runtime.js` and integrated it into the Windows packaging job.

## 0.6.0 - 2026-10-26

- Replaced the chat-first default with a minimal welcome/setup page: download Qwen3 0.6B/1.7B or choose an existing local GGUF, then continue.
- Wrapped guidance around the first run: choose a model, click once, and the sidebar switches to chat when ready.
- Stopped bundling the default model in the Windows VSIX. The Windows package still bundles Node/npm and QVAC; the user downloads or supplies the model.
- Added a platform-aware QVAC lookup so the Windows bundle is never executed on Linux.
- Removed the previous decorative chat-first welcome content in favor of the compact setup/chat UI.
- Added automated coverage for the setup start path.

## 0.5.0 - 2026-10-26

- The Windows VSIX is now fully self-contained: Node.js 24.21.0, npm, the full QVAC CLI 0.16.0 with Windows natives, and the Qwen3-0.6B Q4_0 model are bundled.
- No QVAC or model download is required on Windows after installing the VSIX; only the Vulkan 1.4 driver remains a system prerequisite.
- Added platform-aware bundled-runtime selection so a Windows runtime is never used on Linux (and vice versa).
- Added a reproducible `scripts/prepare-bundled-qvac-win32.sh` and `scripts/prepare-bundled-model.sh`.
- Generic VSIX remains small and downloads QVAC/model on first setup.

## 0.4.0 - 2026-10-26

- Added a Windows self-contained VSIX that bundles Node.js 24.21.0 and npm 11.19.0.
- The extension now prefers the bundled Node runtime on Windows, with system Node/`localpilot.nodePath` still supported as fallbacks.
- QVAC/model setup remains one-click; no global npm install or separate Node install is needed for the Windows package.
- Added a reproducible `scripts/prepare-bundled-node.sh` and CI packaging for the Windows VSIX.
- Kept the generic VSIX for source/Linux use (requires system Node).

## 0.3.0 - 2026-10-26

- Added a LocalPilot Activity Bar sidebar webview for chat, setup, model selection, and runtime actions.
- Added **Set Up LocalPilot (QVAC + Model)**.
- Added automatic QVAC CLI installation into VS Code global storage when no supported global CLI exists.
- Added Node/npm preflight and a Node.js download action for setup errors.
- QVAC/model downloads are cued from the extension; Node.js and Vulkan remain system prerequisites.

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
