#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("module");

class FakeEventEmitter {
  event = () => ({ dispose: () => undefined });
  fire() {}
  dispose() {}
}
const webview = {
  options: {},
  html: "",
  onDidReceiveMessage: () => ({ dispose: () => undefined }),
  postMessage: async () => true
};
const view = {
  webview,
  onDidDispose: () => ({ dispose: () => undefined }),
  show: () => undefined
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "vscode") return { EventEmitter: FakeEventEmitter };
  return originalLoad.call(this, request, parent, isMain);
};
const { ChatPanel } = require("../out/chatView.js");
ChatPanel.fromWebviewView(view);
const base = webview.html;
Module._load = originalLoad;

const nonce = base.match(/nonce-([^']+)'/i)?.[1] ?? "";
const theme = `
  :root {
    --vscode-sideBar-background: #1f1f1f;
    --vscode-sideBar-foreground: #cccccc;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-panel-border: #333333;
    --vscode-input-background: #3c3c3c;
    --vscode-input-foreground: #cccccc;
    --vscode-input-border: #3c3c3c;
    --vscode-button-background: #0e639c;
    --vscode-button-foreground: #ffffff;
    --vscode-textCodeBlock-background: #2b2b2b;
    --vscode-errorForeground: #f14c4c;
    --vscode-textLink-foreground: #3794ff;
    --vscode-focusBorder: #007fd4;
    --vscode-editor-font-family: "SFMono-Regular", Consolas, monospace;
    --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --vscode-font-size: 13px;
    background: #1f1f1f;
  }
`;

function previewScript(messages) {
  return `<script nonce="${nonce}">
window.acquireVsCodeApi = function () {
  return { postMessage: function () {}, getState: function () { return {}; }, setState: function () {} };
};
window.addEventListener('load', function () {
  setTimeout(function () {
    ${messages}
  }, 80);
});
</script>`;
}

function makeHtml(messages) {
  const csp = base.includes("Content-Security-Policy");
  return base
    .replace("</head>", `<style nonce="${nonce}">${theme}</style>${previewScript(messages)}</head>`);
}

const statusSetup = `
  window.postMessage({ type: 'status', status: {
    state: 'stopped', label: 'Runtime stopped', detail: 'QVAC has not been started.',
    endpoint: 'http://127.0.0.1:11434', modelId: 'QWEN3_600M_INST_Q4',
    modelAlias: 'localpilot-model', owned: false
  } }, '*');
  window.postMessage({ type: 'setupConfig', config: {
    modelId: 'QWEN3_600M_INST_Q4', modelPath: '', onboarded: false
  } }, '*');
  window.postMessage({ type: 'cachedModels', models: [{
    label: 'Qwen3 0.6B Q4 0', fileName: '5b8aae816570a09d_Qwen3-0.6B-Q4_0.gguf',
    sizeBytes: 382156480, path: 'C:/Users/you/.qvac/models/5b8aae816570a09d_Qwen3-0.6B-Q4_0.gguf'
  }], directory: 'C:/Users/you/.qvac/models' }, '*');
  window.postMessage({ type: 'mode', mode: 'setup' }, '*');
`;

const statusChat = `
  window.postMessage({ type: 'status', status: {
    state: 'running', label: 'QVAC running (managed)', detail: 'Model ready.',
    endpoint: 'http://127.0.0.1:11434', modelId: 'QWEN3_600M_INST_Q4',
    modelAlias: 'localpilot-model', owned: true
  } }, '*');
  window.postMessage({ type: 'setupConfig', config: {
    modelId: 'QWEN3_600M_INST_Q4', modelPath: '', onboarded: true
  } }, '*');
  window.postMessage({ type: 'mode', mode: 'chat' }, '*');
  window.postMessage({ type: 'note', message: 'Model ready. Ask a question below.' }, '*');
  window.postMessage({ type: 'user', text: 'Explain this function in one sentence.\\nfunction add(a, b) { return a + b; }' }, '*');
  window.postMessage({ type: 'assistantStart', id: 1 }, '*');
  window.postMessage({ type: 'assistantDelta', id: 1, text: 'It adds two numbers and returns the result.' }, '*');
  window.postMessage({ type: 'assistantEnd', id: 1, meta: { elapsedMs: 4200, completionTokens: 9, finishReason: 'stop' } }, '*');
`;

const statusDownload = `
  window.postMessage({ type: 'status', status: {
    state: 'starting', label: 'Starting', detail: 'QVAC is preparing the model.',
    endpoint: 'http://127.0.0.1:11434', modelId: 'QWEN3_1_7B_INST_Q4',
    modelAlias: 'localpilot-model', owned: true
  } }, '*');
  window.postMessage({ type: 'setupConfig', config: {
    modelId: 'QWEN3_1_7B_INST_Q4', modelPath: '', onboarded: false
  } }, '*');
  window.postMessage({ type: 'mode', mode: 'setup' }, '*');
  window.postMessage({ type: 'setupBusy', active: true, message: 'Preparing the model…' }, '*');
  window.postMessage({ type: 'downloadProgress', downloaded: 420000000, total: 1056782912, active: true }, '*');
`;

fs.writeFileSync(path.join(__dirname, "../docs/ui/setup.html"), makeHtml(statusSetup));
fs.writeFileSync(path.join(__dirname, "../docs/ui/chat.html"), makeHtml(statusChat));
fs.writeFileSync(path.join(__dirname, "../docs/ui/download.html"), makeHtml(statusDownload));
console.log("Wrote docs/ui/setup.html, chat.html, and download.html");
