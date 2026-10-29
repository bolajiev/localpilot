import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { CachedModel } from "./modelCache";

export type ChatAction =
  | { type: "ready" }
  | { type: "send"; text: string; agent?: boolean; web?: boolean }
  | { type: "cancel" }
  | { type: "clear" }
  | { type: "startRuntime" }
  | { type: "stopRuntime" }
  | { type: "checkRuntime" }
  | { type: "showSetup" }
  | { type: "showChat" }
  | { type: "browseModel" }
  | { type: "openModelsFolder" }
  | { type: "startSetup"; kind: "catalog"; modelId: string }
  | { type: "startSetup"; kind: "local"; modelPath: string }
  | { type: "selectModel" }
  | { type: "openSettings" };

export interface ChatStatus {
  state: string;
  label: string;
  detail: string;
  endpoint: string;
  modelId: string;
  modelAlias: string;
  owned: boolean;
}

export interface SetupConfig {
  modelId: string;
  modelPath: string;
  onboarded: boolean;
}

export interface AssistantMeta {
  elapsedMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: string | null;
  note?: string;
}

export class ChatPanel implements vscode.Disposable {
  private readonly webview: vscode.Webview;
  private readonly revealHost: (preserveFocus: boolean) => void;
  private readonly messageEmitter = new vscode.EventEmitter<ChatAction>();
  private readonly disposables: vscode.Disposable[] = [];
  private status?: ChatStatus;
  private mode: "setup" | "chat" = "setup";
  private setupConfig?: SetupConfig;
  private cachedModels?: { models: CachedModel[]; directory: string };
  private messageCounter = 0;
  private disposed = false;

  public get isClosed(): boolean {
    return this.disposed;
  }

  public readonly onDidReceiveMessage = this.messageEmitter.event;

  private constructor(
    webview: vscode.Webview,
    onDidDispose: vscode.Event<void>,
    reveal: (preserveFocus: boolean) => void
  ) {
    this.webview = webview;
    this.revealHost = reveal;
    this.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    };
    this.disposables.push(
      this.webview.onDidReceiveMessage((raw: unknown) => {
        const action = this.parseAction(raw);
        if (action) {
          this.messageEmitter.fire(action);
        }
      }),
      onDidDispose(() => this.dispose()),
      this.messageEmitter
    );
    this.webview.html = chatHtml();
  }

  public static fromWebviewView(view: vscode.WebviewView): ChatPanel {
    return new ChatPanel(
      view.webview,
      view.onDidDispose,
      (preserveFocus) => view.show(preserveFocus)
    );
  }

  public reveal(preserveFocus = true): void {
    if (!this.disposed) {
      this.revealHost(preserveFocus);
    }
  }

  public setStatus(status: ChatStatus): void {
    this.status = status;
    this.post({ type: "status", status });
  }

  public setMode(mode: "setup" | "chat"): void {
    this.mode = mode;
    this.post({ type: "mode", mode });
  }

  public setSetupConfig(config: SetupConfig): void {
    this.setupConfig = config;
    this.post({ type: "setupConfig", config });
  }

  public setSetupBusy(active: boolean, message: string): void {
    this.post({ type: "setupBusy", active, message });
  }

  public setSetupError(message: string, hint?: string): void {
    this.post({ type: "setupError", message, hint });
  }

  public setSetupLocalPath(modelPath: string): void {
    this.post({ type: "setupLocalPath", path: modelPath });
  }

  public setCachedModels(models: CachedModel[], directory: string): void {
    this.cachedModels = { models, directory };
    this.post({ type: "cachedModels", models, directory });
  }

  public setDownloadProgress(downloaded: number, total: number, active: boolean): void {
    this.post({ type: "downloadProgress", downloaded, total, active });
  }

  public setBusy(active: boolean, label: string, canCancel: boolean): void {
    this.post({ type: "busy", active, label, canCancel });
  }

  public appendUser(text: string): void {
    this.post({ type: "user", text });
  }

  public appendInfo(text: string): void {
    this.post({ type: "info", text });
  }

  public beginAssistant(): number {
    this.messageCounter += 1;
    this.post({ type: "assistantStart", id: this.messageCounter });
    return this.messageCounter;
  }

  public appendAssistantDelta(id: number, text: string): void {
    this.post({ type: "assistantDelta", id, text });
  }

  public endAssistant(id: number, meta: AssistantMeta = {}): void {
    this.post({ type: "assistantEnd", id, meta });
  }

  public addError(message: string, hint?: string): void {
    this.post({ type: "error", message, hint });
  }

  public addNote(message: string): void {
    this.post({ type: "note", message });
  }

  public restoreInput(text: string): void {
    this.post({ type: "restoreInput", text });
  }

  public clear(): void {
    this.post({ type: "clear" });
  }

  private post(message: Record<string, unknown>): void {
    if (!this.disposed) {
      void this.webview.postMessage(message);
    }
  }

  private parseAction(raw: unknown): ChatAction | undefined {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const record = raw as {
      type?: unknown;
      text?: unknown;
      agent?: unknown;
      web?: unknown;
      kind?: unknown;
      modelId?: unknown;
      modelPath?: unknown;
    };
    if (typeof record.type !== "string") {
      return undefined;
    }
    switch (record.type) {
      case "ready":
        if (this.status) {
          this.post({ type: "status", status: this.status });
        }
        this.post({ type: "mode", mode: this.mode });
        if (this.setupConfig) {
          this.post({ type: "setupConfig", config: this.setupConfig });
        }
        if (this.cachedModels) {
          this.post({
            type: "cachedModels",
            models: this.cachedModels.models,
            directory: this.cachedModels.directory
          });
        }
        return { type: "ready" };
      case "send":
        return typeof record.text === "string"
          ? {
              type: "send",
              text: record.text,
              agent: record.agent === true,
              web: record.web === true
            }
          : undefined;
      case "startSetup":
        if (record.kind === "catalog" && typeof record.modelId === "string") {
          return { type: "startSetup", kind: "catalog", modelId: record.modelId };
        }
        if (record.kind === "local" && typeof record.modelPath === "string") {
          return { type: "startSetup", kind: "local", modelPath: record.modelPath };
        }
        return undefined;
      case "cancel":
      case "clear":
      case "startRuntime":
      case "stopRuntime":
      case "checkRuntime":
      case "showSetup":
      case "showChat":
      case "browseModel":
      case "openModelsFolder":
      case "selectModel":
      case "openSettings":
        return { type: record.type };
      default:
        return undefined;
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

function chatHtml(): string {
  const nonce = randomBytes(18).toString("base64url");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>LocalPilot</title>
<style nonce="${nonce}">
  :root {
    --bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --fg: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground));
    --muted: var(--vscode-descriptionForeground);
    --line: var(--vscode-panel-border, rgba(127,127,127,.25));
    --input: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --accent: var(--vscode-button-background);
    --accent-fg: var(--vscode-button-foreground);
    --code: var(--vscode-textCodeBlock-background);
    --error: var(--vscode-errorForeground);
    --ok: var(--vscode-testing-iconPassed, #3fb950);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    display: flex; flex-direction: column; overflow: hidden;
  }
  header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border-bottom: 1px solid var(--line); flex: none;
  }
  .brand { font-weight: 600; font-size: 12px; letter-spacing: .2px; white-space: nowrap; }
  .status { display: flex; align-items: center; gap: 5px; min-width: 0; color: var(--muted); font-size: 11px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); flex: none; }
  .status.running .dot, .status.external .dot { background: var(--ok); }
  .status.starting .dot, .status.stopping .dot { background: #d7a94b; animation: pulse 1.1s infinite; }
  .status.error .dot { background: var(--error); }
  .status-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @keyframes pulse { 50% { opacity: .25; } }
  .grow { flex: 1; }
  button {
    font: inherit; font-size: 11px; color: var(--fg);
    background: transparent; border: 1px solid var(--line);
    border-radius: 4px; padding: 3px 8px; cursor: pointer;
  }
  button:hover { border-color: var(--muted); }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; font-weight: 600; }
  button.power { min-width: 48px; }
  button.agent { min-width: 46px; font-size: 10px; padding: 2px 6px; }
  button.agent.active { background: var(--accent); color: var(--accent-fg); border-color: transparent; font-weight: 600; }
  button.net { min-width: 38px; font-size: 10px; padding: 2px 6px; }
  button.net.active { background: var(--error); color: #ffffff; border-color: transparent; font-weight: 600; }
  button.net:disabled { opacity: .35; }
  main { flex: 1; overflow-y: auto; }
  /* Setup */
  .setup { display: flex; justify-content: center; padding: 24px 16px 16px; }
  .setup-inner { width: 100%; max-width: 380px; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 6px; }
  .sub { margin: 0 0 18px; color: var(--muted); font-size: 12px; line-height: 1.45; }
  .options { border-top: 1px solid var(--line); margin-bottom: 14px; }
  .option {
    display: flex; align-items: flex-start; gap: 9px;
    padding: 11px 2px; border-bottom: 1px solid var(--line); cursor: pointer;
  }
  .option input { margin: 2px 0 0; accent-color: var(--vscode-focusBorder); }
  .option > span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .option strong { font-weight: 500; font-size: 12px; }
  .option small { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
  .option small.warn { color: var(--error); }
  .flag { display: inline-block; border: 1px solid currentColor; border-radius: 2px; padding: 0 3px; font-size: 9px; margin-left: 4px; letter-spacing: .3px; vertical-align: 1px; }
  .option.disabled { opacity: .55; cursor: default; }
  .setup-actions { display: flex; flex-direction: column; gap: 8px; }
  .setup-actions button { padding: 6px 10px; font-size: 12px; }
  .setup-actions button.primary { padding: 7px 10px; }
  .setup-note { color: var(--muted); font-size: 10px; line-height: 1.45; margin: 14px 0 0; }
  .progress { min-height: 32px; margin: 2px 0 8px; visibility: hidden; }
  .progress.active { visibility: visible; }
  .download-bar { height: 5px; background: var(--line); border-radius: 3px; overflow: hidden; }
  #download-fill { width: 0%; height: 100%; background: var(--accent); transition: width .2s ease; }
  .progress.indeterminate #download-fill { width: 100%; animation: progress-pulse 1.2s infinite; }
  .download-label { color: var(--muted); font-size: 10px; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @keyframes progress-pulse { 50% { opacity: .35; } }
  .setup-feedback { min-height: 18px; margin: 0 0 8px; }
  .setup-error {
    color: var(--error); font-size: 11px; line-height: 1.4;
    white-space: pre-wrap;
  }
  .setup-busy { color: var(--muted); font-size: 11px; }
  .cached { margin: 0 0 12px; }
  .cached-title { color: var(--muted); font-size: 10px; letter-spacing: .5px; text-transform: uppercase; margin: 4px 0 2px; }
  .cache-dir { color: var(--muted); font-size: 10px; line-height: 1.4; margin-top: 12px; overflow-wrap: anywhere; }
  .cache-actions { margin-top: 2px; }
  .link { background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; }
  /* Chat */
  .chat { padding: 14px 12px 6px; }
  .msg { margin: 0 0 14px; }
  .msg .who { color: var(--muted); font-size: 10px; margin-bottom: 3px; }
  .msg.user { margin-left: 36px; }
  .msg.user .who { text-align: right; }
  .msg.user .body { background: var(--input); color: var(--input-fg); border-radius: 5px; padding: 6px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .msg.assistant .body { border-left: 2px solid var(--line); padding-left: 9px; line-height: 1.5; overflow-wrap: anywhere; }
  .msg.info .body, .msg.note .body, .msg.error .body { color: var(--muted); font-size: 11px; white-space: pre-wrap; }
  .msg.error .body { color: var(--error); }
  .msg .meta { color: var(--muted); font-size: 10px; margin-top: 4px; }
  .body p { margin: 0 0 .6em; white-space: pre-wrap; }
  .body p:last-child { margin-bottom: 0; }
  .body pre {
    background: var(--code); border: 1px solid var(--line); border-radius: 4px;
    padding: 8px; overflow-x: auto; margin: .6em 0;
  }
  .body code { font-family: var(--vscode-editor-font-family); font-size: .94em; }
  .body :not(pre) > code { background: var(--code); padding: 1px 3px; border-radius: 2px; }
  .streaming .body::after {
    content: ""; display: inline-block; width: 5px; height: 12px;
    background: var(--fg); opacity: .5; margin-left: 3px;
    vertical-align: text-bottom; animation: blink 1s steps(1) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  footer {
    flex: none; border-top: 1px solid var(--line);
    padding: 8px 10px; display: flex; flex-direction: column; gap: 5px;
  }
  .composer { display: flex; gap: 6px; align-items: flex-end; }
  textarea {
    flex: 1; resize: none; min-height: 34px; max-height: 140px;
    background: var(--input); color: var(--input-fg);
    border: 1px solid var(--vscode-input-border, var(--line));
    border-radius: 5px; padding: 7px 8px; font: inherit; line-height: 1.35;
    outline: none;
  }
  textarea:focus { border-color: var(--vscode-focusBorder); }
  .footer-row { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 10px; }
  .busy-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header>
  <div class="brand">LocalPilot</div>
  <div id="status" class="status" title=""><span class="dot"></span><span id="status-label" class="status-label">Starting…</span></div>
  <div class="grow"></div>
  <button id="power" class="power" style="visibility:hidden">Start</button>
  <button id="model" title="Change model">Model</button>
  <button id="settings" title="Settings">Settings</button>
</header>

<main id="setup" class="setup">
  <div class="setup-inner">
    <h1>Choose a model</h1>
    <p class="sub">LocalPilot runs the model on this machine. Download one now, or use a GGUF file you already have.</p>
    <div class="options">
      <label class="option">
        <input type="radio" name="model" value="QWEN3_600M_INST_Q4" checked>
        <span><strong>Qwen3 0.6B</strong><small>382 MB · recommended</small></span>
      </label>
      <label class="option">
        <input type="radio" name="model" value="QWEN3_1_7B_INST_Q4">
        <span><strong>Qwen3 1.7B</strong><small class="warn">1.01 GB · slower, more capable <span class="flag">SLOW</span></small></span>
      </label>
      <label class="option">
        <input type="radio" name="model" value="local">
        <span><strong>Use a local GGUF</strong><small id="local-path">No file selected</small></span>
      </label>
    </div>
    <div id="cached-wrap" class="cached" hidden>
      <div class="cached-title">Already on this PC</div>
      <div id="cached-list" class="options"></div>
    </div>
    <div id="download-progress" class="progress" aria-live="polite">
      <div class="download-bar"><div id="download-fill"></div></div>
      <div id="download-label" class="download-label"></div>
    </div>
    <div class="setup-feedback">
      <div id="setup-error" class="setup-error" hidden></div>
      <div id="setup-busy" class="setup-busy" hidden></div>
    </div>
    <div class="setup-actions">
      <button id="browse" disabled>Browse for .gguf…</button>
      <button id="setup-start" class="primary">Download and start</button>
      <button id="back" class="link" hidden>Back to chat</button>
    </div>
    <div id="cache-dir" class="cache-dir"></div>
    <div class="cache-actions"><button id="open-cache" class="link" hidden>Open models folder</button></div>
    <p class="setup-note">No cloud. No telemetry. Prompts stay on this machine. Internet is needed only for the model download. CPU inference can take several seconds before the first token.</p>
  </div>
</main>

<main id="chat" class="chat" hidden></main>

<footer id="composer" hidden>
  <div class="composer">
    <textarea id="input" rows="1" placeholder="Ask about your code…" aria-label="Message"></textarea>
    <button id="send" class="primary">Send</button>
    <button id="cancel" hidden>Stop</button>
  </div>
  <div class="footer-row">
    <button id="agent" class="agent" title="Agent mode: read workspace files and propose edits; every write needs approval.">Agent</button>
    <button id="net" class="net" title="Internet tools: web search and URL fetch. Off by default; sends queries off this machine.">Net</button>
    <span id="model-label"></span>
    <span class="grow"></span>
    <span id="busy-label" class="busy-label"></span>
  </div>
</footer>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const setup = document.getElementById('setup');
  const chat = document.getElementById('chat');
  const composer = document.getElementById('composer');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const cancel = document.getElementById('cancel');
  const power = document.getElementById('power');
  const agentButton = document.getElementById('agent');
  const netButton = document.getElementById('net');
  const status = document.getElementById('status');
  const statusLabel = document.getElementById('status-label');
  const busyLabel = document.getElementById('busy-label');
  const modelLabel = document.getElementById('model-label');
  const setupError = document.getElementById('setup-error');
  const setupBusy = document.getElementById('setup-busy');
  const downloadProgress = document.getElementById('download-progress');
  const downloadFill = document.getElementById('download-fill');
  const downloadLabel = document.getElementById('download-label');
  const setupStart = document.getElementById('setup-start');
  const browse = document.getElementById('browse');
  const back = document.getElementById('back');
  const localPathLabel = document.getElementById('local-path');
  const cachedWrap = document.getElementById('cached-wrap');
  const cachedList = document.getElementById('cached-list');
  const cacheDir = document.getElementById('cache-dir');
  const openCache = document.getElementById('open-cache');
  const assistants = new Map();
  let busy = false;
  let canCancel = false;
  let mode = 'setup';
  let runtimeState = 'stopped';
  let setupRunning = false;
  let onboarded = false;
  let localPath = '';
  let agentMode = false;
  let netMode = false;
  let cachedModels = [];
  let cacheDirectory = '';

  function post(message) { vscode.postMessage(message); }
  function allRadios() { return Array.from(document.querySelectorAll('input[name="model"]')); }
  function selectedValue() { const r = allRadios().find((x) => x.checked); return r ? r.value : 'QWEN3_600M_INST_Q4'; }
  function isLocal() { return selectedValue() === 'local'; }
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
    return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  }
  function updateSetup() {
    const local = isLocal();
    const cached = selectedValue().startsWith('cached:');
    browse.disabled = setupRunning || !local;
    back.hidden = !onboarded;
    setupStart.disabled = setupRunning || (local && !localPath);
    setupStart.textContent = setupRunning
      ? 'Working…'
      : local || cached
        ? 'Use this model'
        : 'Download and start';
    for (const r of allRadios()) r.disabled = setupRunning;
    updatePower();
  }
  function updatePower() {
    const active = runtimeState === 'running' || runtimeState === 'external';
    power.textContent = active ? 'Stop' : 'Start';
    power.disabled = runtimeState === 'starting' || runtimeState === 'stopping';
    power.style.visibility = mode === 'chat' ? 'visible' : 'hidden';
  }
  function nearBottom() { return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 100; }
  function scroll(force) { if (force || nearBottom()) requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; }); }

  function inline(parent, text) {
    const parts = text.split(/(\`[^\`\\n]+\`)/g);
    for (const part of parts) {
      if (!part) continue;
      if (part.length > 2 && part.startsWith('\`') && part.endsWith('\`')) {
        const code = document.createElement('code');
        code.textContent = part.slice(1, -1);
        parent.appendChild(code);
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    }
  }
  function render(body, text) {
    body.textContent = '';
    const sections = text.split(/\`\`\`/);
    sections.forEach((section, index) => {
      if (index % 2 === 1) {
        let code = section;
        const nl = section.indexOf('\\n');
        if (nl >= 0) code = section.slice(nl + 1);
        const pre = document.createElement('pre');
        const codeEl = document.createElement('code');
        codeEl.textContent = code.replace(/\\n$/, '');
        pre.appendChild(codeEl);
        body.appendChild(pre);
      } else if (section) {
        for (const paragraph of section.split(/\\n{2,}/)) {
          if (!paragraph.trim()) continue;
          const p = document.createElement('p');
          inline(p, paragraph.replace(/^\\n+|\\n+$/g, ''));
          body.appendChild(p);
        }
      }
    });
  }
  function addMessage(kind, label, text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + kind;
    if (label) {
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = label;
      wrap.appendChild(who);
    }
    const body = document.createElement('div');
    body.className = 'body';
    if (kind === 'assistant' || kind === 'user') render(body, text);
    else body.textContent = text;
    wrap.appendChild(body);
    chat.appendChild(wrap);
    scroll(true);
    return { wrap, body };
  }
  function setBusy(active, label) {
    busy = active;
    send.disabled = active;
    cancel.hidden = !(active && canCancel);
    busyLabel.textContent = active ? label || 'Working…' : '';
  }
  function showError(message, hint) {
    setupError.hidden = false;
    setupError.textContent = hint ? message + '\\n' + hint : message;
  }

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'status': {
        const s = m.status;
        const labels = {
          running: 'Running',
          external: 'External',
          starting: 'Starting',
          stopping: 'Stopping',
          stopped: 'Stopped',
          error: 'Error'
        };
        const names = {
          QWEN3_600M_INST_Q4: 'Qwen3 0.6B',
          QWEN3_1_7B_INST_Q4: 'Qwen3 1.7B'
        };
        status.className = 'status ' + s.state;
        status.title = s.detail || s.label || '';
        statusLabel.textContent = labels[s.state] || s.label;
        modelLabel.textContent = names[s.modelId] || s.modelAlias || '';
        runtimeState = s.state;
        const active = s.state === 'running' || s.state === 'external';
        updateSetup();
        break;
      }
      case 'mode': {
        mode = m.mode === 'setup' ? 'setup' : 'chat';
        setup.hidden = mode !== 'setup';
        chat.hidden = mode !== 'chat';
        composer.hidden = mode !== 'chat';
        if (mode === 'chat') { setTimeout(() => input.focus(), 0); }
        updateSetup();
        break;
      }
      case 'setupConfig': {
        const c = m.config;
        onboarded = Boolean(c.onboarded);
        localPath = c.modelPath || '';
        if (c.modelPath) {
          const r = allRadios().find((x) => x.value === 'local');
          if (r) r.checked = true;
          localPathLabel.textContent = c.modelPath;
        } else {
          const r = allRadios().find((x) => x.value === c.modelId);
          if (r) r.checked = true;
          localPathLabel.textContent = 'No file selected';
        }
        setupError.hidden = true;
        updateSetup();
        break;
      }
      case 'setupLocalPath': {
        localPath = m.path || '';
        localPathLabel.textContent = localPath || 'No file selected';
        const r = allRadios().find((x) => x.value === 'local');
        if (r) r.checked = true;
        setupError.hidden = true;
        updateSetup();
        break;
      }
      case 'cachedModels': {
        cachedModels = Array.isArray(m.models) ? m.models : [];
        cacheDirectory = m.directory || '';
        cachedList.textContent = '';
        cachedWrap.hidden = cachedModels.length === 0;
        cachedModels.forEach(function (model, index) {
          const label = document.createElement('label');
          label.className = 'option';
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = 'model';
          input.value = 'cached:' + index;
          const span = document.createElement('span');
          const strong = document.createElement('strong');
          strong.textContent = model.label || model.fileName || 'Local model';
          const small = document.createElement('small');
          small.textContent = [formatBytes(model.sizeBytes), 'already downloaded'].filter(Boolean).join(' · ');
          small.title = model.path || '';
          if (model.sizeBytes > 800 * 1024 * 1024) {
            small.classList.add('warn');
            const flag = document.createElement('span');
            flag.className = 'flag';
            flag.textContent = 'SLOW';
            small.appendChild(flag);
          }
          span.appendChild(strong);
          span.appendChild(small);
          label.appendChild(input);
          label.appendChild(span);
          cachedList.appendChild(label);
        });
        if (localPath) {
          const match = cachedModels.findIndex(function (model) { return model.path === localPath; });
          if (match >= 0) {
            const r = allRadios().find(function (x) { return x.value === 'cached:' + match; });
            if (r) r.checked = true;
          }
        }
        cacheDir.textContent = cacheDirectory ? 'Models folder: ' + cacheDirectory : '';
        openCache.hidden = !cacheDirectory;
        updateSetup();
        break;
      }
      case 'setupBusy': {
        setupRunning = Boolean(m.active);
        setupBusy.hidden = !setupRunning;
        setupBusy.textContent = m.message || '';
        updateSetup();
        break;
      }
      case 'downloadProgress': {
        const active = Boolean(m.active);
        const downloaded = Number(m.downloaded) || 0;
        const total = Number(m.total) || 0;
        const pct = total > 0 ? Math.min(100, (downloaded / total) * 100) : 0;
        downloadProgress.classList.toggle('active', active);
        downloadProgress.classList.toggle('indeterminate', active && total <= 0);
        downloadFill.style.width = active ? (total > 0 ? pct.toFixed(1) + '%' : '100%') : '0%';
        downloadLabel.textContent = active
          ? total > 0
            ? 'Downloading ' + formatBytes(downloaded) + ' / ' + formatBytes(total) + ' · ' + pct.toFixed(0) + '%'
            : 'Downloading ' + formatBytes(downloaded)
          : '';
        break;
      }
      case 'setupError': {
        if (!m.message) {
          setupError.hidden = true;
          setupError.textContent = '';
        } else {
          showError(m.message, m.hint);
        }
        setupRunning = false;
        setupBusy.hidden = true;
        updateSetup();
        break;
      }
      case 'busy': {
        canCancel = Boolean(m.canCancel);
        setBusy(Boolean(m.active), m.label);
        break;
      }
      case 'user': addMessage('user', 'You', m.text); break;
      case 'info':
      case 'note': addMessage(m.type, '', m.message || m.text || ''); break;
      case 'error': {
        const e = addMessage('error', 'Error', m.message);
        if (m.hint) {
          const hint = document.createElement('div');
          hint.className = 'meta';
          hint.textContent = m.hint;
          e.wrap.appendChild(hint);
        }
        scroll(true);
        break;
      }
      case 'assistantStart': {
        const entry = addMessage('assistant streaming', 'LocalPilot', '');
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = 'waiting for first token · 0.0s';
        entry.wrap.appendChild(meta);
        const startedAt = performance.now();
        const timer = setInterval(function () {
          const a = assistants.get(m.id);
          if (!a || a.hasContent) return;
          a.meta.textContent =
            'waiting for first token · ' + ((performance.now() - startedAt) / 1000).toFixed(1) + 's';
        }, 250);
        assistants.set(m.id, { ...entry, meta, text: '', hasContent: false, timer });
        scroll(true);
        break;
      }
      case 'assistantDelta': {
        const a = assistants.get(m.id);
        if (!a) break;
        if (!a.hasContent) {
          a.hasContent = true;
          clearInterval(a.timer);
          a.meta.textContent = 'generating…';
        }
        a.text += m.text || '';
        render(a.body, a.text);
        scroll(false);
        break;
      }
      case 'assistantEnd': {
        const a = assistants.get(m.id);
        if (!a) break;
        clearInterval(a.timer);
        a.wrap.classList.remove('streaming');
        const meta = m.meta || {};
        const bits = [];
        if (meta.elapsedMs) bits.push((meta.elapsedMs / 1000).toFixed(1) + 's');
        if (meta.completionTokens) bits.push(meta.completionTokens + ' tokens');
        if (meta.finishReason === 'length') bits.push('truncated');
        if (meta.note) bits.push(meta.note);
        a.meta.textContent = bits.join(' · ');
        assistants.delete(m.id);
        scroll(false);
        break;
      }
      case 'restoreInput':
        input.value = m.text || '';
        input.dispatchEvent(new Event('input'));
        input.focus();
        break;
      case 'clear':
        chat.textContent = '';
        for (const a of assistants.values()) clearInterval(a.timer);
        assistants.clear();
        break;
    }
  });

  function submit() {
    const text = input.value;
    if (!text.trim() || busy) return;
    input.value = '';
    input.style.height = 'auto';
    post({ type: 'send', text, agent: agentMode, web: netMode });
  }
  function beginSetup() {
    setupError.hidden = true;
    const value = selectedValue();
    if (value.startsWith('cached:')) {
      const model = cachedModels[Number(value.slice(7))];
      if (!model || !model.path) { showError('That cached model is no longer available.'); return; }
      post({ type: 'startSetup', kind: 'local', modelPath: model.path });
    } else if (value === 'local') {
      if (!localPath) { showError('Choose a .gguf file first.'); return; }
      post({ type: 'startSetup', kind: 'local', modelPath: localPath });
    } else {
      post({ type: 'startSetup', kind: 'catalog', modelId: value });
    }
  }

  setup.addEventListener('change', (event) => {
    if (event.target && event.target.name === 'model') updateSetup();
  });
  browse.addEventListener('click', () => post({ type: 'browseModel' }));
  setupStart.addEventListener('click', beginSetup);
  back.addEventListener('click', () => post({ type: 'showChat' }));
  openCache.addEventListener('click', () => post({ type: 'openModelsFolder' }));
  document.getElementById('model').addEventListener('click', () => post({ type: 'showSetup' }));
  document.getElementById('settings').addEventListener('click', () => post({ type: 'openSettings' }));
  power.addEventListener('click', () => {
    if (runtimeState === 'running' || runtimeState === 'external') post({ type: 'stopRuntime' });
    else post({ type: 'startRuntime' });
  });
  function updateAgentUi() {
    agentButton.classList.toggle('active', agentMode);
    netButton.disabled = !agentMode;
    if (!agentMode) netMode = false;
    netButton.classList.toggle('active', netMode);
  }
  agentButton.addEventListener('click', () => {
    agentMode = !agentMode;
    if (!agentMode) netMode = false;
    updateAgentUi();
    addMessage('note', '', agentMode
      ? 'Agent mode ON. LocalPilot can read workspace files and propose edits. Every write requires your approval. Internet is off unless you enable Net.'
      : 'Chat mode ON. The model will not use workspace tools or internet.');
    input.focus();
  });
  netButton.addEventListener('click', () => {
    netMode = !netMode;
    updateAgentUi();
    addMessage('note', '', netMode
      ? 'Internet ON. Agent requests may send search queries/URLs off this machine. Web content is untrusted. Turn Net off for the offline demo.'
      : 'Internet OFF. Agent tools are local-only.');
    input.focus();
  });
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });
  cancel.addEventListener('click', () => post({ type: 'cancel' }));
  updateSetup();
  updateAgentUi();
  post({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

export class LocalPilotChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private surface?: ChatPanel;
  private readonly messageEmitter = new vscode.EventEmitter<ChatAction>();
  private readonly resolveEmitter = new vscode.EventEmitter<ChatPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private waiters: Array<(surface: ChatPanel) => void> = [];

  public readonly onDidReceiveMessage = this.messageEmitter.event;
  public readonly onDidResolveSurface = this.resolveEmitter.event;

  public constructor() {
    this.disposables.push(this.messageEmitter, this.resolveEmitter);
  }

  public get currentSurface(): ChatPanel | undefined {
    return this.surface;
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.surface?.dispose();
    const surface = ChatPanel.fromWebviewView(view);
    this.surface = surface;
    this.disposables.push(
      surface.onDidReceiveMessage((action) => this.messageEmitter.fire(action)),
      view.onDidDispose(() => {
        if (this.surface === surface) {
          this.surface = undefined;
          this.view = undefined;
        }
      })
    );
    this.resolveEmitter.fire(surface);
    for (const waiter of this.waiters.splice(0)) {
      waiter(surface);
    }
  }

  public async focus(preserveFocus = false): Promise<ChatPanel> {
    if (this.surface) {
      this.view?.show(preserveFocus);
      return this.surface;
    }
    const waitForSurface = this.waitForSurface();
    try {
      await vscode.commands.executeCommand("localpilot.chatView.focus");
    } catch (error) {
      this.waiters = [];
      throw error;
    }
    return waitForSurface;
  }

  private waitForSurface(timeoutMs = 5000): Promise<ChatPanel> {
    return new Promise<ChatPanel>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error("LocalPilot sidebar view did not open in time."));
      }, timeoutMs);
      const waiter = (surface: ChatPanel): void => {
        clearTimeout(timer);
        resolve(surface);
      };
      this.waiters.push(waiter);
    });
  }

  public dispose(): void {
    this.surface?.dispose();
    this.surface = undefined;
    this.view = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
