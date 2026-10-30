import { AgentMessage, AgentResult, ToolDefinition } from "./agentTypes";
import { AgentTools } from "./agentTools";
import { WriteIntent } from "./agentPolicy";
import { ToolChoice } from "./qvacClient";

export interface AgentClient {
  chatWithTools(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    params: {
      maxTokens: number;
      temperature: number;
      enableReasoning: boolean;
      toolChoice?: ToolChoice;
    },
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<AgentResult>;
}

export interface AgentLoopOptions {
  client: AgentClient;
  tools: AgentTools;
  messages: AgentMessage[];
  mode: "plan" | "build";
  writeIntent: WriteIntent;
  contextProvided: boolean;
  maxSteps?: number;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onStep?: (step: number, maxSteps: number) => void;
  onToolStart?: (name: string, rawArguments: string) => void;
  onToolResult?: (summary: string) => void;
}

export interface AgentLoopResult {
  content: string;
  steps: number;
  wroteFile: boolean;
  writeDenied: boolean;
}

function toolChoiceFor(
  step: number,
  options: AgentLoopOptions,
  wroteFile: boolean,
  writeDenied: boolean
): ToolChoice {
  if (step === 0) {
    // With editor/file context the model can plan immediately. Without context,
    // force an inspection tool so it cannot answer blind.
    return options.contextProvided ? "auto" : "required";
  }
  if (
    options.mode === "build" &&
    options.writeIntent.wantsWrite &&
    !wroteFile &&
    !writeDenied &&
    step === 1
  ) {
    return {
      type: "function",
      function: { name: options.writeIntent.writeTool }
    };
  }
  return "auto";
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxSteps = options.maxSteps ?? 6;
  const messages = options.messages;
  let wroteFile = false;
  let writeDenied = false;
  let finalContent = "";
  let steps = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    steps = step + 1;
    options.onStep?.(step + 1, maxSteps);
    const result = await options.client.chatWithTools(
      messages,
      options.tools.definitions(),
      {
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        enableReasoning: false,
        toolChoice: toolChoiceFor(step, options, wroteFile, writeDenied)
      },
      options.signal,
      options.timeoutMs
    );

    if (result.toolCalls.length === 0) {
      finalContent = result.content.trim();
      break;
    }

    messages.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls
    });

    for (const call of result.toolCalls) {
      options.onToolStart?.(call.function.name, call.function.arguments);
      const outcome = await options.tools.execute(call.function.name, call.function.arguments);
      const isWrite =
        call.function.name === "write_file" || call.function.name === "replace_in_file";
      if (isWrite && outcome.ok) {
        wroteFile = true;
      }
      if (isWrite && !outcome.ok && /denied/i.test(outcome.content)) {
        writeDenied = true;
      }
      options.onToolResult?.(outcome.summary);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: outcome.ok ? outcome.content : `ERROR: ${outcome.content}`
      });
    }
  }

  if (!finalContent) {
    finalContent = wroteFile
      ? "The file change was applied, but the model did not produce a final summary."
      : "The agent reached the step limit without a final answer.";
  }

  return { content: finalContent, steps, wroteFile, writeDenied };
}
