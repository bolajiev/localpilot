#!/usr/bin/env node
"use strict";

const { createQvacClient } = require("../out/qvacClient");
const { LocalPilotError } = require("../out/errors");
const { buildExplainMessages } = require("../out/prompts");

const endpoint = process.env.LOCALPILOT_ENDPOINT || "http://127.0.0.1:11434";
const alias = process.env.LOCALPILOT_ALIAS || "localpilot-model";
const maxTokens = Number(process.env.LOCALPILOT_MAX_TOKENS || "96");
const timeoutMs = Number(process.env.LOCALPILOT_TIMEOUT_MS || "900000");

const code = `function retry(fn, attempts) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}`;

async function main() {
  const client = createQvacClient(endpoint, alias);
  const probe = await client.probe(5000);
  if (probe.kind !== "qvac" || !probe.models.some((entry) => entry.id === alias)) {
    throw new Error(`QVAC model ${alias} is not ready at ${endpoint}`);
  }

  const messages = buildExplainMessages("javascript", code, 6000);
  console.log(`endpoint=${endpoint} alias=${alias} selectionChars=${code.length} maxTokens=${maxTokens}`);
  const started = Date.now();
  let firstDeltaMs;
  const result = await client.chatStream(
    messages,
    { maxTokens, temperature: 0, enableReasoning: false },
    (delta) => {
      if (delta.content) {
        if (firstDeltaMs === undefined) {
          firstDeltaMs = Date.now() - started;
        }
        process.stdout.write(delta.content);
      }
    },
    undefined,
    timeoutMs
  );
  if (!result.content.trim()) {
    throw new Error(`No explanation text returned. reasoningChars=${result.reasoning.length}`);
  }
  process.stdout.write("\n---\n");
  console.log(
    JSON.stringify(
      {
        firstDeltaMs: firstDeltaMs ?? null,
        elapsedMs: result.elapsedMs,
        finishReason: result.finishReason ?? null,
        usage: result.usage ?? null,
        contentChars: result.content.length
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  if (error instanceof LocalPilotError) {
    console.error(`ERROR ${error.code}: ${error.message}`);
    if (error.hint) console.error(`HINT: ${error.hint}`);
    if (error.detail) console.error(`DETAIL: ${error.detail}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
