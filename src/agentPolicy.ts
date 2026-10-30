export type WriteToolName = "write_file" | "replace_in_file";

export interface WriteIntent {
  wantsWrite: boolean;
  writeTool: WriteToolName;
}

const ACTION = /\b(create|write|save|add|edit|modify|update|fix|refactor|change|implement)\b/i;
const SUBJECT = /\b(file|code|function|component|test|class|module|readme|config|typescript|javascript|python|bug|script|style|app|api|route|hook|source)\b|[./\\][A-Za-z0-9_.-]+/i;
const CREATE = /\b(create|write|save|implement)\b|\badd\s+(?:a\s+)?(?:new\s+)?(?:file|function|test|component|code|module)\b/i;

export function detectWriteIntent(text: string): WriteIntent {
  const wantsWrite = ACTION.test(text) && SUBJECT.test(text);
  return {
    wantsWrite,
    writeTool: CREATE.test(text) ? "write_file" : "replace_in_file"
  };
}
