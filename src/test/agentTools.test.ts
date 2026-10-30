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

test("AgentTools exposes web tools only when enabled and blocks private URLs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localpilot-agent-web-"));
  try {
    const disabled = new AgentTools(root, async () => false);
    assert.equal(
      disabled.definitions().some((tool) => tool.function.name === "fetch_url"),
      false
    );
    const disabledResult = await disabled.execute(
      "fetch_url",
      JSON.stringify({ url: "https://example.com" })
    );
    assert.equal(disabledResult.ok, false);
    assert.match(disabledResult.content, /disabled/);

    const enabled = new AgentTools(root, async () => false, { webEnabled: true });
    assert.equal(
      enabled.definitions().some((tool) => tool.function.name === "web_search"),
      true
    );
    const blocked = await enabled.execute(
      "fetch_url",
      JSON.stringify({ url: "http://127.0.0.1:11434/v1/models" })
    );
    assert.equal(blocked.ok, false);
    assert.match(blocked.content, /Private/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("DuckDuckGo result parsing extracts titles, decoded URLs, and snippets", async () => {
  const { parseDuckDuckGoResults } = await import("../agentTools");
  const html = `
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=x">Example <b>docs</b></a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">A &amp; B snippet</a>
  `;
  const results = parseDuckDuckGoResults(html);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Example docs");
  assert.equal(results[0].url, "https://example.com/docs");
  assert.equal(results[0].snippet, "A & B snippet");
});

test("detectWriteIntent distinguishes create from edit requests", async () => {
  const { detectWriteIntent } = await import("../agentPolicy");
  assert.deepEqual(detectWriteIntent("Create a file src/add.ts with an add function"), {
    wantsWrite: true,
    writeTool: "write_file"
  });
  assert.deepEqual(detectWriteIntent("Fix the bug in src/add.ts"), {
    wantsWrite: true,
    writeTool: "replace_in_file"
  });
  assert.equal(detectWriteIntent("Explain this function").wantsWrite, false);
});

test("Plan/read-only mode removes write tools and blocks writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "localpilot-agent-plan-"));
  try {
    const tools = new AgentTools(root, async () => true, { readOnly: true });
    const names = tools.definitions().map((tool) => tool.function.name);
    assert.equal(names.includes("write_file"), false);
    assert.equal(names.includes("replace_in_file"), false);
    const result = await tools.execute(
      "write_file",
      JSON.stringify({ path: "blocked.txt", content: "no" })
    );
    assert.equal(result.ok, false);
    assert.match(result.content, /Plan mode is read-only/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
