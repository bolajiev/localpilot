# LocalPilot — Instructions for Coding Agents

## Mission

Build and validate **LocalPilot**, a Windows-first VS Code extension for private, CPU-first local AI coding assistance using **QVAC**. The target development machine is Windows 10/11 x64, 16 GB RAM, with no NVIDIA GPU. This is a hackathon MVP, not a full production IDE assistant.

The MVP is complete only when the extension can run a supported QVAC model locally, answer a chat prompt, explain selected code, and pass a real offline test after model assets have been cached.

## Read before changing code

1. Read this file, `README.md`, `MASTER_AGENT_PROMPT.md`, and `RESEARCH_NOTES.md`.
2. Inspect every existing project file before editing. Keep working code where possible; do not replace files wholesale without understanding them.
3. Verify the current installed QVAC SDK/CLI version and official documentation. QVAC APIs, model identifiers, and CLI flags can change. Treat examples in this repository as hypotheses until tested.
4. Keep a short `IMPLEMENTATION_LOG.md` updated with decisions, commands run, test results, and blockers.

## Product boundaries

### Required MVP features

- Check whether the QVAC runtime and configured model are available.
- Load/start one supported small quantized local model.
- Chat using a simple VS Code input flow and readable output (Output Channel or a basic webview; prioritize reliability over elaborate UI).
- Explain the active editor's selected code. If nothing is selected, show an actionable message; do not silently send the whole file.
- Stop/unload the runtime started by LocalPilot, when the chosen integration mode supports that safely.
- Friendly errors for missing QVAC CLI, unsupported model ID, Vulkan/runtime issues, model download failures, port conflicts, timeout, and offline cache misses.
- A documented offline test and honest report of whether it passed.

### Out of scope for the MVP

- No cloud inference or cloud fallback.
- No telemetry, remote analytics, prompt upload, remote code indexing, or external logging of user prompts/code.
- No automatic edits to workspace files. Suggestions are displayed as text; user must apply changes manually.
- No multi-agent autonomous coding, embeddings/RAG, or multi-model routing unless all required MVP tests already pass.
- No invented claims about speed, privacy, model quality, or hackathon eligibility.

## Critical platform gate

QVAC's published system requirements list Windows 10+ x64 and **Vulkan >= 1.4**, and state that Vulkan is required even for CPU-only inference. This is a gate, not a detail to ignore.

Before committing to the QVAC runtime:

1. Identify the actual Windows version and architecture on the development PC.
2. Check whether the active graphics driver/runtime supports the version required by the current QVAC release. Use the current official QVAC instructions and available tools; do not infer this from the absence of an NVIDIA GPU.
3. Install the documented QVAC CLI/SDK version and run the exact diagnostics that exist in that version (`qvac --help` first; do not assume a `doctor` subcommand exists).
4. Run a standalone QVAC model test outside VS Code before building more UI.
5. If the system gate fails, report the exact blocker and stop claiming the MVP works on that PC. Investigate a supported QVAC-compatible configuration or a documented fallback, but keep QVAC integration as the hackathon goal. Do not silently replace QVAC with another runtime and present it as QVAC.

## Architecture decision: prove the smallest vertical slice first

Prefer this order:

1. **Runtime spike:** Follow the current QVAC quickstart with the smallest suitable model and get one response from a standalone script or the documented local server.
2. **Server integration (preferred for MVP if supported):** Use the official QVAC CLI's documented OpenAI-compatible local HTTP server. Confirm its real CLI flags, config schema, default bind address, endpoint, model alias, and health/readiness behavior from the installed version/docs before implementing against them.
3. **Direct SDK alternative:** Use `@qvac/sdk` directly only if the actual package/API works in the current Windows Node.js environment. Confirm current exported names and function signatures from version-matched docs/examples or TypeScript declarations.
4. Keep the runtime behind a small adapter (for example, `src/qvacClient.ts`) so the extension UI does not depend on one transport implementation.

Never assume a copied endpoint, port, model ID, config property, SDK symbol, or CLI switch is correct merely because it appears in an old example. Pin and document the tested version.

## Model selection policy

- Start with one small text-instruct model, preferably a supported QVAC catalog model around the 0.6B–1.7B class if the installed registry provides one.
- Check the exact catalog identifier and license in current QVAC sources. Do not invent identifiers or claim that a generic Hugging Face GGUF can be loaded unless the current QVAC path supports it.
- If QVAC exposes a current model-fit/memory-assessment API, use it according to the version-matched signature before downloading/loading. Otherwise record the absence and use documented model/runtime guidance.
- A 4-bit model's file size is not its peak RAM use. Include runtime buffers, context/KV cache, VS Code, and other Windows applications when judging fit.
- Do not promise a tokens-per-second target before benchmarking the target machine. Measure cold start, model load, first-token latency if available, short-answer latency, throughput if available, and approximate peak RAM. Report measured values and test conditions.

## Implementation standards

- TypeScript with the supported VS Code Extension API. Use `@types/vscode` as a development dependency; do not add a runtime dependency on the `vscode` package unless current official tooling explicitly requires it.
- Use small modules with clear responsibilities, for example:
  - `src/extension.ts` — activation and command registration
  - `src/qvacClient.ts` — runtime transport adapter
  - `src/processManager.ts` — optional subprocess lifecycle and readiness checks
  - `src/privacy.ts` — local endpoint/config guardrails if useful
- Use the current official extension generator or known-compatible package versions. Keep `engines.vscode`, `package.json`, scripts, and TypeScript configuration consistent.
- On Windows, verify how the QVAC executable is resolved. npm-installed command shims may be `.cmd` files; do not assume `spawn('qvac', ...)` works identically on every shell. Prefer a safe, tested executable invocation. Avoid shell-string command construction and never interpolate user input into a shell command.
- If the extension starts a runtime, detect whether it is already running, avoid duplicate processes, monitor stdout/stderr safely, wait for readiness with a timeout, handle port conflicts, and shut down only the process tree owned by LocalPilot. Do not kill unrelated user processes.
- Bind the inference service to loopback (`127.0.0.1`) where configurable. Do not expose it to the LAN. Handle request timeouts and invalid JSON/API responses.
- Avoid logging selected source code, prompts, or model outputs. Diagnostic logs should contain status/error metadata, not user content.
- Never write model output directly into a file or execute it. Treat model output as untrusted text.
- Add tests for pure logic and mocked runtime errors. Use a real model for the final acceptance tests; mock tests alone do not prove local inference.

## Required phases and stop conditions

### Phase 0 — Inspect and report
- Inspect repository state and read official docs listed in `RESEARCH_NOTES.md`.
- Report exact Node/npm/VS Code/QVAC versions and Windows runtime prerequisite findings where possible.
- Make a short compatibility table: confirmed, failed, not yet checked.
- Do not start a major UI implementation before the standalone QVAC test succeeds or a blocker is clearly identified.

### Phase 1 — Runtime proof
- Install QVAC using current official instructions.
- Verify the actual CLI syntax and available model identifiers.
- Download/cache one small supported model while online.
- Generate at least one response from a standalone test or local HTTP endpoint.
- Save exact commands (without secrets) and outcomes in `IMPLEMENTATION_LOG.md`.

**Gate:** If standalone inference fails, investigate that first. Do not conceal it behind a polished extension UI.

### Phase 2 — Extension vertical slice
- Implement runtime status/check command.
- Implement start/load command (or document the manual server-start prerequisite if reliable child-process ownership is not yet solved).
- Implement chat command.
- Implement Explain Selected Code command.
- Implement stop/unload command only to the extent it is safe and verified.
- Ensure input and output errors are actionable.

### Phase 3 — Validation and privacy
- Run package install, type-check/compile, tests, and VS Code Extension Development Host smoke test.
- Run chat and code-explanation workflows using the real local model.
- Cache all model/runtime assets first, then disable Wi-Fi/Ethernet and retry from a fresh extension/runtime start.
- Confirm that the app makes no remote inference requests. Localhost HTTP calls to the QVAC process are allowed. Inspect logs and document the observation method.
- Test missing CLI, missing model, invalid endpoint, port collision, request timeout, empty prompt, and no selection.
- Record actual load latency, answer latency, RAM estimate, model name/version, runtime version, and offline outcome. Do not fill unknown values with guesses.

### Phase 4 — Package and submission
- Run the current VS Code packaging tool and create a `.vsix` only after compile/tests pass.
- Include installation instructions, supported system requirements, exact model identifier/license/source, offline workflow, known limitations, and a clear privacy statement backed by test evidence.
- Verify current official AI Yako rules, tracks, deadline, submission format, and any QVAC integration requirement directly on the official hackathon page. If the page is unavailable, explicitly mark any third-party schedule as unverified.
- Prepare a reproducible demo script: show runtime/model status, ask one prompt, explain selected code, disable network, repeat successfully, show test/benchmark notes.

## Acceptance checklist (all must be reported honestly)

- [ ] Current QVAC prerequisites on this Windows device verified.
- [ ] Exact QVAC version and model ID recorded.
- [ ] Standalone local inference succeeds.
- [ ] `npm install` or `npm ci` succeeds from a clean project state.
- [ ] TypeScript compile/type-check passes.
- [ ] VS Code Extension Development Host activates the extension.
- [ ] LocalPilot chat returns a response from the QVAC runtime.
- [ ] Explain Selected Code uses only the selected text and returns a response.
- [ ] Runtime/endpoint stays bound to loopback; no cloud fallback exists.
- [ ] Model remains usable after internet is disconnected and runtime/extension are restarted.
- [ ] Failure cases produce useful messages and do not hang indefinitely.
- [ ] Actual performance/memory measurements are reported, or explicitly marked unavailable.
- [ ] Packaging succeeds and submission requirements are verified or flagged unverified.

## Required final report from the coding agent

When work ends, provide:
1. What was implemented and which files changed.
2. Exact setup/run/test commands.
3. QVAC/Node/VS Code/model versions and exact model ID.
4. Each acceptance checkbox marked PASS, FAIL, or NOT TESTED with evidence.
5. Offline test result and how it was performed.
6. Measured performance and machine/runtime conditions.
7. Known issues, compatibility blockers, and the next most valuable task.
8. The output path for the working project and `.vsix`, if created.

Do not say “working,” “offline,” “private,” “tested,” or “ready to submit” unless the corresponding acceptance evidence exists.
