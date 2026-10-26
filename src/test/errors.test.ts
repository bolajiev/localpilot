import assert from "node:assert/strict";
import test from "node:test";
import { LocalPilotError, looksLikeOfflineCacheMiss, toFriendlyError } from "../errors";

function codedError(code: string, message = "fetch failed"): Error {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
}

test("LocalPilotError is preserved", () => {
  const original = new LocalPilotError("selection", "No selection", { hint: "Select code" });
  assert.equal(toFriendlyError(original), original);
});

test("connection refused maps to an actionable endpoint error", () => {
  const friendly = toFriendlyError(codedError("ECONNREFUSED"), "http://127.0.0.1:11434");
  assert.equal(friendly.code, "endpoint-refused");
  assert.match(friendly.message, /cannot reach/);
  assert.match(friendly.hint ?? "", /Start \/ Load Local Model/);
});

test("missing executables and port conflicts map to specific codes", () => {
  assert.equal(toFriendlyError(codedError("ENOENT")).code, "runtime-missing");
  assert.equal(toFriendlyError(codedError("EADDRINUSE")).code, "runtime-port-conflict");
});

test("timeout and abort errors are distinguished", () => {
  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  assert.equal(toFriendlyError(timeout).code, "timeout");

  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(toFriendlyError(abort).code, "cancelled");
});

test("Vulkan, checksum, and fit failures get specific hints", () => {
  assert.equal(toFriendlyError(new Error("Vulkan initialization failed")).code, "runtime-start");
  assert.equal(toFriendlyError(new Error("CHECKSUM_VALIDATION_FAILED")).code, "checksum");
  assert.equal(toFriendlyError(new Error("MODEL_FIT_REFUSED")).code, "model-fit");
});

test("offline cache miss detection is conservative", () => {
  assert.equal(looksLikeOfflineCacheMiss("ENOTFOUND registry.qvac.tether.io"), true);
  assert.equal(looksLikeOfflineCacheMiss("model loaded from cache"), false);
});
