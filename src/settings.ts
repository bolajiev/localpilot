import * as vscode from "vscode";
import { LocalPilotSettings } from "./runtimeConfig";

export function readSettings(): LocalPilotSettings {
  const config = vscode.workspace.getConfiguration("localpilot");
  return {
    qvacPath: config.get<string>("qvacPath", ""),
    nodePath: config.get<string>("nodePath", ""),
    host: config.get<string>("host", "127.0.0.1"),
    port: config.get<number>("port", 11434),
    modelId: config.get<string>("modelId", "QWEN3_600M_INST_Q4"),
    modelPath: config.get<string>("modelPath", ""),
    modelAlias: config.get<string>("modelAlias", "localpilot-model"),
    contextSize: config.get<number>("contextSize", 4096),
    maxOutputTokens: config.get<number>("maxOutputTokens", 384),
    temperature: config.get<number>("temperature", 0.2),
    enableReasoning: config.get<boolean>("enableReasoning", false),
    maxSelectionChars: config.get<number>("maxSelectionChars", 6000),
    startupTimeoutMs: config.get<number>("startupTimeoutMs", 1800000),
    requestTimeoutMs: config.get<number>("requestTimeoutMs", 900000),
    autoStart: config.get<boolean>("autoStart", false),
    autoInstallQvac: config.get<boolean>("autoInstallQvac", true),
    stopOnExit: config.get<boolean>("stopOnExit", true)
  };
}
