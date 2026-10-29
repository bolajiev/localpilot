import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolDefinition } from "./agentTypes";

const MAX_READ_CHARS = 80_000;
const MAX_WRITE_CHARS = 120_000;
const MAX_LIST = 200;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "build",
  ".next",
  ".vscode-test",
  "target",
  ".venv",
  "venv",
  "__pycache__"
]);

export type ReviewChange = (
  relativePath: string,
  oldContent: string,
  newContent: string,
  isNew: boolean
) => Promise<boolean>;

export interface ToolOutcome {
  ok: boolean;
  content: string;
  summary: string;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function displayPath(relativePath: string): string {
  return relativePath === "." ? "." : relativePath.split(path.sep).join("/");
}

export class AgentTools {
  private readonly root: string;

  public constructor(
    workspaceRoot: string,
    private readonly reviewChange: ReviewChange
  ) {
    this.root = path.resolve(workspaceRoot);
  }

  public definitions(): ToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "list_files",
          description: "List files and directories in the workspace. Paths are relative to the workspace root.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative directory path, or . for the workspace root." }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a UTF-8 text file from the workspace.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace-relative file path." }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "write_file",
          description: "Create or replace a text file in the workspace. The user must approve a diff before the write.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace-relative file path." },
              content: { type: "string", description: "Full file content." }
            },
            required: ["path", "content"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "replace_in_file",
          description: "Replace one exact occurrence of old_text with new_text in a workspace file. The user must approve a diff.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace-relative file path." },
              old_text: { type: "string", description: "Exact existing text; must occur once." },
              new_text: { type: "string", description: "Replacement text." }
            },
            required: ["path", "old_text", "new_text"]
          }
        }
      }
    ];
  }

  public async execute(name: string, rawArguments: string): Promise<ToolOutcome> {
    let args: Record<string, unknown>;
    try {
      args = rawArguments.trim() ? (JSON.parse(rawArguments) as Record<string, unknown>) : {};
    } catch {
      return { ok: false, content: "Invalid JSON tool arguments.", summary: `Invalid arguments for ${name}.` };
    }

    try {
      switch (name) {
        case "list_files":
          return await this.listFiles(typeof args.path === "string" ? args.path : ".");
        case "read_file":
          return await this.readFile(requireString(args.path, "path"));
        case "write_file":
          return await this.writeFile(
            requireString(args.path, "path"),
            requireString(args.content, "content", true)
          );
        case "replace_in_file":
          return await this.replaceInFile(
            requireString(args.path, "path"),
            requireString(args.old_text, "old_text", true),
            requireString(args.new_text, "new_text", true)
          );
        default:
          return { ok: false, content: `Unknown tool: ${name}`, summary: `Unknown tool ${name}.` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, content: message, summary: `Tool ${name} failed: ${message}` };
    }
  }

  private resolvePath(requested: string): { absolute: string; relative: string } {
    if (!requested.trim()) {
      throw new Error("A non-empty workspace-relative path is required.");
    }
    if (path.isAbsolute(requested)) {
      throw new Error("Absolute paths are not allowed.");
    }
    const absolute = path.resolve(this.root, requested);
    const relative = path.relative(this.root, absolute) || ".";
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Path is outside the workspace.");
    }
    const segments = relative.split(path.sep);
    if (segments.some((segment) => SKIP_DIRS.has(segment))) {
      throw new Error(`Path traversal into ${segments.find((segment) => SKIP_DIRS.has(segment))} is not allowed.`);
    }
    return { absolute, relative };
  }

  private async listFiles(requested: string): Promise<ToolOutcome> {
    const { absolute, relative } = this.resolvePath(requested);
    const lines: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (lines.length >= MAX_LIST || depth > 3) {
        return;
      }
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (lines.length >= MAX_LIST) {
          return;
        }
        if (entry.isSymbolicLink()) {
          continue;
        }
        const child = path.join(dir, entry.name);
        const childRelative = path.relative(this.root, child);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) {
            continue;
          }
          lines.push(`${displayPath(childRelative)}/`);
          await walk(child, depth + 1);
        } else if (entry.isFile()) {
          lines.push(displayPath(childRelative));
        }
      }
    };
    await walk(absolute, 0);
    return {
      ok: true,
      content: lines.join("\n") || "(empty)",
      summary: `Listed ${lines.length} workspace entries under ${displayPath(relative)}.`
    };
  }

  private async readFile(requested: string): Promise<ToolOutcome> {
    const { absolute, relative } = this.resolvePath(requested);
    const content = await fs.readFile(absolute, "utf8");
    const truncated = content.slice(0, MAX_READ_CHARS);
    const suffix = content.length > MAX_READ_CHARS ? "\n\n[truncated by LocalPilot]" : "";
    return {
      ok: true,
      content: truncated + suffix,
      summary: `Read ${displayPath(relative)} (${content.length} characters).`
    };
  }

  private async writeFile(requested: string, content: string): Promise<ToolOutcome> {
    if (content.length > MAX_WRITE_CHARS) {
      throw new Error(`File content exceeds ${MAX_WRITE_CHARS} characters.`);
    }
    const { absolute, relative } = this.resolvePath(requested);
    let oldContent = "";
    let isNew = true;
    try {
      oldContent = await fs.readFile(absolute, "utf8");
      isNew = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (oldContent === content) {
      return { ok: true, content: "No changes.", summary: `No changes needed for ${displayPath(relative)}.` };
    }
    const approved = await this.reviewChange(displayPath(relative), oldContent, content, isNew);
    if (!approved) {
      return {
        ok: false,
        content: "The user denied the file change.",
        summary: `User denied changes to ${displayPath(relative)}.`
      };
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
    return {
      ok: true,
      content: `Applied. ${isNew ? "Created" : "Updated"} ${displayPath(relative)} (${content.length} characters).`,
      summary: `${isNew ? "Created" : "Updated"} ${displayPath(relative)}.`
    };
  }

  private async replaceInFile(requested: string, oldText: string, newText: string): Promise<ToolOutcome> {
    if (!oldText) {
      throw new Error("old_text must not be empty.");
    }
    const { absolute, relative } = this.resolvePath(requested);
    const oldContent = await fs.readFile(absolute, "utf8");
    const first = oldContent.indexOf(oldText);
    const second = first >= 0 ? oldContent.indexOf(oldText, first + oldText.length) : -1;
    if (first < 0) {
      throw new Error("old_text was not found in the file.");
    }
    if (second >= 0) {
      throw new Error("old_text occurs more than once; make the replacement unique.");
    }
    const newContent = oldContent.slice(0, first) + newText + oldContent.slice(first + oldText.length);
    if (newContent.length > MAX_WRITE_CHARS) {
      throw new Error(`Resulting file exceeds ${MAX_WRITE_CHARS} characters.`);
    }
    const approved = await this.reviewChange(displayPath(relative), oldContent, newContent, false);
    if (!approved) {
      return {
        ok: false,
        content: "The user denied the file change.",
        summary: `User denied changes to ${displayPath(relative)}.`
      };
    }
    await fs.writeFile(absolute, newContent, "utf8");
    return {
      ok: true,
      content: `Applied. Updated ${displayPath(relative)}.`,
      summary: `Updated ${displayPath(relative)}.`
    };
  }
}

function requireString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`Tool argument ${name} must be a ${allowEmpty ? "" : "non-empty "}string.`);
  }
  return value;
}

export function toolArgumentsSummary(raw: string): string {
  try {
    return jsonText(JSON.parse(raw));
  } catch {
    return raw.slice(0, 200);
  }
}
