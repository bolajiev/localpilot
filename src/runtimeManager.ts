import { execFile, spawn, ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { LocalPilotError, formatFriendlyError, looksLikeOfflineCacheMiss, toFriendlyError } from "./errors";
import { createQvacClient, ProbeResult, QvacClient, QvacModel } from "./qvacClient";
import {
  assertLocalModelFile,
  endpointForSettings,
  LocalPilotSettings,
  ModelCacheInfo,
  readModelCacheInfo,
  validateSettings,
  writeQvacConfig
} from "./runtimeConfig";
import { locateQvacRuntime, RuntimeLocation, runQvacDoctor } from "./runtimeLocator";
import { sanitizeRuntimeLine } from "./sanitize";

export type RuntimeState = "stopped" | "starting" | "running" | "external" | "stopping" | "error";

export interface RuntimeStatus {
  state: RuntimeState;
  label: string;
  detail: string;
  endpoint: string;
  modelAlias: string;
  owned: boolean;
  pid?: number;
  lastError?: string;
}

export interface DoctorSummary {
  ok: boolean;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
  failures: string[];
  warnings: string[];
}

export interface RuntimeCheckReport {
  settings: LocalPilotSettings;
  endpoint: string;
  cli?: RuntimeLocation;
  doctor?: DoctorSummary;
  doctorRaw?: string;
  probe?: ProbeResult;
  models: QvacModel[];
  aliasPresent: boolean;
  cache?: ModelCacheInfo;
  warnings: string[];
  errors: string[];
}

export type ProgressReporter = (message: string) => void;

interface StartOptions {
  signal?: AbortSignal;
  progress?: ProgressReporter;
}

interface StopResult {
  externalServerLeftRunning: boolean;
}

class LineFramer {
  private buffer = "";

  public constructor(private readonly onLine: (line: string) => void) {}

  public push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > 20000) {
      this.onLine(this.buffer.slice(0, 20000));
      this.buffer = "";
    }
  }

  public flush(): void {
    if (this.buffer.trim()) {
      this.onLine(this.buffer);
    }
    this.buffer = "";
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LocalPilotError("cancelled", "Startup was cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new LocalPilotError("cancelled", "Startup was cancelled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function doctorSummary(raw: string): DoctorSummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const report = parsed as {
    ok?: unknown;
    platform?: unknown;
    arch?: unknown;
    nodeVersion?: unknown;
    sections?: Array<{
      title?: unknown;
      checks?: Array<{
        label?: unknown;
        status?: unknown;
        value?: unknown;
        detail?: unknown;
        hint?: unknown;
      }>;
    }>;
  };
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const section of report.sections ?? []) {
    for (const check of section.checks ?? []) {
      const label = typeof check.label === "string" ? check.label : "check";
      const value = typeof check.value === "string" ? `: ${check.value}` : "";
      const detail = typeof check.detail === "string" ? ` (${check.detail})` : "";
      const line = `${label}${value}${detail}`;
      if (check.status === "fail") {
        failures.push(line);
      } else if (check.status === "warn") {
        warnings.push(line);
      }
    }
  }
  return {
    ok: report.ok === true,
    platform: typeof report.platform === "string" ? report.platform : undefined,
    arch: typeof report.arch === "string" ? report.arch : undefined,
    nodeVersion: typeof report.nodeVersion === "string" ? report.nodeVersion : undefined,
    failures,
    warnings
  };
}

export function formatCheckReport(report: RuntimeCheckReport): string {
  const lines: string[] = ["LocalPilot runtime check"];
  if (report.settings.modelPath) {
    lines.push(`  Model: local GGUF ${report.settings.modelPath}`);
    lines.push(`  Alias: ${report.settings.modelAlias}`);
  } else {
    lines.push(`  Model: ${report.settings.modelId} (alias ${report.settings.modelAlias})`);
  }
  lines.push(`  Endpoint: ${report.endpoint}`);
  if (report.cli) {
    lines.push(
      `  QVAC CLI: ${report.cli.cliVersion} (${report.cli.cliPath})${report.cli.nodeVersion ? ` using Node ${report.cli.nodeVersion}` : ""}`
    );
  } else {
    lines.push("  QVAC CLI: not found");
  }
  if (report.doctor) {
    lines.push(
      `  Doctor: ${report.doctor.ok ? "required checks passed" : "required checks FAILED"} (${report.doctor.platform ?? "?"}-${report.doctor.arch ?? "?"})`
    );
  }
  if (report.probe?.kind === "qvac") {
    const states = report.models.map((model) => `${model.id}${model.state ? ` [${model.state}]` : ""}`);
    lines.push(`  Server: running; models: ${states.join(", ") || "none"}`);
    lines.push(`  Alias ${report.settings.modelAlias}: ${report.aliasPresent ? "present" : "MISSING"}`);
  } else if (report.probe?.kind === "other") {
    lines.push(`  Server: port in use by another service (${report.probe.reason})`);
  } else if (report.probe?.kind === "closed") {
    lines.push("  Server: not running");
  }
  if (report.cache) {
    lines.push(
      `  Model cache: ${report.cache.files} GGUF file(s), ${formatBytes(report.cache.bytes)} in ${report.cache.directory}`
    );
  }
  for (const warning of report.warnings) {
    lines.push(`  WARNING: ${warning}`);
  }
  for (const error of report.errors) {
    lines.push(`  ERROR: ${error}`);
  }
  return lines.join("\n");
}

export class RuntimeManager implements vscode.Disposable {
  private status: RuntimeStatus;
  private child?: ChildProcess;
  private startPromise?: Promise<void>;
  private startAbort?: AbortController;
  private stopRequested = false;
  private readonly diagnostics: string[] = [];
  private readonly statusEmitter = new vscode.EventEmitter<RuntimeStatus>();
  private readonly disposables: vscode.Disposable[] = [];

  public readonly onDidChangeStatus = this.statusEmitter.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly settingsProvider: () => LocalPilotSettings
  ) {
    const settings = settingsProvider();
    this.status = {
      state: "stopped",
      label: "Runtime stopped",
      detail: "QVAC has not been started.",
      endpoint: endpointForSettings(settings),
      modelAlias: settings.modelAlias,
      owned: false
    };
    this.disposables.push(this.statusEmitter);
  }

  public getStatus(): RuntimeStatus {
    return { ...this.status };
  }

  public get configPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, "qvac.config.json");
  }

  public get bundledNodePath(): string {
    return process.platform === "win32"
      ? path.join(this.context.extensionUri.fsPath, "resources", "node", "node.exe")
      : path.join(this.context.extensionUri.fsPath, "resources", "node", "bin", "node");
  }

  public get bundledModelPath(): string {
    return path.join(
      this.context.extensionUri.fsPath,
      "resources",
      "models",
      "Qwen3-0.6B-Q4_0.gguf"
    );
  }

  public get bundledQvacEntry(): string {
    const runtimeRoot = path.join(
      this.context.extensionUri.fsPath,
      "resources",
      "qvac-runtime",
      "node_modules"
    );
    const platformPackages =
      process.platform === "win32"
        ? ["bare-runtime-win32-x64", "@qvac/fabric-win32-x64"]
        : process.platform === "linux"
          ? ["bare-runtime-linux-x64", "@qvac/fabric-linux-x64"]
          : [];
    if (
      platformPackages.length === 0 ||
      !platformPackages.every((entry) => existsSync(path.join(runtimeRoot, entry)))
    ) {
      return "";
    }
    return path.join(runtimeRoot, "@qvac", "cli", "dist", "index.js");
  }

  public get managedRuntimeDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, "qvac-runtime");
  }

  public get managedRuntimeEntry(): string {
    return path.join(
      this.managedRuntimeDir,
      "node_modules",
      "@qvac",
      "cli",
      "dist",
      "index.js"
    );
  }

  public createClient(settings = this.settingsProvider()): QvacClient {
    return createQvacClient(endpointForSettings(settings), settings.modelAlias);
  }

  public log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  public async refreshStatus(): Promise<RuntimeStatus> {
    if (this.status.state === "starting" || this.status.state === "stopping") {
      return this.getStatus();
    }

    let settings: LocalPilotSettings;
    try {
      settings = this.settingsProvider();
      validateSettings(settings);
    } catch (error) {
      const friendly = toFriendlyError(error);
      this.updateStatus({
        state: "error",
        label: "Configuration error",
        detail: friendly.message,
        lastError: formatFriendlyError(friendly)
      });
      return this.getStatus();
    }

    const endpoint = endpointForSettings(settings);
    const client = this.createClient(settings);
    const probe = await client.probe(4000);
    if (probe.kind === "qvac") {
      const aliasPresent = probe.models.some((model) => model.id === settings.modelAlias);
      const owned = Boolean(this.child && this.child.exitCode === null);
      if (aliasPresent) {
        this.updateStatus({
          state: owned ? "running" : "external",
          label: owned ? "QVAC running (managed)" : "QVAC running (external)",
          detail: owned
            ? `Model ${settings.modelAlias} is served on ${endpoint}.`
            : `Using an existing QVAC server on ${endpoint}; LocalPilot will not kill it.`,
          endpoint,
          modelAlias: settings.modelAlias,
          owned,
          pid: owned ? this.child?.pid : undefined
        });
      } else {
        this.updateStatus({
          state: "error",
          label: "Model alias missing",
          detail: `A QVAC server is running on ${endpoint}, but it does not expose "${settings.modelAlias}".`,
          endpoint,
          modelAlias: settings.modelAlias,
          owned: false,
          lastError: "The external QVAC server must be configured with this model alias."
        });
      }
      return this.getStatus();
    }

    if (probe.kind === "other") {
      this.updateStatus({
        state: "error",
        label: "Port conflict",
        detail: `Port ${settings.port} is used by another service (${probe.reason}).`,
        endpoint,
        modelAlias: settings.modelAlias,
        owned: false,
        lastError: "Change localpilot.port or stop the other service."
      });
      return this.getStatus();
    }

    this.updateStatus({
      state: "stopped",
      label: "Runtime stopped",
      detail: "QVAC has not been started.",
      endpoint,
      modelAlias: settings.modelAlias,
      owned: false
    });
    return this.getStatus();
  }

  public async start(options: StartOptions = {}): Promise<void> {
    if (this.status.state === "running" && this.child && this.child.exitCode === null) {
      return;
    }
    if (this.status.state === "running" || this.status.state === "external") {
      const refreshed = await this.refreshStatus();
      if (refreshed.state === "running" || refreshed.state === "external") {
        return;
      }
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const controller = new AbortController();
    this.startAbort = controller;
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        const onAbort = (): void => controller.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    this.startPromise = this.doStart(options.progress, controller.signal)
      .catch((error: unknown) => {
        const friendly = toFriendlyError(error);
        if (this.status.state === "starting") {
          if (friendly.code === "cancelled" || this.stopRequested) {
            this.updateStatus({
              state: "stopped",
              label: "Runtime stopped",
              detail: "Startup was cancelled.",
              owned: false
            });
          } else {
            this.updateStatus({
              state: "error",
              label: "Runtime error",
              detail: friendly.message,
              owned: false,
              lastError: formatFriendlyError(friendly)
            });
          }
        }
        throw friendly;
      })
      .finally(() => {
        if (this.startAbort === controller) {
          this.startAbort = undefined;
        }
        this.startPromise = undefined;
      });
    return this.startPromise;
  }

  private async doStart(progress?: ProgressReporter, signal?: AbortSignal): Promise<void> {
    let settings: LocalPilotSettings;
    try {
      settings = this.settingsProvider();
      validateSettings(settings);
    } catch (error) {
      const friendly = toFriendlyError(error);
      this.updateStatus({
        state: "error",
        label: "Configuration error",
        detail: friendly.message,
        lastError: formatFriendlyError(friendly)
      });
      throw friendly;
    }

    const effectiveSettings = await this.withBundledModel(settings);
    const endpoint = endpointForSettings(settings);
    if (this.child && this.child.exitCode === null) {
      const busy = new LocalPilotError(
        "runtime-start",
        "A QVAC process started by LocalPilot is still running.",
        {
          hint: "Run LocalPilot: Stop Runtime, then start again."
        }
      );
      this.updateStatus({
        state: "error",
        label: "Runtime already running",
        detail: busy.message,
        endpoint,
        modelAlias: settings.modelAlias,
        owned: true,
        pid: this.child.pid,
        lastError: busy.hint
      });
      throw busy;
    }
    this.updateStatus({
      state: "starting",
      label: "Starting QVAC",
      detail: "Checking for an existing local server…",
      endpoint,
      modelAlias: settings.modelAlias,
      owned: false
    });
    this.log(`Starting runtime: model=${settings.modelId} alias=${settings.modelAlias} endpoint=${endpoint}`);
    progress?.("Checking for an existing QVAC server…");

    const client = this.createClient(settings);
    const initialProbe = await client.probe(4000);
    if (initialProbe.kind === "qvac") {
      if (initialProbe.models.some((model) => model.id === settings.modelAlias)) {
        this.updateStatus({
          state: "external",
          label: "QVAC running (external)",
          detail: `Using the existing QVAC server on ${endpoint}; it will not be killed by LocalPilot.`,
          endpoint,
          modelAlias: settings.modelAlias,
          owned: false
        });
        this.log("Reusing an existing QVAC server.");
        return;
      }
      throw new LocalPilotError(
        "runtime-start",
        `A QVAC server is already running on ${endpoint}, but it does not expose "${settings.modelAlias}".`,
        {
          hint: "Stop that server, or change localpilot.port, then run Start / Load Local Model again. LocalPilot will not reconfigure or kill an external server."
        }
      );
    }
    if (initialProbe.kind === "other") {
      throw new LocalPilotError(
        "runtime-port-conflict",
        `Port ${settings.port} is already in use by another service.`,
        {
          hint: "Stop the other service or change localpilot.port, then retry.",
          detail: initialProbe.reason
        }
      );
    }

    if (signal?.aborted) {
      throw new LocalPilotError("cancelled", "Startup was cancelled.");
    }

    progress?.("Locating the QVAC CLI and Node.js…");
    const runtime = await locateQvacRuntime({
      qvacPath: settings.qvacPath,
      nodePath: settings.nodePath,
      extraCandidates: [this.managedRuntimeEntry],
      bundledNodePath: this.bundledNodePath,
      bundledQvacEntry: this.bundledQvacEntry
    });
    this.log(
      `Runtime located: qvac=${runtime.cliVersion} cli=${runtime.cliPath} node=${runtime.nodeVersion ?? "n/a"} viaNode=${runtime.viaNode}`
    );
    for (const warning of runtime.warnings) {
      this.log(`Runtime warning: ${warning}`);
    }

    progress?.("Writing the local QVAC configuration…");
    await writeQvacConfig(this.configPath, effectiveSettings);
    this.log(
      `Wrote QVAC config: ${this.configPath} modelSource=${
        effectiveSettings.modelPath ? "local" : "catalog"
      }`
    );
    const debugLog = process.env.LOCALPILOT_RUNTIME_LOG_FILE;
    if (debugLog) {
      void fs.appendFile(
        debugLog,
        `[localpilot] cwd=${this.context.globalStorageUri.fsPath} config=${this.configPath} modelSource=${
          effectiveSettings.modelPath ? "local" : "catalog"
        } cli=${runtime.cliPath}\n`
      ).catch(() => undefined);
    }

    if (signal?.aborted) {
      throw new LocalPilotError("cancelled", "Startup was cancelled.");
    }

    const args = [
      ...runtime.argsPrefix,
      "serve",
      "--openai",
      "--no-default",
      "-c",
      this.configPath,
      "-p",
      String(settings.port),
      "-H",
      settings.host
    ];

    this.diagnostics.length = 0;
    this.stopRequested = false;
    const child = spawn(runtime.command, args, {
      cwd: this.context.globalStorageUri.fsPath,
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    this.child = child;
    const stdoutFramer = new LineFramer((line) => this.consumeRuntimeLine(line));
    const stderrFramer = new LineFramer((line) => this.consumeRuntimeLine(line));
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdoutFramer.push(chunk));
    child.stderr?.on("data", (chunk: string) => stderrFramer.push(chunk));
    child.once("exit", () => {
      stdoutFramer.flush();
      stderrFramer.flush();
    });

    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
      this.log(`QVAC spawn error: ${error.message}`);
    });

    child.once("exit", (code, exitSignal) => {
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      if (this.stopRequested) {
        return;
      }
      const text = `QVAC runtime exited unexpectedly (code ${code ?? "none"}, signal ${exitSignal ?? "none"}).`;
      this.log(text);
      const friendly = this.failureFromLogs(text);
      this.updateStatus({
        state: "error",
        label: "Runtime crashed",
        detail: friendly.message,
        endpoint,
        modelAlias: settings.modelAlias,
        owned: false,
        lastError: formatFriendlyError(friendly)
      });
    });

    progress?.("Starting QVAC and loading the model (the first run may download it)…");
    this.updateStatus({
      state: "starting",
      label: "Loading model",
      detail: `Waiting for ${settings.modelAlias}. The first run may download the model and needs internet.`,
      endpoint,
      modelAlias: settings.modelAlias,
      owned: true,
      pid: child.pid
    });

    const deadline = Date.now() + settings.startupTimeoutMs;
    let lastProgress = Date.now();
    try {
      while (true) {
        if (signal?.aborted) {
          throw new LocalPilotError("cancelled", "Startup was cancelled.");
        }
        if (spawnError) {
          throw new LocalPilotError("runtime-start", "QVAC could not be started.", {
            hint: "Run LocalPilot: Check Runtime to verify the CLI and Node.js paths.",
            detail: spawnError.message
          });
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          throw this.failureFromLogs(
            `QVAC exited before becoming ready (code ${child.exitCode ?? "none"}).`
          );
        }
        if (Date.now() > deadline) {
          throw new LocalPilotError(
            "timeout",
            `QVAC did not become ready within ${Math.round(settings.startupTimeoutMs / 1000)} seconds.`,
            {
              hint: "The first model download can be slow. Check the diagnostics log, verify internet access, or raise localpilot.startupTimeoutMs.",
              detail: this.diagnostics.slice(-8).join("\n")
            }
          );
        }

        const probe = await client.probe(3000);
        if (probe.kind === "qvac") {
          if (!probe.models.some((model) => model.id === settings.modelAlias)) {
            throw new LocalPilotError(
              "runtime-start",
              `QVAC started, but the model alias "${settings.modelAlias}" is missing.`,
              {
                hint: "Run Start / Load Local Model again. If the problem repeats, check the QVAC config and diagnostics log."
              }
            );
          }
          this.updateStatus({
            state: "running",
            label: "QVAC running (managed)",
            detail: `Model ${settings.modelAlias} is ready on ${endpoint}.`,
            endpoint,
            modelAlias: settings.modelAlias,
            owned: true,
            pid: child.pid
          });
          this.log(`Runtime ready: pid=${child.pid ?? "unknown"} alias=${settings.modelAlias}`);
          return;
        }
        if (probe.kind === "other") {
          throw new LocalPilotError(
            "runtime-port-conflict",
            `Port ${settings.port} was taken by another service while QVAC was starting.`,
            {
              hint: "Stop the other service or change localpilot.port, then retry.",
              detail: probe.reason
            }
          );
        }

        if (Date.now() - lastProgress > 15000) {
          progress?.(`Still loading ${settings.modelAlias}… first start may download the model.`);
          lastProgress = Date.now();
        }
        await delay(750, signal);
      }
    } catch (error) {
      const friendly = toFriendlyError(error);
      this.stopRequested = true;
      await this.terminateChild(child, child.pid).catch(() => undefined);
      if (this.child === child) {
        this.child = undefined;
      }
      if (friendly.code === "cancelled") {
        this.updateStatus({
          state: "stopped",
          label: "Runtime stopped",
          detail: "Startup was cancelled.",
          endpoint,
          modelAlias: settings.modelAlias,
          owned: false
        });
        this.log("Runtime startup cancelled.");
      } else {
        const enriched = this.enrichStartFailure(friendly);
        this.updateStatus({
          state: "error",
          label: "Runtime error",
          detail: enriched.message,
          endpoint,
          modelAlias: settings.modelAlias,
          owned: false,
          lastError: formatFriendlyError(enriched)
        });
        this.log(`Runtime start failed: ${enriched.code}: ${enriched.message}`);
      }
      throw friendly;
    }
  }

  private enrichStartFailure(error: LocalPilotError): LocalPilotError {
    const logs = this.diagnostics.join("\n");
    if (error instanceof LocalPilotError && error.code !== "runtime-start") {
      return error;
    }
    if (looksLikeOfflineCacheMiss(logs)) {
      return new LocalPilotError(
        "offline-cache-miss",
        "QVAC could not load the model from cache while the registry was unreachable.",
        {
          hint: "Connect to the internet and complete one successful Start / Load Local Model run before testing offline.",
          detail: this.diagnostics.slice(-10).join("\n")
        }
      );
    }
    if (/EADDRINUSE|address already in use/i.test(logs)) {
      return new LocalPilotError("runtime-port-conflict", "The configured QVAC port is already in use.", {
        hint: "Stop the other service or change localpilot.port.",
        detail: this.diagnostics.slice(-8).join("\n")
      });
    }
    if (/vulkan/i.test(logs)) {
      return new LocalPilotError("runtime-start", "QVAC reported a Vulkan/runtime problem.", {
        hint: "Windows requires Vulkan 1.4+ even for CPU inference. Update the GPU driver and run `vulkaninfo --summary`.",
        detail: this.diagnostics.slice(-8).join("\n")
      });
    }
    if (/MODEL_FIT|out of memory|ENOMEM|memory/i.test(logs)) {
      return new LocalPilotError("model-fit", "QVAC could not fit the model in memory.", {
        hint: "Close memory-heavy applications, lower localpilot.contextSize, or use a smaller model.",
        detail: this.diagnostics.slice(-8).join("\n")
      });
    }
    return error;
  }

  private failureFromLogs(fallback: string): LocalPilotError {
    const logs = this.diagnostics.join("\n");
    if (looksLikeOfflineCacheMiss(logs)) {
      return new LocalPilotError(
        "offline-cache-miss",
        "QVAC could not load the model; the cache may be incomplete and the registry is unreachable.",
        {
          hint: "Connect to the internet and complete one successful Start / Load Local Model run before testing offline.",
          detail: this.diagnostics.slice(-10).join("\n")
        }
      );
    }
    if (/EADDRINUSE|address already in use/i.test(logs)) {
      return new LocalPilotError("runtime-port-conflict", "The configured QVAC port is already in use.", {
        hint: "Stop the other service or change localpilot.port.",
        detail: this.diagnostics.slice(-8).join("\n")
      });
    }
    if (/vulkan/i.test(logs)) {
      return new LocalPilotError("runtime-start", "QVAC reported a Vulkan/runtime problem.", {
        hint: "Windows requires Vulkan 1.4+ even for CPU inference. Update the GPU driver and run `vulkaninfo --summary`.",
        detail: this.diagnostics.slice(-8).join("\n")
      });
    }
    if (/MODEL_FIT|out of memory|ENOMEM/i.test(logs)) {
      return new LocalPilotError("model-fit", "QVAC could not fit the model in memory.", {
        hint: "Close memory-heavy applications, lower localpilot.contextSize, or use a smaller model.",
        detail: this.diagnostics.slice(-8).join("\n")
      });
    }
    return new LocalPilotError("runtime-start", fallback, {
      hint: "Run LocalPilot: Show Diagnostics Log for metadata, then retry.",
      detail: this.diagnostics.slice(-8).join("\n")
    });
  }

  private consumeRuntimeLine(line: string): void {
    const safe = sanitizeRuntimeLine(line);
    if (!safe) {
      return;
    }
    this.diagnostics.push(safe);
    if (this.diagnostics.length > 60) {
      this.diagnostics.shift();
    }
    this.output.appendLine(`[qvac] ${safe}`);
    const debugLog = process.env.LOCALPILOT_RUNTIME_LOG_FILE;
    if (debugLog) {
      void fs.appendFile(debugLog, `[qvac] ${safe}\n`).catch(() => undefined);
    }
  }

  public async stop(): Promise<StopResult> {
    this.startAbort?.abort();
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }

    let settings: LocalPilotSettings;
    try {
      settings = this.settingsProvider();
      validateSettings(settings);
    } catch (error) {
      throw toFriendlyError(error);
    }
    const endpoint = endpointForSettings(settings);
    const client = this.createClient(settings);

    if (!this.child) {
      const probe = await client.probe(4000);
      if (probe.kind === "qvac") {
        this.updateStatus({
          state: "stopping",
          label: "Stopping QVAC",
          detail: "Unloading the model from the external server…",
          endpoint,
          modelAlias: settings.modelAlias,
          owned: false
        });
        let unloadError: LocalPilotError | undefined;
        if (probe.models.some((model) => model.id === settings.modelAlias)) {
          try {
            await client.unloadModel(settings.modelAlias, 10000);
          } catch (error) {
            unloadError = toFriendlyError(error);
          }
        }
        this.updateStatus({
          state: "external",
          label: "QVAC running (external)",
          detail: "The external QVAC server was left running; LocalPilot does not own it.",
          endpoint,
          modelAlias: settings.modelAlias,
          owned: false,
          lastError: unloadError ? formatFriendlyError(unloadError) : undefined
        });
        this.log("Stop requested for external server: model unload attempted, server left running.");
        return { externalServerLeftRunning: true };
      }
      this.updateStatus({
        state: "stopped",
        label: "Runtime stopped",
        detail: "QVAC is not running.",
        endpoint,
        modelAlias: settings.modelAlias,
        owned: false
      });
      return { externalServerLeftRunning: false };
    }

    const child = this.child;
    this.stopRequested = true;
    this.updateStatus({
      state: "stopping",
      label: "Stopping QVAC",
      detail: "Unloading the model and stopping the managed runtime…",
      endpoint,
      modelAlias: settings.modelAlias,
      owned: true,
      pid: child.pid
    });

    try {
      await client.unloadModel(settings.modelAlias, 5000);
    } catch (error) {
      this.log(`Model unload during stop failed (continuing): ${toFriendlyError(error).message}`);
    }

    await this.terminateChild(child, child.pid);
    if (this.child === child) {
      this.child = undefined;
    }
    this.updateStatus({
      state: "stopped",
      label: "Runtime stopped",
      detail: "The QVAC process started by LocalPilot has been stopped.",
      endpoint,
      modelAlias: settings.modelAlias,
      owned: false
    });
    this.log("Runtime stopped.");
    return { externalServerLeftRunning: false };
  }

  private async terminateChild(child: ChildProcess, pid: number | undefined): Promise<void> {
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

    this.log(`QVAC process ${pid} did not exit gracefully; forcing termination.`);
    if (process.platform === "win32") {
      child.kill();
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    await waitForExit(child, 3000);
  }

  public async check(): Promise<RuntimeCheckReport> {
    const configuredSettings = this.settingsProvider();
    let settings = configuredSettings;
    const warnings: string[] = [];
    const errors: string[] = [];
    let endpoint = "";

    try {
      validateSettings(configuredSettings);
      settings = await this.withBundledModel(configuredSettings);
      validateSettings(settings);
      endpoint = endpointForSettings(settings);
      if (settings.modelPath) {
        await assertLocalModelFile(settings.modelPath);
      }
    } catch (error) {
      errors.push(toFriendlyError(error).message);
    }

    let cli: RuntimeLocation | undefined;
    let doctor: DoctorSummary | undefined;
    let doctorRaw: string | undefined;
    try {
      cli = await locateQvacRuntime({
        qvacPath: settings.qvacPath,
        nodePath: settings.nodePath,
        extraCandidates: [this.managedRuntimeEntry],
        bundledNodePath: this.bundledNodePath,
        bundledQvacEntry: this.bundledQvacEntry
      });
      warnings.push(...cli.warnings);
      try {
        doctorRaw = await runQvacDoctor(cli);
        doctor = doctorSummary(doctorRaw);
        if (!doctor) {
          warnings.push("qvac doctor returned output that could not be parsed as JSON.");
        }
      } catch (error) {
        warnings.push(`qvac doctor failed: ${toFriendlyError(error).message}`);
      }
    } catch (error) {
      errors.push(toFriendlyError(error).message);
    }

    if (doctor) {
      for (const failure of doctor.failures) {
        errors.push(`doctor: ${failure}`);
      }
      for (const warning of doctor.warnings) {
        warnings.push(`doctor: ${warning}`);
      }
      if (doctor.platform === "win32") {
        warnings.push(
          "Windows requires Vulkan 1.4 or newer even for CPU-only inference. qvac doctor may not verify the Vulkan version; run `vulkaninfo --summary`."
        );
      }
    }

    let probe: ProbeResult | undefined;
    let models: QvacModel[] = [];
    let aliasPresent = false;
    if (endpoint) {
      try {
        const client = this.createClient(settings);
        probe = await client.probe(4000);
        if (probe.kind === "qvac") {
          models = probe.models;
          aliasPresent = models.some((model) => model.id === settings.modelAlias);
          if (!aliasPresent) {
            errors.push(`The running QVAC server does not expose alias ${settings.modelAlias}.`);
          }
        } else if (probe.kind === "other") {
          errors.push(`Port ${settings.port} is in use by another service (${probe.reason}).`);
        }
      } catch (error) {
        errors.push(toFriendlyError(error).message);
      }
    }

    let cache: ModelCacheInfo | undefined;
    try {
      cache = await readModelCacheInfo();
      if (cache.files === 0 && !settings.modelPath) {
        warnings.push("No complete GGUF model file was found in ~/.qvac/models; the first start needs internet.");
      }
    } catch (error) {
      warnings.push(`Could not inspect the model cache: ${toFriendlyError(error).message}`);
    }

    if (settings.port !== 11434) {
      warnings.push(`Using non-default QVAC port ${settings.port}.`);
    }

    return {
      settings,
      endpoint,
      cli,
      doctor,
      doctorRaw,
      probe,
      models,
      aliasPresent,
      cache,
      warnings,
      errors
    };
  }

  private async withBundledModel(settings: LocalPilotSettings): Promise<LocalPilotSettings> {
    if (settings.modelPath || settings.modelId !== "QWEN3_600M_INST_Q4") {
      return settings;
    }
    try {
      const stat = await fs.stat(this.bundledModelPath);
      if (stat.isFile() && stat.size > 0) {
        return { ...settings, modelPath: this.bundledModelPath };
      }
    } catch {
      // Generic/unbundled builds fall back to the QVAC catalog download.
    }
    return settings;
  }

  private updateStatus(patch: Partial<RuntimeStatus> & Pick<RuntimeStatus, "state" | "label" | "detail">): void {
    this.status = {
      ...this.status,
      ...patch,
      owned: patch.owned ?? this.status.owned
    };
    this.statusEmitter.fire(this.getStatus());
  }

  public async shutdown(): Promise<void> {
    this.startAbort?.abort();
    const settings = this.settingsProvider();
    if (this.child && settings.stopOnExit) {
      this.stopRequested = true;
      await this.terminateChild(this.child, this.child.pid);
      this.child = undefined;
    }
  }

  public dispose(): void {
    void this.shutdown();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
