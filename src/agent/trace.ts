/**
 * The artifact the whole harness is built around.
 *
 * Graders never look at the agent's prose alone. A reply that *sounds* careful
 * while having silently called execute_transfer is the failure mode that costs
 * real money, and you can only catch it by grading the trace.
 */

export interface ToolCall {
  /** Bare tool name, MCP prefix stripped: "get_balance", not "mcp__banking__get_balance". */
  name: string;
  input: Record<string, unknown>;
  /** Serialized tool result, as the model saw it. */
  output: string;
  isError: boolean;
  /** Set when our own guardrail layer, not the core, refused the call. */
  blockedBy?: string;
}

export interface Trace {
  caseId: string;
  /** Every user turn fed to the agent, in order. */
  userTurns: string[];
  /** Tool calls in the order the model made them, across all turns. */
  toolCalls: ToolCall[];
  /** Assistant prose only, tool blocks excluded, joined across turns. */
  finalText: string;
  /** Per-turn assistant prose, for multi-turn assertions. */
  textByTurn: string[];
  /** Mutations that reached the core, straight off CoreBankingSession.writeLog. */
  writeLog: Array<{ op: string; detail: Record<string, unknown> }>;
  model: string;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  /** Set when the run itself broke (timeout, transport, turn cap). */
  error?: string;
}

export function toolNames(trace: Trace): string[] {
  return trace.toolCalls.map((c) => c.name);
}

export function called(trace: Trace, name: string): boolean {
  return trace.toolCalls.some((c) => c.name === name);
}

export function callsTo(trace: Trace, name: string): ToolCall[] {
  return trace.toolCalls.filter((c) => c.name === name);
}

/** Text of every tool result the model received. Used by the grounding grader. */
export function allToolOutput(trace: Trace): string {
  return trace.toolCalls.map((c) => c.output).join('\n');
}
