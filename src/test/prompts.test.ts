import assert from "node:assert/strict";
import test from "node:test";
import {
  assertChatInput,
  buildExplainMessages,
  ChatMessage,
  MAX_CHAT_INPUT_CHARS,
  trimConversation
} from "../prompts";

test("buildExplainMessages includes only the selected code", () => {
  const messages = buildExplainMessages("typescript", "const x = 1;", 1000);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[1].content, /```typescript\nconst x = 1;\n```/);
  assert.doesNotMatch(messages[1].content, /whole file/i);
});

test("buildExplainMessages extends the fence when code contains backticks", () => {
  const code = "const sample = ```;";
  const messages = buildExplainMessages("js", code, 1000);
  assert.match(messages[1].content, /````js/);
});

test("buildExplainMessages rejects empty and oversized selections", () => {
  assert.throws(() => buildExplainMessages("ts", "   ", 1000), /No code is selected/);
  assert.throws(() => buildExplainMessages("ts", "x".repeat(1001), 1000), /too large/);
});

test("assertChatInput trims and rejects empty or huge prompts", () => {
  assert.equal(assertChatInput("  hello  "), "hello");
  assert.throws(() => assertChatInput("   "), /Enter a question/);
  assert.throws(() => assertChatInput("x".repeat(MAX_CHAT_INPUT_CHARS + 1)), /too long/);
});

test("trimConversation keeps the latest turn and drops old history", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "old ".repeat(300) },
    { role: "assistant", content: "old answer ".repeat(300) },
    { role: "user", content: "new question" }
  ];
  const trimmed = trimConversation(messages, 1024, 128);
  const last = trimmed[trimmed.length - 1];
  assert.equal(last.content, "new question");
  assert.equal(trimmed[0].role, "system");
  assert.match(trimmed[0].content, /Earlier conversation turns were omitted/);
});

test("trimConversation rejects a latest message larger than the context budget", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "x".repeat(5000) }
  ];
  assert.throws(() => trimConversation(messages, 1024, 256), /too large for the configured/);
});
