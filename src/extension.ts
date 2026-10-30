import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import {
  ChatAction,
  ChatPanel,
  ChatStatus,
  LocalPilotChatViewProvider,
  SetupConfig
} from "./chatView";
import { AgentMessage } from "./agentTypes";
import { AgentTools } from "./agentTools";
import { LocalPilotError, toFriendlyError } from "./errors";
import { ChatResult, QvacClient } from "./qvacClient";
import {
  AGENT_OFFLINE_PROMPT,
  AGENT_SYSTEM_PROMPT,
  AGENT_WEB_PROMPT,
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
import { assertLocalModelFile } from "./runtimeConfig";
import {
  modelCacheDirectory,
  readCachedModels,
  recoverLegacyBundledModels
} from "./modelCache";
import { readSettings } from "./settings";

let outputChannel: vscode.OutputChannel | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let manager: RuntimeManager | undefined;
let chatProvider: LocalPilotChatViewProvider | undefined;
let conversation: ChatMessage[] = [];
let requestAbort: AbortController | undefined;
let busy = false;
let suppressSettingsWarning = false;
let lastError: LocalPilotError | undefined;
let lastDownloadProgress: { downloaded: number; total: number } | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

const ONBOARDING_KEY = "localpilot.onboarded";

export interface LocalPilotApi {
  version: string;
  getStatus(): RuntimeStatus;
  startRuntime(): Promise<void>;
  stopRuntime(): Promise<{ externalServerLeftRunning: boolean }>;
  checkRuntime(): Promise<RuntimeCheckReport>;
  createClient(): QvacClient;
  getLastResponse(): string | undefined;
  getLastError(): { code: string; message: string; hint?: string } | undefined;
  getLastDownloadProgress(): { downloaded: number; total: number } | undefined;
  sendChat(text: string): Promise<void>;
  setupModel(kind: "catalog" | "local", value: string): Promise<void>;
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
  lastError = error;
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

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function reviewAgentChange(
  relativePath: string,
  oldContent: string,
  newContent: string,
  isNew: boolean
): Promise<boolean> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showWarningMessage("Open a workspace folder before using Agent mode.");
    return false;
  }
  const absolute = path.resolve(root, relativePath);
  const dirty = vscode.workspace.textDocuments.find(
    (document) => document.uri.fsPath === absolute && document.isDirty
  );
  if (dirty) {
    void vscode.window.showWarningMessage(
      `Save ${relativePath} before applying LocalPilot changes.`
    );
    return false;
  }

  const previewDir = path.join(os.tmpdir(), "localpilot-agent-preview");
  await fs.mkdir(previewDir, { recursive: true });
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const originalFile = path.join(previewDir, `${stamp}-original.txt`);
  const proposedFile = path.join(previewDir, `${stamp}-proposed.txt`);
  await fs.writeFile(originalFile, oldContent, "utf8");
  await fs.writeFile(proposedFile, newContent, "utf8");
  await vscode.commands.executeCommand(
    "vscode.diff",
    vscode.Uri.file(originalFile),
    vscode.Uri.file(proposedFile),
    `LocalPilot proposal: ${relativePath}${isNew ? " (new file)" : ""}`,
    { preview: true }
  );
  const choice = await vscode.window.showWarningMessage(
    `Apply LocalPilot changes to ${relativePath}? The preview is read-only for review; edits in the preview are not applied.`,
    "Apply",
    "Cancel"
  );
  return choice === "Apply";
}

async function runAgentRequest(view: ChatPanel, text: string, webEnabled: boolean): Promise<void> {
  const settings = readSettings();
  const root = workspaceRoot();
  if (!root) {
    view.addError(
      "Agent mode needs an open workspace folder.",
      "Open a folder in VS Code, then retry. Agent tools only access that folder."
    );
    return;
  }

  const controller = new AbortController();
  requestAbort = controller;
  busy = true;
  view.appendUser(text);
  view.setBusy(true, "Agent is working…", true);
  const started = Date.now();

  try {
    const tools = new AgentTools(root, reviewAgentChange, { webEnabled });
    const history = conversation.slice(-8);
    const messages: AgentMessage[] = [
      {
        role: "system",
        content: `${AGENT_SYSTEM_PROMPT}\nWorkspace root: ${root}\nAll tool paths must be relative to the workspace root.\n${
          webEnabled ? AGENT_WEB_PROMPT : AGENT_OFFLINE_PROMPT
        }`
      },
      ...history.map((message) => ({
        role: message.role as "user" | "assistant",
        content: message.content
      })),
      { role: "user", content: text }
    ];
    const client = runtime().createClient(settings);
    let finalContent = "";

    for (let step = 0; step < 4; step += 1) {
      view.setBusy(true, `Agent step ${step + 1} of 4…`, true);
      const result = await client.chatWithTools(
        messages,
        tools.definitions(),
        {
          maxTokens: settings.maxOutputTokens,
          temperature: 0.1,
          enableReasoning: false,
          toolChoice: step === 0 ? "required" : "auto"
        },
        controller.signal,
        settings.requestTimeoutMs
      );
      log(
        `agent step=${step + 1} toolCalls=${result.toolCalls.length} elapsedMs=${result.elapsedMs}`
      );
      if (result.toolCalls.length === 0) {
        finalContent = result.content.trim();
        break;
      }

      messages.push({
        role: "assistant",
        content: result.content || null,
        tool_calls: result.toolCalls
      });
      for (const call of result.toolCalls) {
        view.addNote(`Agent tool: ${call.function.name}`);
        const outcome = await tools.execute(call.function.name, call.function.arguments);
        view.addNote(outcome.summary);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: outcome.ok ? outcome.content : `ERROR: ${outcome.content}`
        });
      }
    }

    if (!finalContent) {
      finalContent = "The agent completed its tool steps without a final summary.";
    }
    const assistantId = view.beginAssistant();
    view.appendAssistantDelta(assistantId, finalContent);
    view.endAssistant(assistantId, { elapsedMs: Date.now() - started });
    appendConversation(
      { role: "user", content: text },
      { role: "assistant", content: finalContent }
    );
    log(`agent completed model=${settings.modelAlias} elapsedMs=${Date.now() - started}`);
  } catch (error) {
    const friendly = toFriendlyError(error);
    if (friendly.code === "cancelled") {
      view.addNote("Agent stopped. Any unapproved changes were discarded.");
      log(`agent cancelled elapsedMs=${Date.now() - started}`);
    } else {
      reportError(friendly, true);
      log(`agent failed code=${friendly.code} elapsedMs=${Date.now() - started}`);
    }
  } finally {
    if (requestAbort === controller) {
      requestAbort = undefined;
    }
    busy = false;
    view.setBusy(false, "", false);
  }
}

async function handleSend(rawText: string, agent = false, web = false): Promise<void> {
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

    if (agent) {
      busy = false;
      await runAgentRequest(view, text, web && agent);
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

  if (!isOnboarded() && !runtimeIsActive()) {
    await openSetupPage();
    void vscode.window.showInformationMessage(
      "Choose a model to set up LocalPilot, then run Explain Selected Code again."
    );
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

async function setModelSettings(modelId: string, modelPath: string): Promise<void> {
  suppressSettingsWarning = true;
  try {
    await updateLocalSetting("modelId", modelId);
    await updateLocalSetting("modelPath", modelPath);
    log(`Model configured: id=${modelId} localPath=${modelPath ? "set" : "none"}`);
  } finally {
    setTimeout(() => {
      suppressSettingsWarning = false;
    }, 600);
  }
}

function isOnboarded(): boolean {
  return extensionContext?.globalState.get<boolean>(ONBOARDING_KEY, false) ?? false;
}

function runtimeIsActive(): boolean {
  const state = runtime().getStatus().state;
  return state === "running" || state === "external" || state === "starting";
}

function currentSetupConfig(): SetupConfig {
  const settings = readSettings();
  return {
    modelId: settings.modelId,
    modelPath: settings.modelPath,
    onboarded: isOnboarded()
  };
}

function initialMode(): "setup" | "chat" {
  return !isOnboarded() && !runtimeIsActive() ? "setup" : "chat";
}

async function openSetupPage(): Promise<ChatPanel> {
  const surface = await showChatSurface(false);
  surface.setSetupConfig(currentSetupConfig());
  surface.setSetupError("");
  surface.setSetupBusy(false, "");
  await refreshSetupCache(surface);
  surface.setMode("setup");
  return surface;
}

async function showChatPage(): Promise<ChatPanel> {
  if (!isOnboarded() && !runtimeIsActive()) {
    return openSetupPage();
  }
  const surface = await showChatSurface(false);
  surface.setMode("chat");
  return surface;
}

async function refreshSetupCache(surface: ChatPanel): Promise<void> {
  try {
    const models = await readCachedModels();
    surface.setCachedModels(models, modelCacheDirectory());
  } catch (error) {
    log(`model cache scan failed: ${toFriendlyError(error).message}`);
  }
}

async function recoverOldModels(): Promise<void> {
  const extensionsDirectory = extensionContext
    ? path.dirname(extensionContext.extensionUri.fsPath)
    : undefined;
  if (!extensionsDirectory) {
    void vscode.window.showWarningMessage("LocalPilot is not active.");
    return;
  }
  const recovered = await recoverLegacyBundledModels(extensionsDirectory);
  const surface = panel();
  if (surface) {
    await refreshSetupCache(surface);
  }
  if (recovered.length > 0) {
    const choice = await vscode.window.showInformationMessage(
      `Recovered ${recovered.length} model file(s) from an older LocalPilot extension into %USERPROFILE%\.qvac\models.`,
      "Open Models Folder"
    );
    if (choice === "Open Models Folder") {
      await openModelsFolder();
    }
  } else {
    void vscode.window.showInformationMessage(
      "No old LocalPilot bundled models were found. Downloaded models stay in %USERPROFILE%\.qvac\models."
    );
  }
}

async function openModelsFolder(): Promise<void> {
  const directory = modelCacheDirectory();
  await fs.mkdir(directory, { recursive: true });
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(directory));
}

async function browseModelForSetup(): Promise<void> {
  const surface = panel();
  if (!surface) {
    return;
  }
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: "Select a GGUF chat model",
    filters: { "GGUF model": ["gguf"] }
  });
  if (selected?.[0]) {
    surface.setSetupLocalPath(selected[0].fsPath);
  }
}

async function startSetup(
  action: Extract<ChatAction, { type: "startSetup" }>
): Promise<void> {
  const surface = panel() ?? (await showChatSurface(false));
  surface.setMode("setup");
  surface.setSetupError("");
  surface.setDownloadProgress(0, 0, false);
  surface.setSetupBusy(
    true,
    action.kind === "local" ? "Loading the local model…" : "Preparing the model…"
  );
  lastError = undefined;
  lastDownloadProgress = undefined;

  try {
    if (action.kind === "catalog") {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(action.modelId)) {
        throw new LocalPilotError("model-missing", "That model ID is not valid.");
      }
      await setModelSettings(action.modelId, "");
    } else {
      await assertLocalModelFile(action.modelPath);
      await setModelSettings(readSettings().modelId, action.modelPath);
    }

    if (runtime().getStatus().state === "running") {
      await stopRuntimeInteractive(true);
    }

    const ready = await startRuntimeInteractive(true);
    if (!ready) {
      surface.setSetupBusy(false, "");
      const failure = lastError as LocalPilotError | undefined;
      surface.setSetupError(
        failure?.message ?? "Setup did not finish.",
        failure?.hint
      );
      return;
    }

    await extensionContext?.globalState.update(ONBOARDING_KEY, true);
    surface.setDownloadProgress(0, 0, false);
    surface.setSetupBusy(false, "");
    surface.setSetupConfig(currentSetupConfig());
    surface.setMode("chat");
    surface.addNote("Model ready. Ask a question below.");
    void vscode.commands.executeCommand("localpilot.chatView.focus");
  } catch (error) {
    const friendly = toFriendlyError(error);
    lastError = friendly;
    surface.setSetupBusy(false, "");
    surface.setSetupError(friendly.message, friendly.hint);
  } finally {
    surface.setDownloadProgress(0, 0, false);
    surface.setSetupBusy(false, "");
    setTimeout(() => {
      suppressSettingsWarning = false;
    }, 600);
  }
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
      extraCandidates: [runtime().managedRuntimeEntry],
      bundledNodePath: runtime().bundledNodePath,
      bundledQvacEntry: runtime().bundledQvacEntry
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
    await checkNodeRuntime(settings.nodePath, runtime().bundledNodePath);
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
            bundledNodePath: runtime().bundledNodePath,
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
  const surface = panel();
  lastDownloadProgress = undefined;
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
            progress: (message) => progress.report({ message }),
            onDownloadProgress: (downloaded, total) => {
              lastDownloadProgress = { downloaded, total };
              surface?.setDownloadProgress(downloaded, total, true);
            }
          });
        } finally {
          subscription.dispose();
        }
      }
    );

    surface?.setDownloadProgress(0, 0, false);
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
    surface?.setDownloadProgress(0, 0, false);
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
      label: "$(cloud-download) Set Up / Choose Model",
      description: "Open the welcome page to download a model or load a local GGUF",
      command: "localpilot.setup"
    },
    {
      label: "$(archive) Recover Old Bundled Models",
      description: "Recover models bundled inside pre-0.6 LocalPilot extension folders",
      command: "localpilot.recoverOldModels"
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
        await handleSend(action.text, action.agent === true, action.web === true);
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
      case "showSetup":
      case "selectModel":
        await openSetupPage();
        break;
      case "showChat":
        await showChatPage();
        break;
      case "browseModel":
        await browseModelForSetup();
        break;
      case "openModelsFolder":
        await openModelsFolder();
        break;
      case "recoverModels":
        await recoverOldModels();
        break;
      case "startSetup":
        await startSetup(action);
        break;
      case "openSettings":
        openSettings();
        break;
      case "ready": {
        const view = panel();
        if (view) {
          view.setStatus(statusToChat(runtime().getStatus()));
          view.setSetupConfig(currentSetupConfig());
          view.setMode(initialMode());
        }
        break;
      }
    }
  } catch (error) {
    reportError(toFriendlyError(error), true);
  }
}

async function openChat(): Promise<void> {
  await showChatPage();
  try {
    const status = await runtime().refreshStatus();
    const view = panel();
    if (view) {
      view.setStatus(statusToChat(status));
      view.setSetupConfig(currentSetupConfig());
      view.setMode(initialMode());
    }
  } catch (error) {
    reportError(toFriendlyError(error), true);
  }
}

function registerCommands(context: vscode.ExtensionContext): void {
  const register = (command: string, callback: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  };

  register("localpilot.setup", () => openSetupPage());
  register("localpilot.checkRuntime", () => checkRuntime(false));
  register("localpilot.startRuntime", () => startRuntimeInteractive(false));
  register("localpilot.selectModel", async () => {
    try {
      await openSetupPage();
    } catch (error) {
      reportError(toFriendlyError(error), false);
    }
  });
  register("localpilot.chat", () => openChat());
  register("localpilot.explainSelection", () => explainSelection());
  register("localpilot.stopRuntime", () => stopRuntimeInteractive(false));
  register("localpilot.showLogs", () => outputChannel?.show(true));
  register("localpilot.openModelsFolder", () => openModelsFolder());
  register("localpilot.recoverOldModels", () => recoverOldModels());
  register("localpilot.statusMenu", () => showStatusMenu());
  register("localpilot.openSettingsInternal", () => openSettings());
}

export function activate(context: vscode.ExtensionContext): LocalPilotApi {
  extensionContext = context;
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
      surface.setSetupConfig(currentSetupConfig());
      surface.setMode(initialMode());
      void refreshSetupCache(surface);
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
    getLastError: () =>
      lastError
        ? { code: lastError.code, message: lastError.message, hint: lastError.hint }
        : undefined,
    getLastDownloadProgress: () =>
      lastDownloadProgress ? { ...lastDownloadProgress } : undefined,
    sendChat: (text: string) => handlePanelAction({ type: "send", text }),
    setupModel: (kind, value) =>
      startSetup(
        kind === "catalog"
          ? { type: "startSetup", kind: "catalog", modelId: value }
          : { type: "startSetup", kind: "local", modelPath: value }
      )
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
