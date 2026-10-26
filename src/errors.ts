export type LocalPilotErrorCode =
  | "cancelled"
  | "timeout"
  | "runtime-missing"
  | "runtime-start"
  | "runtime-port-conflict"
  | "runtime-crashed"
  | "endpoint-refused"
  | "endpoint-invalid"
  | "network"
  | "offline-cache-miss"
  | "model-missing"
  | "model-load"
  | "model-fit"
  | "checksum"
  | "http"
  | "invalid-response"
  | "prompt"
  | "selection"
  | "unknown";

export interface LocalPilotErrorOptions {
  hint?: string;
  detail?: string;
  cause?: unknown;
}

export class LocalPilotError extends Error {
  public readonly code: LocalPilotErrorCode;
  public readonly hint?: string;
  public readonly detail?: string;

  public constructor(
    code: LocalPilotErrorCode,
    message: string,
    options: LocalPilotErrorOptions = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LocalPilotError";
    this.code = code;
    this.hint = options.hint;
    this.detail = options.detail;
  }
}

export function isCancelled(error: unknown): boolean {
  if (error instanceof LocalPilotError) {
    return error.code === "cancelled";
  }
  if (error instanceof Error) {
    return (
      error.name === "AbortError" ||
      error.name === "InferenceCancelledError" ||
      /cancelled|aborted/i.test(error.message)
    );
  }
  return false;
}

function collectCodes(error: unknown, depth = 0): string[] {
  if (!error || depth > 5) {
    return [];
  }
  const codes: string[] = [];
  if (typeof error === "object") {
    const value = error as { code?: unknown; cause?: unknown; name?: unknown };
    if (typeof value.code === "string") {
      codes.push(value.code);
    }
    if (value.cause) {
      codes.push(...collectCodes(value.cause, depth + 1));
    }
  }
  return codes;
}

function rawMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function trimDetail(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 800 ? `${trimmed.slice(0, 800)}…` : trimmed;
}

export function looksLikeOfflineCacheMiss(text: string): boolean {
  return /ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed|network|registry|download|offline|cache.*(missing|empty)|no such file|CHECKSUM|failed to resolve|unable to reach/i.test(
    text
  );
}

export function toFriendlyError(error: unknown, endpoint?: string): LocalPilotError {
  if (error instanceof LocalPilotError) {
    return error;
  }

  const message = rawMessage(error);
  const codes = collectCodes(error);
  const name = error instanceof Error ? error.name : "";
  const where = endpoint ? ` at ${endpoint}` : "";
  const detail = trimDetail(message);

  if (name === "TimeoutError" || /timed? ?out/i.test(message)) {
    return new LocalPilotError(
      "timeout",
      "The local model did not respond before the request timeout.",
      {
        hint: "The CPU-only model can be slow. Wait and retry, use a shorter prompt, or raise localpilot.requestTimeoutMs.",
        detail
      }
    );
  }

  if (name === "AbortError") {
    return new LocalPilotError("cancelled", "The local request was stopped.", { detail });
  }

  if (codes.includes("ECONNREFUSED")) {
    return new LocalPilotError(
      "endpoint-refused",
      `LocalPilot cannot reach the QVAC runtime${where}.`,
      {
        hint: "Run LocalPilot: Start / Load Local Model, then retry. If the port was changed, restart the runtime.",
        detail
      }
    );
  }

  if (codes.includes("EADDRINUSE")) {
    return new LocalPilotError(
      "runtime-port-conflict",
      "The configured QVAC port is already in use.",
      {
        hint: "Stop the other service or change localpilot.port, then run Start / Load Local Model again.",
        detail
      }
    );
  }

  if (codes.includes("ENOENT")) {
    return new LocalPilotError(
      "runtime-missing",
      "A required QVAC or Node.js executable could not be found.",
      {
        hint: "Install Node.js 22.21+ (or 24.9+) and run: npm install -g @qvac/cli@0.16.0. Then run LocalPilot: Check Runtime.",
        detail
      }
    );
  }

  if (codes.some((code) => code === "ENOTFOUND" || code === "EAI_AGAIN")) {
    return new LocalPilotError(
      "network",
      "LocalPilot could not reach the QVAC model registry.",
      {
        hint: "The first model download needs internet. If the model is already cached, retry and check the QVAC runtime log.",
        detail
      }
    );
  }

  if (/vulkan/i.test(message)) {
    return new LocalPilotError(
      "runtime-start",
      "QVAC reported a Vulkan/runtime problem.",
      {
        hint: "Windows requires Vulkan 1.4 or newer, even for CPU-only inference. Update the GPU driver and verify with `vulkaninfo --summary`.",
        detail
      }
    );
  }

  if (/MODEL_FIT_REFUSED/i.test(message)) {
    return new LocalPilotError(
      "model-fit",
      "QVAC refused to load the model because it does not fit in available memory.",
      {
        hint: "Close memory-heavy applications, use a smaller model, or lower localpilot.contextSize.",
        detail
      }
    );
  }

  if (/CHECKSUM|INSECURE_MODEL_SOURCE|checksum/i.test(message)) {
    return new LocalPilotError(
      "checksum",
      "QVAC rejected the downloaded model because integrity verification failed.",
      {
        hint: "Delete the incomplete model cache (see README), reconnect to the internet, and run Start / Load Local Model again.",
        detail
      }
    );
  }

  if (looksLikeOfflineCacheMiss(message)) {
    return new LocalPilotError(
      "offline-cache-miss",
      "QVAC could not load the model; the cache may be incomplete and the registry is unreachable.",
      {
        hint: "Connect to the internet and complete one successful Start / Load Local Model run before testing offline.",
        detail
      }
    );
  }

  return new LocalPilotError("unknown", "The local QVAC request failed.", {
    hint: "Run LocalPilot: Show Diagnostics Log for status metadata, then retry.",
    detail
  });
}

export function formatFriendlyError(error: LocalPilotError): string {
  return error.hint ? `${error.message} ${error.hint}` : error.message;
}
