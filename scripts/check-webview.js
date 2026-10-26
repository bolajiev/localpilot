#!/usr/bin/env node
"use strict";

const Module = require("module");
const vm = require("vm");

class FakeEventEmitter {
  constructor() {
    this.listeners = [];
  }

  event = (listener) => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };

  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose() {
    this.listeners = [];
  }
}

let capturedPanel;
const panel = {
  webview: {
    options: {},
    html: "",
    onDidReceiveMessage: () => ({ dispose: () => undefined }),
    postMessage: async () => true
  },
  onDidDispose: () => ({ dispose: () => undefined }),
  reveal: () => undefined,
  dispose: () => undefined
};

const fakeVscode = {
  EventEmitter: FakeEventEmitter,
  ViewColumn: { Beside: 2 },
  window: {
    createWebviewPanel: () => {
      capturedPanel = panel;
      return panel;
    }
  }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "vscode") {
    return fakeVscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const { ChatPanel } = require("../out/chatView.js");
  const chat = ChatPanel.show();
  const html = capturedPanel.webview.html;
  const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) {
    throw new Error(`Expected exactly one nonce-tagged webview script, found ${scripts.length}.`);
  }
  new vm.Script(scripts[0][1], { filename: "localpilot-webview.js" });
  if (!/default-src 'none'/.test(html) || !/Content-Security-Policy/.test(html)) {
    throw new Error("Webview CSP is missing or not restrictive.");
  }
  if (html.includes("http://") || html.includes("https://")) {
    throw new Error("Webview HTML must not reference remote resources.");
  }
  chat.dispose();
  console.log(`Webview check passed (${html.length} bytes, CSP, one valid script, no remote resources).`);
} finally {
  Module._load = originalLoad;
}
