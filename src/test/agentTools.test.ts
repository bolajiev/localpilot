import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentTools } from "../agentTools";

test("AgentTools creates, reads, lists, and replaces workspace files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localpilot-agent-tools-"));
  try {
    const approvals: string[] = [];
    const tools = new AgentTools(root, async (relativePath) => {
      approvals.push(relativePath);
      return true;
    });

    const created = await tools.execute(
      "write_file",
      JSON.stringify({ path: "src/demo.ts", content: "export const value = 1;\n" })
    );
    assert.equal(created.ok, true);
    assert.match(created.summary, /Created src\/demo.ts/);

    const read = await tools.execute("read_file", JSON.stringify({ path: "src/demo.ts" }));
    assert.equal(read.ok, true);
    assert.match(read.content, /value = 1/);

    const listed = await tools.execute("list_files", JSON.stringify({ path: "." }));
    assert.equal(listed.ok, true);
    assert.match(listed.content, /src\/demo\.ts/);

    const replaced = await tools.execute(
      "replace_in_file",
      JSON.stringify({ path: "src/demo.ts", old_text: "value = 1", new_text: "value = 2" })
    );
    assert.equal(replaced.ok, true);
    assert.equal(
      await fs.readFile(path.join(root, "src", "demo.ts"), "utf8"),
      "export const value = 2;\n"
    );
    assert.deepEqual(approvals, ["src/demo.ts", "src/demo.ts"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("AgentTools rejects traversal and requires approval for writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localpilot-agent-safety-"));
  try {
    const tools = new AgentTools(root, async () => false);
    const outside = await tools.execute(
      "write_file",
      JSON.stringify({ path: "../outside.txt", content: "no" })
    );
    assert.equal(outside.ok, false);
    assert.match(outside.content, /outside the workspace/);

    const denied = await tools.execute(
      "write_file",
      JSON.stringify({ path: "denied.txt", content: "no" })
    );
    assert.equal(denied.ok, false);
    assert.match(denied.content, /denied/);
    await assert.rejects(fs.stat(path.join(root, "denied.txt")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("AgentTools replace requires a unique exact match", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localpilot-agent-replace-"));
  try {
    const tools = new AgentTools(root, async () => true);
    await fs.writeFile(path.join(root, "a.txt"), "same same", "utf8");
    const result = await tools.execute(
      "replace_in_file",
      JSON.stringify({ path: "a.txt", old_text: "same", new_text: "once" })
    );
    assert.equal(result.ok, false);
    assert.match(result.content, /more than once/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
