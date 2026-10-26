import { LocalPilotError, toFriendlyError } from "./errors";
import { ChatMessage } from "./prompts";
import { ChatDelta, ChatUsage, isDonePayload, parseChatDelta, SseDecoder } from "./sse";
import { assertLoopbackHost } from "./runtimeConfig";

export interface QvacModel {
  id: string;
  object?: string;
  state?: string;
  owned_by?: string;
}

export type ProbeResult =
  | { kind: "qvac"; models: QvacModel[] }
  | { kind: "other"; reason: string }
  | { kind: "closed"; reason: string };

export interface ChatParams {
  maxTokens: number;
  temperature: number;
  enableReasoning: boolean;
}

export interface ChatDeltaHandler {
  (delta: { content?: string; reasoning?: string }): void;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  finishReason?: string | null;
  usage?: ChatUsage;
  elapsedMs: number;
}

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ServerErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    type?: unknown;
  };
  message?: unknown;
  code?: unknown;
}

function errorCodes(error: unknown, depth = 0): string[] {
  if (!error || depth > 5) {
    return [];
  }
  const codes: string[] = [];
  if (typeof error === "object") {
    const record = error as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") {
      codes.push(record.code);
    }
    if (record.cause) {
      codes.push(...errorCodes(record.cause, depth + 1));
    }
  }
  return codes;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || /timed out/i.test(error.message));
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs) {
    return signal;
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function serverErrorCode(body: ServerErrorBody | undefined): string | undefined {
  if (!body) {
    return undefined;
  }
  if (body.error && typeof body.error === "object") {
    if (typeof body.error.code === "string") {
      return body.error.code;
    }
    if (typeof body.error.type === "string") {
      return body.error.type;
    }
  }
  return typeof body.code === "string" ? body.code : undefined;
}

function serverErrorMessage(body: ServerErrorBody | undefined): string | undefined {
  if (!body) {
    return undefined;
  }
  if (body.error && typeof body.error === "object" && typeof body.error.message === "string") {
    return body.error.message;
  }
  return typeof body.message === "string" ? body.message : undefined;
}

function friendlyHttpError(
  status: number,
  code: string | undefined,
  message: string | undefined,
  modelAlias: string
): LocalPilotError {
  const detail = message ? `${code ?? status}: ${message.slice(0, 500)}` : undefined;

  if (code === "model_not_found") {
    return new LocalPilotError(
      "model-missing",
      `The QVAC runtime does not expose a model named "${modelAlias}".`,
      {
        hint: "Run LocalPilot: Start / Load Local Model so the managed config is used, or add the alias to the external server's qvac.config.json.",
        detail
      }
    );
  }

  if (code === "model_not_loaded" || code === "model_load_timeout" || status === 503) {
    return new LocalPilotError(
      "model-load",
      "The local model is not loaded or could not be loaded.",
      {
        hint: "Wait for Start / Load Local Model to finish, then retry. Check the diagnostics log for model-fit or memory errors.",
        detail
      }
    );
  }

  if (code === "inference_failed" || status === 502) {
    return new LocalPilotError(
      "model-load",
      "The local model failed during inference.",
      {
        hint: "Retry once. If it repeats, stop and restart the runtime, and check the diagnostics log.",
        detail
      }
    );
  }

  if (code === "model_fit_refused") {
    return new LocalPilotError(
      "model-fit",
      "QVAC refused to load the model because it does not fit in available memory.",
      {
        hint: "Close memory-heavy apps, lower localpilot.contextSize, or use a smaller model.",
        detail
      }
    );
  }

  if (status === 401 || status === 403) {
    return new LocalPilotError(
      "http",
      "The QVAC runtime rejected the request.",
      {
        hint: "A server started outside LocalPilot may require an API key. Start the runtime from LocalPilot instead.",
        detail
      }
    );
  }

  if (status === 429) {
    return new LocalPilotError("http", "The QVAC runtime is busy with another request.", {
      hint: "Wait for the current request to finish, or stop it and retry.",
      detail
    });
  }

  if (status === 404) {
    return new LocalPilotError(
      "model-missing",
      `The QVAC runtime does not expose the expected model or OpenAI-compatible endpoint.`,
      {
        hint: "Run LocalPilot: Start / Load Local Model so the managed config is used, or check the external server's qvac.config.json.",
        detail
      }
    );
  }

  return new LocalPilotError("http", `QVAC returned HTTP ${status}${code ? ` (${code})` : ""}.`, {
    hint: "Check the diagnostics log and retry.",
    detail
  });
}

export class QvacClient {
  public readonly endpoint: string;
  public readonly alias: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(endpoint: string, alias: string, fetchImpl: typeof fetch = globalThis.fetch) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch (error) {
      throw new LocalPilotError("endpoint-invalid", `Invalid QVAC endpoint: ${endpoint}`, {
        detail: error instanceof Error ? error.message : String(error)
      });
    }
    if (url.protocol !== "http:") {
      throw new LocalPilotError("endpoint-invalid", "Only http:// loopback QVAC endpoints are supported.");
    }
    if (url.username || url.password) {
      throw new LocalPilotError("endpoint-invalid", "QVAC endpoints must not contain credentials.");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    assertLoopbackHost(hostname);
    if (url.pathname !== "/" || url.search || url.hash) {
      throw new LocalPilotError("endpoint-invalid", "QVAC endpoint must be an origin without a path.");
    }
    if (!alias) {
      throw new LocalPilotError("endpoint-invalid", "A model alias is required for QVAC requests.");
    }
    this.endpoint = url.origin;
    this.alias = alias;
    this.fetchImpl = fetchImpl;
  }

  public modelUrl(path: string): string {
    return `${this.endpoint}${path}`;
  }

  public async probe(timeoutMs = 4000): Promise<ProbeResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.modelUrl("/v1/models"), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const codes = errorCodes(error);
      if (codes.includes("ECONNREFUSED") || codes.includes("ECONNRESET")) {
        return { kind: "closed", reason: "Connection refused." };
      }
      if (isTimeout(error)) {
        return { kind: "other", reason: "The port accepted a connection but did not answer in time." };
      }
      return {
        kind: "other",
        reason: error instanceof Error ? error.message : String(error)
      };
    }

    if (!response.ok) {
      return { kind: "other", reason: `HTTP ${response.status} at /v1/models.` };
    }

    try {
      const body = (await response.json()) as { object?: unknown; data?: unknown };
      if (body.object !== "list" || !Array.isArray(body.data)) {
        return { kind: "other", reason: "The server did not return an OpenAI-compatible model list." };
      }
      const models = body.data
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
        .filter((entry) => typeof entry.id === "string")
        .map((entry) => ({
          id: String(entry.id),
          object: typeof entry.object === "string" ? entry.object : undefined,
          state: typeof entry.state === "string" ? entry.state : undefined,
          owned_by: typeof entry.owned_by === "string" ? entry.owned_by : undefined
        }));
      return { kind: "qvac", models };
    } catch {
      return { kind: "other", reason: "The server returned invalid JSON for /v1/models." };
    }
  }

  public async listModels(timeoutMs = 10000, signal?: AbortSignal): Promise<QvacModel[]> {
    const response = await this.request("/v1/models", {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
      timeoutMs
    });
    const body = (await this.readJson(response, 2 * 1024 * 1024)) as {
      object?: unknown;
      data?: unknown;
    };
    if (body.object !== "list" || !Array.isArray(body.data)) {
      throw new LocalPilotError("invalid-response", "QVAC returned an unexpected model list.", {
        hint: "Restart the QVAC runtime and run Check Runtime."
      });
    }
    return body.data
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .filter((entry) => typeof entry.id === "string")
      .map((entry) => ({
        id: String(entry.id),
        object: typeof entry.object === "string" ? entry.object : undefined,
        state: typeof entry.state === "string" ? entry.state : undefined,
        owned_by: typeof entry.owned_by === "string" ? entry.owned_by : undefined
      }));
  }

  public async chatStream(
    messages: ChatMessage[],
    params: ChatParams,
    onDelta: ChatDeltaHandler,
    signal?: AbortSignal,
    timeoutMs = 900000
  ): Promise<ChatResult> {
    const started = Date.now();
    const combined = combineSignals(signal, timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.modelUrl("/v1/chat/completions"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        body: JSON.stringify({
          model: this.alias,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: params.temperature,
          max_tokens: params.maxTokens,
          reasoning_budget: params.enableReasoning
        }),
        signal: combined
      });
    } catch (error) {
      throw this.requestFailure(error, combined, signal);
    }

    if (!response.ok) {
      const body = await this.readErrorBody(response);
      throw friendlyHttpError(
        response.status,
        serverErrorCode(body),
        serverErrorMessage(body),
        this.alias
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return this.consumeBlockingResponse(response, onDelta, started);
    }
    if (!response.body) {
      throw new LocalPilotError("invalid-response", "QVAC returned an empty response body.", {
        hint: "Restart the runtime and retry."
      });
    }

    return this.consumeStream(response.body, onDelta, started, combined, signal);
  }

  public async unloadModel(alias = this.alias, timeoutMs = 12000): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.modelUrl(`/v1/models/${encodeURIComponent(alias)}`), {
        method: "DELETE",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw toFriendlyError(error, this.endpoint);
    }
    if (response.status === 404) {
      return;
    }
    if (!response.ok) {
      const body = await this.readErrorBody(response);
      throw friendlyHttpError(response.status, serverErrorCode(body), serverErrorMessage(body), alias);
    }
    await response.body?.cancel().catch(() => undefined);
  }

  private async request(path: string, options: FetchOptions = {}): Promise<Response> {
    const combined = combineSignals(options.signal, options.timeoutMs);
    try {
      return await this.fetchImpl(this.modelUrl(path), {
        method: options.method ?? "GET",
        headers: options.headers,
        signal: combined
      });
    } catch (error) {
      throw this.requestFailure(error, combined, options.signal);
    }
  }

  private requestFailure(
    error: unknown,
    combined: AbortSignal | undefined,
    external: AbortSignal | undefined
  ): LocalPilotError {
    if (combined?.aborted && !external?.aborted) {
      return new LocalPilotError(
        "timeout",
        "The local model did not respond before the request timeout.",
        {
          hint: "CPU-only inference can be slow. Retry with a shorter prompt or raise localpilot.requestTimeoutMs.",
          detail: error instanceof Error ? error.message : undefined
        }
      );
    }
    if (external?.aborted || isAbort(error)) {
      return new LocalPilotError("cancelled", "The local request was stopped.");
    }
    if (isTimeout(error)) {
      return new LocalPilotError("timeout", "The local model request timed out.");
    }
    return toFriendlyError(error, this.endpoint);
  }

  private async readErrorBody(response: Response): Promise<ServerErrorBody | undefined> {
    try {
      const text = (await response.text()).slice(0, 8192);
      const parsed = JSON.parse(text) as ServerErrorBody;
      return parsed && typeof parsed === "object" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async readJson(response: Response, maxBytes: number): Promise<unknown> {
    const text = await response.text();
    if (text.length > maxBytes) {
      throw new LocalPilotError("invalid-response", "QVAC returned an unexpectedly large JSON response.");
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new LocalPilotError("invalid-response", "QVAC returned invalid JSON.", {
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async consumeBlockingResponse(
    response: Response,
    onDelta: ChatDeltaHandler,
    started: number
  ): Promise<ChatResult> {
    const body = (await this.readJson(response, 8 * 1024 * 1024)) as {
      choices?: Array<{
        message?: { content?: unknown; reasoning_content?: unknown };
        finish_reason?: unknown;
      }>;
      usage?: ChatUsage;
    };
    const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    const reasoning =
      typeof choice?.message?.reasoning_content === "string" ? choice.message.reasoning_content : "";
    if (content) {
      onDelta({ content });
    }
    if (reasoning && !content) {
      onDelta({ reasoning });
    }
    if (!content && !reasoning) {
      throw new LocalPilotError("invalid-response", "QVAC returned an empty model response.");
    }
    return {
      content,
      reasoning,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
      usage: body.usage,
      elapsedMs: Date.now() - started
    };
  }

  private async consumeStream(
    stream: ReadableStream<Uint8Array>,
    onDelta: ChatDeltaHandler,
    started: number,
    combined: AbortSignal | undefined,
    external: AbortSignal | undefined
  ): Promise<ChatResult> {
    const reader = stream.getReader();
    const textDecoder = new TextDecoder();
    const sse = new SseDecoder();
    let content = "";
    let reasoning = "";
    let finishReason: string | null | undefined;
    let usage: ChatUsage | undefined;
    let done = false;

    try {
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        const text = textDecoder.decode(chunk.value, { stream: true });
        for (const payload of sse.push(text)) {
          if (isDonePayload(payload)) {
            done = true;
            break;
          }
          const delta = parseChatDelta(payload);
          this.applyDelta(delta, onDelta, (nextContent) => {
            content += nextContent;
          }, (nextReasoning) => {
            reasoning += nextReasoning;
          });
          if (delta.finishReason !== undefined) {
            finishReason = delta.finishReason;
          }
          if (delta.usage) {
            usage = delta.usage;
          }
          if (delta.error) {
            throw new LocalPilotError(
              "http",
              `QVAC inference failed${delta.error.code ? ` (${delta.error.code})` : ""}.`,
              {
                hint: "Retry once. If it repeats, restart the runtime and check the diagnostics log.",
                detail: delta.error.message
              }
            );
          }
        }
      }

      for (const payload of sse.flush()) {
        if (done || isDonePayload(payload)) {
          continue;
        }
        const delta = parseChatDelta(payload);
        this.applyDelta(delta, onDelta, (nextContent) => {
          content += nextContent;
        }, (nextReasoning) => {
          reasoning += nextReasoning;
        });
        if (delta.finishReason !== undefined) {
          finishReason = delta.finishReason;
        }
        if (delta.usage) {
          usage = delta.usage;
        }
      }
    } catch (error) {
      if (error instanceof LocalPilotError) {
        throw error;
      }
      if (!combined?.aborted && !external?.aborted && !isAbort(error)) {
        const friendly = toFriendlyError(error, this.endpoint);
        if (friendly.code === "unknown") {
          throw new LocalPilotError("invalid-response", "The QVAC response stream failed.", {
            detail: error instanceof Error ? error.message : String(error)
          });
        }
        throw friendly;
      }
      throw this.requestFailure(error, combined, external);
    } finally {
      reader.releaseLock();
    }

    if (!content && !reasoning) {
      if (finishReason === "length") {
        throw new LocalPilotError(
          "model-load",
          "The model used its token budget before producing an answer.",
          {
            hint: "Reasoning may be consuming the budget. Keep localpilot.enableReasoning off, lower the prompt size, or raise localpilot.maxOutputTokens."
          }
        );
      }
      throw new LocalPilotError("invalid-response", "QVAC finished without returning any text.", {
        hint: "Retry with a shorter prompt. If it repeats, check the diagnostics log."
      });
    }

    return {
      content,
      reasoning,
      finishReason,
      usage,
      elapsedMs: Date.now() - started
    };
  }

  private applyDelta(
    delta: ChatDelta,
    onDelta: ChatDeltaHandler,
    appendContent: (text: string) => void,
    appendReasoning: (text: string) => void
  ): void {
    if (delta.content) {
      appendContent(delta.content);
      onDelta({ content: delta.content });
    }
    if (delta.reasoning) {
      appendReasoning(delta.reasoning);
      onDelta({ reasoning: delta.reasoning });
    }
  }
}

export function createQvacClient(endpoint: string, alias: string): QvacClient {
  return new QvacClient(endpoint, alias);
}
