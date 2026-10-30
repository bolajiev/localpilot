import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentLoop } from "../agentLoop";
import { AgentMessage, AgentResult } from "../agentTypes";
import { detectWriteIntent } from "../agentPolicy";
import { AgentTools } from "../agentTools";

function result(overrides: Partial<AgentResult>): AgentResult {
  return {
    content: "",
    toolCalls: [],
    elapsedMs: 1,
    ...overrides
  };
}

test("ReAct loop runs a write tool, observes it, then returns the final answer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localpilot-agent-loop-"));
  try {
    const tools = new AgentTools(root, async () => true);
    const messages: AgentMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "Create hello.txt with hi." }
    ];
    const calls: string[] = [];
    const client = {
      async chatWithTools(
        input: AgentMessage[],
        _tools: unknown,
        params: { toolChoice?: unknown }
      ): Promise<AgentResult> {
        calls.push(JSON.stringify(params.toolChoice));
        if (calls.length === 1) {
          return result({
            toolCalls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "hello.txt", content: "hi" })
                }
              }
            ],
            finishReason: "tool_calls"
          });
        }
        const tool = input.find((message) => message.role === "tool");
        assert.ok(tool);
        assert.match(tool.content ?? "", /Created hello\.txt/);
        return result({ content: "Created hello.txt.", finishReason: "stop" });
      }
    };

    const outcome = await runAgentLoop({
      client,
      tools,
      messages,
      mode: "build",
      writeIntent: detectWriteIntent("Create hello.txt with hi."),
      contextProvided: true,
      maxTokens: 32,
      temperature: 0,
      timeoutMs: 5000
    });

    assert.equal(outcome.wroteFile, true);
    assert.equal(outcome.steps, 2);
    assert.match(outcome.content, /Created hello\.txt/);
    assert.equal(await fs.readFile(path.join(root, "hello.txt"), "utf8"), "hi");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
