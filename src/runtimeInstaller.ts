import { execFile, spawn, ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { LocalPilotError } from "./errors";
import { isSupportedNodeVersion, parseVersionOutput } from "./runtimeLocator";

const QVAC_CLI_VERSION = "0.16.0";
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const REQUIRED_FREE_BYTES = 6 * 1024 * 1024 * 1024;

interface ExecResult {
  stdout: string;
  stderr: string;
}

type ExecFn = (
  file: string,
  args: string[],
  options: { windowsHide: boolean; timeout: number; maxBuffer: number }
) => Promise<ExecResult>;

const defaultExec: ExecFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

export interface ManagedQvacInstallOptions {
  targetDir: string;
  nodePath?: string;
  signal?: AbortSignal;
  onMessage?: (message: string) => void;
}

export interface ManagedQvacInstallResult {
  entry: string;
  nodeCommand: string;
  nodeVersion: string;
}

class LineCollector {
  private buffer = "";
  public readonly lines: string[] = [];

  public push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      this.add(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
    }
  }

  public flush(): void {
    if (this.buffer.trim()) {
      this.add(this.buffer);
    }
    this.buffer = "";
  }

  private add(line: string): void {
    const clean = line.replace(/\r$/, "").replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").trim();
    if (!clean) {
      return;
    }
    this.lines.push(clean.length > 400 ? `${clean.slice(0, 400)}…` : clean);
    if (this.lines.length > 40) {
      this.lines.shift();
    }
  }
}

function managedCliEntry(targetDir: string): string {
  return path.join(targetDir, "node_modules", "@qvac", "cli", "dist", "index.js");
}

async function exists(file: string): Promise<boolean> {
  try {
    const info = await fs.stat(file);
    return info.isFile();
  } catch {
    return false;
  }
}

async function whichAll(command: string): Promise<string[]> {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const result = await defaultExec(locator, [command], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function nodePreference(file: string): number {
  if (/[\\/]WindowsApps[\\/]/i.test(file)) {
    return 5;
  }
  return path.extname(file).toLowerCase() === ".exe" ? 0 : 1;
}

async function findNode(nodePath?: string): Promise<{ command: string; version: string }> {
  if (nodePath?.trim()) {
    const command = nodePath.trim();
    if (!(await exists(command))) {
      throw new LocalPilotError("runtime-missing", `Configured Node.js path does not exist: ${command}`, {
        hint: "Set localpilot.nodePath to node.exe or install Node.js 22.21+ / 24.9+."
      });
    }
    const version = await nodeVersion(command);
    if (!isSupportedNodeVersion(version)) {
      throw new LocalPilotError("runtime-missing", `Node.js ${version} is not supported by QVAC.`, {
        hint: "Install Node.js 22.21+ (22.x) or 24.9+."
      });
    }
    return { command, version };
  }

  const candidates = (await whichAll("node")).sort((left, right) => nodePreference(left) - nodePreference(right));
  let lastVersion: string | undefined;
  for (const candidate of candidates) {
    try {
      const version = await nodeVersion(candidate);
      if (isSupportedNodeVersion(version)) {
        return { command: candidate, version };
      }
      lastVersion = version;
    } catch {
      // Try the next PATH entry.
    }
  }
  if (lastVersion) {
    throw new LocalPilotError("runtime-missing", `Node.js ${lastVersion} is not supported by QVAC.`, {
      hint: "Install Node.js 22.21+ (22.x) or 24.9+."
    });
  }
  throw new LocalPilotError("runtime-missing", "Node.js was not found on PATH.", {
    hint: "Install Node.js 22.21+ or 24.9+. The extension cannot install a system Node.js runtime safely."
  });
}

export async function checkNodeRuntime(
  nodePath?: string
): Promise<{ command: string; version: string }> {
  return findNode(nodePath);
}

async function nodeVersion(command: string): Promise<string> {
  const result = await defaultExec(command, ["--version"], {
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 1024 * 1024
  });
  const version = parseVersionOutput(`${result.stdout}\n${result.stderr}`);
  if (!version) {
    throw new Error("Node.js version output was invalid.");
  }
  return version;
}

async function findNpmCli(nodeCommand: string): Promise<string> {
  const nodeDir = path.dirname(nodeCommand);
  const candidates = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  const npmCandidates = (await whichAll("npm")).sort((left, right) => {
    const score = (file: string): number => {
      const ext = path.extname(file).toLowerCase();
      if (ext === ".cmd") return 0;
      if (ext === ".exe") return 1;
      if (ext === ".js") return 2;
      return 3;
    };
    return score(left) - score(right);
  });
  for (const candidate of npmCandidates) {
    const real = await fs.realpath(candidate).catch(() => candidate);
    if (path.extname(real).toLowerCase() === ".js") {
      return real;
    }
    const extension = path.extname(real).toLowerCase();
    if (extension === ".cmd" || extension === ".bat") {
      const text = await fs.readFile(real, "utf8").catch(() => "");
      const match = text.match(/node_modules[\\/]+npm[\\/]+bin[\\/]+npm-cli\.js/i);
      if (match) {
        const entry = path.join(path.dirname(real), match[0].replace(/\//g, path.sep));
        if (await exists(entry)) {
          return entry;
        }
      }
    }
  }

  throw new LocalPilotError("runtime-missing", "npm was not found next to Node.js or on PATH.", {
    hint: "Install Node.js from nodejs.org (includes npm), reopen VS Code, and retry."
  });
}

async function checkFreeDisk(targetDir: string): Promise<void> {
  try {
    const stats = await fs.statfs(targetDir);
    const free = stats.bavail * stats.bsize;
    if (free < REQUIRED_FREE_BYTES) {
      throw new LocalPilotError(
        "runtime-start",
        "There is not enough free disk space to install QVAC.",
        {
          hint: `Free at least ${Math.ceil(REQUIRED_FREE_BYTES / 1024 ** 3)} GB, then retry. QVAC runtime is about 3 GB plus the model.`
        }
      );
    }
  } catch (error) {
    if (error instanceof LocalPilotError) {
      throw error;
    }
    // Some filesystems do not support statfs; let npm report disk errors.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    const finish = (): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(true);
      }
    };
    child.once("exit", finish);
    child.once("error", finish);
  });
}

async function terminateTree(child: ChildProcess, pid: number | undefined): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (!pid) {
    child.kill();
    await waitForExit(child, 4000);
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 15000 },
        () => resolve()
      );
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  if (await waitForExit(child, 8000)) {
    return;
  }
  if (process.platform === "win32") {
    child.kill();
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  await delay(1000);
}

export async function installManagedQvac(
  options: ManagedQvacInstallOptions
): Promise<ManagedQvacInstallResult> {
  if (options.signal?.aborted) {
    throw new LocalPilotError("cancelled", "QVAC installation was cancelled.");
  }

  const node = await findNode(options.nodePath);
  const entry = managedCliEntry(options.targetDir);
  if (await exists(entry)) {
    return { entry, nodeCommand: node.command, nodeVersion: node.version };
  }

  const npmCli = await findNpmCli(node.command);
  await fs.mkdir(options.targetDir, { recursive: true });
  await checkFreeDisk(options.targetDir);
  options.onMessage?.("Downloading QVAC runtime (about 3 GB). This can take several minutes…");

  const args = [
    npmCli,
    "install",
    "--prefix",
    options.targetDir,
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    `@qvac/cli@${QVAC_CLI_VERSION}`
  ];
  const child = spawn(node.command, args, {
    cwd: options.targetDir,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      npm_config_update_notifier: "false"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32"
  });

  const output = new LineCollector();
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => output.push(chunk));
  child.stderr?.on("data", (chunk: string) => output.push(chunk));

  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });

  let timedOut = false;
  let cancelled = false;
  const onAbort = (): void => {
    cancelled = true;
    void terminateTree(child, child.pid);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    void terminateTree(child, child.pid);
  }, INSTALL_TIMEOUT_MS);

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  try {
    const result = await closed;
    output.flush();
    if (cancelled) {
      throw new LocalPilotError("cancelled", "QVAC installation was cancelled.");
    }
    if (timedOut) {
      throw new LocalPilotError("timeout", "QVAC installation timed out.", {
        hint: "Check internet access and disk space, then retry."
      });
    }
    if (spawnError) {
      throw new LocalPilotError("runtime-start", "Could not start npm to install QVAC.", {
        detail: spawnError.message
      });
    }
    if (result.code !== 0) {
      throw new LocalPilotError("runtime-start", "Automatic QVAC installation failed.", {
        hint: "Check internet access, Node/npm permissions, and free disk space. You can also install manually with: npm install -g @qvac/cli@0.16.0",
        detail: output.lines.slice(-12).join("\n")
      });
    }
    if (!(await exists(entry))) {
      throw new LocalPilotError("runtime-start", "npm finished but the QVAC CLI entry point was not found.", {
        hint: "Retry the setup. If it repeats, install manually with: npm install -g @qvac/cli@0.16.0"
      });
    }
    options.onMessage?.("QVAC runtime installed. Preparing the model…");
    return { entry, nodeCommand: node.command, nodeVersion: node.version };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
