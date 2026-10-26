import assert from "node:assert/strict";
import test from "node:test";
import { isDonePayload, parseChatDelta, SseDecoder } from "../sse";

test("SseDecoder joins data lines and dispatches on blank lines", () => {
  const decoder = new SseDecoder();
  const events: string[] = [];
  events.push(...decoder.push("data: first\n"));
  events.push(...decoder.push("data: second\r\n\r\ndata: third\n\n"));
  events.push(...decoder.flush());
  assert.deepEqual(events, ["first\nsecond", "third"]);
});

test("SseDecoder handles comments and chunk boundaries", () => {
  const decoder = new SseDecoder();
  const events: string[] = [];
  events.push(...decoder.push(": keepalive\n"));
  events.push(...decoder.push("da"));
  events.push(...decoder.push("ta: {\"a\":1}\n"));
  events.push(...decoder.push("\n"));
  assert.deepEqual(events, ["{\"a\":1}"]);
});

test("SseDecoder flushes a trailing event without a blank line", () => {
  const decoder = new SseDecoder();
  assert.deepEqual(decoder.push("data: tail"), []);
  assert.deepEqual(decoder.flush(), ["tail"]);
});

test("isDonePayload recognizes the OpenAI terminator", () => {
  assert.equal(isDonePayload("[DONE]"), true);
  assert.equal(isDonePayload(" [DONE] "), true);
  assert.equal(isDonePayload("{\"done\":true}"), false);
});

test("parseChatDelta extracts content and finish reason", () => {
  const delta = parseChatDelta(
    JSON.stringify({
      choices: [{ delta: { content: "hello" }, finish_reason: null }]
    })
  );
  assert.equal(delta.content, "hello");
  assert.equal(delta.finishReason, null);
});

test("parseChatDelta extracts reasoning and usage", () => {
  const delta = parseChatDelta(
    JSON.stringify({
      choices: [{ delta: { reasoning_content: "think" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
    })
  );
  assert.equal(delta.reasoning, "think");
  assert.equal(delta.finishReason, "stop");
  assert.deepEqual(delta.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
});

test("parseChatDelta exposes server errors", () => {
  const delta = parseChatDelta(
    JSON.stringify({ error: { code: "inference_failed", message: "boom" } })
  );
  assert.deepEqual(delta.error, { code: "inference_failed", message: "boom" });
});

test("parseChatDelta rejects invalid JSON", () => {
  assert.throws(() => parseChatDelta("{not json"), /invalid streaming JSON/);
});
