import { Dirent, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CachedModel {
  path: string;
  fileName: string;
  label: string;
  sizeBytes: number;
}

export function modelCacheDirectory(home = os.homedir()): string {
  return path.join(home, ".qvac", "models");
}

function displayName(fileName: string): string {
  const withoutHash = fileName.replace(/^[a-f0-9]{8,}_/i, "");
  const withoutExtension = withoutHash.replace(/\.gguf$/i, "");
  const words = withoutExtension.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words || fileName;
}

export async function readCachedModels(home = os.homedir()): Promise<CachedModel[]> {
  const directory = modelCacheDirectory(home);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const models: CachedModel[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".gguf")) {
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.size <= 0) {
        continue;
      }
      models.push({
        path: fullPath,
        fileName: entry.name,
        label: displayName(entry.name),
        sizeBytes: stat.size
      });
    } catch {
      // Skip a file that disappears while scanning.
    }
  }
  models.sort((left, right) => left.label.localeCompare(right.label));
  return models;
}


export interface CatalogModelInfo {
  fileName: string;
  sizeBytes: number;
}

export const CATALOG_MODELS: Record<string, CatalogModelInfo> = {
  QWEN3_600M_INST_Q4: { fileName: "Qwen3-0.6B-Q4_0.gguf", sizeBytes: 382156480 },
  QWEN3_1_7B_INST_Q4: { fileName: "Qwen3-1.7B-Q4_0.gguf", sizeBytes: 1056782912 },
  QWEN3_4B_INST_Q4_K_M: { fileName: "Qwen3-4B-Q4_K_M.gguf", sizeBytes: 2497280256 }
};

export interface CatalogModelCacheState {
  path?: string;
  bytes: number;
  expected: number;
  cached: boolean;
}

export function catalogModelInfo(modelId: string): CatalogModelInfo | undefined {
  return CATALOG_MODELS[modelId];
}

export async function findCatalogModelCache(
  modelId: string,
  home = os.homedir()
): Promise<CatalogModelCacheState | undefined> {
  const info = catalogModelInfo(modelId);
  if (!info) {
    return undefined;
  }
  const models = await readCachedModels(home);
  const matches = models
    .filter((model) => model.fileName.toLowerCase().endsWith(info.fileName.toLowerCase()))
    .sort((left, right) => right.sizeBytes - left.sizeBytes);
  const best = matches[0];
  return {
    path: best?.path,
    bytes: best?.sizeBytes ?? 0,
    expected: info.sizeBytes,
    cached: Boolean(best && best.sizeBytes >= info.sizeBytes * 0.995)
  };
}
