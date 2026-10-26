import assert from "node:assert/strict";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import test from "node:test";
import { LocalPilotError } from "../errors";
import { QvacClient } from "../qvacClient";

interface TestServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (server: TestServer) => Promise<void>
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port.");
  }
  const testServer: TestServer = {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  try {
    await run(testServer);
  } finally {
    await testServer.close();
  }
}

function collectBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

test("QvacClient rejects non-loopback, https, and pathed endpoints", () => {
  assert.throws(() => new QvacClient("http://192.168.1.10:11434", "m"), /non-loopback/);
  assert.throws(() => new QvacClient("https://127.0.0.1:11434", "m"), /Only http/);
  assert.throws(() => new QvacClient("http://127.0.0.1:11434/api", "m"), /without a path/);
});

test("probe distinguishes QVAC, other services, and closed ports", async () => {
  await withServer(
    (request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: "localpilot-model" }] }));
      } else {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("not qvac");
      }
    },
    async ({ url }) => {
      const client = new QvacClient(url, "localpilot-model");
      const result = await client.probe();
      assert.equal(result.kind, "qvac");
      if (result.kind === "qvac") {
        assert.deepEqual(result.models.map((model) => model.id), ["localpilot-model"]);
      }
    }
  );

  const other = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("hello");
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  const otherAddress = other.address();
  assert.ok(otherAddress && typeof otherAddress !== "string");
  try {
    const client = new QvacClient(`http://127.0.0.1:${otherAddress.port}`, "m");
    const result = await client.probe();
    assert.equal(result.kind, "other");
  } finally {
    other.closeAllConnections();
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }

  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedAddress = closed.address();
  assert.ok(closedAddress && typeof closedAddress !== "string");
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const closedClient = new QvacClient(`http://127.0.0.1:${closedAddress.port}`, "m");
  assert.equal((await closedClient.probe()).kind, "closed");
});

test("chatStream parses split SSE chunks, usage, and deltas", async () => {
  let bodyPromise: Promise<string> | undefined;
  let sawDelete = false;
  await withServer(
    (request, response) => {
      if (request.method === "DELETE") {
        sawDelete = true;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ deleted: true }));
        return;
      }
      if (request.url === "/v1/chat/completions") {
        bodyPromise = collectBody(request);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
          'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\r\n\r\n'
        );
        response.write('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n');
        response.write("\n");
        response.write('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n');
        response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        response.write(
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n'
        );
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: "not_found" } }));
    },
    async ({ url }) => {
      const client = new QvacClient(url, "localpilot-model");
      const deltas: string[] = [];
      const result = await client.chatStream(
        [{ role: "user", content: "hello" }],
        { maxTokens: 8, temperature: 0.1, enableReasoning: false },
        (delta) => {
          if (delta.content) {
            deltas.push(delta.content);
          }
        },
        undefined,
        5000
      );
      assert.equal(result.content, "Hello");
      assert.equal(result.reasoning, "think");
      assert.equal(result.finishReason, "stop");
      assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
      assert.deepEqual(deltas, ["Hel", "lo"]);
      const requestBody = JSON.parse(await bodyPromise!) as Record<string, unknown>;
      assert.equal(requestBody.model, "localpilot-model");
      assert.equal(requestBody.stream, true);
      assert.deepEqual(requestBody.stream_options, { include_usage: true });
      assert.equal(requestBody.reasoning_budget, false);
      await client.unloadModel("localpilot-model");
      assert.equal(sawDelete, true);
    }
  );
});

test("chatStream supports a blocking JSON response", async () => {
  await withServer(
    (request, response) => {
      void collectBody(request);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "blocking answer" },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
        })
      );
    },
    async ({ url }) => {
      const client = new QvacClient(url, "localpilot-model");
      const deltas: string[] = [];
      const result = await client.chatStream(
        [{ role: "user", content: "hello" }],
        { maxTokens: 8, temperature: 0, enableReasoning: false },
        (delta) => {
          if (delta.content) {
            deltas.push(delta.content);
          }
        }
      );
      assert.equal(result.content, "blocking answer");
      assert.deepEqual(deltas, ["blocking answer"]);
    }
  );
});

test("HTTP errors map to friendly LocalPilotError codes", async () => {
  await withServer(
    (request, response) => {
      void collectBody(request).then((text) => {
        const body = JSON.parse(text) as { model?: string };
        if (body.model === "missing") {
          response.writeHead(404, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({ error: { code: "model_not_found", message: "model alias missing" } })
          );
        } else {
          response.writeHead(502, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({ error: { code: "inference_failed", message: "backend failed" } })
          );
        }
      });
    },
    async ({ url }) => {
      const missing = new QvacClient(url, "missing");
      await assert.rejects(
        missing.chatStream(
          [{ role: "user", content: "hello" }],
          { maxTokens: 4, temperature: 0, enableReasoning: false },
          () => undefined,
          undefined,
          5000
        ),
        (error: unknown) =>
          error instanceof LocalPilotError && error.code === "model-missing"
      );

      const failing = new QvacClient(url, "failing");
      await assert.rejects(
        failing.chatStream(
          [{ role: "user", content: "hello" }],
          { maxTokens: 4, temperature: 0, enableReasoning: false },
          () => undefined,
          undefined,
          5000
        ),
        (error: unknown) =>
          error instanceof LocalPilotError && error.code === "model-load"
      );
    }
  );
});

test("request timeout aborts a hung local request", async () => {
  await withServer(
    (request) => {
      void collectBody(request);
    },
    async ({ url }) => {
      const client = new QvacClient(url, "localpilot-model");
      await assert.rejects(
        client.chatStream(
          [{ role: "user", content: "hello" }],
          { maxTokens: 4, temperature: 0, enableReasoning: false },
          () => undefined,
          undefined,
          80
        ),
        (error: unknown) => {
          assert.ok(error instanceof LocalPilotError);
          assert.equal(error.code, "timeout");
          return true;
        }
      );
    }
  );
});
