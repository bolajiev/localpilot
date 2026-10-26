import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalPilotError } from "./errors";

export interface LocalPilotSettings {
  qvacPath: string;
  nodePath: string;
  host: string;
  port: number;
  modelId: string;
  modelPath: string;
  modelAlias: string;
  contextSize: number;
  maxOutputTokens: number;
  temperature: number;
  enableReasoning: boolean;
  maxSelectionChars: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  autoStart: boolean;
  autoInstallQvac: boolean;
  stopOnExit: boolean;
}

export interface QvacCatalogServeModel {
  model: string;
  preload: boolean;
  modelFitPolicy: "log";
  config: { ctx_size: number };
}

export interface QvacLocalServeModel {
  src: string;
  type: "llamacpp-completion";
  preload: boolean;
  modelFitPolicy: "log";
  config: { ctx_size: number };
}

export type QvacServeModel = QvacCatalogServeModel | QvacLocalServeModel;

export interface QvacConfigFile {
  serve: {
    models: Record<string, QvacServeModel>;
    load: {
      lazy: boolean;
      concurrency: number;
    };
  };
}

export const MODEL_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function assertLoopbackHost(host: string): void {
  if (!isLoopbackHostname(host)) {
    throw new LocalPilotError(
      "endpoint-invalid",
      `Refusing to use non-loopback QVAC host "${host}".`,
      {
        hint: "LocalPilot only connects to a runtime on this machine. Use 127.0.0.1, localhost, or ::1."
      }
    );
  }
}

export function endpointForSettings(settings: LocalPilotSettings): string {
  assertLoopbackHost(settings.host);
  const host = settings.host === "::1" ? "[::1]" : settings.host;
  return `http://${host}:${settings.port}`;
}

export function validateSettings(settings: LocalPilotSettings): void {
  assertLoopbackHost(settings.host);

  if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) {
    throw new LocalPilotError("endpoint-invalid", "localpilot.port must be an integer between 1024 and 65535.");
  }

  if (!MODEL_ALIAS_PATTERN.test(settings.modelAlias)) {
    throw new LocalPilotError(
      "model-missing",
      "localpilot.modelAlias contains unsupported characters.",
      { hint: "Use 1-64 letters, digits, dots, underscores, or hyphens, starting with a letter or digit." }
    );
  }

  if (settings.modelPath) {
    if (!path.isAbsolute(settings.modelPath)) {
      throw new LocalPilotError(
        "model-missing",
        "localpilot.modelPath must be an absolute path.",
        { hint: "Use LocalPilot: Choose Model or Local GGUF to pick a file, or enter a full path." }
      );
    }
    if (!settings.modelPath.toLowerCase().endsWith(".gguf")) {
      throw new LocalPilotError(
        "model-missing",
        "localpilot.modelPath must point to a .gguf file.",
        { hint: "QVAC loads local chat models as llama.cpp GGUF files." }
      );
    }
  } else if (!MODEL_ID_PATTERN.test(settings.modelId)) {
    throw new LocalPilotError(
      "model-missing",
      "localpilot.modelId is not a valid QVAC catalog model constant.",
      { hint: "Use a catalog constant such as QWEN3_600M_INST_Q4." }
    );
  }

  if (
    !Number.isInteger(settings.contextSize) ||
    settings.contextSize < 512 ||
    settings.contextSize > 32768
  ) {
    throw new LocalPilotError("prompt", "localpilot.contextSize must be an integer between 512 and 32768.");
  }

  if (
    !Number.isInteger(settings.maxOutputTokens) ||
    settings.maxOutputTokens < 16 ||
    settings.maxOutputTokens >= settings.contextSize
  ) {
    throw new LocalPilotError(
      "prompt",
      "localpilot.maxOutputTokens must be at least 16 and smaller than localpilot.contextSize."
    );
  }

  if (
    !Number.isFinite(settings.temperature) ||
    settings.temperature < 0 ||
    settings.temperature > 2
  ) {
    throw new LocalPilotError("prompt", "localpilot.temperature must be between 0 and 2.");
  }

  if (
    !Number.isInteger(settings.maxSelectionChars) ||
    settings.maxSelectionChars < 500 ||
    settings.maxSelectionChars > 40000
  ) {
    throw new LocalPilotError("selection", "localpilot.maxSelectionChars must be between 500 and 40000.");
  }

  if (
    !Number.isInteger(settings.startupTimeoutMs) ||
    settings.startupTimeoutMs < 30000
  ) {
    throw new LocalPilotError("runtime-start", "localpilot.startupTimeoutMs must be at least 30000.");
  }

  if (typeof settings.autoInstallQvac !== "boolean") {
    throw new LocalPilotError("runtime-start", "localpilot.autoInstallQvac must be true or false.");
  }

  if (!Number.isInteger(settings.requestTimeoutMs) || settings.requestTimeoutMs < 5000) {
    throw new LocalPilotError("timeout", "localpilot.requestTimeoutMs must be at least 5000.");
  }
}

export function buildQvacConfig(settings: LocalPilotSettings): QvacConfigFile {
  validateSettings(settings);
  const modelEntry: QvacServeModel = settings.modelPath
    ? {
        src: settings.modelPath,
        type: "llamacpp-completion",
        preload: true,
        modelFitPolicy: "log",
        config: {
          ctx_size: settings.contextSize
        }
      }
    : {
        model: settings.modelId,
        preload: true,
        modelFitPolicy: "log",
        config: {
          ctx_size: settings.contextSize
        }
      };

  return {
    serve: {
      models: {
        [settings.modelAlias]: modelEntry
      },
      load: {
        lazy: true,
        concurrency: 1
      }
    }
  };
}

export async function assertLocalModelFile(modelPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(modelPath);
  } catch (error) {
    throw new LocalPilotError(
      "model-missing",
      `The local model file was not found: ${modelPath}`,
      {
        hint: "Choose the GGUF file again with LocalPilot: Choose Model or Local GGUF.",
        detail: error instanceof Error ? error.message : String(error)
      }
    );
  }
  if (!stat.isFile()) {
    throw new LocalPilotError("model-missing", `The local model path is not a file: ${modelPath}`);
  }
  if (stat.size === 0) {
    throw new LocalPilotError("model-missing", `The local model file is empty: ${modelPath}`);
  }
}

export async function writeQvacConfig(
  configPath: string,
  settings: LocalPilotSettings
): Promise<QvacConfigFile> {
  const config = buildQvacConfig(settings);
  if (settings.modelPath) {
    await assertLocalModelFile(settings.modelPath);
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export interface ModelCacheInfo {
  directory: string;
  files: number;
  bytes: number;
}

export async function readModelCacheInfo(home = os.homedir()): Promise<ModelCacheInfo> {
  const directory = path.join(home, ".qvac", "models");
  let files = 0;
  let bytes = 0;
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".gguf")) {
        continue;
      }
      files += 1;
      try {
        const stat = await fs.stat(path.join(directory, entry.name));
        bytes += stat.size;
      } catch {
        // A file disappearing mid-scan should not fail diagnostics.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return { directory, files, bytes };
}
