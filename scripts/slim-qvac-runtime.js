#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const runtimeRoot = process.argv[2];
const platform = process.argv[3];
if (!runtimeRoot || !platform) {
  console.error("Usage: node scripts/slim-qvac-runtime.js <qvac-cli-root> <win32-x64|linux-x64>");
  process.exit(2);
}
const modules = path.join(runtimeRoot, "node_modules");
const qvac = path.join(modules, "@qvac");
if (!fs.existsSync(path.join(modules, "@qvac", "llm-llamacpp"))) {
  console.error(`Not a QVAC CLI install: ${runtimeRoot}`);
  process.exit(2);
}

const removePackages = [
  "diffusion-cpp",
  "bci-whispercpp",
  "translation-nmtcpp",
  "ocr-ggml",
  "tts-ggml",
  `tts-ggml-${platform}`,
  "audiogen-ggml",
  `audiogen-ggml-${platform}`,
  "asr-ggml",
  `asr-ggml-${platform}`,
  "classification-ggml",
  "vla-ggml",
  "decoder-audio",
  "embed-llamacpp"
];
for (const name of removePackages) {
  fs.rmSync(path.join(qvac, name), { recursive: true, force: true });
}
fs.rmSync(path.join(modules, "bare-ffmpeg"), { recursive: true, force: true });
const binDir = path.join(modules, ".bin");
if (fs.existsSync(binDir)) {
  for (const entry of fs.readdirSync(binDir)) {
    const full = path.join(binDir, entry);
    try {
      fs.realpathSync(full);
      fs.statSync(full);
    } catch {
      fs.rmSync(full, { force: true });
    }
  }
}

const llmPrebuilds = path.join(qvac, "llm-llamacpp", "prebuilds");
if (fs.existsSync(llmPrebuilds)) {
  for (const entry of fs.readdirSync(llmPrebuilds)) {
    if (entry !== platform) {
      fs.rmSync(path.join(llmPrebuilds, entry), { recursive: true, force: true });
    }
  }
}

const fabricRoot = path.join(qvac, `fabric-${platform}`);
const fabricPrebuilds = path.join(fabricRoot, "prebuilds", platform);
if (fs.existsSync(fabricPrebuilds)) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/(cuda|hip|rocm|metal)/i.test(entry.name)) fs.rmSync(full, { force: true });
    }
  };
  walk(fabricPrebuilds);
}

const worker = path.join(qvac, "sdk", "dist", "src", "worker", "index.js");
const original = fs.readFileSync(worker, "utf8");
const start = original.indexOf("import { llmPlugin }");
const end = original.indexOf("const { hasRPCConfig }");
if (start < 0 || end < 0) {
  console.error("Could not find QVAC worker plugin block to trim.");
  process.exit(1);
}
const head = original.slice(0, start);
let rest = original.slice(end);
rest = rest.replace(
  /registerPlugins\(\[[\s\S]*?\]\);/,
  "registerPlugins([llmPlugin]);"
);
if (!rest.includes("registerPlugins([llmPlugin]);")) {
  console.error("Could not trim QVAC worker plugin registration.");
  process.exit(1);
}
const replacement =
  "import { llmPlugin } from '@qvac/inference/llamacpp-completion/plugin';\n";
fs.writeFileSync(worker, head + replacement + rest);

function size(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += size(full);
    else {
      try {
        total += fs.statSync(full).size;
      } catch {
        // Broken .bin symlink left by a removed optional package.
      }
    }
  }
  return total;
}
console.log(`Trimmed QVAC chat runtime: ${(size(runtimeRoot) / 1024 ** 2).toFixed(1)} MiB`);
