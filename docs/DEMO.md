# LocalPilot Demo Procedure (AI Yako)

This is a real-inference demo. Do not substitute mocked responses. The submission requires a recorded demo showing the core AI feature with internet disconnected.

## Pre-demo checklist (online)

1. Windows target is booted and `vulkaninfo --summary` reports Vulkan 1.4+.
2. The Windows `win32-x64` VSIX includes Node.js and QVAC; no separate Node/QVAC install is needed.
3. LocalPilot VSIX is installed; open the LocalPilot view in the Secondary Side Bar (right), or run **LocalPilot: Chat with Local Model**.
4. On first open, use the welcome page to download a model (Qwen3 0.6B is 382 MB) or select a local GGUF.
5. Leave **Net off** for the offline demo. Agent file tools still work; web search/fetch must not be used in the offline demonstration.
6. Model cache is primed:
   - Run **LocalPilot: Start / Load Local Model** with internet.
   - Run one chat prompt and one **Explain Selected Code**.
   - Confirm fresh output and note timings.
   - Run **LocalPilot: Stop Runtime**.
7. Close other memory/CPU-heavy apps so the 16 GB machine has room for the worker. Do not run other agents, Docker builds, or dev servers during the demo.
8. Prepare a small code file with a 10-30 line function selected. Do not select the whole file.
9. Clear the sidebar chat if you do not want previous prompts in the recording.
10. If you plan to demo an existing local GGUF, confirm **Choose Model or Local GGUF** loads it and that it answers before recording.
11. Record screen and, if possible, the Task Manager memory graph.

## Demo script (about 4-6 minutes)

### 1. Show the sidebar and runtime version

Open LocalPilot in the Secondary Side Bar (right) or run **LocalPilot: Chat with Local Model**. If the welcome page appears, choose the model you prepared and continue. Then run:

- **LocalPilot: Check Runtime**

Show:

- QVAC CLI 0.16.0 and Node version.
- `qvac doctor` result.
- No local server running yet (fresh start).
- Model alias `localpilot-model`.
- Qwen GGUF cache file (about 382 MB).

Say: "The model is local. The first run needed internet; the cache is already primed."

### 2. Start the local model

Run **LocalPilot: Start / Load Local Model**.

Show the status-bar progress and, when ready:

- **QVAC running (managed)**.
- Endpoint `http://127.0.0.1:11434`.
- Model alias.

Do not claim a startup time until you have measured it. State the measured value and machine conditions.

### 3. Chat

Run **LocalPilot: Chat with Local Model**.

Use a short prompt that demonstrates real generation, for example:

```text
Explain what this extension does in two sentences. It is a local VS Code assistant.
```

Let the response stream. Point out the elapsed time and token metadata.

Optional second prompt that proves context works:

```text
Now give me a one-line summary.
```

### 4. Build-mode conversational question (streaming)

Open a folder and select a small function in the editor. In the LocalPilot Secondary Side Bar:

1. Choose **Build** in the mode selector (leave **Net** off).
2. Ask: **Explain the selected function and how I would change its return type.**
3. This is a conversational request, so Build uses normal streaming chat with the selected code. Tokens appear incrementally; no tools or approval card are needed.
4. Point out that Build can chat without being forced into a file write.

Do not use this step to ask for a file change; that enters the ReAct tool loop.

### 5. Agent file edit (optional; pre-record if time is short)

Ask: **Create src/demo-add.ts with a small add function and a comment.** The footer shows `Agent step …` and a timer; tool activity appears in chat. When the red **Create file — approval required** card appears, review the diff and click **Apply**, then show the file in Explorer.

The 0.6B model can take minutes per tool step on CPU. Do not click Send again while the timer is running. If the live tool step is too slow, show it as a pre-recorded clip and say so; do not claim it was live.

### 6. Explain Selected Code

Hide the sidebar if needed. In the editor, select **only one small function**. Run **LocalPilot: Explain Selected Code** (or right-click the selection).

Show:

- The panel label says the selection line count.
- The explanation references the selected code.
- No whole-file content is sent; the selection guard is in the code.

If you test an empty selection, show the warning and that no request starts.

### 7. Stop the runtime

Run **LocalPilot: Stop Runtime**. Show that the managed QVAC process is stopped. If you used an external server, the UI will explicitly say it is leaving that server running.

### 8. The offline proof

This is the required part. Do not skip it.

1. Fully quit VS Code.
2. Disable Wi-Fi and unplug Ethernet (or disable the adapter). Confirm the Windows network icon shows no connectivity.
3. Reopen VS Code.
4. Run **LocalPilot: Check Runtime**. It should show the CLI and cache without needing the network. `qvac doctor --offline` is used.
5. Run **LocalPilot: Start / Load Local Model**. This must start from cache.
6. Run a **new** chat prompt. Show it returns new text with the network still disconnected.
7. Select code and run **Explain Selected Code** again; show a new explanation.
8. Optionally open Task Manager and show the QVAC worker process using memory.
9. Run **LocalPilot: Stop Runtime**.

Say exactly what was observed:

- "External networking was disabled before this fresh runtime start."
- "The cached model loaded and performed new local inference."
- "These are measured timings on this Windows machine; I am not extrapolating."

If offline loading fails, do not claim offline support. Capture the exact error and troubleshoot the cache.

## Evidence to save with the submission

- Full demo video with the network toggle visible.
- Exact QVAC/Node/VS Code/model versions.
- Windows build, CPU, RAM, GPU/driver, Vulkan version.
- Model download size and cache path.
- Measured cold start, warm start, first-token latency, completion time, and worker RSS.
- The commands in `README.md` and the test results in `IMPLEMENTATION_LOG.md`.
- A statement that Windows execution was or was not tested by the submitter.

## Fallback if this PC fails the Vulkan gate

Do not silently replace QVAC. The hackathon requires meaningful QVAC use. Options:

1. Fix the Vulkan 1.4 driver requirement on the target machine.
2. Test on another QVAC-compatible Windows PC and disclose the device.
3. If using the Linux verification host for evidence, clearly state that the recorded device is Linux and that Windows is unverified. Do not present Linux results as Windows measurements.

## Claims to avoid

- Do not say "fast" without measured tokens/second on the demo device.
- Do not say "completely private" while a first-run download is in progress; say prompts/code stay local after setup.
- Do not say "offline" if the runtime was already running before the network was disabled.
- Do not say "tested on Windows" unless the Windows sequence above was actually run.
