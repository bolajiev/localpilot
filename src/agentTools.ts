import { promises as fs } from "node:fs";
import { promises as dns } from "node:dns";
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

export interface AgentToolOptions {
  webEnabled?: boolean;
  readOnly?: boolean;
  fetchImpl?: typeof fetch;
}

function isPrivateIp(value: string): boolean {
  const host = value.toLowerCase();
  if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host === "0.0.0.0") {
    return true;
  }
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    );
}

export function stripHtmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function parseDuckDuckGoResults(html: string, limit = 5): WebSearchResult[] {
  const links: Array<{ href: string; title: string }> = [];
  const linkPattern = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(linkPattern)) {
    const href = decodeEntities(match[1]);
    const title = stripHtmlToText(match[2]);
    if (title) {
      links.push({ href, title });
    }
    if (links.length >= 20) {
      break;
    }
  }
  const snippets: string[] = [];
  const snippetPattern = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(snippetPattern)) {
    snippets.push(stripHtmlToText(match[1]));
    if (snippets.length >= 20) {
      break;
    }
  }
  return links.slice(0, limit).map((link, index) => {
    let url = link.href;
    try {
      const parsed = new URL(link.href, "https://duckduckgo.com");
      const target = parsed.searchParams.get("uddg");
      if (target) {
        url = target;
      }
    } catch {
      // Keep the original href.
    }
    return { title: link.title, url, snippet: snippets[index] ?? "" };
  });
}

export class AgentTools {
  private readonly root: string;
  private readonly webEnabled: boolean;
  private readonly readOnly: boolean;
  private readonly fetchImpl: typeof fetch;

  public constructor(
    workspaceRoot: string,
    private readonly reviewChange: ReviewChange,
    options: AgentToolOptions = {}
  ) {
    this.root = path.resolve(workspaceRoot);
    this.webEnabled = options.webEnabled === true;
    this.readOnly = options.readOnly === true;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public definitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [
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
          name: "search_text",
          description: "Search text files in the workspace for a literal string. Returns up to 20 matching lines.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Literal text to search for." }
            },
            required: ["query"]
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
    const visible = this.readOnly
      ? definitions.filter(
          (tool) =>
            tool.function.name !== "write_file" && tool.function.name !== "replace_in_file"
        )
      : definitions;
    if (this.webEnabled) {
      visible.push(
        {
          type: "function",
          function: {
            name: "web_search",
            description: "Search the web. This sends the query to DuckDuckGo; use only when internet access is needed.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query." }
              },
              required: ["query"]
            }
          }
        },
        {
          type: "function",
          function: {
            name: "fetch_url",
            description: "Fetch a public http(s) URL and return readable text. Private/local addresses are blocked.",
            parameters: {
              type: "object",
              properties: {
                url: { type: "string", description: "Public http(s) URL." }
              },
              required: ["url"]
            }
          }
        }
      );
    }
    return visible;
  }

  public async execute(name: string, rawArguments: string): Promise<ToolOutcome> {
    let args: Record<string, unknown>;
    try {
      args = rawArguments.trim() ? (JSON.parse(rawArguments) as Record<string, unknown>) : {};
    } catch {
      return { ok: false, content: "Invalid JSON tool arguments.", summary: `Invalid arguments for ${name}.` };
    }

    if (
      this.readOnly &&
      (name === "write_file" || name === "replace_in_file")
    ) {
      return {
        ok: false,
        content: "Plan mode is read-only. Switch to Build mode to make file changes.",
        summary: "Blocked a write in Plan mode."
      };
    }

    try {
      switch (name) {
        case "list_files":
          return await this.listFiles(typeof args.path === "string" ? args.path : ".");
        case "read_file":
          return await this.readFile(requireString(args.path, "path"));
        case "search_text":
          return await this.searchText(requireString(args.query, "query"));
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
        case "web_search":
          if (!this.webEnabled) {
            throw new Error("Internet tools are disabled. Turn on Net in the chat footer.");
          }
          return await this.webSearch(requireString(args.query, "query"));
        case "fetch_url":
          if (!this.webEnabled) {
            throw new Error("Internet tools are disabled. Turn on Net in the chat footer.");
          }
          return await this.fetchUrl(requireString(args.url, "url"));
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

  private async assertPublicUrl(raw: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("Invalid URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only http(s) URLs are allowed.");
    }
    if (url.username || url.password) {
      throw new Error("URLs with credentials are not allowed.");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host === "metadata.google.internal" ||
      isPrivateIp(host)
    ) {
      throw new Error("Private, loopback, and local URLs are not allowed.");
    }
    const ipLiteral = /^[\d.]+$/.test(host) || host.includes(":");
    if (!ipLiteral) {
      const addresses = await dns.lookup(host, { all: true });
      if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
        throw new Error("The hostname resolves to a private address.");
      }
    }
    return url;
  }

  private async fetchText(url: URL, accept: string): Promise<{ response: Response; text: string }> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "LocalPilot/0.12 (+https://github.com/bolajiev/localpilot)",
        Accept: accept
      },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url.hostname}`);
    }
    const finalUrl = new URL(response.url || url.toString());
    await this.assertPublicUrl(finalUrl.toString());
    const contentType = response.headers.get("content-type") ?? "";
    if (
      !/text\/|application\/(json|xml|xhtml)/i.test(contentType) &&
      contentType.length > 0
    ) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }
    const text = await response.text();
    if (text.length > 500_000) {
      throw new Error("The page is too large to read.");
    }
    return { response, text };
  }

  private async fetchUrl(raw: string): Promise<ToolOutcome> {
    const url = await this.assertPublicUrl(raw);
    const { response, text } = await this.fetchText(
      url,
      "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1"
    );
    const contentType = response.headers.get("content-type") ?? "";
    const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtmlToText(titleMatch[1]) : "";
    const readable = contentType.includes("html") ? stripHtmlToText(text) : text.trim();
    const clipped = readable.slice(0, 20_000);
    return {
      ok: true,
      content: `URL: ${url.toString()}\nTitle: ${title || "(none)"}\n\n${clipped}`,
      summary: `Fetched ${url.hostname} (${clipped.length} characters).`
    };
  }

  private async webSearch(rawQuery: string): Promise<ToolOutcome> {
    const query = rawQuery.trim().slice(0, 400);
    if (!query) {
      throw new Error("Search query must not be empty.");
    }
    const url = await this.assertPublicUrl(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    );
    const { text } = await this.fetchText(url, "text/html");
    const results = parseDuckDuckGoResults(text, 5);
    if (results.length === 0) {
      throw new Error("No search results were returned.");
    }
    return {
      ok: true,
      content: JSON.stringify(results, null, 2),
      summary: `Web search: "${query}" (${results.length} results).`
    };
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

  private async searchText(rawQuery: string): Promise<ToolOutcome> {
    const query = rawQuery.trim();
    if (!query) {
      throw new Error("Search query must not be empty.");
    }
    const needle = query.toLowerCase();
    const matches: string[] = [];
    let scanned = 0;
    const walk = async (dir: string): Promise<void> => {
      if (matches.length >= 20 || scanned >= 300) {
        return;
      }
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= 20 || scanned >= 300) {
          return;
        }
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            await walk(path.join(dir, entry.name));
          }
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const absolute = path.join(dir, entry.name);
        let content: string;
        try {
          const stat = await fs.stat(absolute);
          if (stat.size > 500_000) {
            continue;
          }
          content = await fs.readFile(absolute, "utf8");
        } catch {
          continue;
        }
        scanned += 1;
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].toLowerCase().includes(needle)) {
            matches.push(`${displayPath(path.relative(this.root, absolute))}:${index + 1}: ${lines[index].trim().slice(0, 300)}`);
            if (matches.length >= 20) {
              return;
            }
          }
        }
      }
    };
    await walk(this.root);
    return {
      ok: true,
      content: matches.join("\n") || "(no matches)",
      summary: `Searched for "${query}" (${matches.length} matches).`
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
