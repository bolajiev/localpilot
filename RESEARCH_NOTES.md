# LocalPilot Research Notes and Source Register

These notes are an engineering starting point, not proof that the project has been built or tested. Recheck current documentation because QVAC APIs, model catalogs, and CLI commands can evolve.

## Confirmed from official QVAC material reviewed for this brief

- QVAC describes itself as an open-source local AI SDK with Windows support and JavaScript/TypeScript and Python interfaces.
- The published system requirements page states Windows 10+, x64, and Vulkan >= 1.4; the page explicitly says Vulkan is required even for CPU-only inference.
- QVAC provides a CLI package, `@qvac/cli`, which depends on `@qvac/sdk`.
- The official QVAC CLI documentation shows a local HTTP server with an OpenAI-compatible chat-completions API. The example documentation says the server binds to `127.0.0.1:11434` by default; verify the current installed version before relying on that default.
- QVAC's model download lifecycle documentation describes provisioning catalog assets with `downloadAsset()` and a later `loadModel()` using cache when available, allowing a pre-downloaded model to load without contacting the registry.
- QVAC documents an `assessModelFit()` API to estimate whether candidate models fit available memory; verify its current exports and call signature before use.
- VS Code extensions can register commands using the Extension API, and VS Code provides an Extension Development Host for debugging.

## Important unknowns that must be answered during implementation

1. Does the user's exact Windows build and graphics driver satisfy the current QVAC Vulkan requirement?
2. Does the current QVAC SDK run properly inside the selected VS Code extension-host Node.js version, or is a separate CLI process more reliable?
3. What exact CLI flags, `qvac.config.json` schema, endpoint, model alias, and process behavior does the installed QVAC release support?
4. Is the model ID suggested in the starter (`QWEN3_600M_INST_Q4`) present in the installed/current model catalog? Do not assume so.
5. What are the actual download size, peak memory, load time, tokens/sec, and offline behavior on the target PC?
6. What are the current official AI Yako eligibility rules, track wording, deadline, and submission requirements? Verify on the official DoraHacks page. A third-party event listing is not sufficient evidence of current official rules.

## Official source URLs

- QVAC repository: https://github.com/tetherto/qvac
- QVAC examples: https://github.com/tetherto/qvac-examples
- QVAC SDK system requirements: https://docs.qvac.tether.io/sdk/system-requirements/
- QVAC HTTP server: https://docs.qvac.tether.io/cli/http-server/
- QVAC model download lifecycle: https://docs.qvac.tether.io/sdk/models/download-lifecycle/
- QVAC model fit assessment: https://docs.qvac.tether.io/sdk/models/assess-model-fit/
- VS Code Extension API: https://code.visualstudio.com/api
- VS Code extension getting started: https://code.visualstudio.com/api/get-started/your-first-extension
- Official AI Yako hackathon page: https://dorahacks.io/hackathon/ai-yako/detail

## Model strategy

Choose one small text-instruct model supported by the currently installed QVAC release. A 0.6B-class quantized model can be useful as an integration smoke test; a larger model may answer coding questions more capably but will be slower on CPU. Decide only after checking the current model catalog, model license, runtime support, memory-fit estimate, and an actual test run. A model's disk file size is not the same as peak RAM use.

## Offline test protocol

1. Install the extension and QVAC runtime while connected.
2. Download/cache the model and any required assets.
3. Confirm the model answers a simple prompt online.
4. Stop the QVAC server and close the Extension Development Host.
5. Disable Wi-Fi and Ethernet.
6. Restart the QVAC server and Extension Development Host; run chat and Explain Selected Code.
7. Capture logs and outcomes. A cached response, mocked response, or previously-running process does not count as proof of offline inference.
8. Mark PASS only if new local inference succeeds with external network access disabled. Otherwise report the exact failure.
