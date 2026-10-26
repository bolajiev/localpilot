#!/usr/bin/env node
"use strict";

const { createQvacClient } = require("../out/qvacClient");
const { LocalPilotError } = require("../out/errors");

const endpoint = process.env.LOCALPILOT_ENDPOINT || "http://127.0.0.1:11434";
const alias = process.env.LOCALPILOT_ALIAS || "localpilot-model";
const maxTokens = Number(process.env.LOCALPILOT_MAX_TOKENS || "32");
const timeoutMs = Number(process.env.LOCALPILOT_TIMEOUT_MS || "900000");
const enableReasoning = process.env.LOCALPILOT_REASONING === "1";
const prompt = process.argv.slice(2).join(" ") || "Reply with exactly: LocalPilot online";

async function main() {
  const client = createQvacClient(endpoint, alias);
  const probe = await client.probe(5000);
  if (probe.kind !== "qvac") {
    throw new Error(`QVAC is not ready at ${endpoint}: ${probe.kind} (${probe.reason || "alias list unavailable"})`);
  }
  const model = probe.models.find((entry) => entry.id === alias);
  if (!model) {
    throw new Error(
      `The runtime at ${endpoint} does not expose ${alias}. Models: ${probe.models.map((entry) => entry.id).join(", ") || "none"}`
    );
  }

  console.log(`endpoint=${endpoint} alias=${alias} state=${model.state || "unknown"} maxTokens=${maxTokens}`);
  const started = Date.now();
  let firstDeltaMs;
  let streamedChars = 0;
  const result = await client.chatStream(
    [{ role: "user", content: prompt }],
    { maxTokens, temperature: 0, enableReasoning },
    (delta) => {
      if (delta.content) {
        if (firstDeltaMs === undefined) {
          firstDeltaMs = Date.now() - started;
        }
        streamedChars += delta.content.length;
        process.stdout.write(delta.content);
      }
    },
    undefined,
    timeoutMs
  );
  if (!result.content.trim()) {
    throw new Error(
      `The model returned no final text. reasoningChars=${result.reasoning.length} finish=${result.finishReason || "n/a"}`
    );
  }
  process.stdout.write("\n");
  console.log("---");
  console.log(
    JSON.stringify(
      {
        firstDeltaMs: firstDeltaMs ?? null,
        elapsedMs: result.elapsedMs,
        streamedChars,
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
