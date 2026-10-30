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


const WORKSPACE_READ = /\b(read|open|inspect|list|show|search|find|look|explore|scan|review|analyz|navigat|locate|grep|browse|walk)\b/i;
const WORKSPACE_SUBJECT = /\b(file|folder|directory|workspace|project|codebase|repo|repository|tree|source|module|test|selection|snippet|code)\b/i;
const FILE_PATH = /(?:^|[\s`"'(])(?:[\w.-]+[\\/])*[\w.-]+\.(?:ts|tsx|js|jsx|json|md|py|css|html|go|rs|java|c|cpp|h|hpp|cs|php|rb|swift|kt)(?=[\s`"')]|$)/i;
const EDIT_THIS = /\b(create|write|save|add|edit|modify|update|fix|refactor|change|implement|remove|delete|rename|replace)\b[^.!?\n]{0,40}\b(this|it|selection|snippet|file|code)\b/i;

const QUESTION = /^\s*(what|why|how|explain|describe|tell|summarize|review|compare|is|are|does|do|can you explain|could you explain|help me understand)\b/i;

export function shouldUseWorkspaceAgent(text: string, mode: "plan" | "build"): boolean {
  // Questions and explanations stay on the streaming chat path. Only direct
  // workspace actions enter the slow tool loop.
  if (QUESTION.test(text)) {
    return false;
  }
  if (mode === "build" && detectWriteIntent(text).wantsWrite) {
    return true;
  }
  if (FILE_PATH.test(text)) {
    return true;
  }
  if (mode === "build" && EDIT_THIS.test(text)) {
    return true;
  }
  return WORKSPACE_READ.test(text) && WORKSPACE_SUBJECT.test(text);
}
