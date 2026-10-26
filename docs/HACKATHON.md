# AI Yako Submission Notes

Verified against the official DoraHacks page on **2026-10-26**:

- Page: https://dorahacks.io/hackathon/ai-yako/detail
- Repository: https://github.com/bolajiev/localpilot
- Release download: https://github.com/bolajiev/localpilot/releases/latest
- Event: **AI Yako: Own Your AI | QVAC Hackathon**, 24-31 October 2026, Node NBO, Nairobi.
- Submission deadline shown on the page: **2026-10-30 14:00 UTC** (17:00 EAT).
- Remote participation is allowed under the same judging criteria. Travel is not required.
- Solo or teams of up to three. Submit one Build per solo builder/team.
- Prize pool displayed: 3,500 USDt.

## Required submission material

The official page lists:

- A clear problem statement, audience, and chosen track.
- A GitHub/GitLab/Bitbucket source repository with setup instructions, dependencies, and a note on what was built during the event. Disclose existing and third-party work.
- A short demo video showing the working product and its core AI feature **with the internet disconnected**.
- QVAC integration details: SDK/package versions, model name, model download/setup steps, and the files where QVAC is used.
- Device and operating system, memory needs, model licences, and hardware limits.
- A clear list of features that still need a network.
- No private data, passwords, API keys, or wallet secrets.

## Tracks

1. **Offline AI apps** — a useful QVAC app whose core AI feature works without internet.
2. **Cloud to Pocket** — move an existing cloud workload to a device and explain tradeoffs.
3. **On-device agentic finance** — QVAC + WDK. WDK is required for this track.

LocalPilot targets **Offline AI apps**. Its core feature is local chat and selected-code explanation through QVAC, with no cloud AI fallback.

## Judging criteria stated on the page

- Real user value.
- Meaningful QVAC integration.
- Working implementation.
- Usability.
- Clarity and reproducibility of the offline demonstration.

Cloud AI APIs for the core feature make an entry ineligible for prizes. LocalPilot has no cloud inference path.

## What LocalPilot submits

| Item | Value |
| --- | --- |
| QVAC package | `@qvac/cli@0.16.0` (bundles `@qvac/sdk@0.22.0`) |
| Runtime mode | `qvac serve --openai --no-default`, loopback `127.0.0.1:11434` |
| Model | `QWEN3_600M_INST_Q4` (`Qwen3-0.6B-Q4_0.gguf`, 382,156,480 bytes) |
| Model source | `unsloth/Qwen3-0.6B-GGUF` commit `50968a4468ef4233ed78cd7c3de230dd1d61a56b` |
| Model license | Apache-2.0 |
| QVAC integration files | `src/runtimeLocator.ts`, `src/runtimeManager.ts`, `src/qvacClient.ts`, `src/runtimeConfig.ts` |
| LocalPilot version | `0.2.0` |
| Model loading | Curated catalog download or user-supplied local `.gguf` path |
| Extension host | VS Code 1.95+ |
| Tested runtime | Node 24.21.0, VS Code 1.143.1 test host, Linux x64 CPU fallback |
| Windows status | **Not tested in this environment**; Vulkan 1.4 gate must be verified on the target PC |

## Honest acceptance status

| Check | Status | Evidence |
| --- | --- | --- |
| QVAC CLI installed and doctor run | PASS (Linux) | CLI 0.16.0; `qvac doctor` exit 0, CPU fallback warning |
| Real model loaded and answered | PASS (Linux) | Streaming chat, 5-6 tokens returned |
| Existing local GGUF loaded and answered | PASS (Linux) | Explicit `src` + `llamacpp-completion`; extension-host integration |
| Explain Selected Code with real model | PASS (Linux) | VS Code command integration and offline script |
| Offline inference after cache | PASS (Linux) | Isolated network namespace, real chat + explain |
| Windows 10/11 + Vulkan 1.4 | NOT TESTED | No Windows host available in this environment |
| Windows VSIX install/smoke test | NOT TESTED | VSIX built on Linux; cross-platform package not run on Windows |
| Demo video with network off | NOT DONE | Must be recorded by the submitter on the target device |
| Repository link | PASS | https://github.com/bolajiev/localpilot |
| GitHub Actions CI | PASS | Build/test/package workflow succeeded; VSIX artifact uploaded |
| Clean install/typecheck/unit tests | PASS | 43 unit tests, TypeScript, VSIX |
| Extension Host integration | PASS (Linux) | Start, check, chat, explain command, stop, error paths |

Do not upgrade "PASS (Linux)" to "tested on Windows" without running the Windows sequence.

## Suggested Build description

> LocalPilot is a privacy-first VS Code extension that lets developers chat with a local QVAC model and explain selected code without sending prompts or source to the cloud. It manages the QVAC CLI server on loopback, preloads Qwen3-0.6B, offers a small catalog model chooser, and can load an existing local GGUF file. It rejects non-loopback endpoints and has no cloud fallback or telemetry. The MVP was validated with real QVAC inference and an isolated-network offline test on Linux x64 CPU. Windows verification is documented as pending because the target Vulkan 1.4 machine was not available to the build environment.

## Submission checklist

- [x] Create/push the repository with source, README, tests, and this documentation.
- [x] Include the tested VSIX or build instructions.
- [ ] Record a new demo video that visibly disables networking before the offline start and shows new chat and explanation output.
- [ ] State the exact Windows device, Vulkan version, CPU/RAM, and measured timings, or clearly mark them unavailable.
- [ ] Include QVAC CLI/SDK and model versions and license.
- [ ] Add all team members to the Build.
- [ ] Submit before **2026-10-30 14:00 UTC** and verify every link while logged out.
- [ ] Do not include secrets, API keys, private code, or unauthorized model assets.

## Sources

- AI Yako official page: https://dorahacks.io/hackathon/ai-yako/detail
- QVAC docs: https://docs.qvac.tether.io/
- QVAC system requirements: https://docs.qvac.tether.io/sdk/system-requirements/
- QVAC HTTP server: https://docs.qvac.tether.io/cli/http-server/
- QVAC download lifecycle: https://docs.qvac.tether.io/sdk/models/download-lifecycle/
- Qwen3-0.6B: https://huggingface.co/Qwen/Qwen3-0.6B
- Qwen3-0.6B GGUF: https://huggingface.co/unsloth/Qwen3-0.6B-GGUF
