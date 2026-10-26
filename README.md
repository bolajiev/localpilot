# LocalPilot

LocalPilot is a Windows-first VS Code extension for private, CPU-first local AI coding help using [QVAC](https://qvac.tether.io). It starts a QVAC runtime, preloads one local model, provides a chat view in the VS Code Activity Bar sidebar, and explains only the code you explicitly select.

No cloud inference. No telemetry. No prompt or source-code logging. No automatic file edits. The runtime is bound to loopback.

Source and releases: **https://github.com/bolajiev/localpilot**

## Verification status

The complete extension was built, packaged, and exercised against a **real QVAC model** in this repository's development environment:

- Real QVAC CLI `0.16.0` with bundled SDK `0.22.0`, Node.js `24.21.0`, VS Code `1.143.1` test host, Linux x64, CPU backend (no Vulkan ICD).
- Activity Bar sidebar, managed start, runtime check, streaming chat, Explain Selected Code, managed stop, and loading an existing local GGUF passed in a VS Code Extension Host integration test.
- The private QVAC installer was verified with a real 3.3 GB install and managed-runtime resolution; its interactive confirmation prompt is not automated.
- Chat and code explanation passed again with external networking disabled in an isolated Linux network namespace.
- **Windows-specific execution and the Windows Vulkan 1.4 gate were not tested here.** The repository was developed in a Linux environment, not on the target Windows PC. Run the verification steps below on the target machine before claiming Windows support.

Measured results and the full acceptance matrix are in [`IMPLEMENTATION_LOG.md`](IMPLEMENTATION_LOG.md).

## Features and commands

| Command | Behavior |
| --- | --- |
| `LocalPilot: Set Up LocalPilot (QVAC + Model)` | One-click setup: installs a private QVAC runtime into VS Code storage if needed, writes the loopback config, downloads the model, and opens the sidebar. |
| `LocalPilot: Check Runtime` | Locates the QVAC CLI and Node.js, runs `qvac doctor`, checks the loopback server/model alias, and reports the Qwen GGUF cache. |
| `LocalPilot: Start / Load Local Model` | Writes a loopback-only QVAC config, starts `qvac serve --openai --no-default`, waits for the model to preload, and reports errors. The first catalog-model run downloads the model. If QVAC is missing, this offers the automatic install. |
| `LocalPilot: Choose Model or Local GGUF` | Opens a short model list (Qwen3 0.6B/1.7B/4B) or a file picker for an existing local `.gguf` model. Downloads happen only when you start the selected catalog model. |
| `LocalPilot: Chat with Local Model` | Focuses the LocalPilot Activity Bar sidebar and its streaming chat. Prompts and responses stay in memory and on this machine. |
| `LocalPilot: Explain Selected Code` | Sends only the current editor selection. With no selection it shows an actionable warning and sends nothing. Oversized selections are rejected. |
| `LocalPilot: Stop Runtime` | Unloads the model and stops the process tree **only if LocalPilot started it**. An external QVAC server is never killed; only its model may be unloaded after confirmation. |
| `LocalPilot: Show Diagnostics Log` | Shows status metadata and sanitized QVAC runtime lines. Prompt/code fields are filtered out. |

After installation, LocalPilot appears as a robot icon in the Activity Bar. Click it for the chat/setup sidebar. The status-bar item also opens all actions. The editor context menu includes **Explain Selected Code** when text is selected.

## Requirements

### Target machine

- Windows 10/11 x64.
- **Vulkan 1.4 or newer**, including CPU-only inference. Update the AMD/Intel/NVIDIA GPU driver. Verify with the Vulkan SDK's `vulkaninfo --summary`. A machine with no Vulkan 1.4-capable driver does not satisfy QVAC's published Windows requirement.
- Node.js `22.21+` on the 22.x line, or `24.9+`. QVAC's CLI declares these ranges. Node includes npm; LocalPilot uses it for the automatic QVAC install.
- VS Code `1.95+`.
- 16 GB RAM recommended. The tested model file is 382 MB, but the QVAC worker used about **1.5 GB RSS** during inference; Windows, VS Code, and the KV cache need memory too.
- Internet for the first setup only. LocalPilot downloads the QVAC runtime (about 3 GB) and then the model (about 382 MB by default). Later starts can use the cache offline.
- About 4 GB of free disk for QVAC plus the model, and extra room for VS Code and the KV cache.

### Verified development environment

Ubuntu 24.04.5 x64, 6 vCPU AMD EPYC, 11.68 GB RAM, no Vulkan ICD (Linux CPU fallback), Node.js 24.21.0, npm 11.19.0, QVAC CLI 0.16.0, VS Code 1.143.1.

## Windows setup

### 1. Install Node.js

```powershell
node --version
npm --version
```

Node.js 22.21+ (22.x) or 24.9+ is required. QVAC CLI does **not** need a manual global install: LocalPilot installs it privately under VS Code global storage on first **Set Up LocalPilot** or **Start**.

Advanced/offline users can preinstall the tested CLI manually:

```powershell
npm install -g @qvac/cli@0.16.0
qvac --version
qvac doctor
```

### 2. Verify Vulkan

Install the [LunarG Vulkan SDK](https://vulkan.lunarg.com) or use an existing Vulkan-capable GPU driver, then:

```powershell
vulkaninfo --summary
```

Require a Vulkan API version of 1.4 or newer. If only an older version is available, update the vendor graphics driver first.

### 3. Install the extension

**Download the prebuilt VSIX (recommended):**

Download the latest `localpilot-0.3.0.vsix` from:

```text
https://github.com/bolajiev/localpilot/releases/latest
```

Then install it:

```powershell
code --install-extension .\localpilot-0.3.0.vsix
```

Or in VS Code: **Extensions** → `...` → **Install from VSIX**.

**Build from source instead:**

```powershell
npm ci
npm run check
npm run package
code --install-extension .\localpilot-0.3.0.vsix
```

For development, open the folder in VS Code and press **F5** to launch the Extension Development Host. The `preLaunchTask` compiles TypeScript.

### 4. First run

Click the LocalPilot robot icon in the Activity Bar, or open the Command Palette and run **LocalPilot: Set Up LocalPilot (QVAC + Model)**.

1. If QVAC is missing, LocalPilot asks once to install it into VS Code storage. This downloads about **3 GB** and does not require administrator rights or a global npm install.
2. LocalPilot writes a loopback-only config, starts QVAC, and downloads the default model (about 382 MB). The progress notification is cancellable; cancelling stops the process LocalPilot started.
3. Optional: run **LocalPilot: Choose Model or Local GGUF** to pick a larger catalog model or an existing GGUF file.
4. Ask a question in the sidebar, or select code and run **LocalPilot: Explain Selected Code**.
5. Run **LocalPilot: Stop Runtime** to unload the model and stop the managed process.

The initial response can be slow on CPU. The default context is 4096 tokens and the default output cap is 384 tokens. Adjust `localpilot.maxOutputTokens` if needed.

### Why isn't everything inside the VSIX?

The QVAC runtime is roughly **3.3 GB installed** and contains platform-specific native binaries. Bundling it plus a model into every VSIX would create a very large, platform-specific package and still would not remove the Node/Vulkan system requirements. LocalPilot instead downloads the tested QVAC CLI once into VS Code storage, then downloads the model once. After that, the core workflow is offline-capable. Node.js and a Vulkan 1.4-capable driver are operating-system prerequisites that an extension cannot safely install for you.

## Offline use

LocalPilot can work offline after one successful online start, because QVAC caches the model under:

```text
%USERPROFILE%\.qvac\models
```

Use this procedure for a real offline check:

1. Connect to the internet and complete **Start / Load Local Model** plus one successful chat.
2. Confirm the response is new local inference, not a cached UI message.
3. Run **Stop Runtime**. Close the Extension Development Host (and VS Code, if using the installed extension).
4. Disable Wi-Fi and Ethernet.
5. Reopen VS Code / the Extension Development Host and run **Start / Load Local Model** again.
6. Run a chat prompt and **Explain Selected Code**. Check that both return new text.
7. Record the result. If the model or runtime tries to download anything, the offline test has not passed.

The repository includes `scripts/offline-test.sh` for Linux CI. It starts QVAC inside an isolated network namespace with only loopback, verifies external HTTPS/DNS are unavailable, loads the cached model, and runs real chat and explanation requests. It passed on the development host. Windows offline validation still needs to be performed manually on the target PC.

## Privacy and local-only behavior

- LocalPilot only constructs `http://` endpoints for `127.0.0.1`, `localhost`, or `::1`. Non-loopback hosts are rejected in settings and in the HTTP client.
- The managed server binds with `--host 127.0.0.1`. It is started with `--openai --no-default`, exposing the OpenAI-compatible text API rather than the full QVAC surface.
- No cloud API, fallback, telemetry, analytics, prompt upload, or external logging exists.
- LocalPilot never logs prompt text, selected code, or model output. The diagnostics channel logs status metadata and sanitized QVAC lines; lines containing content/message/prompt/code/input fields are dropped.
- Model output is displayed as text only. LocalPilot does not write it to files or execute it.
- Chat prompts and selections stay in extension memory. QVAC itself writes model files to `~/.qvac/models` and KV-cache data to `~/.qvac/kv-cache`.
- The loopback server has no API key by default. Other processes running as your user could call it. Stop the runtime when not needed.

## Model choices and loading a model you already have

Users without a model do **not** need a separate store: the default model downloads automatically on the first **Start / Load Local Model**. **Choose Model or Local GGUF** adds a small shopping-style list without building a full marketplace:

| Choice | Download | Notes |
| --- | --- | --- |
| Qwen3 0.6B Q4 | ≈ 382 MB | Tested default, fastest on CPU |
| Qwen3 1.7B Q4 | ≈ 1.01 GB | Stronger, slower, more RAM |
| Qwen3 4B Q4_K_M | ≈ 2.50 GB | Much slower on CPU; 16 GB is a minimum, not a guarantee |
| Existing local `.gguf` | None | Uses a model already on disk |

**If the model is already in QVAC's cache** (`~/.qvac/models`), simply start the matching catalog model; QVAC reuses the cached files and can start offline.

**If you have your own GGUF file**, choose **Use an existing local GGUF file…** and select it. LocalPilot writes an explicit QVAC entry:

```json
{
  "src": "C:\\models\\my-model.gguf",
  "type": "llamacpp-completion",
  "preload": true,
  "config": { "ctx_size": 4096 }
}
```

Requirements and caveats for local GGUF files:

- Must be a llama.cpp-compatible chat GGUF with a usable chat template. A file that works in another runtime may still fail or produce poor chat output here.
- The path must be absolute and readable by the same Windows user running VS Code.
- QVAC does **not** verify a local file against catalog checksums. You are responsible for the file's source, integrity, license, and memory fit.
- A 4-bit file size is not peak RAM. The tested 0.6B file used about 1.5 GB RSS in the QVAC worker.
- You can also set `localpilot.modelPath` manually. Clear it (or run **Reset to the default Qwen3 0.6B model**) to return to catalog downloads.

The model list is curated, not a live remote marketplace. A full live catalog browser can use QVAC's `/v1/models/catalog` endpoint later, but that endpoint requires a running server and adds complexity beyond this MVP.

## Default model

| Field | Value |
| --- | --- |
| QVAC catalog constant | `QWEN3_600M_INST_Q4` |
| Upstream source | [`unsloth/Qwen3-0.6B-GGUF`](https://huggingface.co/unsloth/Qwen3-0.6B-GGUF), commit `50968a4468ef4233ed78cd7c3de230dd1d61a56b`, file `Qwen3-0.6B-Q4_0.gguf` |
| License | Apache-2.0 |
| Size | 382,156,480 bytes (about 364 MiB) |
| Parameters / quantization | 0.6B / Q4_0 |
| Default context | 4096 tokens |
| Reasoning | Disabled by default (`reasoning_budget: false`) for CPU latency |
| API alias | `localpilot-model` |

The 0.6B model is intentionally small for CPU-first execution. It is useful for grounded explanations and short answers, but it is not a frontier coding model. On the tested shared 6-vCPU host, throughput was about **0.08-0.1 tokens/second**; do not treat that as a Windows performance prediction.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `localpilot.qvacPath` | empty | Optional path to `qvac.cmd`, the QVAC executable, or `dist/index.js`. Empty resolves `qvac` from PATH. |
| `localpilot.nodePath` | empty | Optional Node.js 22.21+/24.9+ executable. Empty resolves `node` from PATH. |
| `localpilot.host` | `127.0.0.1` | Loopback host only. |
| `localpilot.port` | `11434` | Local QVAC port. Restart the runtime after changing it. |
| `localpilot.modelId` | `QWEN3_600M_INST_Q4` | QVAC catalog constant used when `modelPath` is empty. |
| `localpilot.modelPath` | empty | Absolute path to an existing llama.cpp-compatible `.gguf` file. Takes precedence over `modelId`. |
| `localpilot.modelAlias` | `localpilot-model` | Alias used in OpenAI-compatible requests. |
| `localpilot.contextSize` | `4096` | Model context window (input plus output). |
| `localpilot.maxOutputTokens` | `384` | Maximum generated tokens per response. |
| `localpilot.temperature` | `0.2` | Sampling temperature. |
| `localpilot.enableReasoning` | `false` | Hybrid-model reasoning. Much slower on CPU. |
| `localpilot.maxSelectionChars` | `6000` | Hard limit for Explain Selected Code. Oversized selections are rejected. |
| `localpilot.startupTimeoutMs` | `1800000` | Allows 30 minutes for first download/load. |
| `localpilot.requestTimeoutMs` | `900000` | Per-response timeout. |
| `localpilot.autoStart` | `false` | If false, Chat/Explain asks before starting the runtime. |
| `localpilot.autoInstallQvac` | `true` | If QVAC is missing, offer to install it privately into VS Code storage. About 3 GB; requires Node/npm and internet. |
| `localpilot.stopOnExit` | `true` | Stop a LocalPilot-managed process when VS Code shuts down. External servers are never killed. |

## How it works

```text
VS Code webview / commands
        |
        v
src/extension.ts  ---- conversation, selection guard, prompts
        |
        v
src/runtimeManager.ts ---- spawn, readiness, process ownership, stop
        |          \
        |           `-- src/runtimeLocator.ts  (qvac.cmd/node resolution)
        v
src/qvacClient.ts ---- loopback HTTP + SSE parsing
        |
        v
qvac serve --openai --no-default -c <globalStorage>/qvac.config.json
        |
        v
Qwen3-0.6B GGUF (QVAC cache)
```

- The extension writes its own `qvac.config.json` under VS Code global storage. It does not modify a workspace config.
- `preload: true` means QVAC's port stays closed until the model is loaded, which gives a reliable readiness signal.
- On Windows, LocalPilot resolves the npm `.cmd` shim to the CLI's JavaScript entry point and runs it with `node.exe`. It avoids shell-string command construction. `.cmd` shims are not spawned directly.
- On POSIX, the QVAC process is started in its own process group; shutdown sends `SIGTERM`/`SIGKILL` to the group. On Windows, `taskkill /PID <pid> /T /F` is used for the process tree owned by LocalPilot.
- An already-running QVAC server is reused only if it exposes the configured alias. It is marked **external** and is never killed by LocalPilot.

## Development and tests

```powershell
npm ci
npm run typecheck
npm test
npm run check
```

`npm test` runs 43 unit tests covering SSE parsing, catalog/local config generation, prompt/selection limits, error mapping, sanitizer behavior, runtime locator helpers, and the QVAC HTTP client (including timeout and 404/502 paths).

Linux extension-host integration test (downloads a VS Code test build on first run):

```bash
xvfb-run -a npm run test:integration
```

It verifies command registration, missing-CLI and port-conflict errors, managed start, `qvac doctor`, `/v1/models`, real streaming inference, the panel send path, empty-selection behavior, the actual **Explain Selected Code** command, managed stop, and restarting with a user-supplied local GGUF file.

Real-runtime smoke scripts:

```bash
npm run compile
node scripts/chat-smoke.js "Reply with exactly: LocalPilot online"
node scripts/explain-smoke.js
bash scripts/offline-test.sh
```

Use `LOCALPILOT_MAX_TOKENS` / `LOCALPILOT_TIMEOUT_MS` to keep CI CPU runs short.

Packaging:

```powershell
npm run package
```

## Troubleshooting

See [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) for detailed Windows guidance. Quick answers:

| Symptom | Action |
| --- | --- |
| QVAC CLI was not found | Use **Set Up LocalPilot** to install it privately, or manually install `npm install -g @qvac/cli@0.16.0` and reopen VS Code. |
| Unsupported Node.js | Install Node 22.21+ or 24.9+, set `localpilot.nodePath`, reopen VS Code. Node/npm are required for the automatic QVAC install. |
| Vulkan/runtime failure | Update the GPU driver; `vulkaninfo --summary` must report Vulkan 1.4+. Required even for CPU. |
| Port already in use | Stop the other service or change `localpilot.port`. LocalPilot will not kill an unknown server. |
| First setup fails while offline | QVAC and the model are not cached. Connect once, complete **Set Up LocalPilot**, then retest offline. |
| Automatic QVAC install fails | Check internet, free disk (about 4 GB+), and Node/npm. The diagnostics log has the npm error tail. Manual fallback: `npm install -g @qvac/cli@0.16.0`. |
| `model_not_found` | Start the runtime from LocalPilot, or add `localpilot-model` to the external server's `qvac.config`. |
| Local GGUF not found / invalid | Pick the file again with **Choose Model or Local GGUF**; it must be an absolute path to a non-empty `.gguf` file. |
| Local GGUF loads but chat is poor/fails | It may be incompatible with QVAC's llama.cpp chat template or too large; use the tested Qwen3 0.6B default to isolate the issue. |
| Checksum failure | Remove the incomplete model from `~/.qvac/models`, reconnect, and start again. |
| Model fit / out of memory | Close other apps, lower `localpilot.contextSize`, or use a smaller model. |
| Response timeout | Raise `localpilot.requestTimeoutMs`, shorten the prompt, or disable reasoning. |
| External server left running | Run **Stop Runtime** unloads the model only. Stop the external process yourself; LocalPilot does not own it. |
| Need to kill an orphan Windows QVAC process | Find the PID in Task Manager, then `taskkill /PID <pid> /T /F`. |

## Hackathon notes

The official AI Yako rules were checked on 2026-10-26. The event requires a repository link, a demo video, and meaningful QVAC use with the core AI feature working with the internet off. Remote participation is allowed. See [`docs/DEMO.md`](docs/DEMO.md) and [`docs/HACKATHON.md`](docs/HACKATHON.md).

Recommended track: **Offline AI apps**.

## Known limitations

- Windows execution is unverified in this repository. The Vulkan 1.4 gate is the highest-risk Windows blocker.
- CPU latency is high in the shared CI environment; measure the target PC.
- One active model and alias. The model chooser rewrites the config and restarts the runtime; there is no multi-model routing, RAG, embeddings, agent loop, or automatic file edit.
- The first setup is not fully offline: it downloads the QVAC runtime (~3 GB) and then the model. Node.js and Vulkan 1.4 remain system prerequisites and are not bundled.
- The automatic installer is tested as a real 3.3 GB npm install and through managed-runtime resolution, but its interactive modal prompt is not automated in CI.
- The model chooser is a curated shortlist, not a live model marketplace. Local GGUF loading bypasses QVAC checksum validation.
- Reasoning is disabled by default; enabling it can consume the entire output budget.
- The chat send path and Explain command are automated through the VS Code extension host; the raw webview button-click event itself is not simulated.
- QVAC 0.16.0 is pinned/tested. Newer CLI releases may change flags or behavior.
- The QVAC server is unauthenticated on loopback by default, like most local model servers.
- Model and KV caches can consume disk; QVAC stores them under `~/.qvac`.

## License

LocalPilot source code: MIT. Qwen3-0.6B model: Apache-2.0.
