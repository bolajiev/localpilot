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

const statusAgent = `
  window.postMessage({ type: 'status', status: {
    state: 'running', label: 'Running', detail: 'Model ready.',
    endpoint: 'http://127.0.0.1:11434', modelId: 'QWEN3_600M_INST_Q4',
    modelAlias: 'localpilot-model', owned: true
  } }, '*');
  window.postMessage({ type: 'setupConfig', config: {
    modelId: 'QWEN3_600M_INST_Q4', modelPath: '', onboarded: true
  } }, '*');
  window.postMessage({ type: 'mode', mode: 'chat' }, '*');
  setTimeout(function () {
    document.getElementById('agent').click();
    setTimeout(function () {
      window.postMessage({ type: 'user', text: 'Create src/add.ts with an add function and a small comment.' }, '*');
      window.postMessage({ type: 'busy', active: true, label: 'Agent step 1 of 4 · waiting for local model', canCancel: true }, '*');
      window.postMessage({ type: 'note', message: 'Agent step 1/4: waiting for the local model…' }, '*');
      window.postMessage({ type: 'note', message: 'Agent tool: read_file' }, '*');
      window.postMessage({ type: 'note', message: 'Read src/index.ts (1,204 characters).' }, '*');
      window.postMessage({ type: 'note', message: 'Agent tool: write_file' }, '*');
      window.postMessage({ type: 'note', message: 'Waiting for approval: src/add.ts' }, '*');
      window.postMessage({ type: 'assistantStart', id: 2 }, '*');
      window.postMessage({ type: 'assistantDelta', id: 2, text: 'I prepared src/add.ts. Review the diff and click Apply to write it to the workspace.' }, '*');
      window.postMessage({ type: 'assistantEnd', id: 2, meta: { elapsedMs: 8200, completionTokens: 24, finishReason: 'stop' } }, '*');
      window.postMessage({ type: 'busy', active: false, label: '', canCancel: false }, '*');
    }, 30);
  }, 20);
`;

const statusThinking = `
  window.postMessage({ type: 'status', status: {
    state: 'running', label: 'Running', detail: 'Model ready.',
    endpoint: 'http://127.0.0.1:11434', modelId: 'QWEN3_600M_INST_Q4',
    modelAlias: 'localpilot-model', owned: true
  } }, '*');
  window.postMessage({ type: 'setupConfig', config: {
    modelId: 'QWEN3_600M_INST_Q4', modelPath: '', onboarded: true
  } }, '*');
  window.postMessage({ type: 'mode', mode: 'chat' }, '*');
  setTimeout(function () {
    document.getElementById('agent').click();
    setTimeout(function () {
      window.postMessage({ type: 'user', text: 'Create src/add.ts with an add function.' }, '*');
      window.postMessage({ type: 'busy', active: true, label: 'Agent step 1 of 4 · waiting for local model', canCancel: true }, '*');
      window.postMessage({ type: 'note', message: 'Agent step 1/4: waiting for the local model…' }, '*');
    }, 30);
  }, 20);
`;

const statusWeb = `
  window.postMessage({ type: 'status', status: {
    state: 'running', label: 'Running', detail: 'Model ready.',
    endpoint: 'http://127.0.0.1:11434', modelId: 'QWEN3_600M_INST_Q4',
    modelAlias: 'localpilot-model', owned: true
  } }, '*');
  window.postMessage({ type: 'setupConfig', config: {
    modelId: 'QWEN3_600M_INST_Q4', modelPath: '', onboarded: true
  } }, '*');
  window.postMessage({ type: 'mode', mode: 'chat' }, '*');
  setTimeout(function () {
    document.getElementById('agent').click();
    document.getElementById('net').click();
    setTimeout(function () {
      window.postMessage({ type: 'user', text: 'Search the web for the QVAC docs and summarize the local server.' }, '*');
      window.postMessage({ type: 'note', message: 'Agent tool: web_search' }, '*');
      window.postMessage({ type: 'note', message: 'Web search: "QVAC docs" (5 results).' }, '*');
      window.postMessage({ type: 'note', message: 'Agent tool: fetch_url' }, '*');
      window.postMessage({ type: 'note', message: 'Fetched docs.qvac.tether.io (8,420 characters).' }, '*');
      window.postMessage({ type: 'assistantStart', id: 3 }, '*');
      window.postMessage({ type: 'assistantDelta', id: 3, text: 'The QVAC docs describe a local OpenAI-compatible server on 127.0.0.1. Source: https://docs.qvac.tether.io/' }, '*');
      window.postMessage({ type: 'assistantEnd', id: 3, meta: { elapsedMs: 10400, completionTokens: 28, finishReason: 'stop' } }, '*');
    }, 30);
  }, 20);
`;

fs.writeFileSync(path.join(__dirname, "../docs/ui/setup.html"), makeHtml(statusSetup));
fs.writeFileSync(path.join(__dirname, "../docs/ui/chat.html"), makeHtml(statusChat));
fs.writeFileSync(path.join(__dirname, "../docs/ui/download.html"), makeHtml(statusDownload));
fs.writeFileSync(path.join(__dirname, "../docs/ui/agent.html"), makeHtml(statusAgent));
fs.writeFileSync(path.join(__dirname, "../docs/ui/web.html"), makeHtml(statusWeb));
fs.writeFileSync(path.join(__dirname, "../docs/ui/thinking.html"), makeHtml(statusThinking));
console.log("Wrote docs/ui/setup.html, chat.html, download.html, agent.html, web.html, and thinking.html");
