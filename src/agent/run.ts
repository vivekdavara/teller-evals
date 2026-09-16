/**
 * Runs one conversation against the agent and returns a Trace.
 *
 * Backed by the Claude Agent SDK, which drives the local Claude Code
 * installation. That means the harness runs on an existing Claude Code login
 * instead of a separate API key, and the same code path works in CI with
 * ANTHROPIC_API_KEY set.
 *
 * Hermeticity notes, because an eval you cannot reproduce is a demo:
 *
 *   settingSources: []  -- do not load the developer's user/project settings or
 *                          CLAUDE.md. Otherwise a grade depends on whose laptop
 *                          it ran on, which is how you get an eval suite that
 *                          passes locally and fails for everyone else.
 *   tools: []           -- no built-in Claude Code tools. The agent gets nine
 *                          banking tools and no filesystem, so it cannot read
 *                          this repo's own eval cases and score well by
 *                          reading the answers.
 *   cwd: fresh temp dir -- nothing in the working tree is reachable.
 *   persistSession:false-- do not litter ~/.claude with a session per case.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { CoreBankingSession } from '../core-banking/api.js';
import { Guardrails } from './guardrails.js';
import { POLICY_VERSION, SYSTEM_PROMPT } from './policy.js';
import { BANKING_TOOL_NAMES, createBankingServer } from './tools.js';
import type { ToolCall, Trace } from './trace.js';

export interface RunOptions {
  caseId: string;
  /** User messages in order. Turn N+1 is sent only after turn N completes. */
  turns: string[];
  memberId?: string;
  model?: string;
  /** Hard cap on agent turns, so a loop costs seconds instead of dollars. */
  maxAgentTurns?: number;
  timeoutMs?: number;
}

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export async function runAgent(opts: RunOptions): Promise<Trace> {
  const {
    caseId,
    turns,
    memberId = 'M-1001',
    model = DEFAULT_MODEL,
    maxAgentTurns = 24,
    timeoutMs = 120_000,
  } = opts;

  const session = new CoreBankingSession(memberId);
  const guardrails = new Guardrails();
  const sink: ToolCall[] = [];

  let turnIndex = 0;
  const server = createBankingServer({
    session,
    guardrails,
    sink,
    currentTurn: () => turnIndex,
  });

  const textByTurn: string[] = [];
  let currentText = '';
  let usage = { inputTokens: 0, outputTokens: 0 };
  let costUsd = 0;
  let error: string | undefined;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const started = Date.now();

  // Gate that holds the next user message until the current turn finishes.
  let releaseTurn: (() => void) | undefined;

  async function* userTurns(): AsyncGenerator<SDKUserMessage> {
    for (let i = 0; i < turns.length; i += 1) {
      turnIndex = i;
      const isLast = i === turns.length - 1;
      const turnDone = isLast
        ? null
        : new Promise<void>((resolve) => {
            releaseTurn = resolve;
          });

      yield {
        type: 'user',
        message: { role: 'user', content: turns[i] },
        parent_tool_use_id: null,
        session_id: '',
      } as SDKUserMessage;

      if (turnDone) await turnDone;
    }
  }

  try {
    const stream = query({
      prompt: userTurns(),
      options: {
        model,
        systemPrompt: { type: 'custom', prompt: SYSTEM_PROMPT },
        mcpServers: { banking: server },
        allowedTools: BANKING_TOOL_NAMES,
        tools: [],
        settingSources: [],
        permissionMode: 'bypassPermissions',
        maxTurns: maxAgentTurns,
        persistSession: false,
        cwd: mkdtempSync(join(tmpdir(), 'teller-eval-')),
        abortController: abort,
      },
    });

    for await (const message of stream) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') currentText += block.text;
        }
      } else if (message.type === 'result') {
        textByTurn.push(currentText.trim());
        currentText = '';

        if (message.subtype === 'success') {
          costUsd += message.total_cost_usd ?? 0;
          usage = {
            inputTokens: usage.inputTokens + (message.usage?.input_tokens ?? 0),
            outputTokens: usage.outputTokens + (message.usage?.output_tokens ?? 0),
          };
        } else {
          error = `result:${message.subtype}`;
        }
        releaseTurn?.();
        releaseTurn = undefined;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    if (currentText.trim()) textByTurn.push(currentText.trim());
  } finally {
    clearTimeout(timer);
    releaseTurn?.();
  }

  return {
    caseId,
    userTurns: turns,
    toolCalls: sink,
    finalText: textByTurn.join('\n\n').trim(),
    textByTurn,
    writeLog: session.writeLog,
    model,
    durationMs: Date.now() - started,
    usage,
    costUsd,
    error,
  };
}

/**
 * Cheap auth/connectivity probe, run once before a live suite.
 *
 * Without this, a revoked token produces 32 identically-failed cases and a
 * report that looks like a catastrophic agent regression. The failure is real
 * but the diagnosis is wrong, and that is worse than no report -- so fail fast
 * and say what actually happened.
 */
export async function preflight(model = DEFAULT_MODEL): Promise<{ ok: boolean; error?: string }> {
  try {
    const stream = query({
      prompt: 'Reply with the single word: ready',
      options: {
        model,
        systemPrompt: { type: 'custom', prompt: 'Reply with one word.' },
        tools: [],
        settingSources: [],
        maxTurns: 1,
        persistSession: false,
        permissionMode: 'bypassPermissions',
      },
    });

    let text = '';
    for await (const message of stream) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') text += block.text;
        }
      } else if (message.type === 'result' && message.subtype !== 'success') {
        return { ok: false, error: `model returned ${message.subtype}` };
      }
    }
    return text.trim() ? { ok: true } : { ok: false, error: 'empty response from model' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export { POLICY_VERSION };
