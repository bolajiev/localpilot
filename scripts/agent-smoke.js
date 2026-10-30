#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentTools } = require("../out/agentTools");
const { createQvacClient } = require("../out/qvacClient");

const endpoint = process.env.LOCALPILOT_ENDPOINT || "http://127.0.0.1:11434";
const alias = process.env.LOCALPILOT_ALIAS || "localpilot-model";
const maxTokens = Number(process.env.LOCALPILOT_MAX_TOKENS || "64");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "localpilot-agent-smoke-"));
  try {
    const approvals = [];
    const tools = new AgentTools(root, async (relativePath, _oldContent, newContent) => {
      approvals.push({ relativePath, bytes: newContent.length });
      return true;
    });
    const client = createQvacClient(endpoint, alias);
    const messages = [
      {
        role: "system",
        content:
          "You are a coding agent. Use tools. Do not answer with code only. The user must approve writes, which this test auto-approves."
      },
      { role: "user", content: "Create hello.txt containing hi." }
    ];
    const writeIntent = { type: "function", function: { name: "write_file" } };
    const first = await client.chatWithTools(
      messages,
      tools.definitions(),
      { maxTokens, temperature: 0, enableReasoning: false, toolChoice: writeIntent },
      undefined,
      900000
    );
    console.log(`first tool calls: ${JSON.stringify(first.toolCalls)}`);
    messages.push({ role: "assistant", content: first.content || null, tool_calls: first.toolCalls });
    for (const call of first.toolCalls) {
      const outcome = await tools.execute(call.function.name, call.function.arguments);
      console.log(`tool ${call.function.name}: ${outcome.summary}`);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: outcome.ok ? outcome.content : `ERROR: ${outcome.content}`
      });
    }
    const second = await client.chatWithTools(
      messages,
      tools.definitions(),
      { maxTokens, temperature: 0, enableReasoning: false, toolChoice: "auto" },
      undefined,
      900000
    );
    console.log(`final: ${JSON.stringify(second.content)}`);
    const file = path.join(root, "hello.txt");
    if (!fs.existsSync(file)) {
      throw new Error("Agent did not create hello.txt.");
    }
    const content = fs.readFileSync(file, "utf8");
    if (content !== "hi") {
      throw new Error(`Unexpected file content: ${JSON.stringify(content)}`);
    }
    console.log(`PASS: wrote ${content.length} bytes after ${approvals.length} approval(s).`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("AGENT SMOKE FAILED:", error && error.code, error && error.message, error && error.detail);
  process.exitCode = 1;
});
