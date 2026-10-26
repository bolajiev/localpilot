import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeRuntimeLine } from "../sanitize";

test("sanitizeRuntimeLine keeps runtime metadata and strips ANSI", () => {
  const line = "\u001B[32m[QVAC] Loading model qwen3\u001B[0m";
  assert.equal(sanitizeRuntimeLine(line), "[QVAC] Loading model qwen3");
});

test("sanitizeRuntimeLine drops prompt and source-code fields", () => {
  assert.equal(sanitizeRuntimeLine('{"content":"secret code"}'), undefined);
  assert.equal(sanitizeRuntimeLine("prompt=secret"), undefined);
  assert.equal(sanitizeRuntimeLine("Authorization: Bearer abc"), undefined);
});

test("sanitizeRuntimeLine drops unrelated chatter and truncates long lines", () => {
  assert.equal(sanitizeRuntimeLine("random unrelated text"), undefined);
  const long = sanitizeRuntimeLine(`loading model ${"x".repeat(1000)}`);
  assert.ok(long);
  assert.ok(long.length <= 501);
});
