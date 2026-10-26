# Implementation Log

This log records actual work, commands, and outcomes. The initial uploaded pack contained only the documents and no starter source code despite the README referring to `src/extension.ts`; the extension was implemented from scratch.

## Environment

### Development/verification host (actual)

- OS: Ubuntu 24.04.5 LTS x64 (not Windows)
- CPU: AMD EPYC Processor (6 vCPU allocated)
- RAM: 11.68 GB total, ~4 GB available at the first QVAC spike
- Graphics / Vulkan: `qvac doctor` reported **Vulkan ICD not found**; QVAC used the Linux CPU fallback. No GPU acceleration was available.
- Node.js: v24.21.0
- npm: 11.19.0
- VS Code test host: 1.143.1 (`@vscode/test-electron` stable), commit `e646868227c3e3a9e3f24277c8c7220be42c0be7`
- QVAC CLI: 0.16.0 (`@qvac/cli`, global install)
- QVAC SDK bundled by the CLI: 0.22.0
- QVAC model: `QWEN3_600M_INST_Q4` (`Qwen3-0.6B-Q4_0.gguf`), 382,156,480 bytes, Apache-2.0
- Model source: `unsloth/Qwen3-0.6B-GGUF` commit `50968a4468ef4233ed78cd7c3de230dd1d61a56b`

### Target host (not available here)

- Windows version/build: **NOT TESTED**
- Windows CPU/RAM: **NOT TESTED**
- GPU/driver and Vulkan version: **NOT TESTED**
- Windows Node/npm/VS Code: **NOT TESTED**

QVAC's current published requirement is Windows 10+ x64 with **Vulkan >= 1.4, required even for CPU-only inference**. This is the highest-risk remaining gate. Do not claim Windows support until `vulkaninfo --summary` and a real Windows run pass.

## Compatibility spike

Official material reviewed:

- QVAC repository: https://github.com/tetherto/qvac
- QVAC system requirements: https://docs.qvac.tether.io/sdk/system-requirements/
- QVAC HTTP server: https://docs.qvac.tether.io/cli/http-server/
- QVAC download lifecycle: https://docs.qvac.tether.io/sdk/models/download-lifecycle/
- QVAC model fit: https://docs.qvac.tether.io/sdk/models/assess-model-fit/
- Official AI Yako page: https://dorahacks.io/hackathon/ai-yako/detail

Confirmed facts used by the implementation:

- CLI package: `@qvac/cli@0.16.0`, depends on `@qvac/sdk@0.22.0`.
- CLI engine requirement: Node `^22.21.0 || >=24.9.0`.
- `qvac serve --openai --no-default` exposes `/v1/*` on `127.0.0.1:11434` by default.
- `serve.models` aliases are the API `model` names.
- `preload: true` keeps the port closed until every preload model is ready.
- `GET /v1/models` reports configured aliases; `DELETE /v1/models/:alias` unloads.
- `reasoning_budget: false` disables hybrid-model thinking.
- Model constants include `QWEN3_600M_INST_Q4`; `qvac configure --yes` selects it as the chat starter.

Commands run and results:

```text
qvac --version                  -> 0.16.0
qvac doctor                     -> exit 0
                                   warning: Vulkan ICD not found; CPU inference fallback on Linux
qvac configure --yes (temp)     -> wrote qwen3-600m-inst-q4 and whisper-tiny-q8-0
qvac serve --openai --no-default -c /tmp/qvac-spike/qvac.config.json -p 11434 -H 127.0.0.1
```

First cold run downloaded the 382 MB GGUF and made the server ready in about 96 seconds (observed while downloading). Warm cached starts took 18.9-29.6 seconds depending on host load.

Standalone real inference:

```text
POST /v1/chat/completions (non-streaming, reasoning_budget=false)
-> "LocalPilot online."
  5 completion tokens, 51.37 s wall, server ttft=9605 ms, tps=0.1, backend=cpu
```

Streaming through LocalPilot's `QvacClient`:

```text
node scripts/chat-smoke.js "Reply with exactly: LocalPilot online"
-> "LocalPilot online."
  5 tokens, first delta 11603 ms, elapsed 64279 ms, finish=stop
```

Explain prompt through LocalPilot's prompt builder and client:

```text
node scripts/explain-smoke.js (16-token cap)
-> "The JavaScript function `retry` attempts to call a function `fn` a specified"
   first delta 6511 ms, elapsed 69165 ms, finish=length (cap), 16 completion tokens
```

The explanation was truncated only because the CI cap was deliberately set to 16 tokens to keep the CPU test bounded. The default extension cap is 384 tokens.

## Build and test history

| Date/time (UTC+1) | Command or test | Result | Notes/evidence |
|---|---|---|---|
| 2026-10-26 06:54 | `npm install -g @qvac/cli@0.16.0` | PASS | 324 packages; CLI 0.16.0 |
| 2026-10-26 06:57 | `qvac doctor` | PASS (with CPU warning) | exit 0; no Vulkan ICD, Linux CPU fallback |
| 2026-10-26 06:58 | QVAC first model download | PASS | 382,156,480-byte GGUF cached in `~/.qvac/models` |
| 2026-10-26 06:59 | First curl chat | PASS | 5 tokens, 51.37 s, backend=cpu |
| 2026-10-26 07:20 | `npm install` (project) | PASS | dev dependencies installed |
| 2026-10-26 07:24 | `npm test` | PASS | 41/41 unit tests |
| 2026-10-26 07:30 | `xvfb-run -a npm run test:integration` (first) | PASS | start 31.9 s; chat 6 tokens 81.7 s; stop 0.7 s |
| 2026-10-26 07:40 | Integration suite with failure paths and Explain command | PASS | see below |
| 2026-10-26 07:36 | `scripts/offline-test.sh` | PASS | isolated network namespace; chat and explanation |
| 2026-10-26 07:47 | `npm run check` | PASS | typecheck + 41 unit tests + webview CSP/script check |
| 2026-10-26 07:50 | `npm run package` | PASS | `localpilot-0.1.0.vsix` produced |
| 2026-10-26 07:55 | `rm -rf node_modules && npm ci` | PASS | clean install from lockfile |
| 2026-10-26 07:56 | `npm run check` after clean install | PASS | 41/41 unit tests, webview check |
| 2026-10-26 07:58 | Final integration rerun | PASS | start 28.5 s; chat 68.9 s; Explain 160.8 s; stop 0.7 s |
| 2026-10-26 07:59 | VSIX install into isolated VS Code profile | PASS | listed as `localpilot.localpilot@0.1.0` |
| 2026-10-26 08:05 | Verification rerun after log-privacy tightening | PASS | start 29.9 s; chat 77.0 s; Explain 169.6 s; stop 1.1 s |
| 2026-10-26 08:20 | Integration rerun after final panel error wrapper | PASS | start 24.8 s; chat 48.5 s; Explain 174.4 s; stop 0.7 s |
| 2026-10-26 08:30 | Integration rerun with panel chat send path | PASS | start 23.8 s; chat 76.8 s; Explain 188.8 s; stop 0.9 s |
| 2026-10-26 | Windows clean install/start/chat/explain/offline | NOT TESTED | no Windows host |

### Integration test details

The second VS Code Extension Host run passed:

```text
[integration] extension activated, version=0.1.0
[integration] all commands registered
[integration] testing missing-CLI error path
[integration] missing-CLI error path passed
[integration] testing port-conflict error path
[integration] port-conflict error path passed
[integration] starting the managed runtime for real inference
[integration] managed runtime ready in 18937 ms at http://127.0.0.1:11434 (pid 447106)
[integration] OpenAI-compatible /v1/models probe passed
[integration] checkRuntime passed: qvac=0.16.0 node=24.21.0 doctor=true
[integration] real local inference passed in 68861 ms: chars=26 tokens=6 finish=stop
[integration] opening the chat panel and testing empty-selection handling
[integration] empty-selection handling passed
[integration] running Explain Selected Code through the VS Code command (16-token cap)
[integration] Explain Selected Code command passed in 177015 ms: chars=61
[integration] managed runtime stopped in 634 ms
Exit code: 0
```

This run exercised the real VS Code command `localpilot.explainSelection` with a real editor selection and the real local model. The 16-token setting was used only to bound CI time.

A final rerun with the packaged code passed again, including the chat panel send path through the extension API:

```text
managed runtime ready in 23847 ms (pid 453238)
checkRuntime passed: qvac=0.16.0 node=24.21.0 doctor=true
real local chat passed in 76784 ms: chars=26 text="LocalPilot integration OK."
empty-selection handling passed
Explain Selected Code command passed in 188795 ms: chars=61
managed runtime stopped in 857 ms
Exit code: 0
```

The generated VSIX was installed into a separate VS Code extensions directory and listed as `localpilot.localpilot@0.1.0`. The final artifact is `localpilot-0.1.0.vsix` (about 61 KB); its SHA-256 is recorded in the final delivery report.

### Automated coverage

- 41 unit tests: SSE stream parser, config validation/writing, prompt selection caps and trimming, error mapping, model cache scan, runtime locator shim/version helpers, sanitizer, QVAC client streaming/blocking/404/502/timeout/loopback guards.
- Extension-host integration: command registration, missing CLI, port collision, managed start, doctor, alias probe, real chat inference through the panel send path, empty selection, real Explain command, managed stop.
- Offline script: fresh QVAC process with only loopback, real chat and explanation.

## Offline validation

- Model/cache primed while online: yes, one successful online start plus chat and explanation.
- Network disabled by: `unshare -n`, then `ip link set lo up` inside the namespace. The script verified external HTTPS and DNS were unreachable before starting QVAC.
- Fresh runtime restart: yes, a new `qvac serve` process was started inside the isolated namespace from the existing cache.
- Extension host restart under the same network namespace: **NOT TESTED**. The offline test used LocalPilot's compiled `QvacClient` and prompt code via `scripts/chat-smoke.js` / `scripts/explain-smoke.js`, not the VS Code UI process.
- Chat result: PASS. 6 completion tokens; first delta 8096 ms; elapsed 54.7 s; output "LocalPilot offline OK."
- Explain Selected Code result: PASS. 12 completion tokens; first delta 12572 ms; elapsed 143.3 s; relevant explanation began "The JavaScript function `retry` attempts to call a function..." (truncated by the 12-token CI cap).
- External network calls observed: none; HTTPS/DNS were unavailable and cache load succeeded.
- Final outcome: **core offline inference PASS on Linux**. Windows offline and VS Code-UI-offline remain NOT TESTED.

## Benchmarks (observed on this host)

These numbers are for the shared 6-vCPU Linux host with QVAC CPU backend. They are not Windows predictions.

- Cold start (first run, includes 382 MB download): ~96 s to server ready.
- Warm managed start in extension host: 18.9 s (another warm run: 29.6 s).
- Offline cached start: 22.0 s.
- First streaming delta: 6.5-12.6 s depending on prompt.
- Chat completion: 5 tokens / 64.3 s; 6 tokens / 54.7-68.9 s.
- Explanation: 16 tokens / 69.2-177.0 s; 12 tokens / 143.3 s.
- Throughput: approximately 0.08-0.1 tokens/second.
- Model file: 382,156,480 bytes.
- QVAC worker RSS during inference: ~1.5 GB; CLI process ~140 MB. Approximate combined QVAC footprint: ~1.65 GB.
- Context: 4096; output cap in automated runs: 8-16 tokens (production default 384); reasoning disabled; temperature 0 for tests.

## 0.2.0 model-source enhancement (2026-10-26)

- Added **Choose Model or Local GGUF** (curated Qwen3 0.6B/1.7B/4B list + file picker).
- Added `localpilot.modelPath` and explicit QVAC `{ src, type: "llamacpp-completion" }` config generation.
- Added local-file validation (absolute path, `.gguf`, exists, non-empty) and check-report support.
- Manually verified the exact local-GGUF QVAC config on a fresh server (port 11436): model state `ready`, 3 real tokens returned in 19.2 s.
- Extension-host integration test now also stops the catalog model, starts a local GGUF path, runs `checkRuntime`, performs 2 real tokens, and stops.
- Unit tests increased from 41 to 43 (local config generation, local file validation).

Final 0.2.0 integration evidence:

```text
[integration] extension activated, version=0.2.0
[integration] managed runtime ready in 23300 ms (pid 475348)
[integration] real local chat passed in 60540 ms: text="LocalPilot integration OK."
[integration] Explain Selected Code command passed in 140384 ms
[integration] managed runtime stopped in 635 ms
[integration] local GGUF start+inference passed in 39766 ms
Exit code: 0
```

The 0.1.0 build history above remains accurate for that version. The 0.2.0 build supersedes its artifact and adds the model-source feature. The final 0.2.0 VSIX is `localpilot-0.2.0.vsix`; its checksum is in the final delivery report. Windows execution, Vulkan 1.4, and Windows offline behavior are still **NOT TESTED**.

## Key engineering decisions

- **CLI server integration, not in-process SDK**: the extension spawns the documented local OpenAI-compatible server. This isolates QVAC's native worker from the VS Code extension host and matches the version-pinned CLI surface.
- **Pinned tested runtime**: `@qvac/cli@0.16.0`; a different installed version produces a warning.
- **Safe Windows launch**: resolve `qvac.cmd` to `node_modules/@qvac/cli/dist/index.js` and spawn `node.exe` with an argument array. No shell string is constructed.
- **Readiness**: rely on QVAC's preload behavior (port stays closed until the model is ready), then verify the configured alias in `/v1/models`.
- **Process ownership**: managed processes use a POSIX process group or `taskkill /T` on Windows. External servers are never killed.
- **Privacy**: loopback-only endpoint guard; no telemetry; prompt/code/output never logged; sanitizer drops sensitive runtime log fields.
- **Model choice**: 0.6B Q4 for CPU-first fit. Reasoning is disabled by default because it consumes the output budget and is very slow on CPU.

## GitHub publication and release

- Repository: https://github.com/bolajiev/localpilot (public)
- Initial GitHub Actions run `40319070398`: PASS (clean install, typecheck, 43 unit tests, webview check, VSIX package, artifact upload) in 19 s.
- Release download: https://github.com/bolajiev/localpilot/releases/latest
- The release asset is the tested `localpilot-0.2.0.vsix`; its checksum is in the final delivery report.
- Repository includes the VS Code extension source, tests, docs, and build workflow. The VSIX itself is a release asset, not committed source.

## Remaining blockers and next tasks

1. **Windows/Vulkan gate**: run on the actual Windows PC, verify Vulkan 1.4+, install/test the VSIX, and repeat chat/explain/offline there.
2. **Test the model chooser and a Windows local GGUF path** on that PC.
3. **Record the required offline demo video** on the target device with networking visibly disabled and a fresh runtime start.
4. **Measure Windows latency/RSS** and replace the Linux-only numbers in the submission.
5. Push the repository and add the link plus demo video to the DoraHacks Build before 2026-10-30 14:00 UTC.

## Submission checklist

- [x] Current official hackathon rules checked (2026-10-26)
- [x] Clean dependency install and TypeScript compile pass
- [x] Unit tests pass (43/43)
- [x] Extension Host smoke test pass (Linux)
- [x] Real QVAC inference pass (Linux CPU)
- [x] Existing local GGUF model load + real inference pass (Linux)
- [x] Explain Selected Code command pass (Linux, 16-token cap)
- [x] Managed start/stop and readiness pass
- [x] Missing CLI and port conflict error paths pass
- [x] Empty selection produces no request
- [x] Core offline inference pass (Linux, isolated network namespace)
- [ ] Windows Vulkan 1.4 / clean install / inference / offline: NOT TESTED
- [ ] VS Code UI offline restart: NOT TESTED
- [x] VSIX generated: `localpilot-0.2.0.vsix` (supersedes 0.1.0)
- [x] VSIX install verified for the final package
- [x] GitHub repository pushed and public
- [x] GitHub Actions build/test/package workflow passed
- [x] GitHub Release asset published for download
- [x] README, troubleshooting, demo, and hackathon notes updated
- [x] Webview CSP and script syntax check included in `npm run check`
- [ ] Demo video recorded
- [x] Repository pushed and release link verified
