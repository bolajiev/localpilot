const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

const SAFE_LINE_PATTERN =
  /qvac|model|download|load|listen|error|warn|fail|checksum|registry|memory|vulkan|port|timeout|cache|worker|backend|ready|preload|start|stop|exit|signal|inference|server|listen/i;

const SENSITIVE_PATTERN =
  /"(?:content|messages?|prompt|code|input|text|body)"\s*:|\b(?:prompt|code|input)\s*=|Authorization:|Bearer\s+[A-Za-z0-9._-]+/i;

export function sanitizeRuntimeLine(line: string): string | undefined {
  const withoutAnsi = line.replace(ANSI_PATTERN, "").trim();
  if (!withoutAnsi) {
    return undefined;
  }
  if (SENSITIVE_PATTERN.test(withoutAnsi)) {
    return undefined;
  }
  if (!SAFE_LINE_PATTERN.test(withoutAnsi)) {
    return undefined;
  }
  return withoutAnsi.length > 500 ? `${withoutAnsi.slice(0, 500)}…` : withoutAnsi;
}
