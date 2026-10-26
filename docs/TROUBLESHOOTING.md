# LocalPilot Windows Troubleshooting

These steps target Windows 10/11 x64. LocalPilot was developed and tested on Linux x64 with QVAC's CPU fallback; the Windows-specific paths below still need to be exercised on the target PC.

## First: collect the exact facts

Open PowerShell and run:

```powershell
[System.Environment]::OSVersion.VersionString
(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB
(Get-CimInstance Win32_VideoController) | Select-Object Name, DriverVersion
node --version
npm --version
qvac --version
qvac doctor
vulkaninfo --summary
```

Do not assume that the absence of an NVIDIA GPU means Vulkan is unavailable. QVAC's published Windows requirement is **Vulkan 1.4 or newer**, even for CPU-only inference. Look for the reported Vulkan API version, not the GPU brand.

## "QVAC CLI was not found" / automatic setup

LocalPilot no longer requires a manual global QVAC install. The Windows VSIX also bundles Node.js/npm. Click the LocalPilot Activity Bar icon and run **Set Up LocalPilot**, or **LocalPilot: Set Up LocalPilot (QVAC + Model)** from the Command Palette. It installs QVAC privately under VS Code global storage (`...\User\globalStorage\localpilot.localpilot\qvac-runtime`) and then downloads the model.

The automatic install:

- On Windows, the `win32-x64` VSIX bundles Node.js 24.21.0/npm, so no separate Node install is needed. Generic/source builds require Node.js 22.21+ or 24.9+.
- Downloads about **3 GB** and needs internet.
- Does not require administrator rights.
- Does not replace or delete a global QVAC install. If a supported global CLI exists, LocalPilot uses it instead.

If the automatic install fails, the diagnostics log contains the npm error tail. Check free disk (about 4 GB+), internet, and Node/npm. Manual fallback:

```powershell
npm install -g @qvac/cli@0.16.0
qvac --version
qvac doctor
```

If you use nvm-windows or a nonstandard npm prefix, set both:

- `localpilot.qvacPath` to `qvac.cmd` or `...\node_modules\@qvac\cli\dist\index.js`.
- `localpilot.nodePath` to the matching `node.exe`.

LocalPilot deliberately does not execute `.cmd` shims through a shell. It resolves the shim to the CLI JavaScript entry point and spawns `node.exe` with an argument array.

## Unsupported Node.js

QVAC CLI 0.16.0 declares:

```text
^22.21.0 || >=24.9.0
```

The Windows `win32-x64` VSIX ships a supported Node 24.21.0, so this normally does not apply there. For generic/source builds, install Node 22.21+ (22.x) or 24.9+, or set `localpilot.nodePath` to a supported `node.exe`. Reopen VS Code after changing PATH.

## Vulkan/runtime error

Symptoms: QVAC exits at startup, logs a Vulkan error, or `qvac doctor` reports no GPU acceleration on Windows.

1. Install or update the actual GPU vendor driver. A generic Microsoft display driver may not provide Vulkan.
2. Install the [LunarG Vulkan SDK](https://vulkan.lunarg.com), then run:
   ```powershell
   vulkaninfo --summary
   ```
3. Confirm the API version is at least 1.4. If not, update the driver or use a machine/driver that supports it.
4. Reboot and run **LocalPilot: Check Runtime**.
5. If the machine cannot meet the Vulkan 1.4 requirement, LocalPilot/QVAC inference is blocked on that PC. Do not present a different runtime as QVAC.

## Port already in use

Default endpoint: `http://127.0.0.1:11434`.

```powershell
Get-NetTCPConnection -LocalPort 11434 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, State, OwningProcess
```

Options:

- Stop the other service.
- Change `localpilot.port`, then run Stop and Start again.
- If an old QVAC process you own is stuck, stop it with Task Manager or:
  ```powershell
  taskkill /PID <pid> /T /F
  ```

LocalPilot refuses to spawn on a port occupied by a non-QVAC service. It also refuses to reconfigure or kill an external QVAC server. If that server already exposes `localpilot-model`, LocalPilot reuses it and marks it **external**.

## External QVAC server and `model_not_found`

If a QVAC server is already running on the port but does not expose the configured alias, LocalPilot reports an error. Either:

1. Stop that server and use **LocalPilot: Start / Load Local Model**, or
2. Add this to that server's `qvac.config.json` and restart it:
   ```json
   {
     "serve": {
       "models": {
         "localpilot-model": {
           "model": "QWEN3_600M_INST_Q4",
           "preload": true,
           "config": { "ctx_size": 4096 }
         }
       }
     }
   }
   ```

**Stop Runtime** never kills a server LocalPilot did not start. It can unload the model after confirmation.

## First start fails offline

The first run must download the QVAC model. LocalPilot uses the QVAC cache at:

```text
%USERPROFILE%\.qvac\models
```

Complete one successful online start and chat before disabling the network. If the cache is incomplete and the registry is unreachable, LocalPilot reports an offline-cache failure. Reconnect, start successfully, stop, then repeat the offline test.

Do not count a previous process that was already running as proof of offline startup. Stop the runtime and restart it with networking disabled.

## Checksum or download failure

Delete only the incomplete QVAC model cache, then reconnect and start again:

```powershell
Remove-Item "$env:USERPROFILE\.qvac\models\*" -Force -ErrorAction SilentlyContinue
```

Do not delete unrelated files. The model is about 382 MB. QVAC validates catalog downloads against checksums; an interrupted or corrupted download should be discarded.

For corporate proxies/TLS inspection, QVAC's registry access may need network configuration outside LocalPilot. LocalPilot itself has no proxy settings.

## Loading a model you already have

Use **LocalPilot: Choose Model or Local GGUF** → **Use an existing local GGUF file…**. If you prefer settings, set `localpilot.modelPath` to an absolute path ending in `.gguf` and leave the QVAC catalog choice unset.

The file must be a llama.cpp-compatible chat GGUF with a usable chat template. QVAC loads local files with:

```json
{ "src": "C:\\models\\my-model.gguf", "type": "llamacpp-completion", "preload": true }
```

Local files bypass QVAC catalog checksum verification. Verify the source, integrity, license, and memory requirements yourself. If the local model fails but the default works, the file is the likely cause.

If you downloaded the model through QVAC and it is already under `%USERPROFILE%\.qvac\models`, you do **not** need a local path: start the matching catalog model and QVAC will reuse the cache.

## Model fit / out of memory

The 0.6B Q4 model file is about 382 MB, but the runtime is larger than the file. On the tested host, the QVAC worker used about 1.5 GB RSS during inference.

- Close other memory-heavy applications.
- Lower `localpilot.contextSize` (for example 2048).
- Keep `localpilot.enableReasoning` off.
- Keep the default small model.
- Check Windows Task Manager for the QVAC/bare worker process.
- Do not assume a 16 GB machine can run several models simultaneously.

## Requests time out or feel very slow

CPU inference is slow, and first-token latency includes prompt prefill.

- Keep prompts short and selections under `localpilot.maxSelectionChars`.
- Keep `localpilot.enableReasoning` false.
- Lower `localpilot.maxOutputTokens` for quick answers.
- Wait for the model to preload before chatting. The port only opens after preload.
- Raise `localpilot.requestTimeoutMs` only if you accept the longer wait.
- Measure on the actual machine; the CI host measured about 0.08-0.1 tokens/second and is not a Windows benchmark.

Click **Stop** in the sidebar chat or press **LocalPilot: Stop Runtime** to cancel. Aborting the HTTP request causes QVAC to cancel the inference.

## Stopping or orphan processes

LocalPilot tracks the process tree it started. On Windows it uses `taskkill /PID <pid> /T /F`; on POSIX it kills the process group. Normal VS Code shutdown also stops a managed process when `localpilot.stopOnExit` is true.

If VS Code crashed and left a process:

1. Run **LocalPilot: Check Runtime** to see whether the server is still up.
2. Find the QVAC process in Task Manager.
3. Stop **only that PID**:
   ```powershell
   taskkill /PID <pid> /T /F
   ```
4. If needed, change `localpilot.port` to avoid the orphan.

Do not kill unrelated Node.js or bare-runtime processes blindly.

## Logs and privacy

- **LocalPilot: Show Diagnostics Log** shows CLI versions, start/stop metadata, doctor summary, and sanitized QVAC runtime lines.
- Lines containing `content`, `messages`, `prompt`, `code`, `input`, authorization headers, or bearer tokens are dropped.
- LocalPilot never writes prompts, selections, or model output to the log.
- QVAC writes its own model and KV caches under `%USERPROFILE%\.qvac`. QVAC CLI stdout is captured in memory for diagnostics and only sanitized lines are shown.

When asking for help, include the output of `node --version`, `qvac --version`, `qvac doctor`, `vulkaninfo --summary`, the exact LocalPilot error text, and the sanitized diagnostics log. Do not paste private source code.

## Reset LocalPilot configuration

The generated QVAC config lives in VS Code global storage:

```text
%APPDATA%\Code\User\globalStorage\localpilot.localpilot\qvac.config.json
```

LocalPilot rewrites it on every managed start from the current settings. Do not place secrets in it; it has no API key.

## Validate on Windows before the demo

Run this acceptance sequence:

1. `npm ci`, `npm run check`, `npm run package` on Windows.
2. Install the VSIX.
3. **Check Runtime** passes and reports Vulkan/runtime facts.
4. **Start / Load Local Model** completes from a clean cache with internet.
5. Chat returns new real text.
6. Select a small function and run **Explain Selected Code**; verify only the selection was sent by checking the UI/output for the reported line count.
7. Stop; disable Wi-Fi/Ethernet; restart; chat and explain again.
8. Record actual load time, first-token time, completion time, and worker RSS.
9. Optional: run **Choose Model or Local GGUF** and load a local `.gguf` to confirm your own-model path works on Windows.

If the Vulkan 1.4 gate fails, stop and report the exact blocker. Do not claim Windows support or offline success without this evidence.
