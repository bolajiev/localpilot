import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildQvacConfig,
  endpointForSettings,
  readModelCacheInfo,
  validateSettings,
  writeQvacConfig
} from "../runtimeConfig";
import { testSettings } from "./helpers";

test("buildQvacConfig creates one preloaded model with a context size", () => {
  const config = buildQvacConfig(testSettings());
  const entry = config.serve.models["localpilot-model"];
  assert.ok("model" in entry);
  assert.equal(entry.model, "QWEN3_600M_INST_Q4");
  assert.equal(entry.preload, true);
  assert.equal(entry.config.ctx_size, 4096);
  assert.equal(config.serve.load.concurrency, 1);
});

test("buildQvacConfig uses an explicit local GGUF entry", () => {
  const config = buildQvacConfig(
    testSettings({ modelPath: "/models/my-model.gguf", modelId: "ignored" })
  );
  const entry = config.serve.models["localpilot-model"];
  assert.ok("src" in entry);
  assert.equal(entry.src, "/models/my-model.gguf");
  assert.equal(entry.type, "llamacpp-completion");
  assert.equal(entry.preload, true);
});

test("endpointForSettings brackets IPv6 loopback", () => {
  assert.equal(endpointForSettings(testSettings({ host: "::1", port: 1234 })), "http://[::1]:1234");
  assert.equal(
    endpointForSettings(testSettings({ host: "127.0.0.1", port: 11434 })),
    "http://127.0.0.1:11434"
  );
});

test("validateSettings rejects non-loopback hosts and bad limits", () => {
  assert.throws(() => validateSettings(testSettings({ host: "0.0.0.0" })), /non-loopback/);
  assert.throws(() => validateSettings(testSettings({ port: 80 })), /between 1024 and 65535/);
  assert.throws(() => validateSettings(testSettings({ modelAlias: "bad alias" })), /unsupported characters/);
  assert.throws(
    () => validateSettings(testSettings({ modelPath: "relative/model.gguf" })),
    /must be an absolute path/
  );
  assert.throws(
    () => validateSettings(testSettings({ modelPath: "/models/model.bin" })),
    /must point to a .gguf/
  );
  assert.throws(() => validateSettings(testSettings({ contextSize: 256 })), /contextSize/);
  assert.throws(
    () => validateSettings(testSettings({ contextSize: 1024, maxOutputTokens: 1024 })),
    /smaller than/
  );
});

test("writeQvacConfig writes valid JSON and creates the directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localpilot-config-"));
  try {
    const target = path.join(root, "nested", "qvac.config.json");
    await writeQvacConfig(target, testSettings({ modelAlias: "alias-one", port: 12345 }));
    const content = JSON.parse(await fs.readFile(target, "utf8")) as ReturnType<typeof buildQvacConfig>;
    const entry = content.serve.models["alias-one"];
    assert.ok(entry);
    assert.ok("model" in entry);
    assert.equal(entry.model, "QWEN3_600M_INST_Q4");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("writeQvacConfig validates a local GGUF file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localpilot-local-model-"));
  try {
    const modelFile = path.join(root, "tiny.gguf");
    await fs.writeFile(modelFile, "not really a model");
    const target = path.join(root, "qvac.config.json");
    await writeQvacConfig(target, testSettings({ modelPath: modelFile }));
    const content = JSON.parse(await fs.readFile(target, "utf8")) as ReturnType<typeof buildQvacConfig>;
    const entry = content.serve.models["localpilot-model"];
    assert.ok("src" in entry);
    assert.equal(entry.src, modelFile);

    await assert.rejects(
      writeQvacConfig(path.join(root, "missing.json"), testSettings({ modelPath: path.join(root, "missing.gguf") })),
      /not found/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readModelCacheInfo counts only GGUF files", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "localpilot-cache-"));
  try {
    const models = path.join(home, ".qvac", "models");
    await fs.mkdir(models, { recursive: true });
    await fs.writeFile(path.join(models, "a.gguf"), "12345");
    await fs.writeFile(path.join(models, "b.GGUF"), "123");
    await fs.writeFile(path.join(models, "ignore.bin"), "1234567");
    const info = await readModelCacheInfo(home);
    assert.equal(info.files, 2);
    assert.equal(info.bytes, 8);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("readModelCacheInfo returns an empty result for a missing cache", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "localpilot-cache-empty-"));
  try {
    const info = await readModelCacheInfo(home);
    assert.equal(info.files, 0);
    assert.equal(info.bytes, 0);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("readCachedModels lists complete GGUF files with friendly labels", async () => {
  const { readCachedModels } = await import("../modelCache");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "localpilot-cached-models-"));
  try {
    const models = path.join(home, ".qvac", "models");
    await fs.mkdir(models, { recursive: true });
    await fs.writeFile(path.join(models, "5b8aae816570a09d_Qwen3-0.6B-Q4_0.gguf"), "12345678");
    await fs.writeFile(path.join(models, "partial.gguf.part"), "123");
    const cached = await readCachedModels(home);
    assert.equal(cached.length, 1);
    assert.equal(cached[0].label, "Qwen3 0.6B Q4 0");
    assert.equal(cached[0].sizeBytes, 8);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("findCatalogModelCache reports partial and complete cached models", async () => {
  const { findCatalogModelCache } = await import("../modelCache");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "localpilot-catalog-cache-"));
  try {
    const models = path.join(home, ".qvac", "models");
    await fs.mkdir(models, { recursive: true });
    const file = path.join(models, "5b8aae816570a09d_Qwen3-0.6B-Q4_0.gguf");
    await fs.writeFile(file, "partial");
    const partial = await findCatalogModelCache("QWEN3_600M_INST_Q4", home);
    assert.equal(partial?.bytes, 7);
    assert.equal(partial?.expected, 382156480);
    assert.equal(partial?.cached, false);

    await fs.truncate(file, 382156480);
    const complete = await findCatalogModelCache("QWEN3_600M_INST_Q4", home);
    assert.equal(complete?.bytes, 382156480);
    assert.equal(complete?.cached, true);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
