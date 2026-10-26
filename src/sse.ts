export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatDelta {
  content?: string;
  reasoning?: string;
  finishReason?: string | null;
  usage?: ChatUsage;
  error?: {
    code?: string;
    message?: string;
  };
}

const MAX_BUFFER_CHARS = 1_000_000;

export class SseDecoder {
  private buffer = "";
  private dataLines: string[] = [];

  public push(chunk: string): string[] {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      throw new Error("SSE buffer exceeded the safety limit.");
    }

    const events: string[] = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.consumeLine(line, events);
      newlineIndex = this.buffer.indexOf("\n");
    }
    return events;
  }

  public flush(): string[] {
    const events: string[] = [];
    let line = this.buffer;
    this.buffer = "";
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    if (line.length > 0) {
      this.consumeLine(line, events);
    }
    if (this.dataLines.length > 0) {
      events.push(this.dataLines.join("\n"));
      this.dataLines = [];
    }
    return events;
  }

  private consumeLine(line: string, events: string[]): void {
    if (line.length === 0) {
      if (this.dataLines.length > 0) {
        events.push(this.dataLines.join("\n"));
        this.dataLines = [];
      }
      return;
    }

    if (line.startsWith(":")) {
      return;
    }

    const colon = line.indexOf(":");
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : "";
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "data") {
      this.dataLines.push(value);
    }
  }
}

export function isDonePayload(payload: string): boolean {
  return payload.trim() === "[DONE]";
}

export function parseChatDelta(payload: string): ChatDelta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("QVAC returned an invalid streaming JSON chunk.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("QVAC returned an unexpected streaming payload.");
  }

  const record = parsed as {
    error?: { code?: unknown; message?: unknown };
    usage?: ChatUsage;
    choices?: Array<{
      delta?: { content?: unknown; reasoning_content?: unknown };
      finish_reason?: unknown;
    }>;
  };

  if (record.error) {
    return {
      error: {
        code: typeof record.error.code === "string" ? record.error.code : undefined,
        message: typeof record.error.message === "string" ? record.error.message : undefined
      }
    };
  }

  const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
  const delta = choice?.delta;
  const content = typeof delta?.content === "string" ? delta.content : undefined;
  const reasoning =
    typeof delta?.reasoning_content === "string" ? delta.reasoning_content : undefined;
  const finishReason =
    typeof choice?.finish_reason === "string" ? choice.finish_reason : choice?.finish_reason === null ? null : undefined;

  return {
    content,
    reasoning,
    finishReason,
    usage: record.usage
  };
}
