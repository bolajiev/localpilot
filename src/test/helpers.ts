import { LocalPilotSettings } from "../runtimeConfig";

export function testSettings(overrides: Partial<LocalPilotSettings> = {}): LocalPilotSettings {
  return {
    qvacPath: "",
    nodePath: "",
    host: "127.0.0.1",
    port: 11434,
    modelId: "QWEN3_600M_INST_Q4",
    modelPath: "",
    modelAlias: "localpilot-model",
    contextSize: 4096,
    maxOutputTokens: 384,
    temperature: 0.2,
    enableReasoning: false,
    maxSelectionChars: 6000,
    startupTimeoutMs: 1800000,
    requestTimeoutMs: 900000,
    autoStart: false,
    autoInstallQvac: true,
    stopOnExit: true,
    ...overrides
  };
}
