import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export type ChatAction =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "cancel" }
  | { type: "clear" }
  | { type: "startRuntime" }
  | { type: "stopRuntime" }
  | { type: "checkRuntime" }
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

export interface AssistantMeta {
  elapsedMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: string | null;
  note?: string;
}

export class ChatPanel implements vscode.Disposable {
  private static current: ChatPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly messageEmitter = new vscode.EventEmitter<ChatAction>();
  private readonly disposables: vscode.Disposable[] = [];
  private status?: ChatStatus;
  private messageCounter = 0;
  private disposed = false;

  public get isClosed(): boolean {
    return this.disposed;
  }

  public readonly onDidReceiveMessage = this.messageEmitter.event;

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    };
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((raw: unknown) => {
        const action = this.parseAction(raw);
        if (action) {
          this.messageEmitter.fire(action);
        }
      }),
      this.panel.onDidDispose(() => this.dispose()),
      this.messageEmitter
    );
    this.panel.webview.html = this.html();
  }

  public static show(): ChatPanel {
    if (ChatPanel.current && !ChatPanel.current.disposed) {
      ChatPanel.current.panel.reveal(undefined, false);
      return ChatPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      "localpilot.chat",
      "LocalPilot",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      }
    );
    ChatPanel.current = new ChatPanel(panel);
    return ChatPanel.current;
  }

  public reveal(preserveFocus = true): void {
    if (!this.disposed) {
      this.panel.reveal(undefined, preserveFocus);
    }
  }

  public setStatus(status: ChatStatus): void {
    this.status = status;
    this.post({ type: "status", status });
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
      void this.panel.webview.postMessage(message);
    }
  }

  private parseAction(raw: unknown): ChatAction | undefined {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const record = raw as { type?: unknown; text?: unknown };
    if (typeof record.type !== "string") {
      return undefined;
    }
    switch (record.type) {
      case "ready":
        if (this.status) {
          this.post({ type: "status", status: this.status });
        }
        return { type: "ready" };
      case "send":
        return typeof record.text === "string" ? { type: "send", text: record.text } : undefined;
      case "cancel":
      case "clear":
      case "startRuntime":
      case "stopRuntime":
      case "checkRuntime":
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
    if (ChatPanel.current === this) {
      ChatPanel.current = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.panel.dispose();
  }

  private html(): string {
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
    color-scheme: light dark;
    --lp-bg: var(--vscode-editor-background);
    --lp-fg: var(--vscode-editor-foreground);
    --lp-muted: var(--vscode-descriptionForeground);
    --lp-border: var(--vscode-panel-border, rgba(127,127,127,.28));
    --lp-panel: var(--vscode-sideBar-background);
    --lp-input: var(--vscode-input-background);
    --lp-input-fg: var(--vscode-input-foreground);
    --lp-input-border: var(--vscode-input-border, var(--lp-border));
    --lp-accent: var(--vscode-button-background);
    --lp-accent-fg: var(--vscode-button-foreground);
    --lp-code: var(--vscode-textCodeBlock-background);
    --lp-error: var(--vscode-errorForeground);
    --lp-warning: var(--vscode-editorWarning-foreground);
    --lp-ok: var(--vscode-testing-iconPassed, #3fb950);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--lp-bg);
    color: var(--lp-fg);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--lp-border);
    background: var(--lp-panel);
    flex-wrap: wrap;
  }
  .brand { font-weight: 700; letter-spacing: .2px; white-space: nowrap; }
  .brand span { color: var(--lp-muted); font-weight: 400; }
  .status {
    display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid var(--lp-border); border-radius: 999px;
    padding: 2px 9px; font-size: 11px; color: var(--lp-muted);
    max-width: 340px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--lp-muted); flex: none; }
  .status.running .dot, .status.external .dot { background: var(--lp-ok); }
  .status.starting .dot, .status.stopping .dot { background: var(--lp-warning); animation: pulse 1.2s infinite; }
  .status.error .dot { background: var(--lp-error); }
  @keyframes pulse { 50% { opacity: .25; } }
  .spacer { flex: 1 1 auto; }
  .header-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  button {
    font: inherit; font-size: 11px; color: var(--lp-fg);
    background: transparent; border: 1px solid var(--lp-border);
    border-radius: 5px; padding: 4px 9px; cursor: pointer;
  }
  button:hover { background: var(--vscode-toolbar-hoverBackground); }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: var(--lp-accent); color: var(--lp-accent-fg); border-color: transparent; font-weight: 600; }
  main {
    flex: 1 1 auto; overflow-y: auto; padding: 18px 18px 8px;
    scroll-behavior: smooth;
  }
  .welcome {
    border: 1px solid var(--lp-border); border-radius: 10px;
    padding: 14px 16px; margin: 0 0 16px; background: var(--lp-panel);
    color: var(--lp-muted); line-height: 1.5; max-width: 760px;
  }
  .welcome strong { color: var(--lp-fg); }
  .msg { margin: 0 0 16px; display: flex; flex-direction: column; gap: 5px; max-width: 880px; }
  .msg.user { align-items: flex-end; margin-left: auto; }
  .who { font-size: 10px; letter-spacing: .6px; text-transform: uppercase; color: var(--lp-muted); padding: 0 4px; }
  .bubble {
    border: 1px solid var(--lp-border); border-radius: 10px;
    padding: 10px 12px; line-height: 1.55; white-space: normal;
    overflow-wrap: anywhere; width: fit-content; max-width: 100%;
  }
  .msg.user .bubble { background: var(--vscode-input-background); }
  .msg.assistant .bubble { background: var(--lp-panel); }
  .msg.error .bubble { border-color: var(--lp-error); color: var(--lp-error); background: transparent; }
  .msg.note .bubble, .msg.info .bubble {
    width: 100%; max-width: 100%; background: transparent; border-style: dashed;
    color: var(--lp-muted); font-size: 12px; white-space: pre-wrap;
  }
  .bubble p, .bubble .para { margin: 0 0 .65em; white-space: pre-wrap; }
  .bubble .para:last-child { margin-bottom: 0; }
  .bubble pre {
    margin: .7em 0; background: var(--lp-code); border-radius: 6px;
    padding: 9px 10px; overflow-x: auto; border: 1px solid var(--lp-border);
  }
  .bubble code { font-family: var(--vscode-editor-font-family); font-size: .94em; }
  .bubble p code, .bubble .para code {
    background: var(--lp-code); border-radius: 3px; padding: 1px 4px;
  }
  .meta { font-size: 10px; color: var(--lp-muted); padding: 0 4px; }
  .streaming .bubble::after {
    content: ""; display: inline-block; width: 6px; height: 14px;
    background: var(--lp-fg); opacity: .55; margin-left: 3px;
    vertical-align: text-bottom; animation: blink 1s steps(1) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  .hint { display: block; margin-top: 6px; color: var(--lp-muted); font-size: 11px; }
  footer {
    border-top: 1px solid var(--lp-border); padding: 12px 16px;
    background: var(--lp-panel); display: flex; flex-direction: column; gap: 8px;
  }
  .composer { display: flex; gap: 8px; align-items: flex-end; }
  textarea {
    flex: 1 1 auto; resize: none; min-height: 44px; max-height: 180px;
    background: var(--lp-input); color: var(--lp-input-fg);
    border: 1px solid var(--lp-input-border); border-radius: 7px;
    padding: 10px 11px; font: inherit; line-height: 1.4;
    outline: none;
  }
  textarea:focus { border-color: var(--vscode-focusBorder); }
  .footer-row { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--lp-muted); }
  .busy-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .grow { flex: 1 1 auto; }
  @media (max-width: 560px) {
    header { padding: 8px 12px; }
    .brand span { display: none; }
    main { padding: 14px 12px 6px; }
    footer { padding: 10px 12px; }
  }
</style>
</head>
<body>
<header>
  <div class="brand">LocalPilot <span>local QVAC assistant</span></div>
  <div id="status" class="status" title="">
    <span class="dot"></span><span id="status-label">Checking runtime…</span>
  </div>
  <div class="spacer"></div>
  <div class="header-actions">
    <button id="check" title="Check QVAC CLI, server, and model cache">Check</button>
    <button id="start" class="primary" title="Start QVAC and load the model">Start</button>
    <button id="stop" title="Unload the model and stop a LocalPilot-managed server">Stop</button>
    <button id="model" title="Choose a catalog model or an existing local GGUF file">Model</button>
    <button id="settings" title="Open LocalPilot settings">Settings</button>
  </div>
</header>
<main id="messages" aria-live="polite">
  <div class="welcome" id="welcome">
    <strong>Private by default.</strong> Prompts and selected code go only to the QVAC runtime on this machine.
    LocalPilot has no cloud fallback and sends no telemetry. The first catalog-model start may need internet;
    later runs, and models you already have on disk, can work offline.
  </div>
</main>
<footer>
  <div class="composer">
    <textarea id="input" rows="2" placeholder="Ask about your code… (Enter to send, Shift+Enter for a new line)" aria-label="Message"></textarea>
    <button id="send" class="primary">Send</button>
    <button id="cancel" style="display:none">Stop</button>
  </div>
  <div class="footer-row">
    <span id="model-label"></span>
    <span class="grow"></span>
    <span id="busy-label" class="busy-label"></span>
  </div>
</footer>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const welcome = document.getElementById('welcome');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const cancel = document.getElementById('cancel');
  const status = document.getElementById('status');
  const statusLabel = document.getElementById('status-label');
  const busyLabel = document.getElementById('busy-label');
  const modelLabel = document.getElementById('model-label');
  const assistants = new Map();
  let busy = false;
  let canCancel = false;

  function post(message) { vscode.postMessage(message); }

  function nearBottom() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;
  }
  function scroll(force) {
    if (force || nearBottom()) {
      requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
    }
  }

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
        let language = '';
        let code = section;
        const newline = section.indexOf('\\n');
        if (newline >= 0) {
          language = section.slice(0, newline).trim();
          code = section.slice(newline + 1);
        }
        const pre = document.createElement('pre');
        if (language) pre.setAttribute('data-language', language);
        const codeEl = document.createElement('code');
        codeEl.textContent = code.replace(/\\n$/, '');
        pre.appendChild(codeEl);
        body.appendChild(pre);
      } else if (section) {
        const paragraphs = section.split(/\\n{2,}/);
        for (const paragraph of paragraphs) {
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
    if (kind !== 'info' && kind !== 'note') {
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = label;
      wrap.appendChild(who);
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (kind === 'assistant' || kind === 'user') render(bubble, text);
    else bubble.textContent = text;
    wrap.appendChild(bubble);
    messages.appendChild(wrap);
    scroll(true);
    return { wrap, bubble };
  }

  function setBusy(active, label) {
    busy = active;
    send.disabled = active;
    cancel.style.display = active && canCancel ? '' : 'none';
    busyLabel.textContent = active ? label || 'Working locally…' : '';
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'status': {
        const s = message.status;
        status.className = 'status ' + s.state;
        status.title = s.detail || '';
        statusLabel.textContent = s.label;
        modelLabel.textContent = s.modelAlias ? s.modelAlias + ' · ' + s.endpoint.replace(/^https?:\\/\\//, '') : '';
        break;
      }
      case 'busy': {
        canCancel = Boolean(message.canCancel);
        setBusy(Boolean(message.active), message.label);
        break;
      }
      case 'user': {
        addMessage('user', 'You', message.text);
        break;
      }
      case 'info':
      case 'note': {
        addMessage(message.type, '', message.text);
        break;
      }
      case 'error': {
        const entry = addMessage('error', 'LocalPilot error', message.message);
        if (message.hint) {
          const hint = document.createElement('span');
          hint.className = 'hint';
          hint.textContent = message.hint;
          entry.bubble.appendChild(hint);
        }
        scroll(true);
        break;
      }
      case 'assistantStart': {
        const entry = addMessage('assistant streaming', 'LocalPilot', '');
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = 'thinking locally…';
        entry.wrap.appendChild(meta);
        assistants.set(message.id, { ...entry, meta, text: '' });
        scroll(true);
        break;
      }
      case 'assistantDelta': {
        const assistant = assistants.get(message.id);
        if (!assistant) break;
        assistant.text += message.text || '';
        render(assistant.bubble, assistant.text);
        scroll(false);
        break;
      }
      case 'assistantEnd': {
        const assistant = assistants.get(message.id);
        if (!assistant) break;
        assistant.wrap.classList.remove('streaming');
        const meta = message.meta || {};
        const bits = [];
        if (meta.elapsedMs) bits.push((meta.elapsedMs / 1000).toFixed(1) + 's');
        if (meta.completionTokens) bits.push(meta.completionTokens + ' tokens');
        if (meta.finishReason === 'length') bits.push('truncated at max tokens');
        if (meta.note) bits.push(meta.note);
        assistant.meta.textContent = bits.join(' · ');
        assistants.delete(message.id);
        scroll(false);
        break;
      }
      case 'restoreInput': {
        input.value = message.text || '';
        input.dispatchEvent(new Event('input'));
        input.focus();
        break;
      }
      case 'clear': {
        messages.textContent = '';
        assistants.clear();
        const note = document.createElement('div');
        note.className = 'msg info';
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = 'Conversation cleared. Prompts are never written to disk by LocalPilot.';
        note.appendChild(bubble);
        messages.appendChild(note);
        break;
      }
    }
  });

  function submit() {
    const text = input.value;
    if (!text.trim() || busy) return;
    input.value = '';
    post({ type: 'send', text });
  }

  send.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  });
  cancel.addEventListener('click', () => post({ type: 'cancel' }));
  document.getElementById('start').addEventListener('click', () => post({ type: 'startRuntime' }));
  document.getElementById('stop').addEventListener('click', () => post({ type: 'stopRuntime' }));
  document.getElementById('check').addEventListener('click', () => post({ type: 'checkRuntime' }));
  document.getElementById('model').addEventListener('click', () => post({ type: 'selectModel' }));
  document.getElementById('settings').addEventListener('click', () => post({ type: 'openSettings' }));
  post({ type: 'ready' });
  input.focus();
  if (welcome) welcome.scrollIntoView({ block: 'nearest' });
})();
</script>
</body>
</html>`;
  }
}
