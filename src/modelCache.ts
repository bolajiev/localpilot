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
