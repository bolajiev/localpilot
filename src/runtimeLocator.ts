import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalPilotError } from "./errors";

export interface RuntimeLocation {
  command: string;
  argsPrefix: string[];
  cliPath: string;
  cliVersion: string;
  nodeVersion?: string;
  viaNode: boolean;
  warnings: string[];
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

type ExecFn = (
  file: string,
  args: string[],
  options: { windowsHide: boolean; timeout: number; maxBuffer: number }
) => Promise<ExecResult>;

export interface LocatorOptions {
  qvacPath?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  execFileFn?: ExecFn;
  stat?: typeof fs.stat;
  realpath?: typeof fs.realpath;
  readFile?: typeof fs.readFile;
}

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

export function parseVersionOutput(text: string): string | undefined {
  const match = text.match(/\bv?(\d+\.\d+\.\d+)\b/);
  return match?.[1];
}

export function isSupportedNodeVersion(version: string): boolean {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  const [major, minor] = parts;
  if (major === 22) {
    return minor >= 21;
  }
  if (major === 24) {
    return minor >= 9;
  }
  return major > 24;
}

export function isSupportedCliVersion(version: string): boolean {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  const [major, minor] = parts;
  if (major > 0) {
    return true;
  }
  return minor >= 16;
}

export function findCliEntryInNpmShim(shimText: string, shimDir: string): string | undefined {
  const match = shimText.match(/node_modules[\\/]+@qvac[\\/]+cli[\\/]+dist[\\/]+index\.js/i);
  if (!match) {
    return undefined;
  }
  return path.join(shimDir, match[0].replace(/\//g, path.sep));
}

async function fileExists(file: string, statFn: typeof fs.stat): Promise<boolean> {
  try {
    const info = await statFn(file);
    return info.isFile() || info.isDirectory();
  } catch {
    return false;
  }
}

async function whichAll(
  commandName: string,
  platform: NodeJS.Platform,
  execFileFn: ExecFn
): Promise<string[]> {
  const locator = platform === "win32" ? "where" : "which";
  try {
    const result = await execFileFn(locator, [commandName], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function preference(file: string, platform: NodeJS.Platform, forNode: boolean): number {
  const extension = path.extname(file).toLowerCase();
  if (forNode) {
    if (/[\\/]WindowsApps[\\/]/i.test(file)) {
      return 5;
    }
    return extension === ".exe" || extension === "" ? 0 : 1;
  }
  if (platform === "win32") {
    if (extension === ".cmd") {
      return 0;
    }
    if (extension === ".exe") {
      return 1;
    }
    return 2;
  }
  return 0;
}

function sortCandidates(files: string[], platform: NodeJS.Platform, forNode: boolean): string[] {
  return [...files].sort(
    (left, right) => preference(left, platform, forNode) - preference(right, platform, forNode)
  );
}

async function commonCliEntries(
  shimDirectory: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir: string
): Promise<string[]> {
  const candidates = [
    path.join(shimDirectory, "node_modules", "@qvac", "cli", "dist", "index.js"),
    path.resolve(shimDirectory, "..", "lib", "node_modules", "@qvac", "cli", "dist", "index.js")
  ];
  if (platform === "win32") {
    const appData = env.APPDATA ?? path.join(homeDir, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    candidates.push(
      path.join(appData, "npm", "node_modules", "@qvac", "cli", "dist", "index.js"),
      path.join(localAppData, "npm", "node_modules", "@qvac", "cli", "dist", "index.js"),
      path.join(programFiles, "nodejs", "node_modules", "@qvac", "cli", "dist", "index.js")
    );
  }
  return candidates;
}

interface ResolvedCli {
  kind: "node" | "direct";
  cliPath: string;
}

async function resolveCliCandidate(
  candidate: string,
  platform: NodeJS.Platform,
  options: Required<Pick<LocatorOptions, "stat" | "realpath" | "readFile">> &
    Pick<LocatorOptions, "env" | "homeDir">
): Promise<ResolvedCli> {
  let info;
  try {
    info = await options.stat(candidate);
  } catch (error) {
    throw new LocalPilotError("runtime-missing", `QVAC CLI path does not exist: ${candidate}`, {
      hint: "Set localpilot.qvacPath to the installed qvac executable or leave it empty to use PATH.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
  if (info.isDirectory()) {
    const entry = path.join(candidate, "dist", "index.js");
    if (await fileExists(entry, options.stat)) {
      return { kind: "node", cliPath: entry };
    }
    throw new LocalPilotError("runtime-missing", "The configured QVAC path is a directory without dist/index.js.");
  }

  const real = await options.realpath(candidate).catch(() => candidate);
  const extension = path.extname(real).toLowerCase();

  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return { kind: "node", cliPath: real };
  }
  if (extension === ".exe") {
    return { kind: "direct", cliPath: real };
  }

  if (extension === ".cmd" || extension === ".bat") {
    const text = await options.readFile(real, "utf8");
    const parsed = findCliEntryInNpmShim(text, path.dirname(real));
    if (parsed && (await fileExists(parsed, options.stat))) {
      return { kind: "node", cliPath: parsed };
    }
    for (const entry of await commonCliEntries(
      path.dirname(real),
      platform,
      options.env ?? process.env,
      options.homeDir ?? os.homedir()
    )) {
      if (await fileExists(entry, options.stat)) {
        return { kind: "node", cliPath: entry };
      }
    }
    throw new LocalPilotError(
      "runtime-missing",
      "The qvac.cmd shim was found, but its QVAC CLI entry point could not be resolved.",
      {
        hint: "Reinstall with: npm install -g @qvac/cli@0.16.0. If using nvm, set localpilot.nodePath and localpilot.qvacPath explicitly."
      }
    );
  }

  if (extension === ".ps1") {
    throw new LocalPilotError(
      "runtime-missing",
      "PowerShell-only QVAC shims are not supported.",
      { hint: "Install the CLI globally with npm so qvac.cmd is available, or set localpilot.qvacPath to dist/index.js." }
    );
  }

  if (platform !== "win32") {
    const text = await options.readFile(real, "utf8").catch(() => "");
    const scriptMatch = text.match(/["']([^"']+\.js)["']/);
    if (scriptMatch) {
      const scriptPath = path.resolve(path.dirname(real), scriptMatch[1]);
      if (scriptPath.includes(`${path.sep}@qvac${path.sep}cli${path.sep}`) && (await fileExists(scriptPath, options.stat))) {
        return { kind: "node", cliPath: scriptPath };
      }
    }
    return { kind: "direct", cliPath: real };
  }

  throw new LocalPilotError("runtime-missing", "Unsupported QVAC executable format.", {
    hint: "Set localpilot.qvacPath to qvac.cmd or to node_modules/@qvac/cli/dist/index.js."
  });
}

async function runVersion(
  command: string,
  args: string[],
  execFileFn: ExecFn
): Promise<string> {
  try {
    const result = await execFileFn(command, args, {
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 1024 * 1024
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const version = parseVersionOutput(output);
    if (!version) {
      throw new Error("Version output did not contain a semantic version.");
    }
    return version;
  } catch (error) {
    throw new LocalPilotError(
      "runtime-missing",
      `Could not run ${path.basename(command)} ${args.join(" ")} to determine its version.`,
      {
        hint: "Verify the QVAC CLI installation with: qvac --version.",
        detail: error instanceof Error ? error.message : String(error)
      }
    );
  }
}

export async function locateQvacRuntime(options: LocatorOptions = {}): Promise<RuntimeLocation> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const execFileFn = options.execFileFn ?? defaultExec;
  const fsDeps = {
    stat: options.stat ?? fs.stat,
    realpath: options.realpath ?? fs.realpath,
    readFile: options.readFile ?? fs.readFile
  };

  let resolved: ResolvedCli | undefined;
  const configured = options.qvacPath?.trim();
  if (configured) {
    const looksLikePath =
      path.isAbsolute(configured) ||
      configured.includes("/") ||
      configured.includes("\\");
    if (looksLikePath) {
      resolved = await resolveCliCandidate(configured, platform, {
        ...fsDeps,
        env,
        homeDir
      });
    } else {
      const found = sortCandidates(
        await whichAll(configured, platform, execFileFn),
        platform,
        false
      );
      if (found.length === 0) {
        throw new LocalPilotError("runtime-missing", `QVAC CLI "${configured}" was not found on PATH.`, {
          hint: "Install it with: npm install -g @qvac/cli@0.16.0"
        });
      }
      resolved = await resolveCliCandidate(found[0], platform, {
        ...fsDeps,
        env,
        homeDir
      });
    }
  } else {
    const candidates = sortCandidates(await whichAll("qvac", platform, execFileFn), platform, false);
    if (candidates.length === 0) {
      throw new LocalPilotError("runtime-missing", "QVAC CLI was not found on PATH.", {
        hint: "Install Node.js 22.21+ or 24.9+, then run: npm install -g @qvac/cli@0.16.0. Reopen VS Code afterwards so PATH refreshes."
      });
    }
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        resolved = await resolveCliCandidate(candidate, platform, {
          ...fsDeps,
          env,
          homeDir
        });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!resolved) {
      throw lastError instanceof Error
        ? lastError
        : new LocalPilotError("runtime-missing", "Could not resolve a usable QVAC CLI on PATH.");
    }
  }

  const warnings: string[] = [];
  let nodeCommand: string | undefined;
  let nodeVersion: string | undefined;

  const configuredNode = options.nodePath?.trim();
  if (configuredNode) {
    if (!(await fileExists(configuredNode, fsDeps.stat))) {
      throw new LocalPilotError("runtime-missing", `Configured Node.js path does not exist: ${configuredNode}`, {
        hint: "Set localpilot.nodePath to node.exe or leave it empty to use PATH."
      });
    }
    nodeCommand = configuredNode;
  } else {
    const nodeCandidates = sortCandidates(
      await whichAll("node", platform, execFileFn),
      platform,
      true
    );
    nodeCommand = nodeCandidates[0];
  }

  if (resolved.kind === "node") {
    if (!nodeCommand) {
      throw new LocalPilotError("runtime-missing", "Node.js was not found on PATH.", {
        hint: "Install Node.js 22.21+ or 24.9+, reopen VS Code, or set localpilot.nodePath."
      });
    }
    nodeVersion = await runVersion(nodeCommand, ["--version"], execFileFn);
    if (!isSupportedNodeVersion(nodeVersion)) {
      throw new LocalPilotError(
        "runtime-missing",
        `Node.js ${nodeVersion} is not supported by QVAC.`,
        {
          hint: "QVAC requires Node.js 22.21+ (on the 22.x line) or 24.9+."
        }
      );
    }
  } else if (nodeCommand) {
    try {
      nodeVersion = await runVersion(nodeCommand, ["--version"], execFileFn);
      if (!isSupportedNodeVersion(nodeVersion)) {
        warnings.push(`Node.js ${nodeVersion} is outside QVAC's supported range (22.21+ or 24.9+).`);
      }
    } catch {
      warnings.push("Node.js could not be version-checked; a direct QVAC executable will be used.");
    }
  }

  const command = resolved.kind === "node" ? nodeCommand! : resolved.cliPath;
  const argsPrefix = resolved.kind === "node" ? [resolved.cliPath] : [];
  const cliVersion = await runVersion(command, [...argsPrefix, "--version"], execFileFn);

  if (!isSupportedCliVersion(cliVersion)) {
    throw new LocalPilotError(
      "runtime-missing",
      `QVAC CLI ${cliVersion} is too old for LocalPilot.`,
      {
        hint: "Upgrade with: npm install -g @qvac/cli@0.16.0"
      }
    );
  }

  if (cliVersion !== "0.16.0") {
    warnings.push(
      `LocalPilot was verified with @qvac/cli 0.16.0; installed version ${cliVersion} may behave differently.`
    );
  }

  return {
    command,
    argsPrefix,
    cliPath: resolved.cliPath,
    cliVersion,
    nodeVersion,
    viaNode: resolved.kind === "node",
    warnings
  };
}

export async function runQvacDoctor(
  location: RuntimeLocation,
  execFileFn: ExecFn = defaultExec
): Promise<string> {
  try {
    const result = await execFileFn(
      location.command,
      [...location.argsPrefix, "doctor", "--json", "--offline"],
      {
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024
      }
    );
    return result.stdout.trim();
  } catch (error) {
    const withOutput = error as { stdout?: string; stderr?: string; message?: string };
    const combined = `${withOutput.stdout ?? ""}\n${withOutput.stderr ?? ""}`.trim();
    if (combined) {
      return combined;
    }
    throw new LocalPilotError("runtime-missing", "qvac doctor could not be executed.", {
      detail: withOutput.message ?? String(error)
    });
  }
}
