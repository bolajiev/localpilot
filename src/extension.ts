import * as vscode from "vscode";
import {
  ChatAction,
  ChatPanel,
  ChatStatus,
  LocalPilotChatViewProvider
} from "./chatView";
import { LocalPilotError, toFriendlyError } from "./errors";
import { ChatResult, QvacClient } from "./qvacClient";
import {
  assertChatInput,
  buildExplainMessages,
  CHAT_SYSTEM_PROMPT,
  ChatMessage,
  trimConversation
} from "./prompts";
import { checkNodeRuntime, installManagedQvac } from "./runtimeInstaller";
import { locateQvacRuntime } from "./runtimeLocator";
import {
  RuntimeCheckReport,
  RuntimeManager,
  RuntimeStatus,
  formatCheckReport
} from "./runtimeManager";
import { readSettings } from "./settings";

let outputChannel: vscode.OutputChannel | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let manager: RuntimeManager | undefined;
let chatProvider: LocalPilotChatViewProvider | undefined;
let conversation: ChatMessage[] = [];
let requestAbort: AbortController | undefined;
let busy = false;
let suppressSettingsWarning = false;

const DEFAULT_MODEL_ID = "QWEN3_600M_INST_Q4";

interface ModelPickItem extends vscode.QuickPickItem {
  action?: "catalog" | "local" | "custom" | "reset";
  modelId?: string;
}

export interface LocalPilotApi {
  version: string;
  getStatus(): RuntimeStatus;
  startRuntime(): Promise<void>;
  stopRuntime(): Promise<{ externalServerLeftRunning: boolean }>;
  checkRuntime(): Promise<RuntimeCheckReport>;
  createClient(): QvacClient;
  getLastResponse(): string | undefined;
  sendChat(text: string): Promise<void>;
}

function log(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function runtime(): RuntimeManager {
  if (!manager) {
    throw new Error("LocalPilot is not active.");
  }
  return manager;
}

function panel(): ChatPanel | undefined {
  const surface = chatProvider?.currentSurface;
  return surface && !surface.isClosed ? surface : undefined;
}

function statusToChat(status: RuntimeStatus): ChatStatus {
  const settings = readSettings();
  return {
    state: status.state,
    label: status.label,
    detail: status.detail,
    endpoint: status.endpoint,
    modelId: settings.modelId,
    modelAlias: status.modelAlias || settings.modelAlias,
    owned: status.owned
  };
}

function updateStatusBar(status: RuntimeStatus): void {
  if (!statusBar) {
    return;
  }
  const icons: Record<RuntimeStatus["state"], string> = {
    stopped: "$(circle-slash)",
    starting: "$(sync~spin)",
    running: "$(check)",
    external: "$(server)",
    stopping: "$(sync~spin)",
    error: "$(error)"
  };
  statusBar.text = `${icons[status.state]} LocalPilot`;
  statusBar.tooltip = new vscode.MarkdownString(
    [
      `**LocalPilot** — ${status.label}`,
      "",
      status.detail,
      "",
      `Model: \`${status.modelAlias}\``,
      `Endpoint: \`${status.endpoint}\``,
      "",
      "Click for LocalPilot actions."
    ].join("\n")
  );
  statusBar.backgroundColor =
    status.state === "error"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : status.state === "starting" || status.state === "stopping"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
}

function handleStatusChange(status: RuntimeStatus): void {
  updateStatusBar(status);
  const view = panel();
  if (view) {
    view.setStatus(statusToChat(status));
  }
}

async function showChatSurface(preserveFocus = false): Promise<ChatPanel> {
  if (!chatProvider) {
    throw new Error("LocalPilot chat view is not ready.");
  }
  const view = await chatProvider.focus(preserveFocus);
  view.setStatus(statusToChat(runtime().getStatus()));
  return view;
}

function openSettings(): void {
  void vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "@ext:localpilot.localpilot"
  );
}

function reportError(error: LocalPilotError, fromPanel: boolean): void {
  log(`error code=${error.code} message=${error.message}`);
  const view = panel();
  if (fromPanel && view) {
    view.addError(error.message, error.hint);
    return;
  }
  const text = error.hint ? `${error.message} ${error.hint}` : error.message;
  void vscode.window
    .showErrorMessage(text, "Show Details", "Open Settings")
    .then((choice) => {
      if (choice === "Show Details") {
        outputChannel?.show(true);
      } else if (choice === "Open Settings") {
        openSettings();
      }
    });
}

function appendConversation(...messages: ChatMessage[]): void {
  conversation.push(...messages);
  while (conversation.length > 40) {
    conversation.splice(0, 2);
  }
}

function clearConversation(): void {
  if (requestAbort) {
    requestAbort.abort();
  }
  conversation = [];
  panel()?.clear();
}

function cancelRequest(): void {
  if (requestAbort) {
    panel()?.setBusy(true, "Stopping the local generation…", true);
    requestAbort.abort();
  }
}

async function requestModel(
  view: ChatPanel,
  displayUser: string,
  messages: ChatMessage[],
  restoreText: string
): Promise<ChatResult | undefined> {
  view.appendUser(displayUser);
  const assistantId = view.beginAssistant();
  const controller = new AbortController();
  requestAbort = controller;
  busy = true;
  view.setBusy(true, "Thinking locally…", true);
  let partial = "";

  try {
    const settings = readSettings();
    const client = runtime().createClient(settings);
    const result = await client.chatStream(
      messages,
      {
        maxTokens: settings.maxOutputTokens,
        temperature: settings.temperature,
        enableReasoning: settings.enableReasoning
      },
      (delta) => {
        if (delta.content) {
          partial += delta.content;
          view.appendAssistantDelta(assistantId, delta.content);
        }
      },
      controller.signal,
      settings.requestTimeoutMs
    );

    if (!result.content.trim() && result.reasoning.trim()) {
      view.endAssistant(assistantId, { elapsedMs: result.elapsedMs, note: "reasoning only" });
      view.addError(
        "The model produced reasoning but no final answer.",
        "Keep localpilot.enableReasoning off, raise localpilot.maxOutputTokens, or shorten the prompt."
      );
      log(`chat reasoning-only model=${settings.modelAlias} elapsedMs=${result.elapsedMs}`);
      return undefined;
    }

    view.endAssistant(assistantId, {
      elapsedMs: result.elapsedMs,
      promptTokens: result.usage?.prompt_tokens,
      completionTokens: result.usage?.completion_tokens,
      finishReason: result.finishReason
    });
    log(
      `chat ok model=${settings.modelAlias} elapsedMs=${result.elapsedMs} promptTokens=${result.usage?.prompt_tokens ?? "n/a"} completionTokens=${result.usage?.completion_tokens ?? "n/a"} finish=${result.finishReason ?? "n/a"}`
    );
    return result;
  } catch (error) {
    const friendly = toFriendlyError(error);
    if (friendly.code === "cancelled") {
      view.endAssistant(assistantId, { note: "stopped" });
      view.addNote(
        "Generation stopped locally. Partial output stays visible but is not added to conversation history."
      );
      log(`chat cancelled partialChars=${partial.length}`);
      return undefined;
    }
    view.endAssistant(assistantId, { note: "failed" });
    reportError(friendly, true);
    if (restoreText) {
      view.restoreInput(restoreText);
    }
    log(`chat failed code=${friendly.code} partialChars=${partial.length}`);
    return undefined;
  } finally {
    if (requestAbort === controller) {
      requestAbort = undefined;
    }
    busy = false;
    view.setBusy(false, "", false);
  }
}

async function ensureRuntime(fromPanel: boolean): Promise<boolean> {
  const status = await runtime().refreshStatus();
  if (status.state === "running" || status.state === "external") {
    return true;
  }
  if (status.state === "starting") {
    try {
      await runtime().start();
      return true;
    } catch (error) {
      reportError(toFriendlyError(error), fromPanel);
      return false;
    }
  }
  if (status.state === "error") {
    reportError(
      new LocalPilotError("runtime-start", status.detail, {
        hint: status.lastError ?? "Fix the runtime problem shown in the status, then retry."
      }),
      fromPanel
    );
    return false;
  }

  const settings = readSettings();
  let shouldStart = settings.autoStart;
  if (!shouldStart) {
    const choice = await vscode.window.showWarningMessage(
      "LocalPilot needs the local QVAC runtime. Start it now? The first run may download the model and requires internet.",
      { modal: true },
      "Start QVAC",
      "Cancel"
    );
    shouldStart = choice === "Start QVAC";
  }
  if (!shouldStart) {
    return false;
  }
  return startRuntimeInteractive(fromPanel);
}

async function handleSend(rawText: string): Promise<void> {
  const view = await showChatSurface(false);
  if (busy) {
    view.restoreInput(rawText);
    view.addNote("LocalPilot is still working. Stop the current response or wait for it to finish.");
    return;
  }

  let text: string;
  try {
    text = assertChatInput(rawText);
  } catch (error) {
    reportError(toFriendlyError(error), true);
    view.restoreInput(rawText);
    return;
  }

  busy = true;
  view.setBusy(true, "Preparing the local runtime…", false);
  try {
    const ready = await ensureRuntime(true);
    if (!ready) {
      view.restoreInput(rawText);
      return;
    }

    const settings = readSettings();
    let messages: ChatMessage[];
    try {
      messages = trimConversation(
        [
          { role: "system", content: CHAT_SYSTEM_PROMPT },
          ...conversation,
          { role: "user", content: text }
        ],
        settings.contextSize,
        settings.maxOutputTokens
      );
    } catch (error) {
      reportError(toFriendlyError(error), true);
      view.restoreInput(rawText);
      return;
    }

    const result = await requestModel(view, text, messages, rawText);
    if (result?.content.trim()) {
      appendConversation(
        { role: "user", content: text },
        { role: "assistant", content: result.content }
      );
    }
  } finally {
    if (!requestAbort) {
      busy = false;
      view.setBusy(false, "", false);
    }
  }
}

async function explainSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Open a file and select the code to explain.");
    return;
  }
  const selection = editor.selection;
  if (selection.isEmpty) {
    void vscode.window.showWarningMessage(
      "Nothing is selected. Select the code to explain, then run LocalPilot: Explain Selected Code again."
    );
    return;
  }
  const code = editor.document.getText(selection);
  if (!code.trim()) {
    void vscode.window.showWarningMessage(
      "The selection is empty or whitespace. Select the code to explain and try again."
    );
    return;
  }

  const settings = readSettings();
  let explainMessages: ChatMessage[];
  try {
    explainMessages = buildExplainMessages(
      editor.document.languageId,
      code,
      settings.maxSelectionChars
    );
    trimConversation(explainMessages, settings.contextSize, settings.maxOutputTokens);
  } catch (error) {
    reportError(toFriendlyError(error), false);
    return;
  }

  if (busy) {
    const choice = await vscode.window.showWarningMessage(
      "LocalPilot is already generating a response.",
      "Stop Current",
      "Cancel"
    );
    if (choice === "Stop Current") {
      cancelRequest();
    }
    return;
  }

  const effectiveEndLine =
    selection.end.character === 0 && selection.end.line > selection.start.line
      ? selection.end.line - 1
      : selection.end.line;
  const lineCount = effectiveEndLine - selection.start.line + 1;
  const language = editor.document.languageId || "text";
  const displayUser = `Explain selected ${language} code (${lineCount} line${lineCount === 1 ? "" : "s"}, selection only)`;

  const view = await showChatSurface(false);
  busy = true;
  view.setBusy(true, "Preparing the local runtime…", false);
  try {
    const ready = await ensureRuntime(true);
    if (!ready) {
      return;
    }
    const result = await requestModel(view, displayUser, explainMessages, "");
    if (result?.content.trim()) {
      appendConversation(
        { role: "user", content: explainMessages[explainMessages.length - 1].content },
        { role: "assistant", content: result.content }
      );
    }
  } finally {
    if (!requestAbort) {
      busy = false;
      view.setBusy(false, "", false);
    }
  }
}

async function updateLocalSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration("localpilot")
    .update(key, value, vscode.ConfigurationTarget.Global);
}

async function offerRuntimeRestart(): Promise<void> {
  const state = runtime().getStatus().state;
  if (state === "running" || state === "external" || state === "starting") {
    const choice = await vscode.window.showInformationMessage(
      "Model configuration changed. Restart the QVAC runtime to load the new model.",
      "Restart Now",
      "Later"
    );
    if (choice === "Restart Now") {
      await stopRuntimeInteractive(true);
      await startRuntimeInteractive(false);
    }
    return;
  }
  void vscode.window.showInformationMessage(
    "Model configured. Run LocalPilot: Start / Load Local Model to load it."
  );
}

async function selectModel(): Promise<void> {
  const settings = readSettings();
  const items: ModelPickItem[] = [
    {
      label: "Qwen3 0.6B (Q4)",
      description: "≈ 382 MB download · fastest · tested default",
      detail: "QWEN3_600M_INST_Q4 — recommended for CPU-first 16 GB machines",
      action: "catalog",
      modelId: "QWEN3_600M_INST_Q4"
    },
    {
      label: "Qwen3 1.7B (Q4)",
      description: "≈ 1.01 GB download · slower but more capable",
      detail: "QWEN3_1_7B_INST_Q4 — still CPU-friendly, needs more RAM",
      action: "catalog",
      modelId: "QWEN3_1_7B_INST_Q4"
    },
    {
      label: "Qwen3 4B (Q4_K_M)",
      description: "≈ 2.50 GB download · much slower on CPU",
      detail: "QWEN3_4B_INST_Q4_K_M — use only if you have RAM and patience",
      action: "catalog",
      modelId: "QWEN3_4B_INST_Q4_K_M"
    },
    {
      label: "",
      kind: vscode.QuickPickItemKind.Separator
    },
    {
      label: "Use an existing local GGUF file…",
      description: settings.modelPath
        ? `Current: ${settings.modelPath}`
        : "No download · load a llama.cpp-compatible .gguf model from disk",
      action: "local"
    },
    {
      label: "Enter a QVAC catalog model ID…",
      description: "For advanced users: use another catalog constant",
      action: "custom"
    },
    {
      label: "Reset to the default Qwen3 0.6B model",
      description: "Use the tested catalog default and clear the local path",
      action: "reset"
    }
  ];

  const current = settings.modelPath ? `local: ${settings.modelPath}` : settings.modelId;
  const picked = await vscode.window.showQuickPick(items, {
    title: "LocalPilot model source",
    placeHolder: `Current: ${current}. Downloads happen on Start / Load Local Model.`
  });
  if (!picked?.action) {
    return;
  }

  let nextModelId = settings.modelId;
  let nextModelPath = settings.modelPath;
  suppressSettingsWarning = true;
  try {
    switch (picked.action) {
      case "catalog":
      case "reset": {
        nextModelId =
          picked.action === "reset" ? DEFAULT_MODEL_ID : picked.modelId ?? DEFAULT_MODEL_ID;
        nextModelPath = "";
        break;
      }
      case "local": {
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          title: "Select a GGUF chat model",
          filters: { "GGUF model": ["gguf"] }
        });
        if (!selected || selected.length === 0) {
          return;
        }
        nextModelPath = selected[0].fsPath;
        break;
      }
      case "custom": {
        const value = await vscode.window.showInputBox({
          title: "QVAC catalog model ID",
          prompt: "Example: QWEN3_600M_INST_Q4",
          value: settings.modelPath ? DEFAULT_MODEL_ID : settings.modelId,
          validateInput: (candidate) =>
            /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(candidate.trim())
              ? undefined
              : "Use letters, digits, dots, underscores, or hyphens."
        });
        if (!value?.trim()) {
          return;
        }
        nextModelId = value.trim();
        nextModelPath = "";
        break;
      }
    }

    await updateLocalSetting("modelId", nextModelId);
    await updateLocalSetting("modelPath", nextModelPath);
    log(`Model configured: id=${nextModelId} localPath=${nextModelPath ? "set" : "none"}`);
  } finally {
    setTimeout(() => {
      suppressSettingsWarning = false;
    }, 600);
  }

  await offerRuntimeRestart();
}

async function promptForNodeDownload(message: string, hint?: string): Promise<void> {
  const action = await vscode.window.showErrorMessage(
    `${message} ${hint ?? ""}`.trim(),
    "Open Node.js Download",
    "Show Details"
  );
  if (action === "Open Node.js Download") {
    await vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org/en/download"));
  } else if (action === "Show Details") {
    outputChannel?.show(true);
  }
}

async function ensureQvacInstalled(
  settings: ReturnType<typeof readSettings>,
  fromPanel: boolean
): Promise<boolean> {
  if (runtime().getStatus().state === "running" || runtime().getStatus().state === "external") {
    return true;
  }

  const locate = (): Promise<unknown> =>
    locateQvacRuntime({
      qvacPath: settings.qvacPath,
      nodePath: settings.nodePath,
      extraCandidates: [runtime().managedRuntimeEntry]
    });

  let initialError: LocalPilotError;
  try {
    await locate();
    return true;
  } catch (error) {
    initialError = toFriendlyError(error);
  }

  if (
    settings.qvacPath ||
    !settings.autoInstallQvac ||
    !initialError.message.includes("QVAC CLI was not found")
  ) {
    reportError(initialError, fromPanel);
    return false;
  }

  try {
    await checkNodeRuntime(settings.nodePath);
  } catch (error) {
    const friendly = toFriendlyError(error);
    await promptForNodeDownload(friendly.message, friendly.hint);
    return false;
  }

  const choice = await vscode.window.showWarningMessage(
    "QVAC runtime is not installed. LocalPilot can install it into VS Code storage automatically. This downloads about 3 GB and requires Node.js 22.21+ or 24.9+ and internet.",
    { modal: true },
    "Install QVAC",
    "Cancel"
  );
  if (choice !== "Install QVAC") {
    return false;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "LocalPilot: installing QVAC runtime",
        cancellable: true
      },
      async (progress, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          await installManagedQvac({
            targetDir: runtime().managedRuntimeDir,
            nodePath: settings.nodePath,
            signal: controller.signal,
            onMessage: (message: string) => progress.report({ message })
          });
        } finally {
          subscription.dispose();
        }
      }
    );
    await locate();
    log("Managed QVAC runtime installed into VS Code storage.");
    return true;
  } catch (error) {
    const friendly = toFriendlyError(error);
    if (friendly.code === "cancelled") {
      if (fromPanel) {
        panel()?.addNote("QVAC installation cancelled.");
      } else {
        void vscode.window.showInformationMessage("QVAC installation cancelled.");
      }
      return false;
    }
    if (/Node\.js|npm/i.test(friendly.message)) {
      await promptForNodeDownload(friendly.message, friendly.hint);
    } else {
      reportError(friendly, fromPanel);
    }
    return false;
  }
}

async function startRuntimeInteractive(fromPanel = false): Promise<boolean> {
  if (!(await ensureQvacInstalled(readSettings(), fromPanel))) {
    return false;
  }
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "LocalPilot: starting QVAC",
        cancellable: true
      },
      async (progress, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          await runtime().start({
            signal: controller.signal,
            progress: (message) => progress.report({ message })
          });
        } finally {
          subscription.dispose();
        }
      }
    );

    const status = runtime().getStatus();
    const message = `LocalPilot runtime ready: ${status.modelAlias} on ${status.endpoint}.`;
    const view = panel();
    if (fromPanel && view) {
      view.addNote(message);
    } else {
      const choice = await vscode.window.showInformationMessage(
        message,
        "Chat",
        "Check Runtime",
        "Show Log"
      );
      if (choice === "Chat") {
        await vscode.commands.executeCommand("localpilot.chat");
      } else if (choice === "Check Runtime") {
        await vscode.commands.executeCommand("localpilot.checkRuntime");
      } else if (choice === "Show Log") {
        outputChannel?.show(true);
      }
    }
    return true;
  } catch (error) {
    const friendly = toFriendlyError(error);
    if (friendly.code === "cancelled") {
      if (fromPanel) {
        panel()?.addNote("QVAC startup cancelled.");
      } else {
        void vscode.window.showInformationMessage("LocalPilot startup cancelled.");
      }
      return false;
    }
    reportError(friendly, fromPanel);
    return false;
  }
}

async function setupLocalPilot(): Promise<void> {
  const ready = await startRuntimeInteractive(false);
  if (ready) {
    await openChat();
  }
}

async function stopRuntimeInteractive(fromPanel = false): Promise<void> {
  if (requestAbort) {
    requestAbort.abort();
  }

  const status = runtime().getStatus();
  if (status.state === "external") {
    const choice = await vscode.window.showWarningMessage(
      "The QVAC server on this port was not started by LocalPilot. Unload the model but leave that server running?",
      { modal: true },
      "Unload Model",
      "Cancel"
    );
    if (choice !== "Unload Model") {
      return;
    }
  }

  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "LocalPilot: stopping QVAC",
        cancellable: false
      },
      async () => runtime().stop()
    );
    const message = result.externalServerLeftRunning
      ? "Model unloaded. The external QVAC server was left running."
      : "LocalPilot runtime stopped.";
    if (fromPanel) {
      panel()?.addNote(message);
    } else {
      void vscode.window.showInformationMessage(message);
    }
  } catch (error) {
    reportError(toFriendlyError(error), fromPanel);
  }
}

async function checkRuntime(fromPanel = false): Promise<void> {
  try {
    const report = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "LocalPilot: checking QVAC runtime",
        cancellable: false
      },
      async () => runtime().check()
    );
    const formatted = formatCheckReport(report);
    log(formatted);
    if (report.doctorRaw && !report.doctor) {
      outputChannel?.appendLine(report.doctorRaw);
    }

    if (report.errors.length > 0) {
      const summary = `Runtime check found ${report.errors.length} issue(s): ${report.errors[0]}`;
      const view = panel();
      if (fromPanel && view) {
        view.addError("LocalPilot runtime check found problems.", report.errors.join(" "));
      } else {
        const choice = await vscode.window.showErrorMessage(
          summary,
          "Show Details",
          "Open Settings"
        );
        if (choice === "Show Details") {
          outputChannel?.show(true);
        } else if (choice === "Open Settings") {
          openSettings();
        }
      }
      return;
    }

    const summary = `QVAC ${report.cli?.cliVersion ?? "unknown"}; server ${
      report.probe?.kind === "qvac" ? "running" : "stopped"
    }; alias ${report.aliasPresent ? "present" : "not loaded"}; cache ${
      report.cache?.files ?? 0
    } GGUF file(s).`;
    const view = panel();
    if (fromPanel && view) {
      view.addNote(`Runtime check passed. ${summary}`);
    } else {
      const choice = await vscode.window.showInformationMessage(
        `LocalPilot runtime check passed. ${summary}`,
        "Show Details",
        "Start Model",
        "Chat"
      );
      if (choice === "Show Details") {
        outputChannel?.show(true);
      } else if (choice === "Start Model") {
        await vscode.commands.executeCommand("localpilot.startRuntime");
      } else if (choice === "Chat") {
        await vscode.commands.executeCommand("localpilot.chat");
      }
    }
  } catch (error) {
    reportError(toFriendlyError(error), fromPanel);
  }
}

async function showStatusMenu(): Promise<void> {
  const status = runtime().getStatus();
  const items: Array<vscode.QuickPickItem & { command?: string }> = [
    {
      label: `Current status: ${status.label}`,
      description: status.detail,
      detail: `${status.modelAlias} · ${status.endpoint}`
    },
    {
      label: "$(cloud-download) Set Up LocalPilot (QVAC + Model)",
      description: "Install the QVAC runtime if missing, then download and load the model",
      command: "localpilot.setup"
    },
    {
      label: "$(pulse) Check Runtime",
      description: "Inspect the QVAC CLI, doctor report, server, and model cache",
      command: "localpilot.checkRuntime"
    },
    {
      label: "$(play) Start / Load Local Model",
      description: "Start QVAC and preload the configured model",
      command: "localpilot.startRuntime"
    },
    {
      label: "$(library) Choose Model or Local GGUF",
      description: "Pick a catalog download or an existing .gguf file on disk",
      command: "localpilot.selectModel"
    },
    {
      label: "$(comment-discussion) Chat with Local Model",
      description: "Open the local chat panel",
      command: "localpilot.chat"
    },
    {
      label: "$(code) Explain Selected Code",
      description: "Send only the current editor selection to the local model",
      command: "localpilot.explainSelection"
    },
    {
      label: "$(debug-stop) Stop Runtime",
      description: "Unload the model and stop a LocalPilot-managed QVAC process",
      command: "localpilot.stopRuntime"
    },
    {
      label: "$(output) Show Diagnostics Log",
      description: "Show status metadata and sanitized QVAC runtime lines",
      command: "localpilot.showLogs"
    },
    {
      label: "$(gear) Open Settings",
      description: "Configure the QVAC path, port, model, and timeouts",
      command: "localpilot.openSettingsInternal"
    }
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "LocalPilot",
    placeHolder: "Choose a LocalPilot action"
  });
  if (picked?.command === "localpilot.openSettingsInternal") {
    openSettings();
  } else if (picked?.command) {
    await vscode.commands.executeCommand(picked.command);
  }
}

async function handlePanelAction(action: ChatAction): Promise<void> {
  try {
    switch (action.type) {
      case "send":
        await handleSend(action.text);
        break;
      case "cancel":
        cancelRequest();
        break;
      case "clear":
        clearConversation();
        break;
      case "startRuntime":
        await startRuntimeInteractive(true);
        break;
      case "stopRuntime":
        await stopRuntimeInteractive(true);
        break;
      case "checkRuntime":
        await checkRuntime(true);
        break;
      case "selectModel":
        await selectModel();
        break;
      case "openSettings":
        openSettings();
        break;
      case "ready": {
        const view = panel();
        if (view) {
          view.setStatus(statusToChat(runtime().getStatus()));
        }
        break;
      }
    }
  } catch (error) {
    reportError(toFriendlyError(error), true);
  }
}

async function openChat(): Promise<void> {
  await showChatSurface(false);
  try {
    const status = await runtime().refreshStatus();
    const view = panel();
    if (view) {
      view.setStatus(statusToChat(status));
    }
  } catch (error) {
    reportError(toFriendlyError(error), true);
  }
}

function registerCommands(context: vscode.ExtensionContext): void {
  const register = (command: string, callback: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  };

  register("localpilot.setup", () => setupLocalPilot());
  register("localpilot.checkRuntime", () => checkRuntime(false));
  register("localpilot.startRuntime", () => startRuntimeInteractive(false));
  register("localpilot.selectModel", async () => {
    try {
      await selectModel();
    } catch (error) {
      reportError(toFriendlyError(error), false);
    }
  });
  register("localpilot.chat", () => openChat());
  register("localpilot.explainSelection", () => explainSelection());
  register("localpilot.stopRuntime", () => stopRuntimeInteractive(false));
  register("localpilot.showLogs", () => outputChannel?.show(true));
  register("localpilot.statusMenu", () => showStatusMenu());
  register("localpilot.openSettingsInternal", () => openSettings());
}

export function activate(context: vscode.ExtensionContext): LocalPilotApi {
  outputChannel = vscode.window.createOutputChannel("LocalPilot");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = "localpilot.statusMenu";
  statusBar.name = "LocalPilot";
  statusBar.show();

  manager = new RuntimeManager(context, outputChannel, readSettings);
  chatProvider = new LocalPilotChatViewProvider();
  context.subscriptions.push(
    outputChannel,
    statusBar,
    manager,
    chatProvider,
    vscode.window.registerWebviewViewProvider("localpilot.chatView", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    chatProvider.onDidReceiveMessage((action) => {
      void handlePanelAction(action);
    }),
    chatProvider.onDidResolveSurface((surface) => {
      surface.setStatus(statusToChat(runtime().getStatus()));
    })
  );
  context.subscriptions.push(manager.onDidChangeStatus(handleStatusChange));
  registerCommands(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("localpilot")) {
        return;
      }
      if (suppressSettingsWarning) {
        return;
      }
      const state = runtime().getStatus().state;
      if (state === "running" || state === "external" || state === "starting") {
        void vscode.window.showWarningMessage(
          "LocalPilot settings changed. Stop and restart the runtime to apply the new configuration."
        );
        return;
      }
      void runtime()
        .refreshStatus()
        .then(handleStatusChange)
        .catch((error) => log(`status refresh failed: ${toFriendlyError(error).message}`));
    })
  );

  log(
    `LocalPilot activated: vscode=${vscode.version} platform=${process.platform} arch=${process.arch} node=${process.versions.node}`
  );
  handleStatusChange(runtime().getStatus());
  void runtime()
    .refreshStatus()
    .then(handleStatusChange)
    .catch((error) => log(`initial status check failed: ${toFriendlyError(error).message}`));

  return {
    version: String(context.extension.packageJSON.version ?? "0.0.0"),
    getStatus: () => runtime().getStatus(),
    startRuntime: () => runtime().start(),
    stopRuntime: () => runtime().stop(),
    checkRuntime: () => runtime().check(),
    createClient: () => runtime().createClient(),
    getLastResponse: () =>
      [...conversation].reverse().find((message) => message.role === "assistant")?.content,
    sendChat: (text: string) => handlePanelAction({ type: "send", text })
  };
}

export async function deactivate(): Promise<void> {
  requestAbort?.abort();
  chatProvider?.dispose();
  chatProvider = undefined;
  await manager?.shutdown();
  manager?.dispose();
  manager = undefined;
}
