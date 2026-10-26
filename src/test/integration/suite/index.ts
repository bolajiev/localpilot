import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, Server } from "node:http";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import type { LocalPilotApi } from "../../../extension";

function log(message: string): void {
  console.log(`[integration] ${message}`);
}

async function updateSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration("localpilot")
    .update(key, value, vscode.ConfigurationTarget.Global);
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return undefined;
}

async function expectRuntimeError(
  action: () => Promise<unknown>,
  expectedCode: string
): Promise<void> {
  try {
    await action();
    assert.fail(`expected ${expectedCode}, but the action succeeded`);
  } catch (error) {
    assert.equal(errorCode(error), expectedCode, `unexpected error: ${String(error)}`);
  }
}

async function startDummyHttpServer(port: number): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("not a qvac server");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function openEditor(content: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({
    language: "javascript",
    content
  });
  return vscode.window.showTextDocument(document, { preview: false });
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<LocalPilotApi>("localpilot.localpilot");
  assert.ok(extension, "LocalPilot extension should be discoverable");
  const api = await extension.activate();
  assert.ok(api, "LocalPilot should return its automation API");
  log(`extension activated, version=${api.version}`);

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "localpilot.setup",
    "localpilot.checkRuntime",
    "localpilot.startRuntime",
    "localpilot.selectModel",
    "localpilot.chat",
    "localpilot.explainSelection",
    "localpilot.stopRuntime",
    "localpilot.showLogs",
    "localpilot.statusMenu"
  ]) {
    assert.ok(commands.includes(command), `${command} should be registered`);
  }
  log("all commands registered");

  const configuration = vscode.workspace.getConfiguration("localpilot");
  const originalQvacPath = configuration.get<string>("qvacPath", "");
  const originalMaxOutput = configuration.get<number>("maxOutputTokens", 384);
  const originalModelPath = configuration.get<string>("modelPath", "");
  const originalModelId = configuration.get<string>("modelId", "QWEN3_600M_INST_Q4");

  try {
    await api.stopRuntime();

    log("testing missing-CLI error path");
    await updateSetting("qvacPath", "/definitely/not/a/qvac/cli");
    await expectRuntimeError(() => api.startRuntime(), "runtime-missing");
    await updateSetting("qvacPath", originalQvacPath);
    log("missing-CLI error path passed");

    log("testing port-conflict error path");
    const dummy = await startDummyHttpServer(11434);
    try {
      await expectRuntimeError(() => api.startRuntime(), "runtime-port-conflict");
      log("port-conflict error path passed");
    } finally {
      await closeServer(dummy);
    }

    await api.stopRuntime();
    await updateSetting("maxOutputTokens", 16);
    log("starting the managed runtime for real inference");
    const startTime = Date.now();
    await api.startRuntime();
    const startMs = Date.now() - startTime;
    const status = api.getStatus();
    assert.ok(
      status.state === "running",
      `managed runtime should be running, got ${status.state}: ${status.detail}`
    );
    assert.equal(status.modelAlias, "localpilot-model");
    log(`managed runtime ready in ${startMs} ms at ${status.endpoint} (pid ${status.pid ?? "unknown"})`);

    const client = api.createClient();
    const probe = await client.probe(5000);
    assert.equal(probe.kind, "qvac");
    if (probe.kind === "qvac") {
      assert.ok(probe.models.some((model) => model.id === "localpilot-model"));
    }
    log("OpenAI-compatible /v1/models probe passed");

    if (process.env.LOCALPILOT_INTEGRATION_SKIP_CHECK !== "1") {
      const report = await api.checkRuntime();
      assert.ok(report.cli, "checkRuntime should locate the QVAC CLI");
      assert.equal(report.errors.length, 0, `runtime check errors: ${report.errors.join("; ")}`);
      assert.equal(report.aliasPresent, true);
      log(
        `checkRuntime passed: qvac=${report.cli?.cliVersion} node=${report.cli?.nodeVersion ?? "n/a"} doctor=${report.doctor?.ok}`
      );
    } else {
      log("checkRuntime skipped by test environment");
    }

    log("opening the chat panel");
    await vscode.commands.executeCommand("localpilot.chat");

    log("sending a real chat message through the extension's panel send path (16-token cap)");
    const inferenceStart = Date.now();
    await api.sendChat("Reply with exactly: LocalPilot integration OK");
    const chatReply = api.getLastResponse();
    if (!chatReply || !chatReply.trim()) {
      log(`chat error: ${JSON.stringify(api.getLastError())}`);
    }
    assert.ok(chatReply && chatReply.trim().length > 0, "local chat should return non-empty text");
    log(
      `real local chat passed in ${Date.now() - inferenceStart} ms: chars=${chatReply?.length ?? 0} text=${JSON.stringify(chatReply?.trim().slice(0, 80))}`
    );

    if (process.env.LOCALPILOT_INTEGRATION_CHAT_ONLY === "1") {
      await api.stopRuntime();
      return;
    }

    log("testing empty-selection handling");
    const editor = await openEditor("function add(a, b) {\n  return a + b;\n}\n");
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const beforeEmpty = api.getLastResponse();
    await vscode.commands.executeCommand("localpilot.explainSelection");
    assert.equal(api.getLastResponse(), beforeEmpty, "empty selection must not trigger inference");
    log("empty-selection handling passed");

    log("running Explain Selected Code through the VS Code command (16-token cap)");
    await vscode.window.showTextDocument(editor.document, {
      preview: false,
      selection: new vscode.Range(0, 0, 2, 1)
    });
    editor.selection = new vscode.Selection(0, 0, 2, 1);
    const explainStart = Date.now();
    await vscode.commands.executeCommand("localpilot.explainSelection");
    const explanation = api.getLastResponse();
    assert.ok(explanation && explanation.trim().length > 0, "Explain Selected Code should produce text");
    assert.notEqual(explanation, beforeEmpty, "Explain Selected Code should add a new response");
    log(
      `Explain Selected Code command passed in ${Date.now() - explainStart} ms: chars=${explanation?.length ?? 0}`
    );

    const stopStart = Date.now();
    const stopResult = await api.stopRuntime();
    assert.equal(stopResult.externalServerLeftRunning, false);
    assert.equal(api.getStatus().state, "stopped");
    log(`managed runtime stopped in ${Date.now() - stopStart} ms`);

    log("testing a user-supplied local GGUF model path");
    const cacheDir = path.join(os.homedir(), ".qvac", "models");
    const cacheEntries = await fs.readdir(cacheDir);
    const ggufName = cacheEntries.find((entry) => entry.toLowerCase().endsWith(".gguf"));
    assert.ok(ggufName, "a cached GGUF is required for the local-model integration test");
    const localModelPath = path.join(cacheDir, ggufName);
    await updateSetting("modelPath", localModelPath);
    const localStart = Date.now();
    await api.startRuntime();
    const localStatus = api.getStatus();
    assert.equal(localStatus.state, "running");
    const localReport = await api.checkRuntime();
    assert.equal(localReport.errors.length, 0, `local model check errors: ${localReport.errors.join("; ")}`);
    const localClient = api.createClient();
    const localResult = await localClient.chatStream(
      [{ role: "user", content: "Say OK" }],
      { maxTokens: 2, temperature: 0, enableReasoning: false },
      () => undefined,
      undefined,
      300000
    );
    assert.ok(
      localResult.content.trim().length > 0 || localResult.reasoning.trim().length > 0,
      "local GGUF model should return text"
    );
    log(
      `local GGUF start+inference passed in ${Date.now() - localStart} ms: path=${path.basename(localModelPath)} chars=${localResult.content.length}`
    );
    await api.stopRuntime();
    await updateSetting("modelPath", "");
  } finally {
    await updateSetting("maxOutputTokens", originalMaxOutput);
    await updateSetting("qvacPath", originalQvacPath);
    await updateSetting("modelPath", originalModelPath);
    await updateSetting("modelId", originalModelId);
    await api.stopRuntime().catch(() => undefined);
  }
}
