# LocalPilot Demo Procedure (AI Yako)

This is a real-inference demo. Do not substitute mocked responses. The submission requires a recorded demo showing the core AI feature with internet disconnected.

## Pre-demo checklist (online)

1. Windows target is booted and `vulkaninfo --summary` reports Vulkan 1.4+.
2. `node --version` is 22.21+ (22.x) or 24.9+.
3. `qvac --version` is `0.16.0`; `qvac doctor` exits 0.
4. LocalPilot VSIX is installed.
5. Model cache is primed:
   - Run **LocalPilot: Start / Load Local Model** with internet.
   - Run one chat prompt and one **Explain Selected Code**.
   - Confirm fresh output and note timings.
   - Run **LocalPilot: Stop Runtime**.
6. Close other memory-heavy apps so the 16 GB machine has room for the worker.
7. Prepare a small code file with a 10-30 line function selected. Do not select the whole file.
8. Clear the chat panel if you do not want previous prompts in the recording.
9. If you plan to demo an existing local GGUF, confirm **Choose Model or Local GGUF** loads it and that it answers before recording.
10. Record screen and, if possible, the Task Manager memory graph.

## Demo script (about 4-6 minutes)

### 1. Show the runtime and version

Open the Command Palette:

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

### 4. Explain Selected Code

Close or hide the chat panel. In the editor, select **only one small function**. Run **LocalPilot: Explain Selected Code** (or right-click the selection).

Show:

- The panel label says the selection line count.
- The explanation references the selected code.
- No whole-file content is sent; the selection guard is in the code.

If you test an empty selection, show the warning and that no request starts.

### 5. Stop the runtime

Run **LocalPilot: Stop Runtime**. Show that the managed QVAC process is stopped. If you used an external server, the UI will explicitly say it is leaving that server running.

### 6. The offline proof

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
